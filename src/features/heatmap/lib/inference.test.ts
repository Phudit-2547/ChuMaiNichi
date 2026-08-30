import { describe, expect, it } from "vitest";
import type { DailyRow } from "../types/types";
import { getInferredDates, timestampToDateKey } from "./inference";

const rows: DailyRow[] = [
  {
    play_date: "2026-06-01",
    maimai_play_count: 1,
    chunithm_play_count: 0,
    ongeki_track_count: 0,
    inferred_games: ["maimai"],
  },
  {
    play_date: "2026-06-06",
    maimai_play_count: 4,
    chunithm_play_count: 0,
    ongeki_track_count: 12,
    inferred_games: ["maimai", "ongeki"],
  },
];

describe("Japan inference markers", () => {
  it("marks only dates inferred for the selected game", () => {
    expect([...getInferredDates(rows, "maimai")]).toEqual([
      "2026-06-01",
      "2026-06-06",
    ]);
    expect([...getInferredDates(rows, "ongeki")]).toEqual(["2026-06-06"]);
    expect([...getInferredDates(rows, "chunithm")]).toEqual([]);
  });

  it("normalizes a calendar timestamp to the database date key", () => {
    expect(timestampToDateKey(Date.UTC(2026, 5, 1))).toBe("2026-06-01");
  });
});
