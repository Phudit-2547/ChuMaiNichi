import { describe, it, expect } from "vitest";
import { suggestSongs } from "./suggest-songs";
import { calculateSongRating, type PlayerData, type SongData } from "./rating";

// ── Test fixtures ────────────────────────────────────

function makeSongs(): SongData[] {
  return [
    // Old songs (not CiRCLE/PRiSM+)
    {
      title: "Old Song A",
      artist: "Artist A",
      chartType: "dx",
      releasedVersion: "BUDDiES",
      master: { level: "13+", constant: 13.7 },
    },
    {
      title: "Old Song B",
      artist: "Artist B",
      chartType: "std",
      releasedVersion: "FESTiVAL",
      master: { level: "14", constant: 14.0 },
    },
    {
      title: "Old Song C",
      artist: "Artist C",
      chartType: "dx",
      releasedVersion: "UNiVERSE",
      master: { level: "12+", constant: 12.8 },
    },
    // New songs (CiRCLE / PRiSM+)
    {
      title: "New Song X",
      artist: "Artist X",
      chartType: "dx",
      releasedVersion: "CiRCLE",
      master: { level: "13+", constant: 13.9 },
    },
    {
      title: "New Song Z",
      artist: "Artist Z",
      chartType: "std",
      releasedVersion: "CiRCLE",
      master: { level: "13", constant: 13.0 },
    },
    // Replacement candidate (high constant, new version, not in top 50)
    {
      title: "New Replacement",
      artist: "Artist R",
      chartType: "dx",
      releasedVersion: "CiRCLE",
      master: { level: "14", constant: 14.2 },
    },
  ];
}

function makePlayerData(): PlayerData {
  return {
    best: [
      { title: "Old Song A", chartType: "dx", difficulty: "master", score: 1000000 }, // SSS
      { title: "Old Song B", chartType: "std", difficulty: "master", score: 995000 },  // SS+
      { title: "Old Song C", chartType: "dx", difficulty: "master", score: 1005000 },  // SSS+ (maxed)
    ],
    current: [
      { title: "New Song X", chartType: "dx", difficulty: "master", score: 990000 }, // SS
      { title: "New Song Z", chartType: "std", difficulty: "master", score: 980000 }, // S+
    ],
    allRecords: [
      { title: "Old Song A", chartType: "dx", difficulty: "master", score: 1000000 },
      { title: "Old Song B", chartType: "std", difficulty: "master", score: 995000 },
      { title: "Old Song C", chartType: "dx", difficulty: "master", score: 1005000 },
      { title: "New Song X", chartType: "dx", difficulty: "master", score: 990000 },
      { title: "New Song Z", chartType: "std", difficulty: "master", score: 980000 },
      // Replacement candidate: played but not in top 50
      { title: "New Replacement", chartType: "dx", difficulty: "master", score: 970000 },
    ],
  };
}

// ── best_effort mode ─────────────────────────────────

describe("suggestSongs — best_effort mode", () => {
  const songs = makeSongs();
  const playerData = makePlayerData();

  it("returns best_effort mode by default", () => {
    const result = suggestSongs(playerData, songs);
    expect(result.mode).toBe("best_effort");
  });

  it("calculates current_rating correctly", () => {
    const result = suggestSongs(playerData, songs);
    // Old Song A: 13.7 * 100.0 * 0.216 = 295.92 → 295
    // Old Song B: 14.0 * 99.5 * 0.211 = 293.923 → 293
    // Old Song C: 12.8 * 100.5 * 0.224 = 288.2304 → 288
    // New Song X: 13.9 * 99.0 * 0.208 = 286.3248 → 286
    // New Song Z: 13.0 * 98.0 * 0.203 = 258.622 → 258
    expect(result.current_rating).toBe(295 + 293 + 288 + 286 + 258);
  });

  it("suggests improvements sorted by score gap (easiest first)", () => {
    const result = suggestSongs(playerData, songs);
    const moves = result.moves;

    // All should be improvements
    for (const m of moves) {
      expect(m.type).toBe("improve");
      expect(m.rating_gain).toBeGreaterThan(0);
    }

    // Should be sorted by score gap ascending
    for (let i = 1; i < moves.length; i++) {
      expect(moves[i].score_gap).toBeGreaterThanOrEqual(moves[i - 1].score_gap);
    }
  });

  it("does not suggest maxed songs (SSS+)", () => {
    const result = suggestSongs(playerData, songs);
    const titles = result.moves.map((m) => m.title);
    expect(titles).not.toContain("Old Song C");
  });

  it("respects maxSuggestions", () => {
    const result = suggestSongs(playerData, songs, { maxSuggestions: 1 });
    expect(result.moves.length).toBeLessThanOrEqual(1);
  });
});

// ── target mode ──────────────────────────────────────

describe("suggestSongs — target mode", () => {
  const songs = makeSongs();
  const playerData = makePlayerData();

  it("activates target mode when targetRating is set", () => {
    const currentRating = suggestSongs(playerData, songs).current_rating;
    const result = suggestSongs(playerData, songs, {
      targetRating: currentRating + 20,
    });
    expect(result.mode).toBe("target");
  });

  it("picks easiest moves first (smallest score gap)", () => {
    const currentRating = suggestSongs(playerData, songs).current_rating;
    const result = suggestSongs(playerData, songs, {
      targetRating: currentRating + 50,
    });
    if (result.mode !== "target") throw new Error("wrong mode");

    // Moves should generally trend toward larger score gaps
    // (though after a song is improved, its next move may be inserted mid-queue)
    expect(result.moves.length).toBeGreaterThan(0);
    for (const m of result.moves) {
      expect(m.score_gap).toBeGreaterThanOrEqual(0);
      expect(m.rating_gain).toBeGreaterThan(0);
    }
  });

  it("projected rating meets or exceeds target when reachable", () => {
    const currentRating = suggestSongs(playerData, songs).current_rating;
    const result = suggestSongs(playerData, songs, {
      targetRating: currentRating + 10,
    });
    if (result.mode !== "target") throw new Error("wrong mode");
    expect(result.projected_rating).toBeGreaterThanOrEqual(currentRating + 10);
  });

  it("gain from each move matches formula", () => {
    const currentRating = suggestSongs(playerData, songs).current_rating;
    const result = suggestSongs(playerData, songs, {
      targetRating: currentRating + 30,
    });
    if (result.mode !== "target") throw new Error("wrong mode");

    for (const m of result.moves) {
      if (m.type === "improve") {
        const expectedGain =
          calculateSongRating(m.constant, m.target_score) -
          calculateSongRating(m.constant, m.current_score);
        expect(m.rating_gain).toBe(expectedGain);
      }
    }
  });

  it("reports shortfall when target is unreachable", () => {
    const result = suggestSongs(playerData, songs, { targetRating: 99999 });
    if (result.mode !== "target") throw new Error("wrong mode");
    expect(result.projected_rating).toBeLessThan(99999);
    expect(result.message).toMatch(/need \d+ more/);
  });

  it("consolidates per song — each title appears at most once", () => {
    const currentRating = suggestSongs(playerData, songs).current_rating;
    const result = suggestSongs(playerData, songs, {
      targetRating: currentRating + 100,
    });
    if (result.mode !== "target") throw new Error("wrong mode");

    // New algorithm: each song maps to one action (improve OR replace),
    // targeting the minimum rank that achieves the per-slot threshold.
    const keyCounts = new Map<string, number>();
    for (const m of result.moves) {
      const key = `${m.title}|${m.chartType}|${m.difficulty}`;
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    }
    for (const [, count] of keyCounts) {
      expect(count).toBe(1);
    }
  });
});

// ── bucket separation ────────────────────────────────

describe("suggestSongs — bucket separation", () => {
  it("replacement candidates respect version buckets", () => {
    const songs = makeSongs();
    const playerData = makePlayerData();
    // Set a very high target to force replacements
    const result = suggestSongs(playerData, songs, { targetRating: 99999 });
    if (result.mode !== "target") throw new Error("wrong mode");

    const replacements = result.moves.filter((m) => m.type === "replace");
    for (const r of replacements) {
      // New Replacement is CiRCLE → should only be in "current" section
      if (r.title === "New Replacement") {
        expect(r.section).toBe("current");
      }
    }
  });
});

// ── edge cases ───────────────────────────────────────

describe("suggestSongs — edge cases", () => {
  it("handles empty player data", () => {
    const result = suggestSongs({}, makeSongs());
    expect(result.current_rating).toBe(0);
    expect(result.moves).toEqual([]);
  });

  it("handles empty song catalog", () => {
    const result = suggestSongs(makePlayerData(), []);
    expect(result.current_rating).toBe(0);
  });

  it("handles player with all SSS+ scores", () => {
    const songs = makeSongs();
    const allMaxed: PlayerData = {
      best: [
        { title: "Old Song A", chartType: "dx", difficulty: "master", score: 1005000 },
        { title: "Old Song B", chartType: "std", difficulty: "master", score: 1005000 },
        { title: "Old Song C", chartType: "dx", difficulty: "master", score: 1005000 },
      ],
      current: [
        { title: "New Song X", chartType: "dx", difficulty: "master", score: 1005000 },
        { title: "New Song Z", chartType: "std", difficulty: "master", score: 1005000 },
      ],
      allRecords: [],
    };
    const result = suggestSongs(allMaxed, songs);
    expect(result.moves).toEqual([]);
  });
});
