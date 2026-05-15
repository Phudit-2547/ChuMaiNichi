import {
  calculateScoreForRating as calculateChunithmScoreForRating,
} from "../../global/lib/chunithm-rating.js";
import {
  calculateScoreForSongRating as calculateMaimaiScoreForSongRating,
  calculateSongRating as calculateMaimaiSongRating,
  getRankInfo as getMaimaiRankInfo,
  type SongData,
} from "../../global/lib/maimai-rating.js";

type Game = "chunithm" | "maimai";
type MaimaiDifficulty = "basic" | "advanced" | "expert" | "master" | "remaster";

interface ParsedCommand {
  game: Game;
  subcommand: string;
  args: string[];
}

interface SlashCommandOptions {
  maimaiMaxConstant?: number | null;
}

const CHUNITHM_MAX_INTERNAL_LEVEL = 16.0;
const DEFAULT_MAIMAI_MAX_CONSTANT = 15.0;
const CHUNITHM_MIN_DISPLAY_SCORE = 975_000;
const MAIMAI_MIN_DISPLAY_SCORE = 970_000;
const MAIMAI_DIFFICULTIES: readonly MaimaiDifficulty[] = [
  "basic",
  "advanced",
  "expert",
  "master",
  "remaster",
];

function stripTimestampPrefix(input: string): string {
  return input.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function parseCommand(input: string): ParsedCommand | null {
  const text = stripTimestampPrefix(input);
  if (!text.startsWith("/")) return null;

  const parts = text.slice(1).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  const gameAlias = parts[0].toLowerCase();
  let game: Game | null = null;
  if (gameAlias === "chuni" || gameAlias === "chunithm") game = "chunithm";
  if (gameAlias === "mai" || gameAlias === "maimai") game = "maimai";
  if (!game) return null;

  return {
    game,
    subcommand: parts[1].toLowerCase(),
    args: parts.slice(2),
  };
}

function parseNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const normalized = raw.replace(/,/g, "").replace(/%$/, "");
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function parseMaimaiScore(raw: string | undefined): number | null {
  const value = parseNumber(raw);
  if (value == null) return null;
  if (raw?.trim().endsWith("%") || value <= 101) {
    return Math.round(value * 10000);
  }
  return Math.round(value);
}

function formatMaimaiPct(score: number): string {
  return `${(score / 10000).toFixed(4)}%`;
}

function formatChunithmRating(value: number): string {
  return value.toFixed(2);
}

function formatMaimaiTarget(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function normalizeMaimaiMaxConstant(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAIMAI_MAX_CONSTANT;
  }
  return Math.floor(value * 10) / 10;
}

export function getMaimaiMaxConstant(allSongs: readonly SongData[]): number | null {
  let max = 0;
  for (const song of allSongs) {
    for (const diff of MAIMAI_DIFFICULTIES) {
      const constant = song[diff]?.constant;
      if (typeof constant === "number" && Number.isFinite(constant)) {
        max = Math.max(max, constant);
      }
    }
  }
  return max > 0 ? max : null;
}

function buildChunithmRatingTable(targetRating: number): string {
  if (targetRating < 1 || targetRating > CHUNITHM_MAX_INTERNAL_LEVEL + 2.15) {
    return `CHUNITHM target play rating must be between 1.00 and ${formatChunithmRating(
      CHUNITHM_MAX_INTERNAL_LEVEL + 2.15,
    )}.`;
  }

  const dataRows: string[] = [];
  let level10 = Math.max(Math.trunc(targetRating - 3) * 10, 10);
  const target10 = targetRating * 10;
  const max10 = CHUNITHM_MAX_INTERNAL_LEVEL * 10;

  while (level10 <= target10 && level10 <= max10) {
    const constant = Math.round(level10) / 10;
    const requiredScore = calculateChunithmScoreForRating(targetRating, constant);
    if (requiredScore != null && requiredScore >= CHUNITHM_MIN_DISPLAY_SCORE) {
      dataRows.push(`${constant.toFixed(1)} | ${String(requiredScore)}`);
    }

    if (level10 >= 100) {
      level10 += 1;
    } else if (level10 >= 70) {
      level10 += 5;
    } else {
      level10 += 10;
    }
  }

  if (dataRows.length === 0) return "No CHUNITHM chart constants found for that target.";

  return [
    `Score required to achieve **${formatChunithmRating(targetRating)}** CHUNITHM play rating:`,
    "",
    "| Const | Score |",
    "| ----- | ----- |",
    ...dataRows.map((l) => {
      const parts = l.split(" | ");
      return `| ${parts[0].trim().padStart(5)} | ${parts[1].trim().padStart(7)} |`;
    }),
  ].join("\n");
}

function buildMaimaiTargetTable(targetRating: number, maxConstant: number): string {
  if (targetRating <= 0) return "maimai target song rating must be greater than 0.";

  const dataRows: string[] = [];
  for (let level10 = 10; level10 <= maxConstant * 10; level10++) {
    const constant = level10 / 10;
    const required = calculateMaimaiScoreForSongRating(constant, targetRating);
    if (!required || required.score < MAIMAI_MIN_DISPLAY_SCORE) continue;
    dataRows.push(
      `${constant.toFixed(1)} | ${formatMaimaiPct(required.score)} | ${required.rankName} | ${calculateMaimaiSongRating(constant, required.score)}`,
    );
  }

  if (dataRows.length === 0) return "No maimai chart constants found for that target.";

  return [
    `Score required to achieve **${formatMaimaiTarget(
      targetRating,
    )}** maimai song rating, without AP bonus:`,
    "",
    "| Const | Achievement | Rank | Rating |",
    "| ----- | ---------- | ---- | ------ |",
    ...dataRows.map((r) => {
      const parts = r.split(" | ");
      return `| ${parts[0].padStart(5)} | ${parts[1].padStart(9)} | ${parts[2].padStart(4)} | ${parts[3].padStart(6)} |`;
    }),
  ].join("\n");
}

function buildMaimaiDirectCalculation(args: string[], maxConstant: number): string {
  const first = parseNumber(args[0]);
  const secondScore = parseMaimaiScore(args[1]);
  if (first == null || secondScore == null) {
    return "Usage: `/mai rating <target_song_rating>` or `/mai rating <constant> <score_or_achievement%>`.";
  }

  const constant = first;
  const score = secondScore;
  if (constant <= 0 || constant > maxConstant) {
    return `maimai chart constant must be between 0.1 and ${maxConstant.toFixed(1)}.`;
  }
  if (score < 0 || score > 1_010_000) {
    return "maimai score must be between 0.0000% and 101.0000%.";
  }

  const rating = calculateMaimaiSongRating(constant, score);
  const rank = getMaimaiRankInfo(score);
  const capNote =
    score > 1_005_000
      ? "\nScores above 100.5000% keep the same rating cap."
      : "";

  return `maimai DX song rating for **${constant.toFixed(1)}** at **${formatMaimaiPct(
    score,
  )} ${rank.rankName}** is **${rating}**.${capNote}`;
}

function buildMaimaiRating(args: string[], maxConstant: number): string {
  if (args.length === 1) {
    const targetRating = parseNumber(args[0]);
    if (targetRating == null) {
      return "Usage: `/mai rating <target_song_rating>` or `/mai rating <constant> <score_or_achievement%>`.";
    }
    return buildMaimaiTargetTable(targetRating, maxConstant);
  }

  return buildMaimaiDirectCalculation(args, maxConstant);
}

export function runSlashCommand(
  input: string,
  enabledGames: readonly string[],
  options: SlashCommandOptions = {},
): string | null {
  const command = parseCommand(input);
  if (!command) return null;

  if (!enabledGames.includes(command.game)) {
    const displayName = command.game === "chunithm" ? "CHUNITHM" : "maimai";
    return `${displayName} is disabled in config.json.`;
  }

  if (command.subcommand !== "rating") {
    return command.game === "chunithm"
      ? "Available CHUNITHM command: `/chuni rating <target_play_rating>`."
      : "Available maimai command: `/mai rating <target_song_rating>` or `/mai rating <constant> <score_or_achievement%>`.";
  }

  if (command.game === "chunithm") {
    const targetRating = parseNumber(command.args[0]);
    if (targetRating == null || command.args.length !== 1) {
      return "Usage: `/chuni rating <target_play_rating>`.";
    }
    return buildChunithmRatingTable(targetRating);
  }

  return buildMaimaiRating(
    command.args,
    normalizeMaimaiMaxConstant(options.maimaiMaxConstant),
  );
}
