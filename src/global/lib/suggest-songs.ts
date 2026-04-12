/**
 * Song suggestion tool for improving maimai DX rating.
 *
 * Algorithm (target mode):
 * 1. threshold = ceil(target_rating / slotCount)  — rating needed per song slot
 *    (slotCount = best.length + current.length, typically 50)
 * 2. min_constant = smallest chart constant where SSS+ rating >= threshold
 * 3. For each song in top slots:
 *    - constant < min_constant → REPLACE (can't reach threshold even at SSS+)
 *    - current_rating < threshold → IMPROVE to min rank that achieves threshold
 *    - current_rating >= threshold → KEEP (no action)
 * 4. For replacements: pick from allRecords with constant >= min_constant,
 *    sorted by lowest constant first (easiest chart), respecting version buckets.
 *    Each replacement targets the min rank that achieves threshold.
 * 5. Display actions sorted by score_gap ascending (easiest grind first).
 */
import {
  RANK_FACTORS,
  getCoverUrl,
  getRankInfo,
  getNextRank,
  calculateSongRating,
  calcRating,
  makeKey,
  type PlayerData,
  type PlayerSong,
  type SongData,
} from "./rating";

// --- Types ---

export interface SuggestOptions {
  targetRating?: number | null;
  mode?: "auto" | "target" | "best_effort";
  maxSuggestions?: number;
}

export interface SuggestedMove {
  title: string;
  artist: string;
  chartType: string;
  difficulty: string;
  level: string;
  constant: number;
  image: string;
  cover_url: string;
  current_score: number;
  current_rank: string;
  current_pct: string;
  current_rating: number;
  target_score: number;
  target_rank: string;
  target_pct: string;
  target_rating: number;
  score_gap: number;
  rating_gain: number;
  max_rating: number;
  section: "best" | "current";
  type: "improve" | "replace";
  /** For replacements: the song being replaced */
  replaces_title?: string;
  replaces_rating?: number;
}

export interface TargetResult {
  mode: "target";
  current_rating: number;
  target_rating: number;
  rating_needed: number;
  moves: SuggestedMove[];
  projected_rating: number;
  message: string;
}

export interface BestEffortResult {
  mode: "best_effort";
  current_rating: number;
  target_rating: null;
  moves: SuggestedMove[];
  message: string;
}

export type SuggestResult = TargetResult | BestEffortResult;

// --- Helpers ---

const LATEST_VERSIONS = ["CiRCLE", "PRiSM+"];

function isNewVersion(version: string | undefined): boolean {
  return LATEST_VERSIONS.includes(version || "");
}

interface SongInfo {
  title: string;
  artist: string;
  chartType: string;
  difficulty: string;
  level: string;
  constant: number;
  image: string;
  version: string;
}

/** Look up song info from songs.json. */
function findSongInfo(
  title: string,
  chartType: string,
  difficulty: string,
  allSongs: SongData[],
): SongInfo | null {
  for (const song of allSongs) {
    if (song.title === title && song.chartType === chartType) {
      const diffData = song[difficulty as keyof SongData];
      if (diffData && typeof diffData === "object" && "constant" in diffData) {
        return {
          title: song.title,
          artist: song.artist || "",
          chartType: song.chartType,
          difficulty,
          level: diffData.level || "",
          constant: diffData.constant || 0,
          image: song.image || "",
          version: song.releasedVersion || "",
        };
      }
    }
  }
  return null;
}

// --- Internal move representation ---

interface QueueMove {
  key: string;
  songInfo: SongInfo;
  section: "best" | "current";
  current_score: number;
  target_score: number;
  target_rank: string;
  score_gap: number;
  current_rating: number;
  target_rating: number;
  rating_gain: number;
  type: "improve" | "replace";
  replaces_title?: string;
  replaces_rating?: number;
}

function buildMove(
  songInfo: SongInfo,
  section: "best" | "current",
  currentScore: number,
  targetScore: number,
  targetRank: string,
  type: "improve" | "replace",
  replacesTitle?: string,
  replacesRating?: number,
): QueueMove {
  const currentRating = calculateSongRating(songInfo.constant, currentScore);
  const targetRating = calculateSongRating(songInfo.constant, targetScore);
  return {
    key: makeKey(songInfo.title, songInfo.chartType, songInfo.difficulty),
    songInfo,
    section,
    current_score: currentScore,
    target_score: targetScore,
    target_rank: targetRank,
    score_gap: targetScore - currentScore,
    current_rating: currentRating,
    target_rating: targetRating,
    rating_gain: type === "replace"
      ? targetRating - (replacesRating ?? 0)
      : targetRating - currentRating,
    type,
    replaces_title: replacesTitle,
    replaces_rating: replacesRating,
  };
}

function moveToSuggestion(m: QueueMove): SuggestedMove {
  const { rankName: currentRank } = getRankInfo(m.current_score);
  return {
    title: m.songInfo.title,
    artist: m.songInfo.artist,
    chartType: m.songInfo.chartType,
    difficulty: m.songInfo.difficulty,
    level: m.songInfo.level,
    constant: m.songInfo.constant,
    image: m.songInfo.image,
    cover_url: getCoverUrl(m.songInfo.image),
    current_score: m.current_score,
    current_rank: currentRank,
    current_pct: (m.current_score / 10000).toFixed(4) + "%",
    current_rating: m.current_rating,
    target_score: m.target_score,
    target_rank: m.target_rank,
    target_pct: (m.target_score / 10000).toFixed(4) + "%",
    target_rating: m.target_rating,
    score_gap: m.score_gap,
    rating_gain: m.rating_gain,
    max_rating: calculateSongRating(m.songInfo.constant, 1005000),
    section: m.section,
    type: m.type,
    replaces_title: m.replaces_title,
    replaces_rating: m.replaces_rating,
  };
}

// --- Main ---

export function suggestSongs(
  playerData: PlayerData,
  allSongs: SongData[],
  options: SuggestOptions = {},
): SuggestResult {
  const {
    targetRating = null,
    mode = "auto",
    maxSuggestions = 10,
  } = options;

  const currentRating = calcRating(playerData, allSongs).rating.total;

  const isTargetMode =
    mode === "target" || (mode === "auto" && targetRating != null);

  if (isTargetMode && targetRating != null) {
    return buildTargetMode(playerData, allSongs, currentRating, targetRating);
  }

  return buildBestEffort(playerData, allSongs, currentRating, maxSuggestions);
}

// --- Best effort mode ---

function buildBestEffort(
  playerData: PlayerData,
  allSongs: SongData[],
  currentRating: number,
  maxSuggestions: number,
): BestEffortResult {
  // Collect next-rank-up moves for all improvable top-50 songs, sorted by score gap
  const moves: QueueMove[] = [];

  for (const s of playerData.best || []) {
    const info = findSongInfo(s.title, s.chartType, s.difficulty, allSongs);
    if (!info || info.constant <= 0) continue;
    const score = s.score || 0;
    if (score >= 1005000) continue;
    const nextRank = getNextRank(score);
    const m = buildMove(info, "best", score, nextRank.minScore, nextRank.rankName, "improve");
    if (m.rating_gain > 0) moves.push(m);
  }

  for (const s of playerData.current || []) {
    const info = findSongInfo(s.title, s.chartType, s.difficulty, allSongs);
    if (!info || info.constant <= 0) continue;
    const score = s.score || 0;
    if (score >= 1005000) continue;
    const nextRank = getNextRank(score);
    const m = buildMove(info, "current", score, nextRank.minScore, nextRank.rankName, "improve");
    if (m.rating_gain > 0) moves.push(m);
  }

  moves.sort((a, b) => a.score_gap - b.score_gap);

  return {
    mode: "best_effort",
    current_rating: currentRating,
    target_rating: null,
    moves: moves.slice(0, maxSuggestions).map(moveToSuggestion),
    message: `Found ${moves.length} possible improvements sorted by easiest score gap`,
  };
}

// --- Target mode ---

/** Find smallest constant (0.1 increments) where SSS+ rating >= threshold. */
function findMinConstant(threshold: number): number {
  for (let cx10 = 10; cx10 <= 160; cx10++) {
    const c = cx10 / 10;
    if (calculateSongRating(c, 1005000) >= threshold) return c;
  }
  return 0;
}

/** Find lowest rank (by score) where this song reaches the threshold rating. */
function findMinRankForThreshold(
  constant: number,
  threshold: number,
): { score: number; rankName: string } | null {
  // RANK_FACTORS is ordered high→low, so iterate in reverse (low→high)
  for (let i = RANK_FACTORS.length - 1; i >= 0; i--) {
    const [minScore, , rankName] = RANK_FACTORS[i];
    if (calculateSongRating(constant, minScore) >= threshold) {
      return { score: minScore, rankName };
    }
  }
  // Check SSS+ cap (1005000)
  if (calculateSongRating(constant, 1005000) >= threshold) {
    return { score: 1005000, rankName: "SSS+" };
  }
  return null;
}

function buildTargetMode(
  playerData: PlayerData,
  allSongs: SongData[],
  currentRating: number,
  targetRating: number,
): TargetResult {
  // Already at target
  if (currentRating >= targetRating) {
    return {
      mode: "target",
      current_rating: currentRating,
      target_rating: targetRating,
      rating_needed: 0,
      moves: [],
      projected_rating: currentRating,
      message: `Already at or above target ${targetRating}.`,
    };
  }

  // Use actual slot count so the algorithm works for partial player data too.
  // For real maimai players this is always 50 (35 best + 15 current).
  const slotCount =
    (playerData.best?.length || 0) + (playerData.current?.length || 0);

  if (slotCount === 0) {
    return {
      mode: "target",
      current_rating: currentRating,
      target_rating: targetRating,
      rating_needed: targetRating - currentRating,
      moves: [],
      projected_rating: currentRating,
      message: `No songs in top slots — cannot plan improvements.`,
    };
  }

  const threshold = Math.ceil(targetRating / slotCount);
  const minConstant = findMinConstant(threshold);

  if (minConstant === 0) {
    const shortfall = targetRating - currentRating;
    return {
      mode: "target",
      current_rating: currentRating,
      target_rating: targetRating,
      rating_needed: shortfall,
      moves: [],
      projected_rating: currentRating,
      message: `Target ${targetRating} requires ${threshold} rating per song — not achievable even at SSS+ on maximum constant charts. Still need ${shortfall} more.`,
    };
  }

  const actions: QueueMove[] = [];
  const existingKeys = new Set<string>();

  interface ReplacementSlot {
    section: "best" | "current";
    replacesTitle: string;
    replacesRating: number;
  }
  const replacementSlots: ReplacementSlot[] = [];

  // --- Classify each top-50 song ---
  const classify = (songs: PlayerSong[], section: "best" | "current") => {
    for (const s of songs) {
      const key = makeKey(s.title, s.chartType, s.difficulty);
      existingKeys.add(key);

      const info = findSongInfo(s.title, s.chartType, s.difficulty, allSongs);
      if (!info || info.constant <= 0) continue;

      const score = s.score || 0;
      const rating = calculateSongRating(info.constant, score);

      if (info.constant < minConstant) {
        // Can't reach threshold even at SSS+ → replace this slot
        replacementSlots.push({
          section,
          replacesTitle: info.title,
          replacesRating: rating,
        });
      } else if (rating < threshold) {
        // Viable but below threshold → grind to min rank that achieves threshold
        const minRank = findMinRankForThreshold(info.constant, threshold);
        if (minRank && score < minRank.score) {
          const m = buildMove(
            info,
            section,
            score,
            minRank.score,
            minRank.rankName,
            "improve",
          );
          if (m.rating_gain > 0) actions.push(m);
        }
      }
      // else: current_rating >= threshold, keep as-is (no action)
    }
  };

  classify(playerData.best || [], "best");
  classify(playerData.current || [], "current");

  // --- Gather replacement candidates from allRecords ---
  interface Candidate {
    info: SongInfo;
    score: number;
    minRank: { score: number; rankName: string };
  }
  const oldCandidates: Candidate[] = [];  // for "best" bucket (non-CiRCLE/PRiSM+)
  const newCandidates: Candidate[] = [];  // for "current" bucket (CiRCLE/PRiSM+)

  for (const r of playerData.allRecords || []) {
    const key = makeKey(r.title, r.chartType, r.difficulty);
    if (existingKeys.has(key)) continue;

    const info = findSongInfo(r.title, r.chartType, r.difficulty, allSongs);
    if (!info || info.constant < minConstant) continue;

    const minRank = findMinRankForThreshold(info.constant, threshold);
    if (!minRank) continue;

    const pool = isNewVersion(info.version) ? newCandidates : oldCandidates;
    pool.push({ info, score: r.score || 0, minRank });
  }

  // Sort: lowest constant first (easiest chart), then highest score (least grinding)
  const sortCandidates = (a: Candidate, b: Candidate) => {
    if (a.info.constant !== b.info.constant) return a.info.constant - b.info.constant;
    return b.score - a.score;
  };
  oldCandidates.sort(sortCandidates);
  newCandidates.sort(sortCandidates);

  // --- Assign candidates to replacement slots ---
  const bestSlots = replacementSlots
    .filter((s) => s.section === "best")
    .sort((a, b) => a.replacesRating - b.replacesRating);
  const currentSlots = replacementSlots
    .filter((s) => s.section === "current")
    .sort((a, b) => a.replacesRating - b.replacesRating);

  let unfilled = 0;

  for (let i = 0; i < bestSlots.length; i++) {
    if (i >= oldCandidates.length) { unfilled++; continue; }
    const slot = bestSlots[i];
    const c = oldCandidates[i];
    const m = buildMove(
      c.info,
      "best",
      c.score,
      c.minRank.score,
      c.minRank.rankName,
      "replace",
      slot.replacesTitle,
      slot.replacesRating,
    );
    if (m.rating_gain > 0) actions.push(m);
  }

  for (let i = 0; i < currentSlots.length; i++) {
    if (i >= newCandidates.length) { unfilled++; continue; }
    const slot = currentSlots[i];
    const c = newCandidates[i];
    const m = buildMove(
      c.info,
      "current",
      c.score,
      c.minRank.score,
      c.minRank.rankName,
      "replace",
      slot.replacesTitle,
      slot.replacesRating,
    );
    if (m.rating_gain > 0) actions.push(m);
  }

  // --- Sort by score gap ascending (easiest grind first) ---
  actions.sort((a, b) => a.score_gap - b.score_gap);

  const totalGain = actions.reduce((s, m) => s + m.rating_gain, 0);
  const projected = currentRating + totalGain;

  let message: string;
  if (projected >= targetRating) {
    message = `Plan to reach ${targetRating}: ${actions.length} songs to grind (+${totalGain} rating). Per-slot threshold ${threshold}, min constant ${minConstant}.`;
  } else {
    const shortfall = targetRating - projected;
    const unfilledPart = unfilled > 0 ? ` ${unfilled} replacement slot(s) could not be filled — no allRecords songs with constant ≥ ${minConstant}.` : "";
    message = `Best plan: ${actions.length} songs (+${totalGain} rating). Projected ${projected}, need ${shortfall} more.${unfilledPart}`;
  }

  return {
    mode: "target",
    current_rating: currentRating,
    target_rating: targetRating,
    rating_needed: targetRating - currentRating,
    moves: actions.map(moveToSuggestion),
    projected_rating: projected,
    message,
  };
}
