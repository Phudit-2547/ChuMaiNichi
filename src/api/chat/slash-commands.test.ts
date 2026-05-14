import { describe, expect, it } from "vitest";
import { getMaimaiMaxConstant, runSlashCommand } from "./slash-commands";

const BOTH_GAMES = ["maimai", "chunithm"];

describe("runSlashCommand", () => {
  it("ignores normal chat messages", () => {
    expect(runSlashCommand("show my rating", BOTH_GAMES)).toBeNull();
  });

  it("handles timestamp-prefixed CHUNITHM rating commands", () => {
    const result = runSlashCommand(
      "[2026-05-14 20:00 ICT, just now] /chuni rating 15.00",
      BOTH_GAMES,
    );
    expect(result).toContain("Score required to achieve **15.00**");
    expect(result).toContain(" 12.9 | 1008500");
    expect(result).toContain(" 15.0 |  975000");
  });

  it("calculates direct maimai chart rating", () => {
    const result = runSlashCommand("/mai rating 14.0 100.0000%", BOTH_GAMES);
    expect(result).toBe(
      "maimai DX song rating for **14.0** at **100.0000% SSS** is **302**.",
    );
  });

  it("accepts raw maimai scores for direct calculation", () => {
    const result = runSlashCommand("/maimai rating 13.4 1005000", BOTH_GAMES);
    expect(result).toContain("**100.5000% SSS+**");
    expect(result).toContain("**301**");
  });

  it("builds maimai target song-rating tables", () => {
    const result = runSlashCommand("/mai rating 300", BOTH_GAMES);
    expect(result).toContain("Score required to achieve **300** maimai song rating");
    expect(result).toContain(" 13.4 | 100.5000% | SSS+ |    301");
    expect(result).toContain(" 15.0 |  98.5222% |   S+ |    300");
    expect(result).not.toContain(" 15.1 |");
    expect(result).not.toContain(" 16.0 |");
  });

  it("respects disabled games", () => {
    expect(runSlashCommand("/chuni rating 15.00", ["maimai"])).toBe(
      "CHUNITHM is disabled in config.json.",
    );
  });

  it("rejects direct maimai chart constants above the known catalog max", () => {
    expect(runSlashCommand("/mai rating 15.1 100.5000%", BOTH_GAMES)).toBe(
      "maimai chart constant must be between 0.1 and 15.0.",
    );
  });

  it("can derive the maimai max constant from song catalog data", () => {
    expect(
      getMaimaiMaxConstant([
        { title: "A", chartType: "dx", master: { level: "14", constant: 14.9 } },
        { title: "B", chartType: "dx", remaster: { level: "15", constant: 15 } },
      ]),
    ).toBe(15);
  });
});
