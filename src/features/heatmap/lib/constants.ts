import type { DailyRow, HeatmapGame } from "../types/types";

export {
  ACTIVITY_UNIT,
  GAME_ACCENT,
  GAME_LABELS,
  JAPAN_GAMES,
} from "../../../global/lib/games";

export const HEATMAP_COLORS: Record<HeatmapGame, string[]> = {
  maimai: [
    "var(--heatmap-maimai-0)",
    "var(--heatmap-maimai-1)",
    "var(--heatmap-maimai-2)",
    "var(--heatmap-maimai-3)",
    "var(--heatmap-maimai-4)",
  ],
  chunithm: [
    "var(--heatmap-chunithm-0)",
    "var(--heatmap-chunithm-1)",
    "var(--heatmap-chunithm-2)",
    "var(--heatmap-chunithm-3)",
    "var(--heatmap-chunithm-4)",
  ],
  ongeki: [
    "var(--heatmap-ongeki-0)",
    "var(--heatmap-ongeki-1)",
    "var(--heatmap-ongeki-2)",
    "var(--heatmap-ongeki-3)",
    "var(--heatmap-ongeki-4)",
  ],
};

export const PLAY_KEY: Record<HeatmapGame, keyof DailyRow> = {
  maimai: "maimai_play_count",
  chunithm: "chunithm_play_count",
  ongeki: "ongeki_track_count",
};

export const RATING_KEY: Partial<Record<HeatmapGame, keyof DailyRow>> = {
  maimai: "maimai_rating",
  chunithm: "chunithm_rating",
};
