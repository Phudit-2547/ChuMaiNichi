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

  it("does not offer score-based suggestions in the Japan context", async () => {
    await expect(
      executeTool("maimai_suggest_songs", {}, "japan"),
    ).resolves.toMatchObject({
      error: expect.stringContaining("play counts only"),
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("runs one static Japan SELECT with validated date parameters", async () => {
    const rows = [
      {
        play_date: "2026-06-01",
        maimai_play_count: 1,
        chunithm_play_count: 0,
        ongeki_track_count: 9,
        inferred_games: ["maimai"],
      },
    ];
    mocks.query.mockResolvedValueOnce(rows);

    await expect(
      executeTool(
        "query_japan_activity",
        {
          start_date: "2026-06-01",
          end_date: "2026-06-30",
          sql: "SELECT * FROM public.user_scores",
        },
        "japan",
      ),
    ).resolves.toEqual({
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      rows,
      rowCount: 1,
    });

    expect(mocks.query).toHaveBeenCalledOnce();
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("FROM public.japan_daily_play");
    expect(sql).toContain("inferred_games");
    expect(sql).toContain("source_paths");
    expect(sql).not.toContain("user_scores");
    expect(sql).not.toContain("2026-06-01");
    expect(params).toEqual(["2026-06-01", "2026-06-30"]);
  });

  it("uses null date parameters when the range is omitted", async () => {
    await executeTool("query_japan_activity", {}, "japan");
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
      executeTool("query_japan_activity", args, "japan"),
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

  it("declares only structured date properties for Japan", () => {
    expect(JAPAN_ACTIVITY_TOOL).toMatchObject({
      type: "function",
      function: {
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            start_date: { type: "string" },
            end_date: { type: "string" },
          },
        },
      },
    });
  });
});
