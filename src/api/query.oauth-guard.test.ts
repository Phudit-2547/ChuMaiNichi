import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryException } from "./query/errors";
import { runQuery } from "./query";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@neondatabase/serverless", () => ({
  neon: () => ({ query: mocks.query }),
}));

describe("dashboard query credential isolation", () => {
  beforeEach(() => {
    mocks.query.mockReset().mockResolvedValue([]);
  });

  it.each([
    "SELECT * FROM public.codex_oauth_credentials",
    'SELECT encrypted_credentials FROM public."codex_oauth_credentials"',
    String.raw`SELECT * FROM U&"codex\005foauth\005fcredentials"`,
    "SELECT query_to_xml('SELECT * FROM codex_' || 'oauth_credentials', true, true, '')",
    "SELECT pg_read_file('/tmp/anything')",
    "SELECT most_common_vals FROM pg_stats",
    "SELECT * FROM information_schema.columns",
  ])("rejects private credential SQL before it reaches Neon", async (sql) => {
    await expect(runQuery(sql, [], "postgresql://example")).rejects.toMatchObject({
      code: "FORBIDDEN_QUERY",
    } satisfies Partial<QueryException>);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("continues to execute ordinary read-only dashboard queries", async () => {
    mocks.query.mockResolvedValueOnce([{ value: 1 }]);

    await expect(
      runQuery("SELECT 1 AS value", [], "postgresql://example"),
    ).resolves.toEqual({ rows: [{ value: 1 }], rowCount: 1 });
    expect(mocks.query).toHaveBeenCalledOnce();
  });
});
