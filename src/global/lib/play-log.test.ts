import { describe, expect, it } from "vitest";
import {
  bangkokToday,
  dayCredits,
  earliestEditableDate,
  isCount,
  isEditableDate,
  isIsoDate,
} from "./play-log";

describe("play log dates", () => {
  it("uses the Bangkok calendar date", () => {
    expect(bangkokToday(new Date("2026-10-25T16:59:00Z"))).toBe("2026-10-25");
    expect(bangkokToday(new Date("2026-10-25T17:00:00Z"))).toBe("2026-10-26");
  });

  it("accepts only real dates inside the edit window", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-10-26")).toBe(true);
    expect(earliestEditableDate("2026-10-26")).toBe("2025-10-26");
    expect(isEditableDate("2025-10-26", "2026-10-26")).toBe(true);
    expect(isEditableDate("2025-10-25", "2026-10-26")).toBe(false);
    expect(isEditableDate("2026-10-27", "2026-10-26")).toBe(false);
  });

  it("bounds counts to 0..99 integers", () => {
    expect([0, 99].every(isCount)).toBe(true);
    expect([-1, 100, 1.5, "3", null].some(isCount)).toBe(false);
  });
});

describe("dayCredits", () => {
  it("adds each ticket's extra credits to plays and prices them per credit", () => {
    expect(dayCredits("maimai", { plays: 3, tickets: { area_x2: 1, area_x3: 1 } })).toEqual({
      plays: 3,
      tickets: 2,
      extraCredits: 3,
      credits: 6,
      baht: 240,
    });
    expect(dayCredits("chunithm", { plays: null, tickets: {} }).baht).toBe(0);
  });

  it("prices logged tickets at their stored credits, including tickets no longer in the catalog", () => {
    expect(
      dayCredits("maimai", {
        plays: 3,
        tickets: { area_x2: 1, old_pass: 1 },
        ticketCredits: { area_x2: 3, old_pass: 2 },
      }),
    ).toMatchObject({ tickets: 2, extraCredits: 5, credits: 8 });
  });
});
