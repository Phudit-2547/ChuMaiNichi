import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import {
  CodexAuthRequestError,
  disconnectCodexAuth,
  fetchCodexAuthStatus,
  nextCodexAuthPollDelay,
  pollCodexAuth,
  requiresCodexAuthReset,
  setCodexModel,
  startCodexAuth,
  statusRequiresCodexAuthReset,
} from "./codex-auth";

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    ...actual,
    default: { ...actual.default, get: vi.fn(), post: vi.fn() },
  };
});

vi.mock("@/features/auth/stores/auth-store", () => ({
  default: {
    getState: () => ({
      getAuthHeaders: () => ({ Authorization: "Bearer dashboard-password" }),
    }),
  },
}));

const get = vi.mocked(axios.get);
const post = vi.mocked(axios.post);

describe("Codex auth API client", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  it("reads status with dashboard authorization", async () => {
    const status = {
      connected: false,
      configured: true,
      experimental: true as const,
    };
    get.mockResolvedValueOnce({ data: status });

    await expect(fetchCodexAuthStatus()).resolves.toEqual(status);
    expect(get).toHaveBeenCalledWith("/api/codex-auth", {
      headers: { Authorization: "Bearer dashboard-password" },
      signal: undefined,
    });
  });

  it("preserves the server-side reset-required recovery state", async () => {
    const status = {
      connected: false,
      configured: false,
      reset_required: true as const,
      experimental: true as const,
    };
    get.mockResolvedValueOnce({ data: status });

    const result = await fetchCodexAuthStatus();

    expect(result).toEqual(status);
    expect(statusRequiresCodexAuthReset(result)).toBe(true);
    expect(
      statusRequiresCodexAuthReset({
        connected: false,
        configured: true,
        experimental: true,
      }),
    ).toBe(false);
  });

  it("identifies an unreadable stored credential as resettable", async () => {
    get.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 500,
        data: {
          error: "Stored Codex credentials are invalid",
          code: "codex_auth_stored_credentials_invalid",
        },
        headers: {},
      },
    });

    const error = await fetchCodexAuthStatus().catch(
      (requestError: unknown) => requestError,
    );

    expect(error).toMatchObject({
      serverCode: "codex_auth_stored_credentials_invalid",
      statusCode: 500,
    });
    expect(requiresCodexAuthReset(error)).toBe(true);
    expect(requiresCodexAuthReset(new Error("unrelated"))).toBe(false);
  });

  it("starts a device login with dashboard authorization", async () => {
    const response = {
      status: "pending" as const,
      login_token: "memory-only-token",
      user_code: "ABCD-EFGH",
      verification_url: "https://example.com/device",
      interval_seconds: 5,
      expires_at: "2030-01-01T00:00:00.000Z",
    };
    post.mockResolvedValueOnce({ data: response });

    await expect(startCodexAuth()).resolves.toEqual(response);
    expect(post).toHaveBeenCalledWith(
      "/api/codex-auth",
      { action: "start" },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer dashboard-password",
        }),
      }),
    );
  });

  it("sends the login token only in a poll request body", async () => {
    post.mockResolvedValueOnce({ data: { status: "pending" } });

    await pollCodexAuth("memory-only-token");

    expect(post).toHaveBeenCalledWith(
      "/api/codex-auth",
      { action: "poll", login_token: "memory-only-token" },
      expect.any(Object),
    );
  });

  it("preserves OAuth error metadata and backs off to Retry-After", async () => {
    post.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 429,
        data: {
          error: "Codex authentication is temporarily rate limited",
          code: "codex_auth_rate_limited",
        },
        headers: { "retry-after": "17" },
      },
    });

    const error = await pollCodexAuth("memory-only-token").catch(
      (requestError: unknown) => requestError,
    );

    expect(error).toBeInstanceOf(CodexAuthRequestError);
    expect(error).toMatchObject({
      serverCode: "codex_auth_rate_limited",
      statusCode: 429,
      retryAfterSeconds: 17,
    });
    expect(nextCodexAuthPollDelay(error, 5_000)).toBe(17_000);
  });

  it("stops polling when the encrypted login token is invalid", async () => {
    post.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: "Invalid or expired Codex login session",
          code: "codex_auth_invalid_login_token",
        },
        headers: {},
      },
    });

    const error = await pollCodexAuth("invalid-token").catch(
      (requestError: unknown) => requestError,
    );

    expect(error).toMatchObject({
      serverCode: "codex_auth_invalid_login_token",
      statusCode: 400,
    });
    expect(nextCodexAuthPollDelay(error, 5_000)).toBeNull();
  });

  it("forwards an AbortSignal when starting device login", async () => {
    const controller = new AbortController();
    post.mockResolvedValueOnce({
      data: {
        status: "pending",
        login_token: "memory-only-token",
        user_code: "ABCD-EFGH",
        verification_url: "https://auth.openai.com/codex/device",
        interval_seconds: 5,
        expires_at: "2030-01-01T00:00:00.000Z",
      },
    });

    await startCodexAuth(controller.signal);

    expect(post).toHaveBeenCalledWith(
      "/api/codex-auth",
      { action: "start" },
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("disconnects the server-side subscription session", async () => {
    const status = {
      connected: false,
      configured: true,
      model: "gpt-5-codex",
      experimental: true as const,
    };
    post.mockResolvedValueOnce({ data: status });

    await expect(disconnectCodexAuth()).resolves.toEqual(status);
    expect(post).toHaveBeenCalledWith(
      "/api/codex-auth",
      { action: "disconnect" },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer dashboard-password",
        }),
      }),
    );
  });

  it("persists a model selection with dashboard authorization", async () => {
    const selection = {
      model: "gpt-5.6-luna",
      model_options: [{
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        description: "Fast and efficient for lighter requests.",
      }],
      experimental: true as const,
    };
    const controller = new AbortController();
    post.mockResolvedValueOnce({ data: selection });

    await expect(setCodexModel(
      "gpt-5.6-luna",
      controller.signal,
    )).resolves.toEqual(selection);
    expect(post).toHaveBeenCalledWith(
      "/api/codex-auth",
      { action: "set_model", model: "gpt-5.6-luna" },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer dashboard-password",
        }),
        signal: controller.signal,
      }),
    );
  });
});
