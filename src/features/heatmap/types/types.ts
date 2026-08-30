import type { Game } from "../../../global/lib/games";
import type { DataRegion } from "../../../global/lib/regions";

export type { DataRegion, Game };

export type HeatmapGame = Game | "ongeki";

export interface DailyRow {
  play_date: string;
  maimai_play_count: number;
  chunithm_play_count: number;
  ongeki_track_count?: number;
  inferred_games?: HeatmapGame[];
  maimai_rating?: number | null;
  chunithm_rating?: number | null;
}

export interface HeatmapStats {
  today: number;
  total: number;
  thisWeek: number;
  currentStreak: number;
  longestStreak: number;
}
