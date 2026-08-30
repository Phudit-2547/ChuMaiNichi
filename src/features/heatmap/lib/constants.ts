import {
  GAME_ACCENT as CORE_GAME_ACCENT,
  GAME_LABELS as CORE_GAME_LABELS,
} from "../../../global/lib/games";
import type { DailyRow, HeatmapGame } from "../types/types";

export const JAPAN_GAMES: HeatmapGame[] = ["maimai", "chunithm", "ongeki"];

export const GAME_ACCENT: Record<HeatmapGame, string> = {
  ...CORE_GAME_ACCENT,
  ongeki: "var(--ongeki)",
};

export const GAME_LABELS: Record<HeatmapGame, string> = {
  ...CORE_GAME_LABELS,
  ongeki: "ONGEKI",
};

export const ACTIVITY_UNIT: Record<HeatmapGame, "play" | "track"> = {
  maimai: "play",
  chunithm: "play",
  ongeki: "track",
};

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
