import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// We need to import the module after setting up mocks
// Since the handler is a default export, we'll test the logic directly

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock environment
const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
  process.env.GITHUB_PAT = undefined;
  process.env.GITHUB_REPO = undefined;
  process.env.DASHBOARD_PASSWORD = undefined;
}

function createMockRequest(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: "POST",
    headers: {},
    query: {},
    ...overrides,
  } as VercelRequest;
}

function createMockResponse(): VercelResponse {
  const res: Partial<VercelResponse> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as VercelResponse;
}

describe("api/refresh.ts", () => {
  beforeEach(() => {
    resetEnv();
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Helper to dynamically import the handler (avoiding hoisting issues)
  async function getHandler() {
    const module = await import("./refresh");
    return module.default;
  }

  describe("Method validation", () => {
    it("returns 405 for GET requests", async () => {
      const handler = await getHandler();
      const req = createMockRequest({ method: "GET" });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.json).toHaveBeenCalledWith({ error: "Method not allowed" });
    });

    it("returns 405 for PUT requests", async () => {
      const handler = await getHandler();
      const req = createMockRequest({ method: "PUT" });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
    });
  });

  describe("Authentication", () => {
    it("returns 401 when Authorization header is missing and DASHBOARD_PASSWORD is set", async () => {
      process.env.DASHBOARD_PASSWORD = "testpassword";
      const handler = await getHandler();
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
    });

    it("returns 401 when Authorization header is invalid", async () => {
      process.env.DASHBOARD_PASSWORD = "testpassword";
      const handler = await getHandler();
      const req = createMockRequest({
        headers: { authorization: "Bearer wrongtoken" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("allows request when DASHBOARD_PASSWORD is not set", async () => {
      // No DASHBOARD_PASSWORD set - should allow
      const handler = await getHandler();
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();

      // Also mock successful GitHub API response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await handler(req, res);

      // Should not return 401
      expect(res.status).not.toHaveBeenCalledWith(401);
    });
  });

  describe("GitHub credentials validation", () => {
    it("returns 500 when GITHUB_PAT is missing", async () => {
      process.env.GITHUB_REPO = "owner/repo";
      const handler = await getHandler();
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "GitHub credentials not configured",
      });
    });

    it("returns 500 when GITHUB_REPO is missing", async () => {
      process.env.GITHUB_PAT = "test-pat";
      const handler = await getHandler();
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "GitHub credentials not configured",
      });
    });

    it("returns 500 when GITHUB_REPO has invalid format (no slash)", async () => {
      process.env.GITHUB_PAT = "test-pat";
      process.env.GITHUB_REPO = "invalid-repo-format";
      const handler = await getHandler();
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Invalid GITHUB_REPO format",
      });
    });
  });

  describe("GitHub API interaction", () => {
    it("calls GitHub API with correct parameters", async () => {
      process.env.GITHUB_PAT = "test-pat";
      process.env.GITHUB_REPO = "owner/repo";

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ workflow_runs: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              workflow_runs: [
                {
                  id: 123,
                  html_url:
                    "https://github.com/owner/repo/actions/runs/123",
                  status: "queued",
                  conclusion: null,
                  event: "workflow_dispatch",
                  head_branch: "main",
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ],
            }),
        });

      const handler = await getHandler();
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/owner/repo/actions/workflows/scrape-user-data.yml/dispatches",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-pat",
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ref: "main",
          }),
        }
      );
    });

    it("returns 500 when GitHub API returns error", async () => {
      process.env.GITHUB_PAT = "test-pat";
      process.env.GITHUB_REPO = "owner/repo";

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ workflow_runs: [] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          text: () => Promise.resolve("Forbidden"),
        });

      const handler = await getHandler();
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error:
          "GitHub API 403 while dispatching scrape-user-data.yml. Check that GITHUB_PAT has repository access plus Actions read/write permission. Forbidden",
      });
    });

    it("returns 200 with run_id and run_url on success", async () => {
      process.env.GITHUB_PAT = "test-pat";
      process.env.GITHUB_REPO = "owner/repo";

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ workflow_runs: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              workflow_runs: [
                {
                  id: 123,
                  html_url:
                    "https://github.com/owner/repo/actions/runs/123",
                  status: "queued",
                  conclusion: null,
                  event: "workflow_dispatch",
                  head_branch: "main",
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ],
            }),
        });

      const handler = await getHandler();
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        run_id: "123",
        run_url: "https://github.com/owner/repo/actions/runs/123",
      });
    });

    it("returns workflow status for a run_id poll", async () => {
      process.env.GITHUB_PAT = "test-pat";
      process.env.GITHUB_REPO = "owner/repo";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: 123,
            html_url: "https://github.com/owner/repo/actions/runs/123",
            status: "completed",
            conclusion: "success",
            event: "workflow_dispatch",
            head_branch: "main",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
      });

      const handler = await getHandler();
      const req = createMockRequest({
        method: "GET",
        query: { run_id: "123" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/owner/repo/actions/runs/123",
        {
          headers: {
            Authorization: "Bearer test-pat",
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        status: "completed",
        conclusion: "success",
        updated_at: expect.any(String),
        run_url: "https://github.com/owner/repo/actions/runs/123",
      });
    });
  });

  describe("Error handling", () => {
    it("returns 500 when fetch throws an error", async () => {
      process.env.GITHUB_PAT = "test-pat";
      process.env.GITHUB_REPO = "owner/repo";

      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const handler = await getHandler();
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Network error",
      });
    });
  });
});
