import type { DailyRow, Game } from "../types/types";

export { GAME_ACCENT } from "../../../global/lib/games";

export const HEATMAP_COLORS: Record<Game, string[]> = {
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
};

export const PLAY_KEY: Record<Game, keyof DailyRow> = {
  maimai: "maimai_play_count",
  chunithm: "chunithm_play_count",
};

export const RATING_KEY: Record<Game, keyof DailyRow> = {
  maimai: "maimai_rating",
  chunithm: "chunithm_rating",
};
