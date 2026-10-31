export type Game = "maimai" | "chunithm";

/** The Japan record also counts ONGEKI, in tracks rather than plays. */
export type JapanGame = Game | "ongeki";

export const JAPAN_GAMES: JapanGame[] = ["maimai", "chunithm", "ongeki"];

export const GAME_ACCENT: Record<JapanGame, string> = {
  maimai: "var(--maimai)",
  chunithm: "var(--chunithm)",
  ongeki: "var(--ongeki)",
};

export const GAME_LABELS: Record<JapanGame, string> = {
  maimai: "maimai",
  chunithm: "CHUNITHM",
  ongeki: "ONGEKI",
};

export const ACTIVITY_UNIT: Record<JapanGame, "play" | "track"> = {
  maimai: "play",
  chunithm: "play",
  ongeki: "track",
};
