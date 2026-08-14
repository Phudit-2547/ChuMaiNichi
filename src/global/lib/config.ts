import rawConfig from "../../../config.json";
import type { Game } from "./games";

export type { Game };

export interface AppConfig {
  games: Game[];
  game_versions: {
    maimai: {
      scraper: string;
      rating_current: string[];
    };
    chunithm: {
      scraper: string;
    };
  };
  currency_per_play: number;
}

export const APP_CONFIG = rawConfig as AppConfig;
