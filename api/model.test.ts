import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  checkAuth: vi.fn(() => true),
  resolveCodexOAuthCredentials: vi.fn(),
  createClient: vi.fn(),
  defaultModel: vi.fn(() => "fallback-model"),
}));

vi.mock("../src/api/auth.js", () => ({ checkAuth: mocks.checkAuth }));
vi.mock("../src/api/chat/client.js", () => ({
  createClient: mocks.createClient,
  defaultModel: mocks.defaultModel,
}));
vi.mock("../src/api/chat/codex-auth.js", () => ({
  CodexOAuthError: class MockCodexOAuthError extends Error {
    readonly code: string;
    readonly statusCode: number;

    constructor(code: string, statusCode: number, message: string) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  },
  resolveCodexOAuthCredentials: mocks.resolveCodexOAuthCredentials,
}));

import handler from "./model";

function request(): VercelRequest {
  return {
    method: "GET",
    headers: { authorization: "Bearer dashboard-password" },
  } as VercelRequest;
}

function response(): VercelResponse {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}

describe("api/model", () => {
  beforeEach(() => {
    mocks.checkAuth.mockReset().mockReturnValue(true);
    mocks.resolveCodexOAuthCredentials.mockReset().mockResolvedValue(null);
    mocks.createClient.mockReset().mockReturnValue({});
    mocks.defaultModel.mockReset().mockReturnValue("fallback-model");
  });

  it("reports a connected Codex model without requiring a fallback", async () => {
    mocks.resolveCodexOAuthCredentials.mockResolvedValueOnce({
      model: "gpt-5.6-luna",
    });
    const res = response();

    await handler(request(), res);

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ model: "gpt-5.6-luna" });
  });

  it("reports the configured fallback model while disconnected", async () => {
    const res = response();

    await handler(request(), res);

    expect(mocks.createClient).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ model: "fallback-model" });
  });

  it("does not advertise a default model when no provider is configured", async () => {
    mocks.createClient.mockImplementationOnce(() => {
      throw new Error("provider missing");
    });
    const res = response();

    await handler(request(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: "AI provider not configured",
    });
    expect(mocks.defaultModel).not.toHaveBeenCalled();
  });
});
