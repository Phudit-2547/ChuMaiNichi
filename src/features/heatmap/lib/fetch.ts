import { queryDB } from "../../../global/lib/api";
import type { DailyRow, DataRegion, Game } from "../types/types";

const TABLE_BY_REGION: Record<DataRegion, string> = {
  international: "daily_play",
  japan: "japan_daily_play",
};

const COLUMNS_BY_REGION: Record<DataRegion, string> = {
  international: `play_date::text, maimai_play_count, chunithm_play_count,
                  maimai_rating, chunithm_rating, scrape_failed, failure_reason`,
  japan: `play_date::text, maimai_play_count, chunithm_play_count,
          ongeki_track_count, inferred_games, source`,
};

export async function fetchYears(
  region: DataRegion = "international",
): Promise<number[]> {
  const table = TABLE_BY_REGION[region];
  const rows = await queryDB<{ year: number }>(
    `SELECT DISTINCT CAST(EXTRACT(YEAR FROM play_date) AS integer) AS year
     FROM ${table}
     ORDER BY year`,
  );
  return rows.map((r) => r.year);
}

export async function fetchLastUpdated(
  region: DataRegion = "international",
): Promise<string | null> {
  const table = TABLE_BY_REGION[region];
  const rows = await queryDB<{ last_date: string | null }>(
    `SELECT MAX(play_date)::text AS last_date FROM ${table}`,
  );
  return rows[0]?.last_date ?? null;
}

export async function fetchData(
  year: number,
  spillover = true,
  signal?: AbortSignal,
  region: DataRegion = "international",
): Promise<DailyRow[]> {
  const table = TABLE_BY_REGION[region];
  const columns = COLUMNS_BY_REGION[region];

  let rows: Promise<DailyRow[]>;
  let range: [string, string];
  if (spillover) {
    const jan1 = new Date(`${year}-01-01`);
    const dayOfWeek = jan1.getDay();
    const spillStart = new Date(jan1);
    spillStart.setDate(jan1.getDate() - dayOfWeek);
    const startStr = spillStart.toISOString().slice(0, 10);
    range = [startStr, `${year + 1}-01-07`];

    rows = queryDB<DailyRow>(
      `SELECT ${columns}
       FROM ${table}
       WHERE play_date >= $1::date
         AND play_date <= $2::date
       ORDER BY play_date`,
      range,
      signal,
    );
  } else {
    range = [`${year}-01-01`, `${year}-12-31`];
    rows = queryDB<DailyRow>(
      `SELECT ${columns}
       FROM ${table}
       WHERE EXTRACT(YEAR FROM play_date) = $1
       ORDER BY play_date`,
      [year],
      signal,
    );
  }
  if (region !== "international") return rows;

  const [days, tickets] = await Promise.all([rows, fetchTickets(range, signal)]);
  for (const day of days) {
    const logged = tickets.get(day.play_date);
    if (logged) day.tickets = logged;
  }
  return days;
}

/** Ticket counts per date and game. Missing ticket data must not hide play data. */
async function fetchTickets(
  [start, end]: [string, string],
  signal?: AbortSignal,
): Promise<Map<string, Partial<Record<Game, number>>>> {
  const byDate = new Map<string, Partial<Record<Game, number>>>();
  try {
    const rows = await queryDB<{ play_date: string; game: Game; tickets: number }>(
      `SELECT play_date::text, game, SUM(count)::int AS tickets
       FROM daily_ticket
       WHERE play_date >= $1::date AND play_date <= $2::date AND count > 0
       GROUP BY play_date, game`,
      [start, end],
      signal,
    );
    for (const row of rows)
      byDate.set(row.play_date, { ...byDate.get(row.play_date), [row.game]: Number(row.tickets) });
  } catch {
    // The table is created by scraper/init.sql; before it exists, show plays only.
  }
  return byDate;
}
