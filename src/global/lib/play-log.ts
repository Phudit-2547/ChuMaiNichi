import { APP_CONFIG, type TicketDef } from "./config.js";
import type { Game, JapanGame } from "./games.js";
import type { DataRegion } from "./regions.js";

// Shared by the day editor and /api/daily-play.

export const MAX_COUNT = 99;
/** ONGEKI is counted in tracks, several per credit. */
export const MAX_TRACKS = 999;
export const EDIT_WINDOW_DAYS = 366;

export interface GameDay {
  plays: number | null;
  /** Rating at the end of the day; a day without a row shows the previous day's. */
  rating: number | null;
  tickets: Record<string, number>;
  /** extra_credits stored with each logged ticket; a later catalog edit never reprices a past day. */
  ticketCredits?: Record<string, number>;
}

export interface DayState {
  date: string;
  region: DataRegion;
  exists: boolean;
  /** Japan days hold plays only (ONGEKI: tracks), never null, with no tickets or rating. */
  games: Partial<Record<JapanGame, GameDay>>;
  /** Japan only: the last day the Journal import covers. Days through it are read-only here. */
  journalThrough?: string | null;
}

export interface PlayWrite {
  date: string;
  game: Game;
  count: number;
  expected: number | null;
}

export interface TicketWrite extends PlayWrite {
  ticket: string;
}

export interface RatingWrite {
  date: string;
  game: Game;
  rating: number;
  expected: number | null;
}

export interface JapanPlayWrite {
  region: "japan";
  date: string;
  game: JapanGame;
  count: number;
  expected: number;
}

export type DayWrite = PlayWrite | TicketWrite | RatingWrite | JapanPlayWrite;

export type WriteErrorCode =
  | "CONFLICT"
  | "TICKETS_EXCEED_PLAYS"
  | "JOURNAL_DAY"
  | "INVALID_REQUEST"
  | "WRITES_DISABLED";

export function isJapanWrite(write: DayWrite): write is JapanPlayWrite {
  return "region" in write;
}

export function isTicketWrite(write: DayWrite): write is TicketWrite {
  return "ticket" in write;
}

export function isRatingWrite(write: DayWrite): write is RatingWrite {
  return "rating" in write;
}

/** Bounds for a typed rating: maimai's is a whole number, CHUNITHM's has two decimals. */
export const RATING_FORMAT: Record<Game, { max: number; decimals: number }> = {
  maimai: { max: 20000, decimals: 0 },
  chunithm: { max: 20, decimals: 2 },
};

export function isRating(game: Game, value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const { max, decimals } = RATING_FORMAT[game];
  const scale = 10 ** decimals;
  return value >= 0 && value <= max && Math.round(value * scale) / scale === value;
}

export function formatRating(game: Game, value: number): string {
  return value.toFixed(RATING_FORMAT[game].decimals);
}

/** Moves a rating by `delta` of its smallest unit (maimai 1, CHUNITHM 0.01), within bounds. */
export function stepRating(game: Game, value: number, delta: number): number {
  const { max, decimals } = RATING_FORMAT[game];
  const scale = 10 ** decimals;
  return Math.min(max, Math.max(0, Math.round(value * scale + delta) / scale));
}

// Japan dates are Journal dates: the calendar day in Japan.
const TIME_ZONE: Record<DataRegion, string> = {
  international: "Asia/Bangkok",
  japan: "Asia/Tokyo",
};

export function regionToday(region: DataRegion, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE[region],
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function bangkokToday(now: Date = new Date()): string {
  return regionToday("international", now);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Earliest editable date: today minus the edit window, inclusive. */
export function earliestEditableDate(today: string = bangkokToday()): string {
  return addDays(today, -(EDIT_WINDOW_DAYS - 1));
}

export function isEditableDate(date: string, today: string = bangkokToday()): boolean {
  return isIsoDate(date) && date <= today && date >= earliestEditableDate(today);
}

export function maxCount(game: JapanGame): number {
  return game === "ongeki" ? MAX_TRACKS : MAX_COUNT;
}

export function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT;
}

export function isCountFor(game: JapanGame, value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maxCount(game);
}

export function ticketCatalog(game: Game): TicketDef[] {
  return APP_CONFIG.tickets?.[game] ?? [];
}

export function findTicket(game: Game, id: string): TicketDef | undefined {
  return ticketCatalog(game).find((ticket) => ticket.id === id);
}

export function ticketTotal(day: Pick<GameDay, "tickets">): number {
  return Object.values(day.tickets).reduce((sum, n) => sum + n, 0);
}

/** Credits paid for one game on one day: plays plus each ticket's extra credits. */
export function dayCredits(
  game: Game,
  day: Pick<GameDay, "plays" | "tickets" | "ticketCredits">,
) {
  const plays = day.plays ?? 0;
  const tickets = ticketTotal(day);
  const extraCredits = Object.entries(day.tickets).reduce(
    (sum, [id, count]) =>
      sum + count * (day.ticketCredits?.[id] ?? findTicket(game, id)?.extra_credits ?? 0),
    0,
  );
  const credits = plays + extraCredits;
  return { plays, tickets, extraCredits, credits, baht: credits * APP_CONFIG.currency_per_play };
}
