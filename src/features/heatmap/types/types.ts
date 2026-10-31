import type { Game } from "../../../global/lib/games";
import type { DataRegion } from "../../../global/lib/regions";

export type { DataRegion, Game };

export type HeatmapGame = Game | "ongeki";

export interface DailyRow {
  play_date: string;
  scrape_failed?: boolean;
  failure_reason?: string | null;
  maimai_play_count: number | null;
  chunithm_play_count: number | null;
  ongeki_track_count?: number;
  inferred_games?: HeatmapGame[];
  /** Japan: "obsidian_journal" for imported days, "manual" for days logged in the day editor. */
  source?: string;
  maimai_rating?: number | null;
  chunithm_rating?: number | null;
  tickets?: Partial<Record<Game, number>>;
}

export interface HeatmapStats {
  today: number;
  total: number;
  thisWeek: number;
  currentStreak: number;
  longestStreak: number;
}
