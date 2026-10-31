import { neon } from "@neondatabase/serverless";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkAuth } from "./auth.js";
import { PasskeyConfigurationError } from "./passkey-errors.js";
import { passkeyStore } from "./passkey-store.js";
import { authConfig, passkeysEnabled } from "./session.js";
import { APP_CONFIG } from "../global/lib/config.js";
import { JAPAN_GAMES, type Game, type JapanGame } from "../global/lib/games.js";
import {
  findTicket,
  isCount,
  isCountFor,
  isEditableDate,
  isIsoDate,
  isJapanWrite,
  isRating,
  isRatingWrite,
  isTicketWrite,
  maxCount,
  regionToday,
  type DayState,
  type DayWrite,
  type JapanPlayWrite,
  type PlayWrite,
  type RatingWrite,
  type TicketWrite,
} from "../global/lib/play-log.js";

export type Sql = (
  text: string,
  params: unknown[],
) => Promise<Record<string, unknown>[]>;

export interface Tables {
  day: string;
  ticket: string;
  japan: string;
}

export const TABLES: Tables = {
  day: "public.daily_play",
  ticket: "public.daily_ticket",
  japan: "public.japan_daily_play",
};

// Column names come from these fixed maps, never from request input.
const PLAY_COLUMN: Record<Game, string> = {
  maimai: "maimai_play_count",
  chunithm: "chunithm_play_count",
};
const CUMULATIVE_COLUMN: Record<Game, string> = {
  maimai: "maimai_cumulative",
  chunithm: "chunithm_cumulative",
};
const RATING_COLUMN: Record<Game, string> = {
  maimai: "maimai_rating",
  chunithm: "chunithm_rating",
};
const JAPAN_COUNT_COLUMN: Record<JapanGame, string> = {
  maimai: "maimai_play_count",
  chunithm: "chunithm_play_count",
  ongeki: "ongeki_track_count",
};
const JAPAN_CUMULATIVE_COLUMN: Record<JapanGame, string> = {
  maimai: "maimai_cumulative",
  chunithm: "chunithm_cumulative",
  ongeki: "ongeki_cumulative_tracks",
};

// A day the editor creates continues the previous row's totals, so it stays
// flagged when that row is unverified: like the nightly fill, it must never
// become a scraper baseline.
const CREATED_FLAG = `COALESCE(p.scrape_failed, FALSE),
              CASE WHEN p.scrape_failed THEN 'Logged in the day editor; totals continue from '
                   || p.play_date || ', which is unverified.' END`;

export function neonSql(url: string): Sql {
  const db = neon(url);
  return (text, params) =>
    db.query(text, params) as Promise<Record<string, unknown>[]>;
}

export async function readDay(
  sql: Sql,
  date: string,
  tables: Tables = TABLES,
): Promise<DayState> {
  const [row] = await sql(
    `SELECT (d.play_date IS NOT NULL) AS exists, d.maimai_play_count, d.chunithm_play_count,
            CASE WHEN d.play_date IS NULL THEN p.maimai_rating ELSE d.maimai_rating END AS maimai_rating,
            CASE WHEN d.play_date IS NULL THEN p.chunithm_rating ELSE d.chunithm_rating END AS chunithm_rating,
            COALESCE((SELECT json_object_agg(t.game || ':' || t.ticket,
                                             json_build_array(t.count, t.extra_credits))
                      FROM ${tables.ticket} t WHERE t.play_date = $1::date), '{}'::json) AS tickets
     FROM (SELECT $1::date AS day) x
     LEFT JOIN ${tables.day} d ON d.play_date = x.day
     LEFT JOIN LATERAL (SELECT maimai_rating, chunithm_rating FROM ${tables.day}
                        WHERE play_date < x.day ORDER BY play_date DESC LIMIT 1) p ON TRUE`,
    [date],
  );
  const exists = Boolean(row?.exists);
  const rawTickets =
    typeof row?.tickets === "string" ? JSON.parse(row.tickets) : row?.tickets;
  const tickets = (rawTickets ?? {}) as Record<string, [number, number]>;
  const games: DayState["games"] = {};
  for (const game of APP_CONFIG.games) {
    const stored = row?.[PLAY_COLUMN[game]];
    const rating = row?.[RATING_COLUMN[game]];
    const gameTickets: Record<string, number> = {};
    const ticketCredits: Record<string, number> = {};
    for (const [key, [count, extra]] of Object.entries(tickets)) {
      const split = key.indexOf(":");
      if (key.slice(0, split) !== game) continue;
      gameTickets[key.slice(split + 1)] = Number(count);
      ticketCredits[key.slice(split + 1)] = Number(extra);
    }
    games[game] = {
      plays: exists ? (stored == null ? null : Number(stored)) : 0,
      rating: rating == null ? null : Number(rating),
      tickets: gameTickets,
      ticketCredits,
    };
  }
  return { date, region: "international", exists, games };
}

export async function readJapanDay(
  sql: Sql,
  date: string,
  tables: Tables = TABLES,
): Promise<DayState> {
  const [row] = await sql(
    `SELECT (d.play_date IS NOT NULL) AS exists, d.maimai_play_count, d.chunithm_play_count,
            d.ongeki_track_count,
            (SELECT MAX(play_date)::text FROM ${tables.japan} WHERE source <> 'manual')
              AS journal_through
     FROM (SELECT $1::date AS day) x
     LEFT JOIN ${tables.japan} d ON d.play_date = x.day`,
    [date],
  );
  const games: DayState["games"] = {};
  for (const game of JAPAN_GAMES)
    games[game] = { plays: Number(row?.[JAPAN_COUNT_COLUMN[game]] ?? 0), rating: null, tickets: {} };
  return {
    date,
    region: "japan",
    exists: Boolean(row?.exists),
    games,
    journalThrough: (row?.journal_through as string | null | undefined) ?? null,
  };
}

/**
 * Compare-and-set one game's Japan count. Days through the last Journal day
 * belong to the Journal import and are never written here, so every row this
 * creates or shifts was logged in the editor. A new row continues the
 * previous row's totals with the other games at 0; the change is added to
 * this day's and every later day's total.
 */
export async function writeJapanPlays(
  sql: Sql,
  write: JapanPlayWrite,
  tables: Tables = TABLES,
): Promise<boolean> {
  const col = JAPAN_COUNT_COLUMN[write.game];
  const cum = JAPAN_CUMULATIVE_COLUMN[write.game];
  const count = (game: JapanGame) => (game === write.game ? "$2::int" : "0");
  const rows = await sql(
    `WITH prev AS (
       SELECT maimai_cumulative, chunithm_cumulative, ongeki_cumulative_tracks
       FROM ${tables.japan} WHERE play_date < $1::date ORDER BY play_date DESC LIMIT 1
     ), written AS (
       INSERT INTO ${tables.japan} AS d (play_date, maimai_play_count, chunithm_play_count,
                                         ongeki_track_count, maimai_cumulative,
                                         chunithm_cumulative, ongeki_cumulative_tracks,
                                         source, source_paths, source_hashes)
       SELECT $1::date, ${count("maimai")}, ${count("chunithm")}, ${count("ongeki")},
              COALESCE(p.maimai_cumulative, 0) + ${count("maimai")},
              COALESCE(p.chunithm_cumulative, 0) + ${count("chunithm")},
              COALESCE(p.ongeki_cumulative_tracks, 0) + ${count("ongeki")},
              'manual', '{}', '{}'
       FROM (SELECT 1) one LEFT JOIN prev p ON TRUE
       WHERE NOT EXISTS (SELECT 1 FROM ${tables.japan}
                         WHERE play_date >= $1::date AND source <> 'manual')
         AND (EXISTS (SELECT 1 FROM ${tables.japan} WHERE play_date = $1::date)
              OR $3::int = 0)
       ON CONFLICT (play_date) DO UPDATE SET
         ${col} = EXCLUDED.${col},
         ${cum} = d.${cum} + ($2::int - d.${col})
       WHERE d.${col} = $3::int
       RETURNING d.play_date
     ), shifted AS (
       UPDATE ${tables.japan} AS later
       SET ${cum} = later.${cum} + ($2::int - $3::int)
       WHERE later.play_date > $1::date AND EXISTS (SELECT 1 FROM written)
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM written)::int AS written`,
    [write.date, write.count, write.expected],
  );
  return Number(rows[0]?.written) === 1;
}

/**
 * Compare-and-set one game's plays. A new row copies the previous row's totals
 * and ratings (a missing day means no play); the count change is added to this
 * day's and every later day's cumulative total. Typing a total for an unknown
 * (NULL) count leaves every total alone: those came from SEGA's counter, which
 * already includes the plays. One statement, so it is atomic over Neon's
 * stateless HTTP driver.
 */
export async function writePlays(
  sql: Sql,
  write: PlayWrite,
  tables: Tables = TABLES,
): Promise<boolean> {
  const col = PLAY_COLUMN[write.game];
  const cum = CUMULATIVE_COLUMN[write.game];
  const maimai = write.game === "maimai" ? "$2::int" : "0";
  const chunithm = write.game === "chunithm" ? "$2::int" : "0";
  const rows = await sql(
    `WITH prev AS (
       SELECT play_date, maimai_cumulative, chunithm_cumulative, maimai_rating, chunithm_rating,
              scrape_failed
       FROM ${tables.day} WHERE play_date < $1::date ORDER BY play_date DESC LIMIT 1
     ), ticket_total AS (
       SELECT COALESCE(SUM(count), 0)::int AS n FROM ${tables.ticket}
       WHERE play_date = $1::date AND game = $4
     ), written AS (
       INSERT INTO ${tables.day} AS d (play_date, maimai_play_count, chunithm_play_count,
                                       maimai_cumulative, chunithm_cumulative,
                                       maimai_rating, chunithm_rating,
                                       scrape_failed, failure_reason)
       SELECT $1::date, ${maimai}, ${chunithm},
              p.maimai_cumulative + ${maimai}, p.chunithm_cumulative + ${chunithm},
              p.maimai_rating, p.chunithm_rating, ${CREATED_FLAG}
       FROM (SELECT 1) one LEFT JOIN prev p ON TRUE
       WHERE $2::int >= (SELECT n FROM ticket_total)
         AND (EXISTS (SELECT 1 FROM ${tables.day} WHERE play_date = $1::date)
              OR $3::int = 0)
       ON CONFLICT (play_date) DO UPDATE SET
         ${col} = EXCLUDED.${col},
         ${cum} = CASE WHEN d.${col} IS NULL THEN d.${cum}
                       ELSE d.${cum} + ($2::int - d.${col}) END
       WHERE d.${col} IS NOT DISTINCT FROM $3::int
       RETURNING d.play_date
     ), shifted AS (
       UPDATE ${tables.day} AS later
       SET ${cum} = later.${cum} + ($2::int - $3::int)
       WHERE later.play_date > $1::date AND later.${cum} IS NOT NULL
         AND $3::int IS NOT NULL AND EXISTS (SELECT 1 FROM written)
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM written)::int AS written`,
    [write.date, write.count, write.expected, write.game],
  );
  return Number(rows[0]?.written) === 1;
}

/**
 * Compare-and-set one ticket count. Adding is allowed only while the game's
 * tickets stay within its plays; lowering is always allowed. extra_credits is
 * kept from the first insert so a later catalog edit never rewrites spending.
 */
export async function writeTicket(
  sql: Sql,
  write: TicketWrite,
  extraCredits: number,
  tables: Tables = TABLES,
): Promise<boolean> {
  const col = PLAY_COLUMN[write.game];
  const rows = await sql(
    `WITH day AS (SELECT ${col} AS plays FROM ${tables.day} WHERE play_date = $1::date),
     others AS (SELECT COALESCE(SUM(count), 0)::int AS n FROM ${tables.ticket}
                WHERE play_date = $1::date AND game = $2 AND ticket <> $3)
     INSERT INTO ${tables.ticket} AS t (play_date, game, ticket, count, extra_credits)
     SELECT $1::date, $2, $3, $4::int, $6::int
     WHERE ($4::int <= COALESCE($5::int, 0)
            OR (SELECT n FROM others) + $4::int <= COALESCE((SELECT plays FROM day), 0))
       AND (EXISTS (SELECT 1 FROM ${tables.ticket}
                    WHERE play_date = $1::date AND game = $2 AND ticket = $3)
            OR COALESCE($5::int, 0) = 0)
     ON CONFLICT (play_date, game, ticket) DO UPDATE SET count = EXCLUDED.count
     WHERE t.count = COALESCE($5::int, 0)
     RETURNING t.count`,
    [write.date, write.game, write.ticket, write.count, write.expected, extraCredits],
  );
  return rows.length === 1;
}

/**
 * Compare-and-set one game's rating. A rating can only change on a day with
 * plays, so the new value also replaces the old one in the following days
 * without plays for this game that still hold it, stopping at the first day
 * with plays (or an unknown count) or a different rating. A missing day is
 * created like a play write would: previous totals and ratings, 0 plays.
 *
 * Ratings compare as float8, the value the client saw: rows written before
 * the scraper rounded ratings hold a float's full binary expansion.
 */
export async function writeRating(
  sql: Sql,
  write: RatingWrite,
  tables: Tables = TABLES,
): Promise<boolean> {
  const col = RATING_COLUMN[write.game];
  const plays = PLAY_COLUMN[write.game];
  const maimai = write.game === "maimai" ? "$2::numeric" : "p.maimai_rating";
  const chunithm = write.game === "chunithm" ? "$2::numeric" : "p.chunithm_rating";
  const rows = await sql(
    `WITH prev AS (
       SELECT play_date, maimai_cumulative, chunithm_cumulative, maimai_rating, chunithm_rating,
              scrape_failed
       FROM ${tables.day} WHERE play_date < $1::date ORDER BY play_date DESC LIMIT 1
     ), old AS (
       SELECT CASE WHEN EXISTS (SELECT 1 FROM ${tables.day} WHERE play_date = $1::date)
                   THEN (SELECT ${col} FROM ${tables.day} WHERE play_date = $1::date)
                   ELSE (SELECT ${col} FROM prev) END::float8 AS r
     ), written AS (
       INSERT INTO ${tables.day} AS d (play_date, maimai_play_count, chunithm_play_count,
                                       maimai_cumulative, chunithm_cumulative,
                                       maimai_rating, chunithm_rating,
                                       scrape_failed, failure_reason)
       SELECT $1::date, 0, 0, p.maimai_cumulative, p.chunithm_cumulative,
              ${maimai}, ${chunithm}, ${CREATED_FLAG}
       FROM (SELECT 1) one LEFT JOIN prev p ON TRUE
       WHERE (SELECT r FROM old) IS NOT DISTINCT FROM $3::float8
       ON CONFLICT (play_date) DO UPDATE SET ${col} = EXCLUDED.${col}
       WHERE d.${col}::float8 IS NOT DISTINCT FROM $3::float8
       RETURNING d.play_date
     ), stop AS (
       SELECT MIN(play_date) AS at FROM ${tables.day}
       WHERE play_date > $1::date
         AND (${plays} IS DISTINCT FROM 0
              OR ${col}::float8 IS DISTINCT FROM (SELECT r FROM old))
     ), carried AS (
       -- The per-row checks repeat the stop rule so that a row another writer
       -- changed after this statement's snapshot keeps its new value.
       UPDATE ${tables.day} AS later SET ${col} = $2::numeric
       WHERE later.play_date > $1::date
         AND later.play_date < COALESCE((SELECT at FROM stop), 'infinity'::date)
         AND later.${plays} = 0
         AND later.${col}::float8 IS NOT DISTINCT FROM (SELECT r FROM old)
         AND EXISTS (SELECT 1 FROM written)
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM written)::int AS written`,
    [write.date, write.rating, write.expected],
  );
  return Number(rows[0]?.written) === 1;
}

const PLAY_KEYS = "count,date,expected,game";
const TICKET_KEYS = "count,date,expected,game,ticket";
const RATING_KEYS = "date,expected,game,rating";
const JAPAN_KEYS = "count,date,expected,game,region";

const DATE_ERROR = "date must be a real date within the last year, not after today.";

function parseJapanWrite(
  b: Record<string, unknown>,
  now: Date,
): { write: JapanPlayWrite } | { error: string } {
  if (b.region !== "japan") return { error: 'region must be "japan".' };
  if (typeof b.date !== "string" || !isEditableDate(b.date, regionToday("japan", now)))
    return { error: DATE_ERROR };
  if (typeof b.game !== "string" || !(JAPAN_GAMES as string[]).includes(b.game))
    return { error: "game must be maimai, chunithm or ongeki." };
  const game = b.game as JapanGame;
  if (!isCountFor(game, b.count) || !isCountFor(game, b.expected))
    return { error: `count and expected must be whole numbers from 0 to ${maxCount(game)}.` };
  return { write: { region: "japan", date: b.date, game, count: b.count, expected: b.expected } };
}

export function parseWrite(
  body: unknown,
  now: Date,
): { write: DayWrite } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { error: "Send a JSON object." };
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b).sort().join(",");
  if (keys === JAPAN_KEYS) return parseJapanWrite(b, now);
  if (keys !== PLAY_KEYS && keys !== TICKET_KEYS && keys !== RATING_KEYS)
    return {
      error: `Send exactly ${PLAY_KEYS} (plus ticket for a ticket, or region for Japan), or ${RATING_KEYS}.`,
    };
  if (typeof b.date !== "string" || !isEditableDate(b.date, regionToday("international", now)))
    return { error: DATE_ERROR };
  if (typeof b.game !== "string" || !(APP_CONFIG.games as string[]).includes(b.game))
    return { error: "game must be one of the configured games." };
  const game = b.game as Game;
  if (keys === RATING_KEYS) {
    if (!isRating(game, b.rating))
      return {
        error:
          game === "maimai"
            ? "rating must be a whole number from 0 to 20000."
            : "rating must be a number from 0 to 20 with at most two decimals.",
      };
    // expected echoes the stored value, which may predate these bounds.
    if (b.expected !== null && (typeof b.expected !== "number" || !Number.isFinite(b.expected)))
      return { error: "expected must be null or a number." };
    return { write: { date: b.date, game, rating: b.rating, expected: b.expected } };
  }
  if (!isCount(b.count)) return { error: "count must be a whole number from 0 to 99." };
  if (b.expected !== null && !isCount(b.expected))
    return { error: "expected must be null or a whole number from 0 to 99." };
  const write: PlayWrite = {
    date: b.date,
    game,
    count: b.count,
    expected: b.expected as number | null,
  };
  if (keys === PLAY_KEYS) return { write };
  const ticket = b.ticket;
  const removingRetired =
    typeof ticket === "string" &&
    /^[a-z0-9_]{1,32}$/.test(ticket) &&
    write.expected != null &&
    write.count < write.expected;
  if (typeof ticket !== "string" || !(findTicket(write.game, ticket) || removingRetired))
    return { error: "ticket must be one of this game's catalog tickets." };
  return { write: { ...write, ticket } };
}

export function createDailyPlayHandler(
  makeSql: (url: string) => Sql,
  now: () => Date = () => new Date(),
) {
  return async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader("Cache-Control", "private, no-store");
    if (req.method !== "GET" && req.method !== "PUT")
      return res.status(405).json({ error: "Method not allowed" });

    const passkeys = passkeysEnabled();
    if (req.method === "PUT") {
      // checkAuth allows everything when no sign-in is configured; writes must not.
      if (!passkeys && !process.env.DASHBOARD_PASSWORD)
        return res.status(503).json({
          code: "WRITES_DISABLED",
          error: "Set up Passkeys or DASHBOARD_PASSWORD to log plays.",
        });
      if (passkeys) {
        let origin: string;
        try {
          origin = authConfig().origin;
        } catch (e) {
          if (e instanceof PasskeyConfigurationError)
            return res.status(503).json({ error: e.message });
          throw e;
        }
        // hasSession accepts a missing Origin; a cookie-authenticated write must not.
        if (req.headers.origin !== origin)
          return res.status(403).json({ error: "Invalid origin" });
      }
    }

    if (
      !checkAuth(
        req.headers.authorization,
        process.env.DASHBOARD_PASSWORD,
        req.headers.cookie,
        req.headers.origin,
      )
    )
      return res.status(401).json({ error: "Sign in to the dashboard" });

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return res.status(500).json({ error: "DATABASE_URL not set" });

    try {
      const sql = makeSql(dbUrl);
      if (req.method === "GET") {
        const date = req.query?.date;
        const region = req.query?.region ?? "international";
        if (!isIsoDate(date))
          return res
            .status(400)
            .json({ code: "INVALID_REQUEST", error: "date must be YYYY-MM-DD." });
        if (region !== "international" && region !== "japan")
          return res
            .status(400)
            .json({ code: "INVALID_REQUEST", error: 'region must be "international" or "japan".' });
        const day = region === "japan" ? await readJapanDay(sql, date) : await readDay(sql, date);
        return res.status(200).json({ day });
      }

      if (passkeys && !(await passkeyStore().rateLimit("daily-play", 60)))
        return res
          .status(429)
          .json({ error: "Too many saves. Retry in a minute." });

      const parsed = parseWrite(req.body, now());
      if ("error" in parsed)
        return res
          .status(400)
          .json({ code: "INVALID_REQUEST", error: parsed.error });
      const write = parsed.write;

      if (isJapanWrite(write)) {
        const saved = await writeJapanPlays(sql, write);
        const day = await readJapanDay(sql, write.date);
        if (saved) return res.status(200).json({ day });
        if (day.journalThrough != null && write.date <= day.journalThrough)
          return res.status(400).json({
            code: "JOURNAL_DAY",
            error: "This day comes from your Obsidian Journal. Change it there.",
            day,
          });
        return res
          .status(409)
          .json({ code: "CONFLICT", error: "Changed on another device.", day });
      }

      const saved = isRatingWrite(write)
        ? await writeRating(sql, write)
        : isTicketWrite(write)
          ? await writeTicket(sql, write, findTicket(write.game, write.ticket)?.extra_credits ?? 0)
          : await writePlays(sql, write);
      const day = await readDay(sql, write.date);
      if (saved) return res.status(200).json({ day });

      const gameDay = day.games[write.game];
      // A rating write fails only when the stored rating moved.
      const changedElsewhere = isRatingWrite(write)
        ? true
        : isTicketWrite(write)
          ? (gameDay?.tickets[write.ticket] ?? 0) !== (write.expected ?? 0)
          : gameDay?.plays !== write.expected;
      if (changedElsewhere)
        return res
          .status(409)
          .json({ code: "CONFLICT", error: "Changed on another device.", day });
      return res.status(400).json({
        code: "TICKETS_EXCEED_PLAYS",
        error: isTicketWrite(write)
          ? "Add a play before adding a ticket."
          : "Remove a ticket first.",
        day,
      });
    } catch (e) {
      console.error("[daily-play]", e instanceof Error ? e.message : e);
      return res.status(500).json({
        error: req.method === "GET" ? "Could not load this day. Try again." : "Could not save. Try again.",
      });
    }
  };
}
