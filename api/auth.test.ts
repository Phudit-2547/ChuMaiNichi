import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import handler from "./auth";

const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
  process.env.DASHBOARD_PASSWORD = undefined;
}

function createMockRequest(
  overrides: Partial<VercelRequest> = {},
): VercelRequest {
  return {
    method: "GET",
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

describe("api/auth.ts", () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Method validation", () => {
    it("returns 405 for POST requests", () => {
      const req = createMockRequest({ method: "POST" });
      const res = createMockResponse();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.json).toHaveBeenCalledWith({ error: "Method not allowed" });
    });
  });

  describe("Authentication", () => {
    it("returns 401 when password is set but Authorization header is missing", () => {
      process.env.DASHBOARD_PASSWORD = "testpassword";
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
    });

    it("returns 401 when the token does not match", () => {
      process.env.DASHBOARD_PASSWORD = "testpassword";
      const req = createMockRequest({
        headers: { authorization: "Bearer wrongtoken" },
      });
      const res = createMockResponse();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("returns 200 when the token matches", () => {
      process.env.DASHBOARD_PASSWORD = "testpassword";
      const req = createMockRequest({
        headers: { authorization: "Bearer testpassword" },
      });
      const res = createMockResponse();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    it("returns 200 when DASHBOARD_PASSWORD is not set (auth disabled)", () => {
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });
  });

  describe("Database independence", () => {
    it("succeeds with a valid password even when DATABASE_URL is unset", () => {
      process.env.DASHBOARD_PASSWORD = "testpassword";
      process.env.DATABASE_URL = undefined;
      const req = createMockRequest({
        headers: { authorization: "Bearer testpassword" },
      });
      const res = createMockResponse();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true });
    });
  });
});
