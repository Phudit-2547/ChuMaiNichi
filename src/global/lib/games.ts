export type Game = "maimai" | "chunithm";

export const GAME_ACCENT: Record<Game, string> = {
  maimai: "#ff69aa",
  chunithm: "#3d67e3",
};

export const GAME_LABELS: Record<Game, string> = {
  maimai: "maimai",
  chunithm: "CHUNITHM",
};
