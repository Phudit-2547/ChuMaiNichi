import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryDBMock } = vi.hoisted(() => ({
  queryDBMock: vi.fn(),
}));

vi.mock("../../../global/lib/api", () => ({
  queryDB: queryDBMock,
}));

import { fetchData, fetchLastUpdated, fetchYears } from "./fetch";

describe("region-aware heatmap queries", () => {
  beforeEach(() => {
    queryDBMock.mockReset();
    queryDBMock.mockResolvedValue([]);
  });

  it("reads Japan years and last-recorded date from japan_daily_play", async () => {
    queryDBMock
      .mockResolvedValueOnce([{ year: 2026 }])
      .mockResolvedValueOnce([{ last_date: "2026-08-30" }]);

    await expect(fetchYears("japan")).resolves.toEqual([2026]);
    await expect(fetchLastUpdated("japan")).resolves.toBe("2026-08-30");

    expect(queryDBMock.mock.calls[0][0]).toContain("FROM japan_daily_play");
    expect(queryDBMock.mock.calls[1][0]).toContain("FROM japan_daily_play");
  });

  it("selects ONGEKI tracks for Japan without rating columns", async () => {
    await fetchData(2026, false, undefined, "japan");

    const sql = String(queryDBMock.mock.calls[0][0]);
    expect(sql).toContain("ongeki_track_count");
    expect(sql).toContain("inferred_games");
    expect(sql).toContain("FROM japan_daily_play");
    expect(sql).not.toContain("maimai_rating");
    expect(sql).not.toContain("chunithm_rating");
  });

  it("keeps the existing International query as the default", async () => {
    await fetchData(2026, false);

    const sql = String(queryDBMock.mock.calls[0][0]);
    expect(sql).toContain("FROM daily_play");
    expect(sql).toContain("maimai_rating");
    expect(sql).toContain("chunithm_rating");
    expect(sql).toContain("scrape_failed");
    expect(sql).toContain("failure_reason");
    expect(sql).not.toContain("ongeki_track_count");
    expect(sql).not.toContain("inferred_games");
  });
});

describe("International ticket counts", () => {
  beforeEach(() => {
    queryDBMock.mockReset();
  });

  it("merges logged tickets into the day rows", async () => {
    queryDBMock
      .mockResolvedValueOnce([
        { play_date: "2026-10-26", maimai_play_count: 3, chunithm_play_count: 0 },
        { play_date: "2026-10-25", maimai_play_count: 0, chunithm_play_count: 0 },
      ])
      .mockResolvedValueOnce([{ play_date: "2026-10-26", game: "maimai", tickets: 2 }]);

    const rows = await fetchData(2026, false);

    expect(String(queryDBMock.mock.calls[1][0])).toContain("FROM daily_ticket");
    expect(queryDBMock.mock.calls[1][1]).toEqual(["2026-01-01", "2026-12-31"]);
    expect(rows[0].tickets).toEqual({ maimai: 2 });
    expect(rows[1].tickets).toBeUndefined();
  });

  it("still returns plays when the ticket query fails", async () => {
    queryDBMock
      .mockResolvedValueOnce([{ play_date: "2026-10-26", maimai_play_count: 3, chunithm_play_count: 0 }])
      .mockRejectedValueOnce(new Error("relation daily_ticket does not exist"));

    await expect(fetchData(2026, false)).resolves.toHaveLength(1);
  });

  it("does not query tickets for Japan", async () => {
    queryDBMock.mockResolvedValue([]);
    await fetchData(2026, false, undefined, "japan");
    expect(queryDBMock).toHaveBeenCalledTimes(1);
  });
});
