import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeTool,
  getChatTools,
  JAPAN_ACTIVITY_TOOL,
} from "./tools";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@neondatabase/serverless", () => ({
  neon: () => ({ query: mocks.query }),
}));

function toolNames(region: "international" | "japan", games: string[]) {
  return getChatTools(region, games).map((tool) => {
    if (tool.type !== "function") throw new Error("Expected a function tool");
    return tool.function.name;
  });
}

describe("chat tool region isolation", () => {
  beforeEach(() => {
    mocks.query.mockReset().mockResolvedValue([]);
  });

  it("offers Japan only the structured activity tool", () => {
    expect(toolNames("japan", ["maimai", "chunithm"])).toEqual([
      "query_japan_activity",
    ]);
  });

  it("keeps International query and suggestion tools", () => {
    expect(toolNames("international", ["maimai", "chunithm"])).toEqual([
      "query_database",
      "maimai_suggest_songs",
    ]);
    expect(toolNames("international", ["chunithm"])).toEqual([
      "query_database",
    ]);
  });

  it("does not execute free-form SQL in the Japan context", async () => {
    await expect(
      executeTool(
        "query_database",
        {
          sql: "SELECT ts_stat('SELECT * FROM public.user_scores')",
        },
        "japan",
      ),
    ).resolves.toMatchObject({
      error: expect.stringContaining("Free-form SQL is unavailable"),
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects Japan data from the International SQL tool", async () => {
    await expect(
      executeTool(
        "query_database",
        { sql: "SELECT * FROM public.japan_daily_play" },
        "international",
      ),
    ).resolves.toMatchObject({
      error: expect.stringContaining("cannot query Japan Journal data"),
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a Unicode-escaped Japan table identifier from International", async () => {
    await expect(
      executeTool(
        "query_database",
        {
          sql: String.raw`SELECT * FROM U&"japan\005fdaily\005fplay"`,
        },
        "international",
      ),
    ).resolves.toMatchObject({
      error: expect.stringContaining("Unicode-escaped identifiers"),
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("never exposes encrypted Codex credential storage to the Assistant", async () => {
    for (const sql of [
      'SELECT * FROM public."codex_oauth_credentials"',
      "SELECT query_to_xml('SELECT * FROM codex_' || 'oauth_credentials', true, true, '')",
      "SELECT most_common_vals FROM pg_stats",
    ]) {
      await expect(
        executeTool("query_database", { sql }, "international"),
      ).resolves.toMatchObject({
        error: expect.stringMatching(
          /Private credential storage|query_to_xml|system catalogs/,
        ),
      });
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("does not offer score-based suggestions in the Japan context", async () => {
    await expect(
      executeTool("maimai_suggest_songs", {}, "japan"),
    ).resolves.toMatchObject({
      error: expect.stringContaining("play counts only"),
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns filtered Japan daily rows without Journal provenance", async () => {
    const rows = [
      {
        play_date: "2026-06-01",
        maimai_play_count: 1,
        chunithm_play_count: 0,
        ongeki_track_count: 9,
        maimai_cumulative: 10,
        chunithm_cumulative: 20,
        ongeki_cumulative_tracks: 30,
        inferred_games: ["maimai"],
        source: "obsidian-journal",
        source_paths: ["private/journal.md"],
        source_hashes: ["private-hash"],
      },
    ];
    mocks.query.mockResolvedValueOnce(rows);

    await expect(
      executeTool(
        "query_japan_activity",
        {
          view: "daily",
          metrics: ["maimai_plays", "ongeki_tracks"],
          start_date: "2026-06-01",
          end_date: "2026-06-30",
        },
        "japan",
      ),
    ).resolves.toEqual({
      view: "daily",
      metrics: ["maimai_plays", "ongeki_tracks"],
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      has_data: true,
      rows: [
        {
          play_date: "2026-06-01",
          maimai_play_count: 1,
          ongeki_track_count: 9,
          inferred_games: ["maimai"],
        },
      ],
      rowCount: 1,
    });

    expect(mocks.query).toHaveBeenCalledOnce();
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("FROM public.japan_daily_play");
    expect(sql).toContain("inferred_games");
    expect(sql).not.toContain("cumulative");
    expect(sql).not.toMatch(/source(?:_paths|_hashes)?/i);
    expect(sql).not.toContain("user_scores");
    expect(sql).not.toContain("2026-06-01");
    expect(params).toEqual(["2026-06-01", "2026-06-30"]);
  });

  it("returns only a requested Japan aggregate without Journal provenance", async () => {
    mocks.query.mockResolvedValueOnce([
      {
        maimai_plays: 108,
        chunithm_plays: 231,
        ongeki_tracks: 543,
        recorded_days: 60,
        maimai_estimated: true,
        chunithm_estimated: false,
        ongeki_estimated: false,
        source_paths: ["private/journal.md"],
        source_hashes: ["private-hash"],
      },
    ]);

    await expect(
      executeTool(
        "query_japan_activity",
        {
          view: "totals",
          metrics: ["ongeki_tracks"],
          start_date: "2026-01-01",
          end_date: "2026-12-31",
        },
        "japan",
      ),
    ).resolves.toEqual({
      view: "totals",
      metrics: ["ongeki_tracks"],
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      has_data: true,
      totals: { ongeki_tracks: 543 },
      estimated_metrics: [],
    });

    const [sql] = mocks.query.mock.calls[0];
    expect(sql).toContain("SUM(ongeki_track_count)");
    expect(sql).toContain("COUNT(*)::integer AS recorded_days");
    expect(sql).not.toMatch(/source_paths|source_hashes/i);
  });

  it("distinguishes an empty Japan aggregate range from observed zero activity", async () => {
    mocks.query.mockResolvedValueOnce([
      { maimai_plays: 0, recorded_days: 0 },
    ]);

    await expect(
      executeTool(
        "query_japan_activity",
        {
          view: "totals",
          metrics: ["maimai_plays"],
          start_date: "2030-01-01",
          end_date: "2030-12-31",
        },
        "japan",
      ),
    ).resolves.toMatchObject({
      view: "totals",
      metrics: ["maimai_plays"],
      has_data: false,
      totals: { maimai_plays: 0 },
      estimated_metrics: [],
    });
  });

  it("defaults a missing or malformed Japan view to privacy-safe totals", async () => {
    mocks.query.mockResolvedValue([
      { ongeki_tracks: 543, recorded_days: 60, ongeki_estimated: false },
    ]);

    for (const view of [undefined, "everything"]) {
      const result = await executeTool(
        "query_japan_activity",
        { view, metrics: ["ongeki_tracks"] },
        "japan",
      );
      expect(result).toMatchObject({
        view: "totals",
        totals: { ongeki_tracks: 543 },
      });
    }

    expect(mocks.query).toHaveBeenCalledTimes(2);
    for (const [sql] of mocks.query.mock.calls) {
      expect(sql).toContain("SUM(ongeki_track_count)");
      expect(sql).not.toContain("play_date,");
    }
  });

  it("requires an explicit bounded date range for Japan daily rows", async () => {
    await expect(
      executeTool(
        "query_japan_activity",
        {
          view: "daily",
          metrics: ["maimai_plays"],
          start_date: "2026-06-01",
        },
        "japan",
      ),
    ).resolves.toMatchObject({
      error: expect.stringContaining("requires both start_date and end_date"),
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("uses null date parameters when the range is omitted", async () => {
    await executeTool(
      "query_japan_activity",
      { view: "totals", metrics: ["maimai_plays"] },
      "japan",
    );
    expect(mocks.query.mock.calls[0][1]).toEqual([null, null]);
  });

  it.each([
    [{ start_date: "2026/06/01" }, "start_date must use YYYY-MM-DD"],
    [{ end_date: "2026-02-30" }, "end_date must be a valid calendar date"],
    [
      { start_date: "2026-07-01", end_date: "2026-06-01" },
      "start_date must be on or before end_date",
    ],
  ])("rejects invalid Japan date filters", async (args, error) => {
    await expect(
      executeTool(
        "query_japan_activity",
        { view: "daily", metrics: ["maimai_plays"], ...args },
        "japan",
      ),
    ).resolves.toMatchObject({ error: expect.stringContaining(error) });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("does not expose the Japan tool in International context", async () => {
    await expect(
      executeTool("query_japan_activity", {}, "international"),
    ).resolves.toMatchObject({
      error: expect.stringContaining("only in the Japan Journal view"),
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("declares structured view, metric, and date properties for Japan", () => {
    expect(JAPAN_ACTIVITY_TOOL).toMatchObject({
      type: "function",
      function: {
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["view", "metrics"],
          properties: {
            view: { type: "string", enum: ["totals", "daily"] },
            metrics: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "maimai_plays",
                  "chunithm_plays",
                  "ongeki_tracks",
                ],
              },
            },
            start_date: { type: "string" },
            end_date: { type: "string" },
          },
        },
      },
    });
  });
});
