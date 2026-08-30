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
    expect(sql).not.toContain("ongeki_track_count");
    expect(sql).not.toContain("inferred_games");
  });
});
