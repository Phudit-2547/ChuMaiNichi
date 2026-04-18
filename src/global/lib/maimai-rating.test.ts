import { describe, it, expect } from "vitest";
import {
  calculateSongRating,
  getRankInfo,
  getNextRank,
  makeKey,
  calcRating,
  getCoverUrl,
  type SongData,
  type PlayerData,
} from "./maimai-rating";

// ── calculateSongRating ──────────────────────────────

describe("calculateSongRating", () => {
  // Formula: trunc(constant * achievement * factor)
  // achievement = score / 10000, capped at 100.5 for SSS+

  it("SSS+ (1005000) with constant 14.0", () => {
    // 14.0 * 100.5 * 0.224 = 315.168 → 315
    expect(calculateSongRating(14.0, 1005000)).toBe(315);
  });

  it("SSS+ (1005000) with constant 13.4", () => {
    // 13.4 * 100.5 * 0.224 = 301.7088 → 301
    expect(calculateSongRating(13.4, 1005000)).toBe(301);
  });

  it("SSS (1000000) with constant 14.0", () => {
    // 14.0 * 100.0 * 0.216 = 302.4 → 302
    expect(calculateSongRating(14.0, 1000000)).toBe(302);
  });

  it("SS+ (995000) with constant 13.0", () => {
    // 13.0 * 99.5 * 0.211 = 272.8385 → 272
    expect(calculateSongRating(13.0, 995000)).toBe(272);
  });

  it("SS (990000) with constant 12.5", () => {
    // 12.5 * 99.0 * 0.208 = 257.4 → 257
    expect(calculateSongRating(12.5, 990000)).toBe(257);
  });

  it("S+ (980000) with constant 13.0", () => {
    // 13.0 * 98.0 * 0.203 = 258.622 → 258
    expect(calculateSongRating(13.0, 980000)).toBe(258);
  });

  it("S (970000) with constant 12.0", () => {
    // 12.0 * 97.0 * 0.200 = 232.8 → 232
    expect(calculateSongRating(12.0, 970000)).toBe(232);
  });

  it("AAA (940000) with constant 11.0", () => {
    // 11.0 * 94.0 * 0.168 = 173.7312 → 173
    expect(calculateSongRating(11.0, 940000)).toBe(173);
  });

  it("score above SSS+ caps achievement at 100.5", () => {
    // Even at 1010000, achievement is 100.5, factor 0.224
    expect(calculateSongRating(14.0, 1010000)).toBe(
      calculateSongRating(14.0, 1005000),
    );
  });

  it("score below A returns 0 (factor is 0)", () => {
    expect(calculateSongRating(13.0, 799999)).toBe(0);
  });

  it("exact A boundary (800000) with constant 10.0", () => {
    // 10.0 * 80.0 * 0.136 = 108.8 → 108
    expect(calculateSongRating(10.0, 800000)).toBe(108);
  });

  it("zero constant returns 0", () => {
    expect(calculateSongRating(0, 1005000)).toBe(0);
  });

  it("zero score returns 0", () => {
    expect(calculateSongRating(14.0, 0)).toBe(0);
  });

  it("uses Math.trunc (not round)", () => {
    // 13.7 * 100.5 * 0.224 = 308.4336 → should be 308 (trunc), not 308 (round same here)
    // Better example: 13.1 * 100.5 * 0.224 = 294.9264 → 294 (trunc, not 295)
    expect(calculateSongRating(13.1, 1005000)).toBe(294);
  });
});

// ── getRankInfo ──────────────────────────────────────

describe("getRankInfo", () => {
  it("returns SSS+ for 1005000+", () => {
    expect(getRankInfo(1005000)).toEqual({ rankName: "SSS+", pct: 100.5 });
  });

  it("returns SSS for 1000000-1004999", () => {
    expect(getRankInfo(1000000).rankName).toBe("SSS");
    expect(getRankInfo(1004999).rankName).toBe("SSS");
  });

  it("returns Below A for < 800000", () => {
    expect(getRankInfo(799999).rankName).toBe("Below A");
  });

  it("pct is score / 10000", () => {
    expect(getRankInfo(995000).pct).toBe(99.5);
    expect(getRankInfo(1005000).pct).toBe(100.5);
  });
});

// ── getNextRank ──────────────────────────────────────

describe("getNextRank", () => {
  it("SSS → SSS+", () => {
    expect(getNextRank(1000000)).toEqual({
      rankName: "SSS+",
      minScore: 1005000,
    });
  });

  it("SS+ → SSS", () => {
    expect(getNextRank(995000)).toEqual({
      rankName: "SSS",
      minScore: 1000000,
    });
  });

  it("S → AAA", () => {
    // S is at index 5, next up is S+ at index 4
    expect(getNextRank(970000)).toEqual({
      rankName: "S+",
      minScore: 980000,
    });
  });

  it("already SSS+ returns SSS+", () => {
    expect(getNextRank(1005000)).toEqual({
      rankName: "SSS+",
      minScore: 1005000,
    });
  });

  it("below A returns SSS+ (fallback)", () => {
    // currentIdx stays -1, so returns SSS+
    expect(getNextRank(700000)).toEqual({
      rankName: "SSS+",
      minScore: 1005000,
    });
  });
});

// ── makeKey ──────────────────────────────────────────

describe("makeKey", () => {
  it("joins with pipe separator", () => {
    expect(makeKey("Song A", "dx", "master")).toBe("Song A|dx|master");
  });
});

// ── calcRating ───────────────────────────────────────

describe("calcRating", () => {
  const allSongs: SongData[] = [
    {
      title: "Song A",
      chartType: "dx",
      master: { level: "14", constant: 14.0 },
    },
    {
      title: "Song B",
      chartType: "dx",
      expert: { level: "12", constant: 12.0 },
    },
  ];

  it("computes rating breakdown for best + current", () => {
    const playerData: PlayerData = {
      best: [
        { title: "Song A", chartType: "dx", difficulty: "master", score: 1005000 },
      ],
      current: [
        { title: "Song B", chartType: "dx", difficulty: "expert", score: 1000000 },
      ],
    };

    const result = calcRating(playerData, allSongs);

    // Song A: 14.0 * 100.5 * 0.224 = 315
    expect(result.best[0].rating).toBe(315);
    expect(result.rating.bestSum).toBe(315);

    // Song B: 12.0 * 100.0 * 0.216 = 259
    expect(result.current[0].rating).toBe(259);
    expect(result.rating.currentSum).toBe(259);

    expect(result.rating.total).toBe(315 + 259);
  });

  it("handles empty player data", () => {
    const result = calcRating({}, allSongs);
    expect(result.rating.total).toBe(0);
    expect(result.best).toEqual([]);
    expect(result.current).toEqual([]);
  });

  it("assigns 0 rating when constant not found", () => {
    const playerData: PlayerData = {
      best: [
        { title: "Unknown Song", chartType: "dx", difficulty: "master", score: 1005000 },
      ],
    };
    const result = calcRating(playerData, allSongs);
    expect(result.best[0].rating).toBe(0);
  });
});

// ── getCoverUrl ──────────────────────────────────────

describe("getCoverUrl", () => {
  it("returns full URL for valid filename", () => {
    expect(getCoverUrl("abc123.png")).toBe(
      "https://maimai.wonderhoy.me/api/imageProxy?img=abc123.png",
    );
  });

  it("returns empty string for empty input", () => {
    expect(getCoverUrl("")).toBe("");
  });
});
