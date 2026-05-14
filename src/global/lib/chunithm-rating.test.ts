import { describe, expect, it } from "vitest";
import {
  calculatePlayRating,
  calculateScoreForRating,
  calculateSongRating,
  calculateWholeRating,
  getNextRank,
  getRankInfo,
} from "./chunithm-rating";

// -- calculatePlayRating ------------------------------------------------------

describe("calculatePlayRating", () => {
  it("caps at internal level + 2.15 from 1009000 upward", () => {
    expect(calculatePlayRating(1_009_000, 15.7)).toBe(17.85);
    expect(calculatePlayRating(1_010_000, 15.7)).toBe(17.85);
  });

  it("calculates SSS and SS+ anchor ratings", () => {
    expect(calculatePlayRating(1_007_500, 15.7)).toBe(17.7);
    expect(calculatePlayRating(1_005_000, 15.7)).toBe(17.2);
  });

  it("calculates SS and S anchor ratings", () => {
    expect(calculatePlayRating(1_000_000, 15.7)).toBe(16.7);
    expect(calculatePlayRating(975_000, 15.7)).toBe(15.7);
  });

  it("interpolates linearly between SS and SS+", () => {
    expect(calculatePlayRating(1_002_500, 15.7)).toBe(16.95);
  });

  it("interpolates linearly between S and SS", () => {
    expect(calculatePlayRating(987_500, 15.7)).toBe(16.2);
  });

  it("interpolates linearly below S", () => {
    expect(calculatePlayRating(937_500, 15.7)).toBe(13.2);
    expect(calculatePlayRating(850_000, 15.7)).toBe(8.02);
    expect(calculatePlayRating(650_000, 15.7)).toBe(2.67);
  });

  it("returns 0 below 500000", () => {
    expect(calculatePlayRating(499_999, 15.7)).toBe(0);
  });

  it("keeps calculateSongRating as a constant-first alias", () => {
    expect(calculateSongRating(15.7, 1_009_000)).toBe(17.85);
  });
});

// -- calculateWholeRating -----------------------------------------------------

describe("calculateWholeRating", () => {
  it("returns raw 1/10000 rating units", () => {
    expect(calculateWholeRating(1_009_000, 15.7)).toBe(178_500);
  });
});

// -- calculateScoreForRating --------------------------------------------------

describe("calculateScoreForRating", () => {
  it("returns exact scores at formula anchors", () => {
    expect(calculateScoreForRating(17.85, 15.7)).toBe(1_009_000);
    expect(calculateScoreForRating(17.7, 15.7)).toBe(1_007_500);
    expect(calculateScoreForRating(17.2, 15.7)).toBe(1_005_000);
    expect(calculateScoreForRating(16.7, 15.7)).toBe(1_000_000);
    expect(calculateScoreForRating(15.7, 15.7)).toBe(975_000);
  });

  it("returns rounded scores for intermediate target ratings", () => {
    expect(calculateScoreForRating(16.2, 15.7)).toBe(987_500);
    expect(calculateScoreForRating(16.95, 15.7)).toBe(1_002_500);
  });

  it("returns null above chart cap", () => {
    expect(calculateScoreForRating(17.86, 15.7)).toBeNull();
  });

  it("returns 0 for target rating 0", () => {
    expect(calculateScoreForRating(0, 15.7)).toBe(0);
  });
});

// -- ranks --------------------------------------------------------------------

describe("rank helpers", () => {
  it("detects CHUNITHM rank thresholds", () => {
    expect(getRankInfo(1_009_000)).toEqual({ rankName: "SSS+", minScore: 1_009_000 });
    expect(getRankInfo(1_007_500)).toEqual({ rankName: "SSS", minScore: 1_007_500 });
    expect(getRankInfo(990_000)).toEqual({ rankName: "S+", minScore: 990_000 });
    expect(getRankInfo(499_999)).toEqual({ rankName: "D", minScore: 0 });
  });

  it("returns next rank thresholds", () => {
    expect(getNextRank(1_000_000)).toEqual({ rankName: "SS+", minScore: 1_005_000 });
    expect(getNextRank(990_000)).toEqual({ rankName: "SS", minScore: 1_000_000 });
    expect(getNextRank(1_009_000)).toEqual({ rankName: "SSS+", minScore: 1_009_000 });
  });
});
