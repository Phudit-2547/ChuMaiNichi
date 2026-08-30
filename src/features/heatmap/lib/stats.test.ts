import { describe, expect, it } from "vitest";
import type { DailyRow } from "../types/types";
import { computeStats } from "./stats";

describe("computeStats", () => {
  it("counts ONGEKI tracks and track-day streaks", () => {
    const rows: DailyRow[] = [
      {
        play_date: "2024-01-01",
        maimai_play_count: 0,
        chunithm_play_count: 0,
        ongeki_track_count: 2,
      },
      {
        play_date: "2024-01-02",
        maimai_play_count: 0,
        chunithm_play_count: 0,
        ongeki_track_count: 3,
      },
      {
        play_date: "2024-01-03",
        maimai_play_count: 0,
        chunithm_play_count: 0,
        ongeki_track_count: 0,
      },
      {
        play_date: "2024-01-04",
        maimai_play_count: 0,
        chunithm_play_count: 0,
        ongeki_track_count: 1,
      },
    ];

    const stats = computeStats(rows, "ongeki", 2024);

    expect(stats.total).toBe(6);
    expect(stats.longestStreak).toBe(2);
  });

  it("treats a missing optional track count as zero", () => {
    const rows: DailyRow[] = [
      {
        play_date: "2024-01-01",
        maimai_play_count: 1,
        chunithm_play_count: 1,
      },
    ];

    expect(computeStats(rows, "ongeki", 2024).total).toBe(0);
  });
});
