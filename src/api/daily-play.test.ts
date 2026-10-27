import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { newSessionCookie } from "./session";

const mocks = vi.hoisted(() => ({ rateLimit: vi.fn() }));
vi.mock("./passkey-store.js", () => ({ passkeyStore: () => mocks }));

import { createDailyPlayHandler, type Sql } from "./daily-play";

const ORIGIN = "https://dashboard.example.com";
const NOW = new Date("2026-10-26T05:00:00Z");
const DAY_ROW = {
  exists: true,
  maimai_play_count: 2,
  chunithm_play_count: 0,
  maimai_rating: "14561",
  chunithm_rating: "15.26",
  tickets: { "maimai:area_x2": [1, 1] },
};

let results: Record<string, unknown>[][];
let sql: ReturnType<typeof vi.fn<Sql>>;
const handler = createDailyPlayHandler(() => sql, () => NOW);

function request(method: string, body?: unknown, headers: Record<string, string | undefined> = {}, query = {}) {
  const cookie = "cookie" in headers ? headers.cookie : newSessionCookie().split(";")[0];
  return { method, body, query, headers: { origin: ORIGIN, ...headers, cookie } } as unknown as VercelRequest;
}
function response() {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}
async function send(req: VercelRequest) {
  const res = response();
  await handler(req, res);
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0], res };
}
const play = (extra = {}) => ({ date: "2026-10-26", game: "maimai", count: 3, expected: 2, ...extra });
const rate = (extra = {}) => ({ date: "2026-10-26", game: "maimai", rating: 14600, expected: 14561, ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PASSKEY_ORIGIN", ORIGIN);
  vi.stubEnv("SESSION_SECRET", "a".repeat(64));
  vi.stubEnv("DASHBOARD_PASSWORD", "old-password");
  vi.stubEnv("DATABASE_URL", "postgres://example");
  mocks.rateLimit.mockResolvedValue(true);
  results = [];
  sql = vi.fn<Sql>(async () => results.shift() ?? []);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("daily-play handler order", () => {
  it("rejects other methods and never caches", async () => {
    const { status, res } = await send(request("POST", play()));
    expect(status).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("refuses writes when no sign-in is configured", async () => {
    vi.stubEnv("PASSKEY_ORIGIN", "");
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("DASHBOARD_PASSWORD", "");
    const { status, body } = await send(request("PUT", play(), { cookie: undefined }));
    expect([status, body.code]).toEqual([503, "WRITES_DISABLED"]);
  });

  it("requires the configured Origin for cookie writes", async () => {
    expect((await send(request("PUT", play(), { origin: undefined }))).status).toBe(403);
    expect((await send(request("PUT", play(), { origin: "https://evil.example" }))).status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    expect((await send(request("PUT", play(), { cookie: undefined }))).status).toBe(401);
    expect((await send(request("GET", undefined, { cookie: undefined }, { date: "2026-10-26" }))).status).toBe(401);
  });

  it("rate limits writes", async () => {
    mocks.rateLimit.mockResolvedValue(false);
    expect((await send(request("PUT", play()))).status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith("daily-play", 60);
  });

  it.each([
    ["an extra key", play({ extra_credits: 9 })],
    ["a future date", play({ date: "2026-10-27" })],
    ["a date outside the edit window", play({ date: "2025-10-25" })],
    ["an impossible date", play({ date: "2026-02-30" })],
    ["an unknown game", play({ game: "ongeki" })],
    ["a count above 99", play({ count: 100 })],
    ["a fractional count", play({ count: 1.5 })],
    ["a negative expected", play({ expected: -1 })],
    ["an unknown ticket", play({ ticket: "area_x9" })],
    ["a retired ticket being raised", play({ ticket: "old_pass", count: 3, expected: 2 })],
    ["a ticket from the other game", play({ ticket: "map_x2" })],
    ["a rating with a count", rate({ count: 1 })],
    ["a fractional maimai rating", rate({ rating: 14600.5 })],
    ["a maimai rating above 20000", rate({ rating: 20001 })],
    ["a CHUNITHM rating with three decimals", rate({ game: "chunithm", rating: 15.265, expected: 15.26 })],
    ["a CHUNITHM rating above 20", rate({ game: "chunithm", rating: 152.6, expected: 15.26 })],
    ["a rating sent as text", rate({ rating: "14600" })],
    ["a negative rating", rate({ rating: -1 })],
    ["a non-numeric expected rating", rate({ expected: "14561" })],
    ["no body", undefined],
  ])("rejects %s", async (_label, body) => {
    const { status, body: json } = await send(request("PUT", body));
    expect([status, json.code]).toEqual([400, "INVALID_REQUEST"]);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe("daily-play writes", () => {
  it("saves plays and returns the re-read day", async () => {
    results = [[{ written: 1 }], [DAY_ROW]];
    const { status, body } = await send(request("PUT", play()));
    expect(status).toBe(200);
    expect(sql.mock.calls[0][1]).toEqual(["2026-10-26", 3, 2, "maimai"]);
    expect(body.day.games.maimai).toEqual({
      plays: 2,
      rating: 14561,
      tickets: { area_x2: 1 },
      ticketCredits: { area_x2: 1 },
    });
    expect(body.day.games.chunithm.rating).toBe(15.26);
  });

  it("saves a rating", async () => {
    results = [[{ written: 1 }], [DAY_ROW]];
    const { status } = await send(request("PUT", rate()));
    expect(status).toBe(200);
    expect(sql.mock.calls[0][1]).toEqual(["2026-10-26", 14600, 14561]);
    expect(sql.mock.calls[0][0]).toContain("SET maimai_rating = EXCLUDED.maimai_rating");
    expect(sql.mock.calls[0][0]).not.toContain("SET chunithm_rating");
  });

  it("saves a first CHUNITHM rating against an unset one", async () => {
    results = [[{ written: 1 }], [DAY_ROW]];
    const { status } = await send(request("PUT", rate({ game: "chunithm", rating: 15.3, expected: null })));
    expect(status).toBe(200);
    expect(sql.mock.calls[0][1]).toEqual(["2026-10-26", 15.3, null]);
    expect(sql.mock.calls[0][0]).toContain("SET chunithm_rating = EXCLUDED.chunithm_rating");
    expect(sql.mock.calls[0][0]).not.toContain("SET maimai_rating");
  });

  it("answers 409 when the stored rating moved", async () => {
    results = [[{ written: 0 }], [DAY_ROW]];
    const { status, body } = await send(request("PUT", rate({ expected: 14500 })));
    expect([status, body.code]).toEqual([409, "CONFLICT"]);
    expect(body.day.games.maimai.rating).toBe(14561);
  });

  it("answers 409 when the stored value moved", async () => {
    results = [[{ written: 0 }], [DAY_ROW]];
    const { status, body } = await send(request("PUT", play({ expected: 1 })));
    expect([status, body.code]).toEqual([409, "CONFLICT"]);
    expect(body.day.games.maimai.plays).toBe(2);
  });

  it("answers TICKETS_EXCEED_PLAYS when lowering plays below the ticket total", async () => {
    results = [[{ written: 0 }], [DAY_ROW]];
    const { status, body } = await send(request("PUT", play({ count: 0, expected: 2 })));
    expect([status, body.code]).toEqual([400, "TICKETS_EXCEED_PLAYS"]);
  });

  it("prices a ticket from the server catalog", async () => {
    results = [[{ count: 1 }], [DAY_ROW]];
    const { status } = await send(request("PUT", play({ ticket: "area_x3", count: 1, expected: 0 })));
    expect(status).toBe(200);
    expect(sql.mock.calls[0][1]).toEqual(["2026-10-26", "maimai", "area_x3", 1, 0, 2]);
  });

  it("lets a ticket that left the catalog be lowered", async () => {
    results = [[{ count: 0 }], [DAY_ROW]];
    const { status } = await send(request("PUT", play({ ticket: "old_pass", count: 0, expected: 1 })));
    expect(status).toBe(200);
    expect(sql.mock.calls[0][1]).toEqual(["2026-10-26", "maimai", "old_pass", 0, 1, 0]);
  });

  it("answers TICKETS_EXCEED_PLAYS for a ticket above plays", async () => {
    results = [[], [DAY_ROW]];
    const { status, body } = await send(request("PUT", play({ ticket: "area_x3", count: 2, expected: 0 })));
    expect([status, body.code]).toEqual([400, "TICKETS_EXCEED_PLAYS"]);
  });

  it("accepts a Bearer password write when Passkeys are not configured", async () => {
    vi.stubEnv("PASSKEY_ORIGIN", "");
    vi.stubEnv("SESSION_SECRET", "");
    results = [[{ written: 1 }], [DAY_ROW]];
    const req = request("PUT", play(), { origin: undefined, cookie: undefined, authorization: "Bearer old-password" });
    expect((await send(req)).status).toBe(200);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("hides database errors", async () => {
    sql.mockRejectedValueOnce(new Error("password authentication failed for user x"));
    const { status, body } = await send(request("PUT", play()));
    expect([status, body.error]).toEqual([500, "Could not save. Try again."]);
  });
});

describe("daily-play reads", () => {
  it("validates the date", async () => {
    expect((await send(request("GET", undefined, {}, { date: "26/10/2026" }))).status).toBe(400);
  });

  it("returns a missing day as zero plays", async () => {
    results = [[{
      exists: false,
      maimai_play_count: null,
      chunithm_play_count: null,
      maimai_rating: "14561",
      chunithm_rating: null,
      tickets: {},
    }]];
    const { status, body } = await send(request("GET", undefined, { origin: undefined }, { date: "2026-10-26" }));
    expect(status).toBe(200);
    expect(body.day).toEqual({
      date: "2026-10-26",
      exists: false,
      games: {
        maimai: { plays: 0, rating: 14561, tickets: {}, ticketCredits: {} },
        chunithm: { plays: 0, rating: null, tickets: {}, ticketCredits: {} },
      },
    });
  });
});
