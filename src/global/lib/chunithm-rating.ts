/**
 * CHUNITHM play rating calculation.
 *
 * Formula ported from chuni-penguin's calculation/rating.py.
 * CHUNITHM chart rating is a 2-decimal play rating, not a maimai-style
 * integer slot contribution.
 */

// --- Types ---

export interface RankInfo {
  rankName: string;
  minScore: number;
}

export interface NextRank {
  rankName: string;
  minScore: number;
}

// --- Constants ---

export const MAX_SCORE = 1_010_000;
export const RATING_CAP_SCORE = 1_009_000;

/** [minScore, rankName] - ordered high to low */
export const RANK_THRESHOLDS: readonly [number, string][] = [
  [1_009_000, "SSS+"],
  [1_007_500, "SSS"],
  [1_005_000, "SS+"],
  [1_000_000, "SS"],
  [990_000, "S+"],
  [975_000, "S"],
  [950_000, "AAA"],
  [925_000, "AA"],
  [900_000, "A"],
  [800_000, "BBB"],
  [700_000, "BB"],
  [600_000, "B"],
  [500_000, "C"],
  [0, "D"],
];

// --- Helpers ---

function levelToUnits(internalLevel: number | null | undefined): number {
  if (internalLevel == null || !Number.isFinite(internalLevel)) return 0;
  return Math.trunc(internalLevel * 10_000 + Number.EPSILON);
}

function twoDecimalRatingToUnits(rating: number): number {
  return Math.round(rating * 100) * 100;
}

function floorRatingUnitsToTwoDecimals(units: number): number {
  return Math.floor(units / 100) / 100;
}

function roundScoreToNearest(value: number, nearest: number): number {
  const scaled = value / nearest;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;

  if (fraction < 0.5) return lower * nearest;
  if (fraction > 0.5) return (lower + 1) * nearest;

  return (lower % 2 === 0 ? lower : lower + 1) * nearest;
}

// --- Functions ---

export function getRankInfo(score: number): RankInfo {
  for (const [minScore, rankName] of RANK_THRESHOLDS) {
    if (score >= minScore) return { rankName, minScore };
  }
  return { rankName: "D", minScore: 0 };
}

export function getNextRank(score: number): NextRank {
  const currentIdx = RANK_THRESHOLDS.findIndex(([minScore]) => score >= minScore);
  if (currentIdx <= 0) return { rankName: "SSS+", minScore: RATING_CAP_SCORE };

  const [minScore, rankName] = RANK_THRESHOLDS[currentIdx - 1];
  return { rankName, minScore };
}

/**
 * Calculate the raw CHUNITHM rating units before the final 2-decimal floor.
 * 1.0000 rating point is represented as 10000 units.
 */
export function calculateWholeRating(
  score: number,
  internalLevel: number | null | undefined,
): number {
  const il10000 = levelToUnits(internalLevel);

  if (score >= 1_009_000) {
    return il10000 + 21_500;
  }
  if (score >= 1_007_500) {
    return il10000 + 20_000 + (score - 1_007_500);
  }
  if (score >= 1_005_000) {
    return il10000 + 15_000 + (score - 1_005_000) * 2;
  }
  if (score >= 1_000_000) {
    return il10000 + 10_000 + (score - 1_000_000);
  }
  if (score >= 975_000) {
    return Math.trunc(il10000 + ((score - 975_000) * 2) / 5);
  }
  if (score >= 900_000) {
    const effectiveIl10000 = Math.max(il10000 - 50_000, 0);
    return Math.trunc(
      effectiveIl10000 +
        ((score - 900_000) / 75_000) * (il10000 - effectiveIl10000),
    );
  }
  if (score >= 800_000) {
    const effectiveIl10000 = Math.max(il10000 - 50_000, 0);
    return Math.trunc(
      effectiveIl10000 / 2 +
        ((score - 800_000) / 100_000) * (effectiveIl10000 / 2),
    );
  }
  if (score >= 500_000) {
    const effectiveIl10000 = Math.max(il10000 - 50_000, 0);
    return Math.trunc(((score - 500_000) / 300_000) * (effectiveIl10000 / 2));
  }

  return 0;
}

export function calculatePlayRating(
  score: number,
  internalLevel: number | null | undefined,
): number {
  return floorRatingUnitsToTwoDecimals(calculateWholeRating(score, internalLevel));
}

/** Same argument order as maimai-rating.calculateSongRating: constant first, score second. */
export function calculateSongRating(internalLevel: number, score: number): number {
  return calculatePlayRating(score, internalLevel);
}

/**
 * Calculate the score required to reach a target play rating on a chart.
 * Returns null if the target rating is above the chart's rating cap.
 */
export function calculateScoreForRating(
  targetRating: number,
  internalLevel: number,
): number | null {
  const rating10000 = twoDecimalRatingToUnits(targetRating);

  if (rating10000 < 0) return null;
  if (rating10000 === 0) return 0;

  const il10000 = twoDecimalRatingToUnits(internalLevel);
  const subSIl10000 = Math.max(il10000 - 50_000, 0);
  const coeff = rating10000 - il10000;

  let requiredScore: number | null = null;

  if (coeff > 21_500) {
    requiredScore = null;
  } else if (coeff >= 20_000) {
    requiredScore = 1_007_500 + coeff - 20_000;
  } else if (coeff >= 15_000) {
    requiredScore = 1_005_000 + (coeff - 15_000) / 2;
  } else if (coeff >= 10_000) {
    requiredScore = 1_000_000 + (coeff - 10_000);
  } else if (coeff >= 0) {
    requiredScore = 975_000 + (coeff * 5) / 2;
  } else if (rating10000 >= subSIl10000) {
    requiredScore =
      ((rating10000 - subSIl10000) / (il10000 - subSIl10000)) * 75_000 +
      900_000;
  } else if (subSIl10000 > 0 && rating10000 >= subSIl10000 / 2) {
    requiredScore = ((rating10000 * 2) / subSIl10000 - 1) * 100_000 + 800_000;
  } else if (subSIl10000 > 0) {
    requiredScore = ((rating10000 * 2) / subSIl10000) * 300_000 + 500_000;
  }

  if (requiredScore == null) return null;
  return roundScoreToNearest(Math.trunc(requiredScore), 50);
}
