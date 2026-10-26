import { neon } from "@neondatabase/serverless";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkAuth } from "./auth.js";
import { PasskeyConfigurationError } from "./passkey-errors.js";
import { passkeyStore } from "./passkey-store.js";
import { authConfig, passkeysEnabled } from "./session.js";
import { APP_CONFIG } from "../global/lib/config.js";
import type { Game } from "../global/lib/games.js";
import {
  bangkokToday,
  findTicket,
  isCount,
  isEditableDate,
  isIsoDate,
  isTicketWrite,
  type DayState,
  type DayWrite,
  type PlayWrite,
  type TicketWrite,
} from "../global/lib/play-log.js";

export type Sql = (
  text: string,
  params: unknown[],
) => Promise<Record<string, unknown>[]>;

export interface Tables {
  day: string;
  ticket: string;
}

export const TABLES: Tables = {
  day: "public.daily_play",
  ticket: "public.daily_ticket",
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
            COALESCE((SELECT json_object_agg(t.game || ':' || t.ticket,
                                             json_build_array(t.count, t.extra_credits))
                      FROM ${tables.ticket} t WHERE t.play_date = $1::date), '{}'::json) AS tickets
     FROM (SELECT $1::date AS day) x
     LEFT JOIN ${tables.day} d ON d.play_date = x.day`,
    [date],
  );
  const exists = Boolean(row?.exists);
  const rawTickets =
    typeof row?.tickets === "string" ? JSON.parse(row.tickets) : row?.tickets;
  const tickets = (rawTickets ?? {}) as Record<string, [number, number]>;
  const games: DayState["games"] = {};
  for (const game of APP_CONFIG.games) {
    const stored = row?.[PLAY_COLUMN[game]];
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
      tickets: gameTickets,
      ticketCredits,
    };
  }
  return { date, exists, games };
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
       SELECT maimai_cumulative, chunithm_cumulative, maimai_rating, chunithm_rating
       FROM ${tables.day} WHERE play_date < $1::date ORDER BY play_date DESC LIMIT 1
     ), ticket_total AS (
       SELECT COALESCE(SUM(count), 0)::int AS n FROM ${tables.ticket}
       WHERE play_date = $1::date AND game = $4
     ), written AS (
       INSERT INTO ${tables.day} AS d (play_date, maimai_play_count, chunithm_play_count,
                                       maimai_cumulative, chunithm_cumulative,
                                       maimai_rating, chunithm_rating, scrape_failed)
       SELECT $1::date, ${maimai}, ${chunithm},
              p.maimai_cumulative + ${maimai}, p.chunithm_cumulative + ${chunithm},
              p.maimai_rating, p.chunithm_rating, FALSE
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

const PLAY_KEYS = "count,date,expected,game";
const TICKET_KEYS = "count,date,expected,game,ticket";

export function parseWrite(
  body: unknown,
  today: string,
): { write: DayWrite } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { error: "Send a JSON object." };
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b).sort().join(",");
  if (keys !== PLAY_KEYS && keys !== TICKET_KEYS)
    return { error: `Send exactly ${PLAY_KEYS} (plus ticket for a ticket).` };
  if (typeof b.date !== "string" || !isEditableDate(b.date, today))
    return { error: "date must be a real date within the last year, not after today." };
  if (typeof b.game !== "string" || !(APP_CONFIG.games as string[]).includes(b.game))
    return { error: "game must be one of the configured games." };
  if (!isCount(b.count)) return { error: "count must be a whole number from 0 to 99." };
  if (b.expected !== null && !isCount(b.expected))
    return { error: "expected must be null or a whole number from 0 to 99." };
  const write: PlayWrite = {
    date: b.date,
    game: b.game as Game,
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
        if (!isIsoDate(date))
          return res
            .status(400)
            .json({ code: "INVALID_REQUEST", error: "date must be YYYY-MM-DD." });
        return res.status(200).json({ day: await readDay(sql, date) });
      }

      if (passkeys && !(await passkeyStore().rateLimit("daily-play", 60)))
        return res
          .status(429)
          .json({ error: "Too many saves. Retry in a minute." });

      const parsed = parseWrite(req.body, bangkokToday(now()));
      if ("error" in parsed)
        return res
          .status(400)
          .json({ code: "INVALID_REQUEST", error: parsed.error });
      const write = parsed.write;

      const saved = isTicketWrite(write)
        ? await writeTicket(sql, write, findTicket(write.game, write.ticket)?.extra_credits ?? 0)
        : await writePlays(sql, write);
      const day = await readDay(sql, write.date);
      if (saved) return res.status(200).json({ day });

      const gameDay = day.games[write.game];
      const changedElsewhere = isTicketWrite(write)
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
