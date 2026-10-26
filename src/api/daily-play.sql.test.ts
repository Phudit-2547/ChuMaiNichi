import { Client, neonConfig } from "@neondatabase/serverless";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readDay, writePlays, writeTicket, type Sql, type Tables } from "./daily-play";

// Runs the route's SQL against session-only TEMP tables; set TEST_DATABASE_URL to run.
const url = process.env.TEST_DATABASE_URL;
const T: Tables = { day: "pg_temp.daily_play", ticket: "pg_temp.daily_ticket" };

type Row = [string, number | null, number | null, number | null, number | null, number | null, string | null];

describe.skipIf(!url)("daily-play SQL", () => {
  let client: Client;
  let sql: Sql;

  beforeAll(async () => {
    if (!neonConfig.webSocketConstructor && typeof WebSocket !== "undefined")
      neonConfig.webSocketConstructor = WebSocket;
    client = new Client(url);
    await client.connect();
    sql = async (text, params) => (await client.query(text, params)).rows;
    await client.query(`CREATE TEMP TABLE daily_play (
      play_date DATE PRIMARY KEY,
      maimai_play_count INTEGER, chunithm_play_count INTEGER,
      maimai_cumulative INTEGER, chunithm_cumulative INTEGER,
      maimai_rating NUMERIC, chunithm_rating NUMERIC,
      scrape_failed BOOLEAN DEFAULT FALSE, failure_reason TEXT)`);
    await client.query(`CREATE TEMP TABLE daily_ticket (
      play_date DATE NOT NULL, game TEXT NOT NULL, ticket TEXT NOT NULL,
      count INTEGER NOT NULL, extra_credits INTEGER NOT NULL,
      PRIMARY KEY (play_date, game, ticket))`);
  });

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(async () => {
    await client.query("TRUNCATE pg_temp.daily_play, pg_temp.daily_ticket");
  });

  async function seed(...rows: Row[]) {
    for (const [date, m, c, mc, cc, mr, cr] of rows)
      await client.query(
        `INSERT INTO pg_temp.daily_play VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,NULL)`,
        [date, m, c, mc, cc, mr, cr],
      );
  }

  async function day(date: string) {
    const { rows } = await client.query(
      `SELECT maimai_play_count m, chunithm_play_count c, maimai_cumulative mc,
              chunithm_cumulative cc, maimai_rating::text mr, chunithm_rating::text cr, scrape_failed f
       FROM pg_temp.daily_play WHERE play_date = $1`,
      [date],
    );
    return rows[0] ?? null;
  }

  const plays = (date: string, count: number, expected: number | null, game: "maimai" | "chunithm" = "maimai") =>
    writePlays(sql, { date, game, count, expected }, T);
  const ticket = (date: string, id: string, count: number, expected: number | null, extra = 1) =>
    writeTicket(sql, { date, game: "maimai", ticket: id, count, expected }, extra, T);

  it("creates a missing day from the previous row's totals and ratings", async () => {
    await seed(["2026-10-24", 0, 0, 735, 339, 14561, "15.26"]);
    expect(await plays("2026-10-26", 2, 0)).toBe(true);
    expect(await day("2026-10-26")).toEqual({
      m: 2, c: 0, mc: 737, cc: 339, mr: "14561", cr: "15.26", f: false,
    });
  });

  it("shifts this day's and later totals by the change, leaving unknown totals alone", async () => {
    await seed(
      ["2026-10-20", 0, 0, 733, 339, 14561, "15.26"],
      ["2026-10-21", 0, 0, 733, 339, 14561, "15.26"],
      ["2026-10-22", 0, 0, null, 339, 14561, "15.26"],
    );
    expect(await plays("2026-10-20", 2, 0)).toBe(true);
    expect(await day("2026-10-20")).toMatchObject({ m: 2, c: 0, mc: 735, cc: 339 });
    expect(await day("2026-10-21")).toMatchObject({ mc: 735, cc: 339 });
    expect(await day("2026-10-22")).toMatchObject({ mc: null, cc: 339 });

    expect(await plays("2026-10-20", 1, 2)).toBe(true);
    expect(await day("2026-10-20")).toMatchObject({ m: 1, mc: 734 });
    expect(await day("2026-10-21")).toMatchObject({ mc: 734 });
  });

  it("rejects a stale expected value without changing anything", async () => {
    await seed(["2026-10-20", 1, 0, 734, 339, 14561, "15.26"], ["2026-10-21", 0, 0, 734, 339, 14561, "15.26"]);
    expect(await plays("2026-10-20", 3, 0)).toBe(false);
    expect(await day("2026-10-20")).toMatchObject({ m: 1, mc: 734 });
    expect(await day("2026-10-21")).toMatchObject({ mc: 734 });
  });

  it("does not create a missing day when the client expected a recorded count", async () => {
    await seed(["2026-10-24", 0, 0, 735, 339, 14561, "15.26"]);
    expect(await plays("2026-10-26", 4, 3)).toBe(false);
    expect(await day("2026-10-26")).toBeNull();
  });

  it("accepts a typed total for an unknown count without moving SEGA's totals", async () => {
    await seed(
      ["2026-10-21", null, 0, 735, 339, 14561, "15.26"],
      ["2026-10-22", 0, 0, 735, 339, 14561, "15.26"],
    );
    expect(await plays("2026-10-21", 2, null)).toBe(true);
    expect(await day("2026-10-21")).toMatchObject({ m: 2, c: 0, mc: 735 });
    expect(await day("2026-10-22")).toMatchObject({ mc: 735 });
  });

  it("does not create a missing day from an unknown expected value", async () => {
    await seed(["2026-10-24", 0, 0, 735, 339, 14561, "15.26"]);
    expect(await plays("2026-10-26", 1, null)).toBe(false);
    expect(await day("2026-10-26")).toBeNull();
  });

  it("leaves the other game's columns and ratings untouched", async () => {
    await seed(["2026-10-20", 1, 2, 734, 341, 14561, "15.26"]);
    expect(await plays("2026-10-20", 3, 2, "chunithm")).toBe(true);
    expect(await day("2026-10-20")).toEqual({
      m: 1, c: 3, mc: 734, cc: 342, mr: "14561", cr: "15.26", f: false,
    });
  });

  it("keeps tickets within plays, and plays at or above tickets", async () => {
    await seed(["2026-10-20", 2, 0, 735, 339, 14561, "15.26"]);
    expect(await ticket("2026-10-20", "area_x2", 1, 0)).toBe(true);
    expect(await ticket("2026-10-20", "area_x3", 2, 0)).toBe(false);
    expect(await ticket("2026-10-20", "area_x3", 1, 0)).toBe(true);
    expect(await plays("2026-10-20", 1, 2)).toBe(false);
    expect(await ticket("2026-10-20", "area_x2", 0, 1)).toBe(true);
    expect(await plays("2026-10-20", 1, 2)).toBe(true);
    expect((await readDay(sql, "2026-10-20", T)).games.maimai).toEqual({
      plays: 1,
      tickets: { area_x2: 0, area_x3: 1 },
      ticketCredits: { area_x2: 1, area_x3: 1 },
    });
  });

  it("allows lowering a ticket count even when tickets already exceed plays", async () => {
    await seed(["2026-10-20", 1, 0, 734, 339, 14561, "15.26"]);
    await client.query(`INSERT INTO pg_temp.daily_ticket VALUES ('2026-10-20','maimai','area_x2',2,1)`);
    expect(await ticket("2026-10-20", "area_x2", 1, 2)).toBe(true);
  });

  it("rejects a stale ticket count and keeps the first extra_credits", async () => {
    await seed(["2026-10-20", 3, 0, 736, 339, 14561, "15.26"]);
    expect(await ticket("2026-10-20", "area_x2", 2, 0, 1)).toBe(true);
    expect(await ticket("2026-10-20", "area_x2", 1, 0, 1)).toBe(false);
    expect(await ticket("2026-10-20", "area_x2", 3, 2, 5)).toBe(true);
    const { rows } = await client.query(`SELECT count, extra_credits FROM pg_temp.daily_ticket`);
    expect(rows).toEqual([{ count: 3, extra_credits: 1 }]);
  });

  it("reads a missing day as zero plays", async () => {
    expect(await readDay(sql, "2026-10-26", T)).toEqual({
      date: "2026-10-26",
      exists: false,
      games: {
        maimai: { plays: 0, tickets: {}, ticketCredits: {} },
        chunithm: { plays: 0, tickets: {}, ticketCredits: {} },
      },
    });
  });
});
