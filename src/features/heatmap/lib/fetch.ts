import { queryDB } from "../../../global/lib/api";
import type { DailyRow } from "../types/types";

export async function fetchYears(): Promise<number[]> {
  const rows = await queryDB<{ year: number }>(
    "SELECT DISTINCT CAST(EXTRACT(YEAR FROM play_date) AS integer) AS year FROM daily_play ORDER BY year",
  );
  return rows.map((r) => r.year);
}

export async function fetchData(
  year: number,
  spillover = true,
  signal?: AbortSignal,
): Promise<DailyRow[]> {
  if (spillover) {
    const jan1 = new Date(`${year}-01-01`);
    const dayOfWeek = jan1.getDay();
    const spillStart = new Date(jan1);
    spillStart.setDate(jan1.getDate() - dayOfWeek);
    const startStr = spillStart.toISOString().slice(0, 10);

    return queryDB<DailyRow>(
      `SELECT play_date::text, maimai_play_count, chunithm_play_count,
              maimai_rating, chunithm_rating
       FROM daily_play
       WHERE play_date >= $1::date
         AND play_date <= $2::date
       ORDER BY play_date`,
      [startStr, `${year + 1}-01-07`],
      signal,
    );
  } else {
    return queryDB<DailyRow>(
      `SELECT play_date::text, maimai_play_count, chunithm_play_count,
              maimai_rating, chunithm_rating
       FROM daily_play
       WHERE EXTRACT(YEAR FROM play_date) = $1
       ORDER BY play_date`,
      [year],
      signal,
    );
  }
}
