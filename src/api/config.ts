import { readFileSync } from "fs";
import { join } from "path";

export function loadConfig(): { games: string[]; currency_per_play: number } {
  try {
    return JSON.parse(
      readFileSync(join(process.cwd(), "config.json"), "utf-8"),
    );
  } catch {
    return { games: ["maimai", "chunithm"], currency_per_play: 40 };
  }
}
