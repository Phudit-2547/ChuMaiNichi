export type Game = "maimai" | "chunithm";

export const GAME_ACCENT: Record<Game, string> = {
  maimai: "var(--maimai)",
  chunithm: "var(--chunithm)",
};

export const GAME_LABELS: Record<Game, string> = {
  maimai: "maimai",
  chunithm: "CHUNITHM",
};
