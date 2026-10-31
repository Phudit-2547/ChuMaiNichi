import { describe, expect, it } from "vitest";
import {
  bangkokToday,
  dayCredits,
  earliestEditableDate,
  formatRating,
  isCount,
  isCountFor,
  isEditableDate,
  isIsoDate,
  isRating,
  regionToday,
  stepRating,
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

  it("bounds ONGEKI tracks to 999 and Japan plays to 99", () => {
    expect([isCountFor("ongeki", 999), isCountFor("ongeki", 1000)]).toEqual([true, false]);
    expect([isCountFor("maimai", 99), isCountFor("chunithm", 100)]).toEqual([true, false]);
  });

  it("dates each region by its own calendar day", () => {
    const late = new Date("2026-10-26T16:00:00Z");
    expect([regionToday("international", late), regionToday("japan", late)]).toEqual([
      "2026-10-26",
      "2026-10-27",
    ]);
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

describe("ratings", () => {
  it("accepts maimai whole numbers and CHUNITHM two-decimal values within bounds", () => {
    expect([0, 14561, 20000].every((n) => isRating("maimai", n))).toBe(true);
    expect([-1, 20001, 14561.5, "14561", null, NaN].some((n) => isRating("maimai", n))).toBe(false);
    expect([0, 15.26, 15.3, 20].every((n) => isRating("chunithm", n))).toBe(true);
    expect([15.265, 20.01, -0.01, "15.26"].some((n) => isRating("chunithm", n))).toBe(false);
  });

  it("formats each game's rating the way the game shows it", () => {
    expect(formatRating("maimai", 14561)).toBe("14561");
    expect(formatRating("chunithm", 15.3)).toBe("15.30");
  });

  it("steps by the smallest unit each game shows, within bounds", () => {
    expect(stepRating("maimai", 14561, 1)).toBe(14562);
    expect(stepRating("maimai", 14561, -1)).toBe(14560);
    expect(stepRating("chunithm", 9.32, 1)).toBe(9.33);
    expect(stepRating("chunithm", 0.3, -1)).toBe(0.29);
    expect(stepRating("maimai", 0, -1)).toBe(0);
    expect(stepRating("maimai", 20000, 1)).toBe(20000);
    expect(stepRating("chunithm", 20, 1)).toBe(20);
  });

  it("lands on a valid rating after many steps and from a legacy float value", () => {
    let rating = 9.32;
    for (let i = 0; i < 37; i++) rating = stepRating("chunithm", rating, 1);
    expect(rating).toBe(9.69);
    expect(isRating("chunithm", rating)).toBe(true);
    expect(stepRating("chunithm", 15.259999999999999787, 1)).toBe(15.27);
  });
});
