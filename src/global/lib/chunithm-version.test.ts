import { describe, expect, it } from "vitest";
import { APP_CONFIG } from "./config";

describe("chunithm version config", () => {
  it("uses Mate for the scraper", () => {
    expect(APP_CONFIG.game_versions.chunithm.scraper).toBe("Mate");
  });
});
