import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const core = vi.hoisted(() => {
  class MockCodexOAuthError extends Error {
    readonly code: string;
    readonly statusCode: number;
    readonly retryAfterSeconds?: number;

    constructor(
      code: string,
      statusCode: number,
      message: string,
      retryAfterSeconds?: number,
    ) {
      super(message);
      this.name = "CodexOAuthError";
      this.code = code;
      this.statusCode = statusCode;
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }

  return {
    MockCodexOAuthError,
    getStatus: vi.fn(),
    start: vi.fn(),
    poll: vi.fn(),
    disconnect: vi.fn(),
    setModel: vi.fn(),
  };
});

const MODEL_OPTIONS = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    description: "Highest capability for complex requests.",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    description: "Balanced capability and speed for everyday use.",
    recommended: true,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    description: "Fast and efficient for lighter requests.",
  },
];

vi.mock("../src/api/chat/codex-auth.js", () => {
  return {
    CodexOAuthError: core.MockCodexOAuthError,
    getCodexOAuthStatus: core.getStatus,
    startPrivateCodexDeviceLogin: core.start,
    pollPrivateCodexDeviceLogin: core.poll,
    disconnectCodexOAuth: core.disconnect,
    setCodexOAuthModel: core.setModel,
  };
});

import handler from "./codex-auth";

const originalEnv = { ...process.env };

function request(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: "GET",
    headers: {},
    query: {},
    ...overrides,
  } as VercelRequest;
}

function response(): VercelResponse {
  const result: Partial<VercelResponse> = {
    setHeader: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return result as VercelResponse;
}

describe("api/codex-auth", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DASHBOARD_PASSWORD;
    core.getStatus.mockReset().mockResolvedValue({
      connected: false,
      configured: false,
      model: "gpt-5.6-terra",
      model_options: MODEL_OPTIONS,
      experimental: true,
    });
    core.start.mockReset();
    core.poll.mockReset();
    core.disconnect.mockReset();
    core.setModel.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("allows a metadata-free GET when the dashboard password is unset", async () => {
    const req = request();
    const res = response();

    await handler(req, res);

    expect(core.getStatus).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      connected: false,
      configured: false,
      model: "gpt-5.6-terra",
      model_options: MODEL_OPTIONS,
      experimental: true,
    });
  });

  it("refuses POST when DASHBOARD_PASSWORD is unset", async () => {
    const req = request({ method: "POST", body: { action: "start" } });
    const res = response();

    await handler(req, res);

    expect(core.start).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: "Codex subscription auth requires DASHBOARD_PASSWORD",
      code: "codex_auth_not_configured",
      experimental: true,
    });
  });

  it("requires the dashboard password before reading connected status", async () => {
    process.env.DASHBOARD_PASSWORD = "dashboard-secret";
    const req = request();
    const res = response();

    await handler(req, res);

    expect(core.getStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  it("starts the device flow for an authenticated dashboard", async () => {
    process.env.DASHBOARD_PASSWORD = "dashboard-secret";
    core.start.mockResolvedValue({
      status: "pending",
      login_token: "opaque-login-token",
      user_code: "ABCD-EFGH",
      verification_url: "https://auth.openai.com/codex/device",
      interval_seconds: 5,
      expires_at: "2026-08-30T12:15:00.000Z",
      experimental: true,
    });
    const req = request({
      method: "POST",
      headers: { authorization: "Bearer dashboard-secret" },
      body: { action: "start" },
    });
    const res = response();

    await handler(req, res);

    expect(core.start).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = vi.mocked(res.json).mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toContain("access_token");
    expect(JSON.stringify(payload)).not.toContain("refresh_token");
  });

  it("polls only with a non-empty opaque login token", async () => {
    process.env.DASHBOARD_PASSWORD = "dashboard-secret";
    core.poll.mockResolvedValue({ status: "pending", experimental: true });
    const authenticated = { authorization: "Bearer dashboard-secret" };

    const missingRes = response();
    await handler(request({
      method: "POST",
      headers: authenticated,
      body: { action: "poll" },
    }), missingRes);
    expect(core.poll).not.toHaveBeenCalled();
    expect(missingRes.status).toHaveBeenCalledWith(400);

    const validRes = response();
    await handler(request({
      method: "POST",
      headers: authenticated,
      body: { action: "poll", login_token: "opaque" },
    }), validRes);
    expect(core.poll).toHaveBeenCalledWith("opaque");
    expect(validRes.json).toHaveBeenCalledWith({
      status: "pending",
      experimental: true,
    });
  });

  it("disconnects the encrypted credential row", async () => {
    process.env.DASHBOARD_PASSWORD = "dashboard-secret";
    core.disconnect.mockResolvedValue({
      connected: false,
      configured: true,
      model: "gpt-5.6-terra",
      model_options: MODEL_OPTIONS,
      experimental: true,
    });
    const res = response();

    await handler(request({
      method: "POST",
      headers: { authorization: "Bearer dashboard-secret" },
      body: { action: "disconnect" },
    }), res);

    expect(core.disconnect).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("allows authenticated reset when the encryption key is unavailable", async () => {
    process.env.DASHBOARD_PASSWORD = "dashboard-secret";
    delete process.env.CODEX_OAUTH_ENCRYPTION_KEY;
    core.disconnect.mockResolvedValue({
      connected: false,
      configured: false,
      model: "gpt-5.6-terra",
      model_options: MODEL_OPTIONS,
      experimental: true,
    });
    const res = response();

    await handler(request({
      method: "POST",
      headers: { authorization: "Bearer dashboard-secret" },
      body: { action: "disconnect" },
    }), res);

    expect(core.disconnect).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      connected: false,
      configured: false,
      model: "gpt-5.6-terra",
      model_options: MODEL_OPTIONS,
      experimental: true,
    });
  });

  it("persists an authenticated model selection", async () => {
    process.env.DASHBOARD_PASSWORD = "dashboard-secret";
    core.setModel.mockResolvedValue({
      model: "gpt-5.6-luna",
      model_options: MODEL_OPTIONS,
      experimental: true,
    });
    const res = response();

    await handler(request({
      method: "POST",
      headers: { authorization: "Bearer dashboard-secret" },
      body: { action: "set_model", model: "gpt-5.6-luna" },
    }), res);

    expect(core.setModel).toHaveBeenCalledWith("gpt-5.6-luna");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      model: "gpt-5.6-luna",
      model_options: MODEL_OPTIONS,
      experimental: true,
    });
  });

  it("returns a bounded error for an unsupported model", async () => {
    process.env.DASHBOARD_PASSWORD = "dashboard-secret";
    core.setModel.mockRejectedValueOnce(new core.MockCodexOAuthError(
      "codex_auth_invalid_model",
      400,
      "Unsupported ChatGPT model",
    ));
    const res = response();

    await handler(request({
      method: "POST",
      headers: { authorization: "Bearer dashboard-secret" },
      body: { action: "set_model", model: "attacker-controlled-model" },
    }), res);

    expect(core.setModel).toHaveBeenCalledWith("attacker-controlled-model");
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Unsupported ChatGPT model",
      code: "codex_auth_invalid_model",
      experimental: true,
    });
    expect(JSON.stringify(vi.mocked(res.json).mock.calls[0]?.[0]))
      .not.toContain("attacker-controlled-model");
  });

  it("returns 405 for unsupported methods", async () => {
    const res = response();
    await handler(request({ method: "DELETE" }), res);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: "Method not allowed" });
  });
});
