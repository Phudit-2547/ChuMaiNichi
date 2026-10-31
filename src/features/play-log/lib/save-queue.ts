import type { Game, JapanGame } from "../../../global/lib/games";
import type { DataRegion } from "../../../global/lib/regions";
import {
  isRatingWrite,
  maxCount,
  stepRating,
  ticketCatalog,
  type DayState,
  type DayWrite,
} from "../../../global/lib/play-log";
import type { SaveResult } from "./api";

// Per-key compare-and-set saving for one day. A key is a game's plays
// ("maimai"), one of its tickets ("maimai:area_x2") or its rating
// ("maimai/rating"); a Japan day has only plays (ONGEKI: tracks). Each game
// sends one request at a time, in an order the server's ticket rule accepts;
// taps meanwhile only move `desired`, and the next request carries the last
// confirmed `server` value as `expected`.

export type KeyStatus =
  | "idle"
  | "saving"
  | "saved"
  | "failed"
  | "conflict"
  | "exceeds"
  | "unauthorized";

export interface KeyState {
  server: number | null;
  desired: number | null;
  inFlight: boolean;
  status: KeyStatus;
  message?: string;
  /** Counts sent whose response never confirmed them; one may have been stored. */
  unconfirmed: number[];
}

export interface Queue {
  date: string;
  region: DataRegion;
  keys: Record<string, KeyState>;
  /** extra_credits stored with logged tickets, per game and ticket id. */
  credits: Partial<Record<Game, Record<string, number>>>;
}

export function keyFor(game: JapanGame, ticket?: string): string {
  return ticket ? `${game}:${ticket}` : game;
}

export function ratingKey(game: Game): string {
  return `${game}/rating`;
}

export function parseKey(key: string): { game: JapanGame; ticket?: string; rating?: true } {
  if (key.endsWith("/rating")) return { game: key.slice(0, -"/rating".length) as Game, rating: true };
  const [game, ticket] = key.split(":");
  return { game: game as JapanGame, ticket };
}

function valueIn(day: DayState, key: string): number | null {
  const { game, ticket, rating } = parseKey(key);
  const gameDay = day.games[game];
  if (rating) return gameDay?.rating ?? null;
  if (!gameDay) return 0;
  return ticket ? (gameDay.tickets[ticket] ?? 0) : gameDay.plays;
}

/** Catalog tickets, plus logged tickets that have since left the catalog. */
function dayKeys(day: DayState): string[] {
  if (day.region === "japan") return (Object.keys(day.games) as JapanGame[]).map((game) => keyFor(game));
  const keys: string[] = [];
  for (const game of Object.keys(day.games) as Game[]) {
    const ids = new Set(ticketCatalog(game).map((t) => t.id));
    for (const [id, count] of Object.entries(day.games[game]?.tickets ?? {}))
      if (count > 0) ids.add(id);
    keys.push(keyFor(game), ...[...ids].map((id) => keyFor(game, id)), ratingKey(game));
  }
  return keys;
}

function creditsIn(day: DayState): Queue["credits"] {
  const credits: Queue["credits"] = {};
  for (const game of Object.keys(day.games) as Game[])
    credits[game] = { ...day.games[game]?.ticketCredits };
  return credits;
}

function settled(value: number | null): KeyState {
  return { server: value, desired: value, inFlight: false, status: "idle", unconfirmed: [] };
}

function isIdle(state: KeyState) {
  return !state.inFlight && state.desired === state.server && state.status !== "failed";
}

export function hasPending(queue: Queue): boolean {
  return Object.values(queue.keys).some((state) => !isIdle(state));
}

export function queueFromDay(day: DayState): Queue {
  const keys: Record<string, KeyState> = {};
  for (const key of dayKeys(day)) keys[key] = settled(valueIn(day, key));
  return { date: day.date, region: day.region, keys, credits: creditsIn(day) };
}

/**
 * A fresh read refreshes idle keys and leaves keys with unsaved or in-flight
 * changes alone. keepNotices keeps a conflict notice on screen, for a re-read
 * the user did not ask for.
 */
export function mergeDay(queue: Queue, day: DayState, keepNotices = false): Queue {
  const keys = { ...queue.keys };
  for (const key of dayKeys(day)) {
    const prev = keys[key];
    if (prev && !isIdle(prev)) continue;
    const next = settled(valueIn(day, key));
    keys[key] =
      keepNotices && (prev?.status === "conflict" || prev?.status === "exceeds")
        ? { ...next, status: prev.status, message: prev.message }
        : next;
  }
  return { ...queue, keys, credits: creditsIn(day) };
}

export function setDesired(queue: Queue, key: string, desired: number): Queue {
  const current = queue.keys[key];
  if (!current) return queue;
  return {
    ...queue,
    keys: {
      ...queue.keys,
      [key]: { ...current, desired, status: current.inFlight ? "saving" : "idle", message: undefined },
    },
  };
}

/**
 * Moves `desired` by `delta` from its latest value, so taps between renders all
 * count. A rating moves by its smallest unit.
 */
export function stepDesired(queue: Queue, key: string, delta: number): Queue {
  const current = queue.keys[key]?.desired;
  if (current == null) return queue;
  const { game, rating } = parseKey(key);
  const next = rating
    ? stepRating(game as Game, current, delta)
    : Math.min(maxCount(game), Math.max(0, current + delta));
  return setDesired(queue, key, next);
}

/** The write to send for `key` now, or null when it is in flight, settled, or waiting for Retry. */
export function pendingWrite(queue: Queue, key: string): DayWrite | null {
  const state = queue.keys[key];
  if (
    !state ||
    state.inFlight ||
    state.desired == null ||
    state.desired === state.server ||
    state.status === "failed" ||
    state.status === "unauthorized"
  )
    return null;
  const { game, ticket, rating } = parseKey(key);
  if (queue.region === "japan")
    return { region: "japan", date: queue.date, game, count: state.desired, expected: state.server ?? 0 };
  // International keys hold only maimai and CHUNITHM.
  const intl = game as Game;
  if (rating) return { date: queue.date, game: intl, rating: state.desired, expected: state.server };
  const write = { date: queue.date, game: intl, count: state.desired, expected: state.server };
  return ticket ? { ...write, ticket } : write;
}

/**
 * The next request for one game, or null while one of its requests is in
 * flight. Order: more plays, fewer tickets, more tickets, fewer plays, so a
 * ticket never lands before the play it rides on and plays never drop below
 * tickets still being removed. The rating goes last.
 */
export function nextWrite(queue: Queue, game: JapanGame): { key: string; write: DayWrite } | null {
  const keys = Object.keys(queue.keys).filter((key) => parseKey(key).game === game);
  if (keys.some((key) => queue.keys[key].inFlight)) return null;
  const ranked = keys
    .map((key) => ({ key, write: pendingWrite(queue, key) }))
    .filter((c): c is { key: string; write: DayWrite } => c.write != null)
    .map((c) => {
      if (isRatingWrite(c.write)) return { ...c, rank: 4 };
      const rising = c.write.count > (c.write.expected ?? 0);
      const isPlays = !parseKey(c.key).ticket;
      const rank = isPlays ? (rising ? 0 : 3) : rising ? 2 : 1;
      return { ...c, rank };
    })
    .sort((a, b) => a.rank - b.rank);
  return ranked[0] ? { key: ranked[0].key, write: ranked[0].write } : null;
}

export function markSent(queue: Queue, key: string): Queue {
  const state = queue.keys[key];
  return {
    ...queue,
    keys: {
      ...queue.keys,
      [key]: {
        ...state,
        inFlight: true,
        status: "saving",
        message: undefined,
        unconfirmed: state.desired == null ? state.unconfirmed : [...state.unconfirmed, state.desired],
      },
    },
  };
}

/** Keys with nothing in flight and no unsent change take the server's latest values. */
function syncIdle(keys: Record<string, KeyState>, day: DayState, except: string) {
  const out = { ...keys };
  for (const [key, state] of Object.entries(keys)) {
    if (key === except || !isIdle(state)) continue;
    const value = valueIn(day, key);
    out[key] = { ...state, server: value, desired: value };
  }
  return out;
}

export function applyResult(queue: Queue, key: string, date: string, result: SaveResult): Queue {
  if (date !== queue.date || !queue.keys[key]) return queue;
  const state = queue.keys[key];
  switch (result.kind) {
    case "saved": {
      const server = valueIn(result.day, key);
      const keys = syncIdle(queue.keys, result.day, key);
      keys[key] = {
        ...state,
        server,
        inFlight: false,
        unconfirmed: [],
        status: state.desired === server ? "saved" : "saving",
      };
      return { ...queue, keys, credits: creditsIn(result.day) };
    }
    case "conflict":
    case "exceeds": {
      const value = valueIn(result.day, key);
      const keys = syncIdle(queue.keys, result.day, key);
      if (result.kind === "conflict" && value != null && state.unconfirmed.includes(value)) {
        // An earlier request whose response was lost did land: keep the latest tap and resend from there.
        keys[key] = {
          ...state,
          server: value,
          inFlight: false,
          unconfirmed: [],
          status: state.desired === value ? "saved" : "idle",
        };
      } else {
        keys[key] = {
          ...settled(value),
          status: result.kind,
          message:
            result.kind !== "conflict"
              ? result.message
              : parseKey(key).rating
                ? // An earlier day's rating can carry into this one, even from this device.
                  "Changed since this day loaded. Showing the latest."
                : "Changed on another device. Showing the latest.",
        };
      }
      return { ...queue, keys, credits: creditsIn(result.day) };
    }
    case "unauthorized":
      return {
        ...queue,
        keys: { ...queue.keys, [key]: { ...state, inFlight: false, status: "unauthorized", message: "Sign in again to save." } },
      };
    case "failed":
      return {
        ...queue,
        keys: { ...queue.keys, [key]: { ...state, inFlight: false, status: "failed", message: result.message } },
      };
  }
}

/** Retry clears failures so the unsaved values are sent again. */
export function retryFailed(queue: Queue): Queue {
  const keys = { ...queue.keys };
  for (const [key, state] of Object.entries(keys))
    if (state.status === "failed") keys[key] = { ...state, status: "idle", message: undefined };
  return { ...queue, keys };
}
