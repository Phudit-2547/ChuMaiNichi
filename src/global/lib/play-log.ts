import { APP_CONFIG, type TicketDef } from "./config.js";
import type { Game } from "./games.js";

// Shared by the day editor and /api/daily-play.

export const MAX_COUNT = 99;
export const EDIT_WINDOW_DAYS = 366;

export interface GameDay {
  plays: number | null;
  tickets: Record<string, number>;
  /** extra_credits stored with each logged ticket; a later catalog edit never reprices a past day. */
  ticketCredits?: Record<string, number>;
}

export interface DayState {
  date: string;
  exists: boolean;
  games: Partial<Record<Game, GameDay>>;
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

export type DayWrite = PlayWrite | TicketWrite;

export type WriteErrorCode =
  | "CONFLICT"
  | "TICKETS_EXCEED_PLAYS"
  | "INVALID_REQUEST"
  | "WRITES_DISABLED";

export function isTicketWrite(write: DayWrite): write is TicketWrite {
  return "ticket" in write;
}

export function bangkokToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
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

export function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT;
}

export function ticketCatalog(game: Game): TicketDef[] {
  return APP_CONFIG.tickets?.[game] ?? [];
}

export function findTicket(game: Game, id: string): TicketDef | undefined {
  return ticketCatalog(game).find((ticket) => ticket.id === id);
}

export function ticketTotal(day: GameDay): number {
  return Object.values(day.tickets).reduce((sum, n) => sum + n, 0);
}

/** Credits paid for one game on one day: plays plus each ticket's extra credits. */
export function dayCredits(game: Game, day: GameDay) {
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
