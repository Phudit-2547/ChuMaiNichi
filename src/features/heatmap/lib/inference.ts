import type { DailyRow, HeatmapGame } from "../types/types";

export const INFERENCE_NOTE = "* inferred from Journal context";

export function getInferredDates(
  data: DailyRow[],
  game: HeatmapGame,
): Set<string> {
  return new Set(
    data
      .filter((row) => row.inferred_games?.includes(game))
      .map((row) => row.play_date),
  );
}

export function timestampToDateKey(timestamp: number): string {
  // CalHeatmap normalizes ghDay cell timestamps to UTC midnight.
  return new Date(timestamp).toISOString().slice(0, 10);
}
