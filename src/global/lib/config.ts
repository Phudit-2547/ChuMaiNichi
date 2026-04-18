import rawConfig from "../../config.json";

export type Game = "maimai" | "chunithm";

export interface AppConfig {
  games: Game[];
  currency_per_play: number;
}

export const APP_CONFIG = rawConfig as AppConfig;
