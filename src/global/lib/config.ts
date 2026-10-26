import rawConfig from "../../../config.json" with { type: "json" };
import type { Game } from "./games.js";

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
  tickets: Record<Game, TicketDef[]>;
}

export interface TicketDef {
  id: string;
  label: string;
  extra_credits: number;
}

export const APP_CONFIG = rawConfig as AppConfig;
