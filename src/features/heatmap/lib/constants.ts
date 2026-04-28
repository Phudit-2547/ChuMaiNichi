import type { DailyRow, Game } from "../types/types";

export { GAME_ACCENT } from "../../../global/lib/games";

export const COLORS: Record<Game, string[]> = {
  maimai: ["#161b22", "#5a2040", "#8a3560", "#b84a80", "#ff69aa"],
  chunithm: ["#161b22", "#1a3066", "#254a99", "#2d59a3", "#3d67e3"],
};

export const PLAY_KEY: Record<Game, keyof DailyRow> = {
  maimai: "maimai_play_count",
  chunithm: "chunithm_play_count",
};

export const RATING_KEY: Record<Game, keyof DailyRow> = {
  maimai: "maimai_rating",
  chunithm: "chunithm_rating",
};
