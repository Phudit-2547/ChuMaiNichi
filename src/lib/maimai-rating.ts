/**
 * Maimai DX rating calculation.
 * Ported from Chunimai_dashboard/public/js/rating.js
 */

// --- Types ---

export interface DifficultyData {
  level: string;
  constant: number;
}

export interface SongData {
  title: string;
  artist?: string;
  image?: string;
  chartType: string; // "dx" | "std"
  releaseDate?: string;
  releasedVersion?: string;
  basic?: DifficultyData;
  advanced?: DifficultyData;
  expert?: DifficultyData;
  master?: DifficultyData;
  remaster?: DifficultyData;
}

export interface PlayerSong {
  title: string;
  chartType: string;
  difficulty: string;
  score?: number;
  [key: string]: unknown;
}

export interface PlayerData {
  profile?: Record<string, unknown>;
  best?: PlayerSong[];
  current?: PlayerSong[];
  allRecords?: PlayerSong[];
}

export interface RankInfo {
  rankName: string;
  pct: number;
}

export interface NextRank {
  rankName: string;
  minScore: number;
}

export interface RatedSong extends PlayerSong {
  rating: number;
}

export interface RatingBreakdown {
  rating: { total: number; bestSum: number; currentSum: number };
  best: RatedSong[];
  current: RatedSong[];
}

// --- Constants ---

const DIFFICULTIES = [
  "basic",
  "advanced",
  "expert",
  "master",
  "remaster",
] as const;

/** [minScore, factor, rankName] — ordered high to low */
export const RANK_FACTORS: readonly [number, number, string][] = [
  [1005000, 0.224, "SSS+"],
  [1000000, 0.216, "SSS"],
  [995000, 0.211, "SS+"],
  [990000, 0.208, "SS"],
  [980000, 0.203, "S+"],
  [970000, 0.200, "S"],
  [940000, 0.168, "AAA"],
  [900000, 0.152, "AA"],
  [800000, 0.136, "A"],
];

export const COVER_BASE_URL =
  "https://maimai.wonderhoy.me/api/imageProxy?img=";

// --- Functions ---

export function getCoverUrl(imageFilename: string): string {
  if (!imageFilename) return "";
  return `${COVER_BASE_URL}${imageFilename}`;
}

export function getRankInfo(score: number): RankInfo {
  let rankName = "Below A";
  const pct = score / 10000;
  for (const [minScore, , name] of RANK_FACTORS) {
    if (score >= minScore) {
      rankName = name;
      break;
    }
  }
  return { rankName, pct };
}

function getRankFactor(score: number): number {
  for (const [minScore, factor] of RANK_FACTORS) {
    if (score >= minScore) return factor;
  }
  return 0.0;
}

export function getNextRank(score: number): NextRank {
  let currentIdx = -1;
  for (let i = 0; i < RANK_FACTORS.length; i++) {
    if (score >= RANK_FACTORS[i][0]) {
      currentIdx = i;
      break;
    }
  }
  if (currentIdx > 0) {
    const [nextMinScore, , nextName] = RANK_FACTORS[currentIdx - 1];
    return { rankName: nextName, minScore: nextMinScore };
  }
  return { rankName: "SSS+", minScore: 1005000 };
}

/**
 * Calculate rating for a single song.
 * rating = trunc(constant * achievement * factor)
 * Achievement capped at 100.5% for SSS+.
 */
export function calculateSongRating(constant: number, score: number): number {
  let achievement: number;
  let factor: number;
  if (score >= 1005000) {
    achievement = 100.5;
    factor = 0.224;
  } else {
    achievement = score / 10000;
    factor = getRankFactor(score);
  }
  return Math.trunc(constant * achievement * factor);
}

/** Key format: "title|chartType|difficulty" */
export function makeKey(
  title: string,
  chartType: string,
  difficulty: string,
): string {
  return `${title}|${chartType}|${difficulty}`;
}

/** Build constants lookup from musicData. */
function buildConstantsMap(allSongs: SongData[]): Map<string, number> {
  const constants = new Map<string, number>();
  for (const song of allSongs) {
    for (const diff of DIFFICULTIES) {
      const d = song[diff];
      if (d) {
        constants.set(makeKey(song.title, song.chartType, diff), d.constant || 0);
      }
    }
  }
  return constants;
}

/**
 * Calculate full rating breakdown locally.
 * Replaces the external API call to maimai.wonderhoy.me/api/calcRating.
 */
export function calcRating(
  playerData: PlayerData,
  allSongs: SongData[],
): RatingBreakdown {
  const constants = buildConstantsMap(allSongs);

  const best: RatedSong[] = (playerData.best || []).map((song) => {
    const key = makeKey(song.title, song.chartType, song.difficulty);
    const constant = constants.get(key) || 0;
    const rating =
      constant > 0 ? calculateSongRating(constant, song.score || 0) : 0;
    return { ...song, rating };
  });

  const current: RatedSong[] = (playerData.current || []).map((song) => {
    const key = makeKey(song.title, song.chartType, song.difficulty);
    const constant = constants.get(key) || 0;
    const rating =
      constant > 0 ? calculateSongRating(constant, song.score || 0) : 0;
    return { ...song, rating };
  });

  const bestSum = best.reduce((sum, s) => sum + s.rating, 0);
  const currentSum = current.reduce((sum, s) => sum + s.rating, 0);

  return {
    rating: { total: bestSum + currentSum, bestSum, currentSum },
    best,
    current,
  };
}
