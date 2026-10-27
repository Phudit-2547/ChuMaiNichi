import { describe, expect, it } from "vitest";
import type { DayState } from "../../../global/lib/play-log";
import {
  applyResult,
  markSent,
  mergeDay,
  nextWrite,
  pendingWrite,
  queueFromDay,
  ratingKey,
  retryFailed,
  setDesired,
  stepDesired,
} from "./save-queue";

const DATE = "2026-10-26";
function day(
  maimai: number | null,
  tickets: Record<string, number> = {},
  chunithm = 0,
  rating: number | null = 14561,
): DayState {
  return {
    date: DATE,
    exists: true,
    games: {
      maimai: { plays: maimai, rating, tickets },
      chunithm: { plays: chunithm, rating: 15.26, tickets: {} },
    },
  };
}

describe("save queue", () => {
  it("builds one key per game and catalog ticket", () => {
    const q = queueFromDay(day(2, { area_x2: 1 }));
    expect(Object.keys(q.keys)).toEqual([
      "maimai", "maimai:area_x2", "maimai:area_x3", "maimai/rating",
      "chunithm", "chunithm:map_x2", "chunithm:map_x3", "chunithm:map_x4", "chunithm:exp_x6",
      "chunithm/rating",
    ]);
    expect(q.keys["chunithm/rating"]).toMatchObject({ server: 15.26, desired: 15.26 });
    expect(q.keys["maimai:area_x2"]).toMatchObject({ server: 1, desired: 1 });
  });

  it("coalesces taps during a request into one follow-up with the new expected value", () => {
    let q = setDesired(queueFromDay(day(0)), "maimai", 1);
    expect(pendingWrite(q, "maimai")).toEqual({ date: DATE, game: "maimai", count: 1, expected: 0 });
    q = markSent(q, "maimai");
    q = setDesired(q, "maimai", 2);
    q = setDesired(q, "maimai", 3);
    expect(pendingWrite(q, "maimai")).toBeNull();

    q = applyResult(q, "maimai", DATE, { kind: "saved", day: day(1) });
    expect(q.keys.maimai).toMatchObject({ server: 1, desired: 3, status: "saving", inFlight: false });
    expect(pendingWrite(q, "maimai")).toEqual({ date: DATE, game: "maimai", count: 3, expected: 1 });

    q = applyResult(markSent(q, "maimai"), "maimai", DATE, { kind: "saved", day: day(3) });
    expect(q.keys.maimai).toMatchObject({ server: 3, desired: 3, status: "saved" });
    expect(pendingWrite(q, "maimai")).toBeNull();
  });

  it("adopts the server value on conflict", () => {
    let q = markSent(setDesired(queueFromDay(day(1)), "maimai", 2), "maimai");
    q = applyResult(q, "maimai", DATE, { kind: "conflict", day: day(4) });
    expect(q.keys.maimai).toMatchObject({ server: 4, desired: 4, status: "conflict" });
    expect(pendingWrite(q, "maimai")).toBeNull();
  });

  it("keeps the unsaved value after a failure until Retry", () => {
    let q = markSent(setDesired(queueFromDay(day(1)), "maimai", 2), "maimai");
    q = applyResult(q, "maimai", DATE, { kind: "failed", message: "Not saved." });
    expect(q.keys.maimai).toMatchObject({ server: 1, desired: 2, status: "failed" });
    expect(pendingWrite(q, "maimai")).toBeNull();
    expect(pendingWrite(retryFailed(q), "maimai")).toMatchObject({ count: 2, expected: 1 });
  });

  it("does not let one key's response overwrite another key in flight", () => {
    let q = queueFromDay(day(2));
    q = markSent(setDesired(q, "maimai:area_x2", 1), "maimai:area_x2");
    q = markSent(setDesired(q, "maimai", 3), "maimai");
    q = applyResult(q, "maimai:area_x2", DATE, { kind: "saved", day: day(2, { area_x2: 1 }) });
    expect(q.keys.maimai).toMatchObject({ server: 2, desired: 3, inFlight: true });
    expect(q.keys["maimai:area_x2"]).toMatchObject({ server: 1, status: "saved" });
  });

  it("refreshes idle keys from a response", () => {
    let q = markSent(setDesired(queueFromDay(day(2)), "maimai", 3), "maimai");
    q = applyResult(q, "maimai", DATE, { kind: "saved", day: day(3, {}, 5) });
    expect(q.keys.chunithm).toMatchObject({ server: 5, desired: 5 });
  });

  it("ignores responses for a day that is no longer open", () => {
    const q = markSent(setDesired(queueFromDay(day(0)), "maimai", 1), "maimai");
    expect(applyResult(q, "maimai", "2026-10-25", { kind: "saved", day: day(1) })).toBe(q);
  });

  it("does not send an unknown count", () => {
    const q = queueFromDay(day(null));
    expect(pendingWrite(q, "maimai")).toBeNull();
    expect(pendingWrite(setDesired(q, "maimai", 2), "maimai")).toEqual({
      date: DATE, game: "maimai", count: 2, expected: null,
    });
  });

  it("lists a logged ticket that has left the catalog so it can be removed", () => {
    const q = queueFromDay(day(2, { old_pass: 1 }));
    expect(q.keys["maimai:old_pass"]).toMatchObject({ server: 1 });
  });

  it("sends one request per game, adding plays before tickets", () => {
    let q = setDesired(setDesired(queueFromDay(day(0)), "maimai:area_x2", 1), "maimai", 1);
    expect(nextWrite(q, "maimai")).toMatchObject({ key: "maimai", write: { count: 1, expected: 0 } });
    q = markSent(q, "maimai");
    expect(nextWrite(q, "maimai")).toBeNull();
    q = applyResult(q, "maimai", DATE, { kind: "saved", day: day(1) });
    expect(nextWrite(q, "maimai")).toMatchObject({ key: "maimai:area_x2", write: { count: 1, expected: 0 } });
  });

  it("removes tickets before lowering plays", () => {
    let q = queueFromDay(day(2, { area_x2: 2 }));
    q = setDesired(setDesired(q, "maimai", 1), "maimai:area_x2", 1);
    expect(nextWrite(q, "maimai")?.key).toBe("maimai:area_x2");
  });

  it("recognises its own earlier write after a lost response and keeps the latest tap", () => {
    let q = markSent(setDesired(queueFromDay(day(0)), "maimai", 1), "maimai");
    q = applyResult(q, "maimai", DATE, { kind: "failed", message: "Not saved." });
    q = markSent(setDesired(q, "maimai", 2), "maimai");
    q = applyResult(q, "maimai", DATE, { kind: "conflict", day: day(1) });
    expect(q.keys.maimai).toMatchObject({ server: 1, desired: 2, status: "idle" });
    expect(pendingWrite(q, "maimai")).toMatchObject({ count: 2, expected: 1 });
  });

  it("merges a fresh read without undoing an unsaved or in-flight tap", () => {
    let q = markSent(setDesired(queueFromDay(day(2)), "maimai", 3), "maimai");
    q = mergeDay(q, day(2, {}, 4));
    expect(q.keys.maimai).toMatchObject({ server: 2, desired: 3, inFlight: true });
    expect(q.keys.chunithm).toMatchObject({ server: 4, desired: 4 });
    q = applyResult(q, "maimai", DATE, { kind: "saved", day: day(3, {}, 4) });
    expect(q.keys.maimai).toMatchObject({ server: 3, desired: 3, status: "saved" });
    expect(pendingWrite(q, "maimai")).toBeNull();
  });

  it("counts every tap from the latest value and stays within 0..99", () => {
    let q = queueFromDay(day(2));
    q = stepDesired(stepDesired(stepDesired(q, "maimai", 1), "maimai", 1), "maimai", 1);
    expect(q.keys.maimai.desired).toBe(5);
    expect(stepDesired(queueFromDay(day(0)), "maimai", -1).keys.maimai.desired).toBe(0);
    expect(stepDesired(queueFromDay(day(null)), "maimai", 1).keys.maimai.desired).toBeNull();
  });
});

describe("rating saves", () => {
  it("sends the typed rating with the last confirmed one as expected", () => {
    const q = setDesired(queueFromDay(day(2)), ratingKey("maimai"), 14600);
    expect(pendingWrite(q, ratingKey("maimai"))).toEqual({
      date: DATE, game: "maimai", rating: 14600, expected: 14561,
    });
  });

  it("sends a first rating against an unset one", () => {
    const q = setDesired(queueFromDay(day(2, {}, 0, null)), ratingKey("maimai"), 14600);
    expect(pendingWrite(q, ratingKey("maimai"))).toMatchObject({ rating: 14600, expected: null });
    expect(pendingWrite(queueFromDay(day(2, {}, 0, null)), ratingKey("maimai"))).toBeNull();
  });

  it("saves the rating after the game's play and ticket changes", () => {
    let q = queueFromDay(day(0));
    q = setDesired(q, ratingKey("maimai"), 14600);
    q = setDesired(q, "maimai", 1);
    expect(nextWrite(q, "maimai")?.key).toBe("maimai");
    q = applyResult(markSent(q, "maimai"), "maimai", DATE, { kind: "saved", day: day(1) });
    expect(nextWrite(q, "maimai")?.key).toBe("maimai/rating");
  });

  it("adopts a rating changed on another device", () => {
    let q = markSent(setDesired(queueFromDay(day(2)), ratingKey("maimai"), 14600), ratingKey("maimai"));
    q = applyResult(q, ratingKey("maimai"), DATE, { kind: "conflict", day: day(2, {}, 0, 14700) });
    expect(q.keys["maimai/rating"]).toMatchObject({
      server: 14700, desired: 14700, status: "conflict",
      message: "Changed since this day loaded. Showing the latest.",
    });
  });

  it("keeps a conflict notice through a re-read the user did not ask for", () => {
    let q = markSent(setDesired(queueFromDay(day(2)), ratingKey("maimai"), 14600), ratingKey("maimai"));
    q = applyResult(q, ratingKey("maimai"), DATE, { kind: "conflict", day: day(2, {}, 0, 14700) });
    expect(mergeDay(q, day(2, {}, 0, 14700), true).keys["maimai/rating"]).toMatchObject({
      server: 14700, status: "conflict",
    });
    expect(mergeDay(q, day(2, {}, 0, 14700)).keys["maimai/rating"]).toMatchObject({ status: "idle" });
  });

  it("does not treat the rating key as a ticket", () => {
    let q = setDesired(queueFromDay(day(2)), ratingKey("chunithm"), 15.3);
    expect(nextWrite(q, "chunithm")?.write).toEqual({
      date: DATE, game: "chunithm", rating: 15.3, expected: 15.26,
    });
    q = applyResult(markSent(q, ratingKey("chunithm")), ratingKey("chunithm"), DATE, {
      kind: "saved",
      day: { ...day(2), games: { ...day(2).games, chunithm: { plays: 0, rating: 15.3, tickets: {} } } },
    });
    expect(q.keys["chunithm/rating"]).toMatchObject({ server: 15.3, status: "saved" });
  });
});
