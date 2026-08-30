import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt";

const config = { games: ["maimai", "chunithm"], currency_per_play: 40 };

describe("buildSystemPrompt region context", () => {
  it("keeps the existing International schema by default", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("CREATE TABLE daily_play");
    expect(prompt).toContain("Currency per play: 40 THB");
    expect(prompt).not.toContain("CREATE TABLE japan_daily_play");
  });

  it("isolates Japan Journal activity from International score data", () => {
    const prompt = buildSystemPrompt(config, "japan");
    expect(prompt).toContain("query_japan_activity returns daily rows");
    expect(prompt).toContain("ONGEKI values as tracks");
    expect(prompt).toContain("never apply the International 40 THB cost");
    expect(prompt).not.toContain("CREATE TABLE user_scores");
    expect(prompt).not.toContain("Use query_database");
  });
});
