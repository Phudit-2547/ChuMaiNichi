import { queryDB } from "../../../global/lib/api";
import type { DailyRow, DataRegion } from "../types/types";

const TABLE_BY_REGION: Record<DataRegion, string> = {
  international: "daily_play",
  japan: "japan_daily_play",
};

const COLUMNS_BY_REGION: Record<DataRegion, string> = {
  international: `play_date::text, maimai_play_count, chunithm_play_count,
                  maimai_rating, chunithm_rating`,
  japan: `play_date::text, maimai_play_count, chunithm_play_count,
          ongeki_track_count, inferred_games`,
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

  if (spillover) {
    const jan1 = new Date(`${year}-01-01`);
    const dayOfWeek = jan1.getDay();
    const spillStart = new Date(jan1);
    spillStart.setDate(jan1.getDate() - dayOfWeek);
    const startStr = spillStart.toISOString().slice(0, 10);

    return queryDB<DailyRow>(
      `SELECT ${columns}
       FROM ${table}
       WHERE play_date >= $1::date
         AND play_date <= $2::date
       ORDER BY play_date`,
      [startStr, `${year + 1}-01-07`],
      signal,
    );
  } else {
    return queryDB<DailyRow>(
      `SELECT ${columns}
       FROM ${table}
       WHERE EXTRACT(YEAR FROM play_date) = $1
       ORDER BY play_date`,
      [year],
      signal,
    );
  }
}
