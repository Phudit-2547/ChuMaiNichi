import { beforeEach, describe, expect, it, vi } from "vitest";

const neonQuery = vi.hoisted(() => vi.fn());

vi.mock("@neondatabase/serverless", () => ({
  neon: () => ({ query: neonQuery }),
}));

import {
  CODEX_MODEL_OPTIONS,
  CodexOAuthError,
  NeonCodexCredentialStore,
  type CodexAuthDependencies,
  type CodexCredentialRecord,
  type CodexCredentialStore,
  disconnectCodexOAuth,
  getCodexOAuthStatus,
  isCodexModelId,
  parseCodexOAuthEncryptionKey,
  pollPrivateCodexDeviceLogin,
  refreshCodexOAuthCredentials,
  resolveCodexOAuthCredentials,
  setCodexOAuthModel,
  startPrivateCodexDeviceLogin,
} from "./codex-auth";

const KEY_HEX = "11".repeat(32);
const NOW = new Date("2026-08-30T12:00:00.000Z");

function jwt(
  accountId: string,
  expiresAtSeconds: number,
  planType = "plus",
): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    exp: expiresAtSeconds,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: planType,
    },
  })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MemoryStore implements CodexCredentialStore {
  record: CodexCredentialRecord | null = null;
  private counter = 0;
  private leaseNowMs = NOW.getTime();

  private ensureRecord(): CodexCredentialRecord {
    if (!this.record) {
      this.record = {
        encryptedCredentials: null,
        selectedModel: null,
        revision: 1,
        pendingLoginId: null,
        refreshLockId: null,
        refreshLockUntil: null,
        updatedAt: NOW.toISOString(),
      };
    }
    return this.record;
  }

  private changedAt(): string {
    this.counter += 1;
    return new Date(NOW.getTime() + this.counter * 1000).toISOString();
  }

  advanceLeaseTime(milliseconds: number) {
    this.leaseNowMs += milliseconds;
  }

  async read() {
    return this.record ? { ...this.record } : null;
  }

  async beginLogin(loginId: string) {
    const current = this.ensureRecord();
    current.pendingLoginId = loginId;
    return { ...current };
  }

  async cancelLogin(loginId: string) {
    const current = this.ensureRecord();
    if (current.pendingLoginId === loginId) {
      current.pendingLoginId = null;
    }
  }

  async completeLogin(loginId: string, encryptedCredentials: string) {
    const current = this.ensureRecord();
    if (current.pendingLoginId !== loginId) return null;
    this.record = {
      encryptedCredentials,
      selectedModel: current.selectedModel,
      revision: current.revision + 1,
      pendingLoginId: null,
      refreshLockId: null,
      refreshLockUntil: null,
      updatedAt: this.changedAt(),
    };
    return { ...this.record };
  }

  async claimRefresh(
    expectedRevision: number,
    lockId: string,
    leaseSeconds: number,
  ) {
    const current = this.ensureRecord();
    if (
      !current.encryptedCredentials ||
      current.revision !== expectedRevision ||
      current.refreshLockId
    ) return null;
    current.refreshLockId = lockId;
    current.refreshLockUntil = new Date(
      this.leaseNowMs + leaseSeconds * 1000,
    ).toISOString();
    return { ...current };
  }

  async renewRefresh(
    expectedRevision: number,
    lockId: string,
    leaseSeconds: number,
  ) {
    const current = this.ensureRecord();
    if (
      !current.encryptedCredentials ||
      current.revision !== expectedRevision ||
      current.refreshLockId !== lockId
    ) return null;
    current.refreshLockUntil = new Date(
      this.leaseNowMs + leaseSeconds * 1000,
    ).toISOString();
    return { ...current };
  }

  async commitRefresh(
    expectedRevision: number,
    lockId: string,
    encryptedCredentials: string,
  ) {
    const current = this.ensureRecord();
    if (
      current.revision !== expectedRevision ||
      current.refreshLockId !== lockId
    ) return null;
    this.record = {
      ...current,
      encryptedCredentials,
      revision: current.revision + 1,
      refreshLockId: null,
      refreshLockUntil: null,
      updatedAt: this.changedAt(),
    };
    return { ...this.record };
  }

  async releaseRefresh(expectedRevision: number, lockId: string) {
    const current = this.ensureRecord();
    if (
      current.revision === expectedRevision &&
      current.refreshLockId === lockId
    ) {
      current.refreshLockId = null;
      current.refreshLockUntil = null;
    }
  }

  async setModel(model: "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna") {
    const current = this.ensureRecord();
    current.selectedModel = model;
    return { ...current };
  }

  async disconnect() {
    const current = this.ensureRecord();
    this.record = {
      encryptedCredentials: null,
      selectedModel: current.selectedModel,
      revision: current.revision + 1,
      pendingLoginId: null,
      refreshLockId: null,
      refreshLockUntil: null,
      updatedAt: this.changedAt(),
    };
    return { ...this.record };
  }
}

function dependencies(
  store: MemoryStore,
  fetchMock: unknown = vi.fn(),
  overrides: Partial<CodexAuthDependencies> = {},
): CodexAuthDependencies {
  return {
    encryptionKey: KEY_HEX,
    dashboardPassword: "dashboard-secret",
    store,
    fetch: fetchMock as unknown as typeof fetch,
    model: "gpt-5.6-terra",
    now: () => NOW,
    ...overrides,
  };
}

async function startLogin(
  store: MemoryStore,
  fetchMock: ReturnType<typeof vi.fn>,
) {
  fetchMock.mockResolvedValueOnce(jsonResponse({
    user_code: "ABCD-EFGH",
    device_auth_id: "device-auth-123",
    interval: 5,
  }));
  return startPrivateCodexDeviceLogin(dependencies(store, fetchMock));
}

describe("private Codex OAuth", () => {
  beforeEach(() => {
    neonQuery.mockReset();
  });

  it("accepts only exact 32-byte hex or canonical padded Base64 keys", () => {
    expect(parseCodexOAuthEncryptionKey(KEY_HEX)).toHaveLength(32);
    const base64 = Buffer.alloc(32, 7).toString("base64");
    expect(base64).toHaveLength(44);
    expect(parseCodexOAuthEncryptionKey(base64)).toEqual(Buffer.alloc(32, 7));
    expect(() => parseCodexOAuthEncryptionKey("short")).toThrow();
    expect(() => parseCodexOAuthEncryptionKey(base64.slice(0, -1))).toThrow();
    expect(() => parseCodexOAuthEncryptionKey(`hex:${KEY_HEX}`)).toThrow();
  });

  it("exposes an exact server-owned model allowlist", () => {
    expect(CODEX_MODEL_OPTIONS.map(({ id }) => id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(isCodexModelId("gpt-5.6-sol")).toBe(true);
    expect(isCodexModelId("gpt-5.6-terra")).toBe(true);
    expect(isCodexModelId("gpt-5.6-luna")).toBe(true);
    expect(isCodexModelId("gpt-5.6-terra; DROP TABLE x")).toBe(false);
    expect(isCodexModelId(123)).toBe(false);
  });

  it("persists model selection without touching OAuth lifecycle state", async () => {
    const store = new MemoryStore();
    store.record = {
      encryptedCredentials: "opaque-ciphertext",
      selectedModel: null,
      revision: 7,
      pendingLoginId: "pending-login",
      refreshLockId: "refresh-owner",
      refreshLockUntil: "2026-08-30T12:01:00.000Z",
      updatedAt: NOW.toISOString(),
    };
    const before = { ...store.record };
    const fetchMock = vi.fn();

    await expect(setCodexOAuthModel(
      "gpt-5.6-luna",
      dependencies(store, fetchMock, { encryptionKey: "" }),
    )).resolves.toEqual({
      model: "gpt-5.6-luna",
      model_options: CODEX_MODEL_OPTIONS,
      experimental: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.record).toEqual({
      ...before,
      selectedModel: "gpt-5.6-luna",
    });
  });

  it("rejects unsupported model selections before storage", async () => {
    const store = new MemoryStore();
    const setModel = vi.spyOn(store, "setModel");

    for (const model of [undefined, "", "gpt-5", 123]) {
      await expect(setCodexOAuthModel(
        model,
        dependencies(store),
      )).rejects.toMatchObject({
        code: "codex_auth_invalid_model",
        statusCode: 400,
        message: "Unsupported ChatGPT model",
      });
    }
    expect(setModel).not.toHaveBeenCalled();
  });

  it("never routes an unsupported configured model to Codex", async () => {
    const store = new MemoryStore();
    await expect(getCodexOAuthStatus(dependencies(store, vi.fn(), {
      dashboardPassword: "",
      model: "unsupported-private-model",
    }))).resolves.toMatchObject({
      model: "gpt-5.6-terra",
    });
  });

  it("does not read stored metadata when DASHBOARD_PASSWORD is unset", async () => {
    const store = new MemoryStore();
    const read = vi.spyOn(store, "read");
    const result = await getCodexOAuthStatus(dependencies(store, vi.fn(), {
      dashboardPassword: "",
    }));

    expect(result).toEqual({
      connected: false,
      configured: false,
      model: "gpt-5.6-terra",
      model_options: CODEX_MODEL_OPTIONS,
      experimental: true,
    });
    expect(read).not.toHaveBeenCalled();
    await expect(resolveCodexOAuthCredentials({
      dependencies: dependencies(store, vi.fn(), { dashboardPassword: "" }),
    })).rejects.toMatchObject({
      code: "codex_auth_not_configured",
      statusCode: 503,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("does not silently fall back for explicit malformed configuration", async () => {
    const store = new MemoryStore();
    await expect(resolveCodexOAuthCredentials({
      dependencies: dependencies(store, vi.fn(), {
        encryptionKey: "not-a-32-byte-key",
      }),
    })).rejects.toMatchObject({
      code: "codex_auth_not_configured",
      statusCode: 503,
      message: "CODEX_OAUTH_ENCRYPTION_KEY is invalid",
    });

    await expect(resolveCodexOAuthCredentials({
      dependencies: {
        encryptionKey: KEY_HEX,
        dashboardPassword: "dashboard-secret",
        databaseUrl: "",
      },
    })).rejects.toMatchObject({
      code: "codex_auth_not_configured",
      statusCode: 503,
    });
  });

  it("blocks fallback when a stored credential has lost its encryption key", async () => {
    const store = new MemoryStore();
    store.record = {
      encryptedCredentials: "opaque-existing-ciphertext",
      selectedModel: null,
      revision: 7,
      pendingLoginId: null,
      refreshLockId: null,
      refreshLockUntil: null,
      updatedAt: NOW.toISOString(),
    };

    await expect(resolveCodexOAuthCredentials({
      dependencies: dependencies(store, vi.fn(), { encryptionKey: "" }),
    })).rejects.toMatchObject({
      code: "codex_auth_not_configured",
      statusCode: 503,
      message: expect.stringContaining("restore it or reset"),
    });
    await expect(getCodexOAuthStatus(dependencies(store, vi.fn(), {
      encryptionKey: "",
    }))).resolves.toMatchObject({
      connected: false,
      configured: false,
      reset_required: true,
    });
    await expect(getCodexOAuthStatus(dependencies(store, vi.fn(), {
      encryptionKey: "malformed-key",
    }))).resolves.toMatchObject({ reset_required: true });

    store.record.encryptedCredentials = null;
    await expect(resolveCodexOAuthCredentials({
      dependencies: dependencies(store, vi.fn(), { encryptionKey: "" }),
    })).resolves.toBeNull();
    await expect(getCodexOAuthStatus(dependencies(store, vi.fn(), {
      encryptionKey: "",
    }))).resolves.not.toHaveProperty("reset_required");
  });

  it("starts an encrypted, opaque device login without exposing device_auth_id", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const result = await startLogin(store, fetchMock);

    expect(result).toMatchObject({
      status: "pending",
      user_code: "ABCD-EFGH",
      verification_url: "https://auth.openai.com/codex/device",
      interval_seconds: 5,
      expires_at: "2026-08-30T12:15:00.000Z",
      experimental: true,
    });
    expect(result.login_token).toMatch(/^v1\./);
    expect(result.login_token).not.toContain("device-auth-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        }),
      }),
    );
  });

  it("accepts the official usercode compatibility spelling", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      usercode: "ALIAS-CODE",
      device_auth_id: "device-auth-alias",
      interval: "7",
    }));

    await expect(startPrivateCodexDeviceLogin(
      dependencies(store, fetchMock),
    )).resolves.toMatchObject({
      status: "pending",
      user_code: "ALIAS-CODE",
      interval_seconds: 7,
    });
  });

  it("does not recreate pending login state when Disconnect wins during Start", async () => {
    const store = new MemoryStore();
    const upstream = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(upstream.promise);
    const starting = startPrivateCodexDeviceLogin(
      dependencies(store, fetchMock),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(store.record?.pendingLoginId).toBeTruthy();
    await disconnectCodexOAuth(dependencies(store, fetchMock));

    upstream.resolve(jsonResponse({
      user_code: "STALE-CODE",
      device_auth_id: "stale-device-auth",
      interval: 5,
    }));
    await expect(starting).rejects.toMatchObject({
      code: "codex_auth_login_superseded",
      statusCode: 409,
    });
    expect(store.record?.pendingLoginId).toBeNull();
    expect(store.record?.encryptedCredentials).toBeNull();
  });

  it("does not let an older Start response replace a newer login", async () => {
    const store = new MemoryStore();
    const olderUpstream = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(olderUpstream.promise)
      .mockResolvedValueOnce(jsonResponse({
        user_code: "NEWER-CODE",
        device_auth_id: "newer-device-auth",
        interval: 5,
      }));

    const olderStart = startPrivateCodexDeviceLogin(
      dependencies(store, fetchMock),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const olderLoginId = store.record?.pendingLoginId;

    const newerStart = await startPrivateCodexDeviceLogin(
      dependencies(store, fetchMock),
    );
    const newerLoginId = store.record?.pendingLoginId;
    expect(newerLoginId).toBeTruthy();
    expect(newerLoginId).not.toBe(olderLoginId);

    olderUpstream.resolve(jsonResponse({
      user_code: "OLDER-CODE",
      device_auth_id: "older-device-auth",
      interval: 5,
    }));
    await expect(olderStart).rejects.toMatchObject({
      code: "codex_auth_login_superseded",
      statusCode: 409,
    });
    expect(store.record?.pendingLoginId).toBe(newerLoginId);

    fetchMock.mockResolvedValueOnce(jsonResponse({}, 403));
    await expect(pollPrivateCodexDeviceLogin(
      newerStart.login_token,
      dependencies(store, fetchMock),
    )).resolves.toEqual({ status: "pending", experimental: true });
  });

  it("clears only its own pending nonce when Start fails upstream", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({}, 502));

    await expect(startPrivateCodexDeviceLogin(
      dependencies(store, fetchMock),
    )).rejects.toMatchObject({
      code: "codex_auth_upstream_unavailable",
      statusCode: 502,
    });
    expect(store.record?.pendingLoginId).toBeNull();
  });

  it("returns pending while the user has not approved the device code", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 403));

    await expect(pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    )).resolves.toEqual({ status: "pending", experimental: true });
    expect(store.record?.encryptedCredentials).toBeNull();
  });

  it("invalidates an in-flight device login on disconnect", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    const revisionBeforeDisconnect = store.record?.revision ?? 0;

    await disconnectCodexOAuth(dependencies(store, fetchMock));
    fetchMock.mockClear();

    await expect(pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    )).resolves.toEqual({ status: "expired", experimental: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.record?.revision).toBeGreaterThan(revisionBeforeDisconnect);
    expect(store.record?.pendingLoginId).toBeNull();
  });

  it("does not resurrect credentials when disconnect wins during token exchange", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    const exchange = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockReturnValueOnce(exchange.promise);

    const polling = pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await disconnectCodexOAuth(dependencies(store, fetchMock));
    exchange.resolve(jsonResponse({
      access_token: jwt(
        "stale-account",
        Math.floor(NOW.getTime() / 1000) + 3600,
      ),
      refresh_token: "stale-refresh",
    }));

    await expect(polling).resolves.toEqual({
      status: "expired",
      experimental: true,
    });
    expect(store.record?.encryptedCredentials).toBeNull();
  });

  it("exchanges the code, persists encrypted tokens, and exposes metadata only", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    const accessToken = jwt(
      "account-123",
      Math.floor(NOW.getTime() / 1000) + 3600,
    );
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: accessToken,
        refresh_token: "refresh-secret",
      }));

    const result = await pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );

    expect(result).toMatchObject({
      status: "connected",
      connected: true,
      configured: true,
      plan_type: "plus",
      model: "gpt-5.6-terra",
      experimental: true,
    });
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(JSON.stringify(result)).not.toContain("refresh-secret");
    expect(store.record?.encryptedCredentials).not.toContain(accessToken);
    expect(store.record?.encryptedCredentials).not.toContain("refresh-secret");

    await expect(getCodexOAuthStatus(dependencies(store, fetchMock)))
      .resolves.toMatchObject({
        connected: true,
        configured: true,
        plan_type: "plus",
      });
  });

  it("uses the persisted model across login, status, chat resolution, and disconnect", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    await setCodexOAuthModel(
      "gpt-5.6-sol",
      dependencies(store, fetchMock, { model: "gpt-5.6-terra" }),
    );
    const start = await startLogin(store, fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: jwt(
          "account-sol",
          Math.floor(NOW.getTime() / 1000) + 3600,
        ),
        refresh_token: "refresh-secret",
      }));

    await expect(pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    )).resolves.toMatchObject({ model: "gpt-5.6-sol" });
    await expect(getCodexOAuthStatus(dependencies(store, fetchMock)))
      .resolves.toMatchObject({ model: "gpt-5.6-sol" });
    await expect(resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    })).resolves.toMatchObject({ model: "gpt-5.6-sol" });
    await expect(disconnectCodexOAuth(dependencies(store, fetchMock)))
      .resolves.toMatchObject({ model: "gpt-5.6-sol" });
    expect(store.record?.selectedModel).toBe("gpt-5.6-sol");
  });

  it("rejects a tampered login token before calling upstream", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    fetchMock.mockClear();
    const tokenParts = start.login_token.split(".");
    tokenParts[2] = `${tokenParts[2][0] === "A" ? "B" : "A"}${tokenParts[2].slice(1)}`;
    const tampered = tokenParts.join(".");

    await expect(pollPrivateCodexDeviceLogin(
      tampered,
      dependencies(store, fetchMock),
    )).rejects.toMatchObject({
      code: "codex_auth_invalid_login_token",
      statusCode: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes expiring credentials and persists rotated refresh tokens", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    const expiringToken = jwt(
      "account-123",
      Math.floor(NOW.getTime() / 1000) + 30,
    );
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: expiringToken,
        refresh_token: "refresh-one",
      }));
    await pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );

    const refreshedToken = jwt(
      "account-123",
      Math.floor(NOW.getTime() / 1000) + 3600,
      "pro",
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({
      access_token: refreshedToken,
      refresh_token: "refresh-two",
    }));
    const resolved = await resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    });
    expect(resolved).toMatchObject({
      accessToken: refreshedToken,
      accountId: "account-123",
      planType: "pro",
      model: "gpt-5.6-terra",
    });
    const firstRefreshBody = String(fetchMock.mock.calls.at(-1)?.[1]?.body);
    expect(firstRefreshBody).toContain("refresh_token=refresh-one");

    const nextToken = jwt(
      "account-123",
      Math.floor(NOW.getTime() / 1000) + 7200,
      "pro",
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: nextToken }));
    const forced = await refreshCodexOAuthCredentials(
      dependencies(store, fetchMock),
    );
    expect(forced?.accessToken).toBe(nextToken);
    const secondRefreshBody = String(fetchMock.mock.calls.at(-1)?.[1]?.body);
    expect(secondRefreshBody).toContain("refresh_token=refresh-two");
  });

  it("keeps a concurrent model change while committing a rotated token", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: jwt(
          "account-123",
          Math.floor(NOW.getTime() / 1000) + 30,
        ),
        refresh_token: "refresh-one",
      }));
    await pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );

    fetchMock.mockReset();
    const upstreamRefresh = deferred<Response>();
    fetchMock.mockReturnValueOnce(upstreamRefresh.promise);
    const resolving = resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const revisionBeforeSelection = store.record?.revision;

    await setCodexOAuthModel(
      "gpt-5.6-luna",
      dependencies(store, fetchMock),
    );
    expect(store.record?.revision).toBe(revisionBeforeSelection);
    upstreamRefresh.resolve(jsonResponse({
      access_token: jwt(
        "account-123",
        Math.floor(NOW.getTime() / 1000) + 3600,
      ),
      refresh_token: "refresh-two",
    }));

    await expect(resolving).resolves.toMatchObject({
      model: "gpt-5.6-luna",
    });
    expect(store.record).toMatchObject({
      selectedModel: "gpt-5.6-luna",
      revision: (revisionBeforeSelection ?? 0) + 1,
      refreshLockId: null,
    });
  });

  it("serializes concurrent refreshes before consuming a rotating token", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: jwt(
          "account-123",
          Math.floor(NOW.getTime() / 1000) + 30,
        ),
        refresh_token: "one-time-refresh",
      }));
    await pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );

    fetchMock.mockReset();
    const upstreamRefresh = deferred<Response>();
    fetchMock.mockReturnValue(upstreamRefresh.promise);
    const first = resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const refreshedToken = jwt(
      "account-123",
      Math.floor(NOW.getTime() / 1000) + 3600,
    );
    upstreamRefresh.resolve(jsonResponse({
      access_token: refreshedToken,
      refresh_token: "rotated-refresh",
    }));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult?.accessToken).toBe(refreshedToken);
    expect(secondResult?.accessToken).toBe(refreshedToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets a competing resolver wait through a valid 23-second owner path", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: jwt(
          "account-123",
          Math.floor(NOW.getTime() / 1000) + 30,
        ),
        refresh_token: "one-time-refresh",
      }));
    await pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );

    fetchMock.mockReset();
    const revision = store.record?.revision ?? 0;
    const encrypted = store.record?.encryptedCredentials ?? "";
    await store.claimRefresh(revision, "valid-owner", 60);

    vi.useFakeTimers();
    try {
      let secondSettled = false;
      const second = resolveCodexOAuthCredentials({
        dependencies: dependencies(store, fetchMock),
      }).finally(() => {
        secondSettled = true;
      });

      // This is still inside a valid 15-second upstream + 10-second commit
      // owner path. The old 20-second waiter budget would already have failed.
      await vi.advanceTimersByTimeAsync(23_000);
      expect(secondSettled).toBe(false);
      await store.commitRefresh(revision, "valid-owner", encrypted);
      await vi.advanceTimersByTimeAsync(250);

      await expect(second).resolves.toMatchObject({
        accountId: "account-123",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews the fenced lease before a delayed rotated-token commit", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: jwt(
          "account-123",
          Math.floor(NOW.getTime() / 1000) + 30,
        ),
        refresh_token: "one-time-refresh",
      }));
    await pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );

    fetchMock.mockReset();
    const upstream = deferred<Response>();
    fetchMock.mockReturnValueOnce(upstream.promise);
    const originalCommit = store.commitRefresh.bind(store);
    const commitGate = deferred<void>();
    const commitStarted = deferred<void>();
    vi.spyOn(store, "commitRefresh").mockImplementation(async (...args) => {
      commitStarted.resolve();
      await commitGate.promise;
      return originalCommit(...args);
    });

    const first = resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    store.advanceLeaseTime(40_000);
    const refreshedToken = jwt(
      "account-123",
      Math.floor(NOW.getTime() / 1000) + 3600,
    );
    upstream.resolve(jsonResponse({
      access_token: refreshedToken,
      refresh_token: "rotated-refresh",
    }));
    await commitStarted.promise;

    const renewedUntil = Date.parse(store.record?.refreshLockUntil ?? "");
    expect(renewedUntil).toBeGreaterThan(NOW.getTime() + 60_000);
    // This is beyond the original T+60s lease, but within the renewed lease
    // established at T+40s. A competing resolver must wait, not replay RT1.
    store.advanceLeaseTime(25_000);
    const second = resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    commitGate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult?.accessToken).toBe(refreshedToken);
    expect(secondResult?.accessToken).toBe(refreshedToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled commit and preserves its renewed lease", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: jwt(
          "account-123",
          Math.floor(NOW.getTime() / 1000) + 30,
        ),
        refresh_token: "one-time-refresh",
      }));
    await pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      access_token: jwt(
        "account-123",
        Math.floor(NOW.getTime() / 1000) + 3600,
      ),
      refresh_token: "rotated-refresh",
    }));
    const neverCommits = deferred<CodexCredentialRecord | null>();
    const commit = vi.spyOn(store, "commitRefresh")
      .mockReturnValue(neverCommits.promise);

    vi.useFakeTimers();
    try {
      const refreshing = resolveCodexOAuthCredentials({
        dependencies: dependencies(store, fetchMock),
      });
      const rejected = expect(refreshing).rejects.toMatchObject({
        code: "codex_auth_storage_unavailable",
        statusCode: 503,
      });
      await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
      const lockId = store.record?.refreshLockId;
      expect(lockId).toBeTruthy();

      await vi.advanceTimersByTimeAsync(10_001);
      await rejected;
      // Commit outcome is uncertain, so releasing here would allow an
      // immediate replay of the already-consumed refresh token.
      expect(store.record?.refreshLockId).toBe(lockId);
      // The deadline is diagnostic, not permission to steal. Even well beyond
      // the renewed T+60s marker, no second owner may replay RT1.
      store.advanceLeaseTime(120_000);
      await expect(store.claimRefresh(
        store.record?.revision ?? 0,
        "competing-lock",
        60,
      )).resolves.toBeNull();
      await expect(getCodexOAuthStatus(dependencies(store, fetchMock, {
        now: () => new Date(NOW.getTime() + 120_000),
      }))).resolves.toMatchObject({
        connected: true,
        reset_required: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("poisons an ambiguous stalled refresh so RT1 is never replayed", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: jwt(
          "account-123",
          Math.floor(NOW.getTime() / 1000) + 30,
        ),
        refresh_token: "one-time-refresh",
      }));
    await pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(
      new ReadableStream<Uint8Array>({
        // Headers resolve immediately, but the body intentionally never does.
        start() {},
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    vi.useFakeTimers();
    try {
      const refreshing = resolveCodexOAuthCredentials({
        dependencies: dependencies(store, fetchMock),
      });
      const rejected = expect(refreshing).rejects.toMatchObject({
        code: "codex_auth_upstream_unavailable",
        statusCode: 502,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(store.record?.refreshLockId).toBeTruthy();

      await vi.advanceTimersByTimeAsync(15_001);
      await rejected;
      expect(store.record?.refreshLockId).toBeTruthy();
      store.advanceLeaseTime(120_000);
      await expect(resolveCodexOAuthCredentials({
        dependencies: dependencies(store, fetchMock, {
          now: () => new Date(NOW.getTime() + 120_000),
        }),
      })).rejects.toMatchObject({
        code: "codex_auth_refresh_state_unknown",
        statusCode: 409,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws a typed safe error when a stored refresh token is rejected", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: jwt(
          "account-123",
          Math.floor(NOW.getTime() / 1000) + 30,
        ),
        refresh_token: "refresh-secret",
      }));
    await pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: { message: "must not leak this upstream body" },
    }, 401));

    const promise = resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    });
    await expect(promise).rejects.toBeInstanceOf(CodexOAuthError);
    await expect(promise).rejects.toMatchObject({
      code: "codex_auth_reauthentication_required",
      statusCode: 401,
      message: "Codex authentication must be renewed",
    });
  });

  it("throws connection-changed when disconnect wins after selection", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: jwt(
          "account-123",
          Math.floor(NOW.getTime() / 1000) + 30,
        ),
        refresh_token: "refresh-one",
      }));
    await pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );
    vi.spyOn(store, "commitRefresh").mockImplementation(async () => {
      await store.disconnect();
      return null;
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({
      access_token: jwt(
        "account-123",
        Math.floor(NOW.getTime() / 1000) + 3600,
      ),
      refresh_token: "refresh-two",
    }));

    await expect(resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    })).rejects.toMatchObject({
      code: "codex_auth_connection_changed",
      statusCode: 409,
    });
  });

  it("prevents a stale refresh from overwriting a reconnected account", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const firstLogin = await startLogin(store, fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "first-authorization-code",
        code_verifier: "first-pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: jwt(
          "old-account",
          Math.floor(NOW.getTime() / 1000) + 30,
        ),
        refresh_token: "old-refresh",
      }));
    await pollPrivateCodexDeviceLogin(
      firstLogin.login_token,
      dependencies(store, fetchMock),
    );

    fetchMock.mockReset();
    const staleUpstream = deferred<Response>();
    fetchMock.mockReturnValueOnce(staleUpstream.promise);
    const staleResolve = resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    });
    await vi.waitFor(() => expect(store.record?.refreshLockId).not.toBeNull());

    await disconnectCodexOAuth(dependencies(store, fetchMock));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        user_code: "NEW-CODE",
        device_auth_id: "new-device-auth",
        interval: 5,
      }));
    const secondLogin = await startPrivateCodexDeviceLogin(
      dependencies(store, fetchMock),
    );
    const newToken = jwt(
      "new-account",
      Math.floor(NOW.getTime() / 1000) + 3600,
      "pro",
    );
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "second-authorization-code",
        code_verifier: "second-pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: newToken,
        refresh_token: "new-refresh",
      }));
    await pollPrivateCodexDeviceLogin(
      secondLogin.login_token,
      dependencies(store, fetchMock),
    );

    staleUpstream.resolve(jsonResponse({
      access_token: jwt(
        "old-account",
        Math.floor(NOW.getTime() / 1000) + 7200,
      ),
      refresh_token: "stale-rotated-refresh",
    }));
    const staleResult = await staleResolve;

    expect(staleResult).toMatchObject({
      accessToken: newToken,
      accountId: "new-account",
    });
    await expect(resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    })).resolves.toMatchObject({
      accessToken: newToken,
      accountId: "new-account",
    });
  });

  it("disconnects by preserving a monotonic tombstone", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn();
    const start = await startLogin(store, fetchMock);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "authorization-code",
        code_verifier: "pkce-verifier",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: jwt(
          "account-123",
          Math.floor(NOW.getTime() / 1000) + 3600,
        ),
        refresh_token: "refresh-secret",
      }));
    await pollPrivateCodexDeviceLogin(
      start.login_token,
      dependencies(store, fetchMock),
    );

    await expect(disconnectCodexOAuth(dependencies(store, fetchMock)))
      .resolves.toMatchObject({ connected: false, configured: true });
    expect(store.record).toMatchObject({
      encryptedCredentials: null,
      pendingLoginId: null,
    });
    await expect(resolveCodexOAuthCredentials({
      dependencies: dependencies(store, fetchMock),
    })).resolves.toBeNull();
  });

  it("can reset corrupt ciphertext without a usable encryption key", async () => {
    const store = new MemoryStore();
    store.record = {
      encryptedCredentials: "corrupt-or-encrypted-with-a-lost-key",
      selectedModel: null,
      revision: 9,
      pendingLoginId: "stale-login",
      refreshLockId: "stale-lock",
      refreshLockUntil: new Date(NOW.getTime() + 60_000).toISOString(),
      updatedAt: NOW.toISOString(),
    };

    await expect(getCodexOAuthStatus(dependencies(store)))
      .rejects.toMatchObject({ code: "codex_auth_stored_credentials_invalid" });
    await expect(disconnectCodexOAuth(dependencies(store, vi.fn(), {
      encryptionKey: "missing-or-invalid",
    }))).resolves.toEqual({
      connected: false,
      configured: false,
      model: "gpt-5.6-terra",
      model_options: CODEX_MODEL_OPTIONS,
      experimental: true,
    });
    expect(store.record).toMatchObject({
      encryptedCredentials: null,
      pendingLoginId: null,
      refreshLockId: null,
      revision: 10,
    });
    await expect(getCodexOAuthStatus(dependencies(store)))
      .resolves.toMatchObject({ connected: false, configured: true });
  });

  it("lazily creates the Neon table once per store instance", async () => {
    neonQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const store = new NeonCodexCredentialStore("postgresql://example.invalid/db");

    await expect(store.read()).resolves.toBeNull();
    await expect(store.read()).resolves.toBeNull();

    const ddlCalls = neonQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("CREATE TABLE IF NOT EXISTS"));
    expect(ddlCalls).toHaveLength(1);
    expect(neonQuery).toHaveBeenCalledTimes(5);
  });

  it("never lets Neon steal an expired refresh marker", async () => {
    neonQuery.mockResolvedValue([]);
    const store = new NeonCodexCredentialStore(
      "postgresql://example.invalid/fenced-refresh-test",
    );

    await store.claimRefresh(4, "first-lock", 60);
    await store.renewRefresh(4, "first-lock", 60);

    const claimSql = String(neonQuery.mock.calls[3]?.[0]);
    expect(claimSql).toContain("refresh_lock_id IS NULL");
    expect(claimSql).not.toContain("refresh_lock_until <= NOW()");
    const renewSql = String(neonQuery.mock.calls[4]?.[0]);
    expect(renewSql).toContain("revision = $1");
    expect(renewSql).toContain("refresh_lock_id = $2");
  });

  it("updates only selected_model in the Neon preference write", async () => {
    neonQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        encrypted_credentials: "opaque-ciphertext",
        selected_model: "gpt-5.6-luna",
        revision: "12",
        pending_login_id: "pending-login",
        refresh_lock_id: "refresh-owner",
        refresh_lock_until: "2026-08-30T12:01:00.000Z",
        updated_at: NOW.toISOString(),
      }]);
    const store = new NeonCodexCredentialStore(
      "postgresql://example.invalid/model-selection-test",
    );

    await expect(store.setModel("gpt-5.6-luna")).resolves.toMatchObject({
      encryptedCredentials: "opaque-ciphertext",
      selectedModel: "gpt-5.6-luna",
      revision: 12,
      pendingLoginId: "pending-login",
      refreshLockId: "refresh-owner",
      updatedAt: NOW.toISOString(),
    });
    const updateSql = String(neonQuery.mock.calls[3]?.[0]);
    expect(updateSql).toContain("SET selected_model = $1");
    expect(updateSql).not.toContain("revision =");
    expect(updateSql).not.toContain("updated_at =");
    expect(neonQuery.mock.calls[3]?.[1]).toEqual(["gpt-5.6-luna"]);
  });

  it("retries lazy schema creation after a transient failure", async () => {
    neonQuery
      .mockRejectedValueOnce(new Error("transient secret-bearing database error"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const store = new NeonCodexCredentialStore("postgresql://example.invalid/db");

    await expect(store.read()).rejects.toThrow();
    await expect(store.read()).resolves.toBeNull();

    const ddlCalls = neonQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("CREATE TABLE IF NOT EXISTS"));
    expect(ddlCalls).toHaveLength(2);
  });

  it("reuses the default Neon store and schema promise in a warm module", async () => {
    neonQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const productionLikeDependencies: CodexAuthDependencies = {
      databaseUrl: "postgresql://example.invalid/warm-cache-test",
      encryptionKey: KEY_HEX,
      dashboardPassword: "dashboard-secret",
      model: "gpt-5.6-terra",
      now: () => NOW,
    };

    await expect(getCodexOAuthStatus(productionLikeDependencies))
      .resolves.toMatchObject({ connected: false, configured: true });
    await expect(getCodexOAuthStatus(productionLikeDependencies))
      .resolves.toMatchObject({ connected: false, configured: true });

    const ddlCalls = neonQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("CREATE TABLE IF NOT EXISTS"));
    expect(ddlCalls).toHaveLength(1);
    expect(neonQuery).toHaveBeenCalledTimes(5);
  });
});
