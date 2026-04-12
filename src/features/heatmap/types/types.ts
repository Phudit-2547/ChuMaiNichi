export interface DailyRow {
  play_date: string;
  maimai_play_count: number;
  chunithm_play_count: number;
  maimai_rating: number | null;
  chunithm_rating: number | null;
}

export type Game = "maimai" | "chunithm";

export interface HeatmapStats {
  total: number;
  thisWeek: number;
  currentStreak: number;
  longestStreak: number;
}
