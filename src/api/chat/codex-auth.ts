import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { neon } from "@neondatabase/serverless";

/**
 * Private, experimental ChatGPT/Codex subscription integration.
 *
 * This is deliberately separate from the supported OpenAI Platform API-key
 * path. It mirrors the device flow used by Codex clients and talks to the
 * consumer Codex backend, whose contract may change without notice.
 */
export const PRIVATE_CODEX_BASE_URL =
  "https://chatgpt.com/backend-api/codex";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-terra";

export const CODEX_MODEL_OPTIONS = [
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
] as const;

export type CodexModelId = (typeof CODEX_MODEL_OPTIONS)[number]["id"];
export type CodexModelOption = (typeof CODEX_MODEL_OPTIONS)[number];

export function isCodexModelId(value: unknown): value is CodexModelId {
  return CODEX_MODEL_OPTIONS.some((option) => option.id === value);
}

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTH_ISSUER = "https://auth.openai.com";
const DEVICE_CODE_URL =
  `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL =
  `${CODEX_AUTH_ISSUER}/api/accounts/deviceauth/token`;
const OAUTH_TOKEN_URL = `${CODEX_AUTH_ISSUER}/oauth/token`;
const DEVICE_VERIFICATION_URL = `${CODEX_AUTH_ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${CODEX_AUTH_ISSUER}/deviceauth/callback`;
const DEVICE_LOGIN_LIFETIME_SECONDS = 15 * 60;
const DEFAULT_REFRESH_SKEW_SECONDS = 120;
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_BODY_BYTES = 128 * 1024;
// The upstream body is bounded to 15s. After it succeeds, renew the marker's
// diagnostic deadline before persisting the rotated token and bound that commit
// to 10s. The deadline never permits another invocation to steal the marker.
const REFRESH_LEASE_SECONDS = 60;
const REFRESH_COMMIT_TIMEOUT_MS = 10_000;
const REFRESH_WAIT_INTERVAL_MS = 250;
// A competing request must wait through the owner's complete sanctioned path:
// bounded upstream response + bounded commit + room for the intervening Neon
// renewal/read. Derive the attempt count so these time budgets cannot drift.
const REFRESH_WAIT_TIMEOUT_MS =
  UPSTREAM_TIMEOUT_MS + REFRESH_COMMIT_TIMEOUT_MS + 10_000;
const REFRESH_WAIT_ATTEMPTS = Math.ceil(
  REFRESH_WAIT_TIMEOUT_MS / REFRESH_WAIT_INTERVAL_MS,
);
const USER_AGENT = "ChuMaiNichi/0.0.0";
const LOGIN_AAD = Buffer.from(
  "chumainichi:private-codex-device-login:v1",
  "utf8",
);
const CREDENTIAL_AAD = Buffer.from(
  "chumainichi:private-codex-credentials:v1",
  "utf8",
);

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CodexOAuthErrorCode =
  | "codex_auth_not_configured"
  | "codex_auth_storage_unavailable"
  | "codex_auth_upstream_unavailable"
  | "codex_auth_rate_limited"
  | "codex_auth_login_superseded"
  | "codex_auth_connection_changed"
  | "codex_auth_refresh_state_unknown"
  | "codex_auth_invalid_login_token"
  | "codex_auth_invalid_upstream_response"
  | "codex_auth_invalid_model"
  | "codex_auth_stored_credentials_invalid"
  | "codex_auth_reauthentication_required";

/** A safe-to-surface error. It never contains an upstream body or token. */
export class CodexOAuthError extends Error {
  readonly code: CodexOAuthErrorCode;
  readonly statusCode: number;
  readonly retryAfterSeconds?: number;

  constructor(
    code: CodexOAuthErrorCode,
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

function codexConnectionChangedError(): CodexOAuthError {
  return new CodexOAuthError(
    "codex_auth_connection_changed",
    409,
    "ChatGPT connection changed while the request was starting; retry it",
  );
}

function codexRefreshStateUnknownError(): CodexOAuthError {
  return new CodexOAuthError(
    "codex_auth_refresh_state_unknown",
    409,
    "ChatGPT credential refresh may have completed remotely; reset the connection before retrying",
  );
}

function hasExpiredRefreshFence(
  record: CodexCredentialRecord,
  now: Date,
): boolean {
  if (!record.refreshLockId) return false;
  if (!record.refreshLockUntil) return true;
  const deadline = Date.parse(record.refreshLockUntil);
  return !Number.isFinite(deadline) || deadline <= now.getTime();
}

export type CodexCredentialRecord = {
  encryptedCredentials: string | null;
  selectedModel: CodexModelId | null;
  revision: number;
  pendingLoginId: string | null;
  refreshLockId: string | null;
  refreshLockUntil: string | null;
  updatedAt: string;
};

export interface CodexCredentialStore {
  read(): Promise<CodexCredentialRecord | null>;
  beginLogin(loginId: string): Promise<CodexCredentialRecord>;
  cancelLogin(loginId: string): Promise<void>;
  completeLogin(
    loginId: string,
    encryptedCredentials: string,
  ): Promise<CodexCredentialRecord | null>;
  claimRefresh(
    expectedRevision: number,
    lockId: string,
    leaseSeconds: number,
  ): Promise<CodexCredentialRecord | null>;
  renewRefresh(
    expectedRevision: number,
    lockId: string,
    leaseSeconds: number,
  ): Promise<CodexCredentialRecord | null>;
  commitRefresh(
    expectedRevision: number,
    lockId: string,
    encryptedCredentials: string,
  ): Promise<CodexCredentialRecord | null>;
  releaseRefresh(expectedRevision: number, lockId: string): Promise<void>;
  setModel(model: CodexModelId): Promise<CodexCredentialRecord>;
  disconnect(): Promise<CodexCredentialRecord>;
}

export interface CodexAuthDependencies {
  fetch?: FetchLike;
  store?: CodexCredentialStore;
  encryptionKey?: string;
  databaseUrl?: string;
  dashboardPassword?: string;
  model?: string;
  now?: () => Date;
}

export type CodexAuthStatus = {
  connected: boolean;
  configured: boolean;
  plan_type?: string;
  model: CodexModelId;
  model_options: readonly CodexModelOption[];
  updated_at?: string;
  reset_required?: true;
  experimental: true;
};

export type CodexModelSelection = {
  model: CodexModelId;
  model_options: readonly CodexModelOption[];
  experimental: true;
};

export type CodexDeviceLoginStart = {
  status: "pending";
  login_token: string;
  user_code: string;
  verification_url: string;
  interval_seconds: number;
  expires_at: string;
  experimental: true;
};

export type CodexDeviceLoginPoll =
  | { status: "pending"; experimental: true }
  | { status: "expired"; experimental: true }
  | ({ status: "connected" } & CodexAuthStatus);

export type CodexRuntimeCredentials = {
  accessToken: string;
  accountId: string;
  planType?: string;
  expiresAt: string;
  baseUrl: typeof PRIVATE_CODEX_BASE_URL;
  model: CodexModelId;
  updatedAt: string;
};

type RuntimeConfig = {
  key: Buffer;
  fetch: FetchLike;
  store: CodexCredentialStore;
  model: CodexModelId;
  now: () => Date;
};

type DisconnectConfig = {
  store: CodexCredentialStore;
  model: CodexModelId;
  configured: boolean;
};

type StoredCredentials = {
  kind: "private-codex-credentials";
  version: 1;
  access_token: string;
  refresh_token: string;
  received_at: string;
};

type DeviceLoginState = {
  kind: "private-codex-device-login";
  version: 1;
  device_auth_id: string;
  user_code: string;
  interval_seconds: number;
  login_id: string;
  issued_at: number;
  expires_at: number;
};

type JwtMetadata = {
  accountId: string;
  planType?: string;
  expiresAtSeconds: number;
};

type DatabaseRow = {
  encrypted_credentials: string | null;
  selected_model: string | null;
  revision: string | number;
  pending_login_id: string | null;
  refresh_lock_id: string | null;
  refresh_lock_until: string | Date | null;
  updated_at: string | Date;
};

export class NeonCodexCredentialStore implements CodexCredentialStore {
  private readonly sql: ReturnType<typeof neon>;
  private schemaReady: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      const attempt = (async () => {
        await this.sql.query(
          `CREATE TABLE IF NOT EXISTS public.codex_oauth_credentials (
             singleton_id SMALLINT PRIMARY KEY DEFAULT 1
                          CHECK (singleton_id = 1),
             encrypted_credentials TEXT,
             selected_model TEXT,
             revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
             pending_login_id TEXT,
             refresh_lock_id TEXT,
             refresh_lock_until TIMESTAMPTZ,
             updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
           )`,
        );
        // Idempotently migrate the short-lived pre-release schema whose
        // ciphertext column was NOT NULL and lacked lifecycle/lease columns.
        await this.sql.query(
          `ALTER TABLE public.codex_oauth_credentials
             ALTER COLUMN encrypted_credentials DROP NOT NULL,
             ADD COLUMN IF NOT EXISTS selected_model TEXT,
             ADD COLUMN IF NOT EXISTS pending_login_id TEXT,
             ADD COLUMN IF NOT EXISTS refresh_lock_id TEXT,
             ADD COLUMN IF NOT EXISTS refresh_lock_until TIMESTAMPTZ`,
        );
        // Keep a tombstone forever. Revision therefore never resets across a
        // disconnect/reconnect cycle and stale refreshes cannot ABA-match.
        await this.sql.query(
          `INSERT INTO public.codex_oauth_credentials
                  (singleton_id, encrypted_credentials, revision, updated_at)
           VALUES (1, NULL, 1, NOW())
           ON CONFLICT (singleton_id) DO NOTHING`,
        );
      })();
      this.schemaReady = attempt;
      try {
        await attempt;
      } catch (error) {
        // Cache only success. A transient Neon wake-up/network failure must not
        // permanently poison this warm serverless instance.
        if (this.schemaReady === attempt) this.schemaReady = null;
        throw error;
      }
      return;
    }
    await this.schemaReady;
  }

  async read(): Promise<CodexCredentialRecord | null> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `SELECT encrypted_credentials, selected_model, revision, pending_login_id,
              refresh_lock_id, refresh_lock_until, updated_at
         FROM public.codex_oauth_credentials
        WHERE singleton_id = 1`,
    )) as DatabaseRow[];
    return rows[0] ? databaseRowToRecord(rows[0]) : null;
  }

  async beginLogin(loginId: string): Promise<CodexCredentialRecord> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `INSERT INTO public.codex_oauth_credentials
              (singleton_id, encrypted_credentials, revision,
               pending_login_id, updated_at)
       VALUES (1, NULL, 1, $1, NOW())
       ON CONFLICT (singleton_id) DO UPDATE
         SET pending_login_id = EXCLUDED.pending_login_id
       RETURNING encrypted_credentials, selected_model, revision, pending_login_id,
                 refresh_lock_id, refresh_lock_until, updated_at`,
      [loginId],
    )) as DatabaseRow[];
    if (!rows[0]) {
      throw new Error("login begin returned no row");
    }
    return databaseRowToRecord(rows[0]);
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.ensureSchema();
    await this.sql.query(
      `UPDATE public.codex_oauth_credentials
          SET pending_login_id = NULL
        WHERE singleton_id = 1
          AND pending_login_id = $1`,
      [loginId],
    );
  }

  async completeLogin(
    loginId: string,
    encryptedCredentials: string,
  ): Promise<CodexCredentialRecord | null> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `UPDATE public.codex_oauth_credentials
          SET encrypted_credentials = $1,
              revision = revision + 1,
              pending_login_id = NULL,
              refresh_lock_id = NULL,
              refresh_lock_until = NULL,
              updated_at = NOW()
        WHERE singleton_id = 1
          AND pending_login_id = $2
       RETURNING encrypted_credentials, selected_model, revision, pending_login_id,
                 refresh_lock_id, refresh_lock_until, updated_at`,
      [encryptedCredentials, loginId],
    )) as DatabaseRow[];
    return rows[0] ? databaseRowToRecord(rows[0]) : null;
  }

  async claimRefresh(
    expectedRevision: number,
    lockId: string,
    leaseSeconds: number,
  ): Promise<CodexCredentialRecord | null> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `UPDATE public.codex_oauth_credentials
          SET refresh_lock_id = $1,
              refresh_lock_until = NOW() + ($3 * INTERVAL '1 second')
        WHERE singleton_id = 1
          AND encrypted_credentials IS NOT NULL
          AND revision = $2
          AND refresh_lock_id IS NULL
       RETURNING encrypted_credentials, selected_model, revision, pending_login_id,
                 refresh_lock_id, refresh_lock_until, updated_at`,
      [lockId, expectedRevision, leaseSeconds],
    )) as DatabaseRow[];
    return rows[0] ? databaseRowToRecord(rows[0]) : null;
  }

  async renewRefresh(
    expectedRevision: number,
    lockId: string,
    leaseSeconds: number,
  ): Promise<CodexCredentialRecord | null> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `UPDATE public.codex_oauth_credentials
          SET refresh_lock_until = NOW() + ($3 * INTERVAL '1 second')
        WHERE singleton_id = 1
          AND encrypted_credentials IS NOT NULL
          AND revision = $1
          AND refresh_lock_id = $2
       RETURNING encrypted_credentials, selected_model, revision, pending_login_id,
                 refresh_lock_id, refresh_lock_until, updated_at`,
      [expectedRevision, lockId, leaseSeconds],
    )) as DatabaseRow[];
    return rows[0] ? databaseRowToRecord(rows[0]) : null;
  }

  async commitRefresh(
    expectedRevision: number,
    lockId: string,
    encryptedCredentials: string,
  ): Promise<CodexCredentialRecord | null> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `UPDATE public.codex_oauth_credentials
          SET encrypted_credentials = $1,
              revision = revision + 1,
              refresh_lock_id = NULL,
              refresh_lock_until = NULL,
              updated_at = NOW()
        WHERE singleton_id = 1
          AND revision = $2
          AND refresh_lock_id = $3
       RETURNING encrypted_credentials, selected_model, revision, pending_login_id,
                 refresh_lock_id, refresh_lock_until, updated_at`,
      [encryptedCredentials, expectedRevision, lockId],
    )) as DatabaseRow[];
    return rows[0] ? databaseRowToRecord(rows[0]) : null;
  }

  async releaseRefresh(expectedRevision: number, lockId: string): Promise<void> {
    await this.ensureSchema();
    await this.sql.query(
      `UPDATE public.codex_oauth_credentials
          SET refresh_lock_id = NULL,
              refresh_lock_until = NULL
        WHERE singleton_id = 1
          AND revision = $1
          AND refresh_lock_id = $2`,
      [expectedRevision, lockId],
    );
  }

  async setModel(model: CodexModelId): Promise<CodexCredentialRecord> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `UPDATE public.codex_oauth_credentials
          SET selected_model = $1
        WHERE singleton_id = 1
       RETURNING encrypted_credentials, selected_model, revision,
                 pending_login_id, refresh_lock_id, refresh_lock_until,
                 updated_at`,
      [model],
    )) as DatabaseRow[];
    if (!rows[0]) throw new Error("model selection returned no row");
    return databaseRowToRecord(rows[0]);
  }

  async disconnect(): Promise<CodexCredentialRecord> {
    await this.ensureSchema();
    const rows = (await this.sql.query(
      `INSERT INTO public.codex_oauth_credentials
              (singleton_id, encrypted_credentials, revision, updated_at)
       VALUES (1, NULL, 1, NOW())
       ON CONFLICT (singleton_id) DO UPDATE
         SET encrypted_credentials = NULL,
             revision = public.codex_oauth_credentials.revision + 1,
             pending_login_id = NULL,
             refresh_lock_id = NULL,
             refresh_lock_until = NULL,
             updated_at = NOW()
       RETURNING encrypted_credentials, selected_model, revision, pending_login_id,
                 refresh_lock_id, refresh_lock_until, updated_at`,
    )) as DatabaseRow[];
    if (!rows[0]) throw new Error("disconnect returned no row");
    return databaseRowToRecord(rows[0]);
  }
}

let cachedDefaultNeonStore:
  | { databaseUrl: string; store: NeonCodexCredentialStore }
  | null = null;

function defaultNeonStore(databaseUrl: string): NeonCodexCredentialStore {
  // Vercel may reuse this module across requests in one warm instance. Keep the
  // successful lazy-schema promise alive with the store instead of issuing DDL
  // on every status/chat request. A changed DATABASE_URL gets a fresh store;
  // neither value is ever logged.
  if (cachedDefaultNeonStore?.databaseUrl !== databaseUrl) {
    cachedDefaultNeonStore = {
      databaseUrl,
      store: new NeonCodexCredentialStore(databaseUrl),
    };
  }
  return cachedDefaultNeonStore.store;
}

function databaseRowToRecord(row: DatabaseRow): CodexCredentialRecord {
  const revision = Number(row.revision);
  let updatedAt: string;
  try {
    updatedAt = new Date(row.updated_at).toISOString();
  } catch {
    throw new Error("invalid credential row");
  }
  if (
    (row.encrypted_credentials !== null &&
      typeof row.encrypted_credentials !== "string") ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error("invalid credential row");
  }
  return {
    encryptedCredentials: row.encrypted_credentials,
    selectedModel: isCodexModelId(row.selected_model)
      ? row.selected_model
      : null,
    revision,
    pendingLoginId: nonEmptyString(row.pending_login_id),
    refreshLockId: nonEmptyString(row.refresh_lock_id),
    refreshLockUntil: row.refresh_lock_until
      ? new Date(row.refresh_lock_until).toISOString()
      : null,
    updatedAt,
  };
}

function effectiveCodexModel(
  record: CodexCredentialRecord | null,
  configuredDefault: CodexModelId,
): CodexModelId {
  return record?.selectedModel ?? configuredDefault;
}

function configuredCodexModel(
  dependencies: CodexAuthDependencies,
): CodexModelId {
  const value = (
    dependencies.model ??
    process.env.CODEX_MODEL ??
    DEFAULT_CODEX_MODEL
  ).trim();
  return isCodexModelId(value) ? value : DEFAULT_CODEX_MODEL;
}

/**
 * Parse CODEX_OAUTH_ENCRYPTION_KEY.
 *
 * Accepted forms are intentionally strict: exactly 64 hexadecimal characters,
 * or canonical padded standard Base64 (44 characters ending in "=") that
 * decodes to exactly 32 bytes. Prefixes and base64url are not accepted.
 */
export function parseCodexOAuthEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }

  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32 && decoded.toString("base64") === value) {
      return decoded;
    }
  }

  throw new Error(
    "CODEX_OAUTH_ENCRYPTION_KEY must be 64 hex characters or canonical 44-character Base64 for exactly 32 bytes",
  );
}

function resolveRuntimeConfig(
  dependencies: CodexAuthDependencies,
): RuntimeConfig | null {
  const dashboardPassword =
    dependencies.dashboardPassword ?? process.env.DASHBOARD_PASSWORD;
  if (!dashboardPassword?.trim()) return null;

  const rawKey =
    dependencies.encryptionKey ?? process.env.CODEX_OAUTH_ENCRYPTION_KEY;
  if (!rawKey?.trim()) return null;

  let key: Buffer;
  try {
    key = parseCodexOAuthEncryptionKey(rawKey);
  } catch {
    return null;
  }

  let store = dependencies.store;
  if (!store) {
    const databaseUrl = dependencies.databaseUrl ?? process.env.DATABASE_URL;
    if (!databaseUrl?.trim()) return null;
    store = defaultNeonStore(databaseUrl);
  }

  return {
    key,
    fetch: dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    store,
    model: configuredCodexModel(dependencies),
    now: dependencies.now ?? (() => new Date()),
  };
}

function requireRuntimeConfig(
  dependencies: CodexAuthDependencies,
): RuntimeConfig {
  const config = resolveRuntimeConfig(dependencies);
  if (!config) {
    throw new CodexOAuthError(
      "codex_auth_not_configured",
      503,
      "Codex subscription auth is not configured",
    );
  }
  return config;
}

function requireDisconnectConfig(
  dependencies: CodexAuthDependencies,
): DisconnectConfig {
  const dashboardPassword =
    dependencies.dashboardPassword ?? process.env.DASHBOARD_PASSWORD;
  if (!dashboardPassword?.trim()) {
    throw new CodexOAuthError(
      "codex_auth_not_configured",
      503,
      "Codex subscription auth requires DASHBOARD_PASSWORD",
    );
  }

  let store = dependencies.store;
  if (!store) {
    const databaseUrl = dependencies.databaseUrl ?? process.env.DATABASE_URL;
    if (!databaseUrl?.trim()) {
      throw new CodexOAuthError(
        "codex_auth_not_configured",
        503,
        "Codex credential storage is not configured",
      );
    }
    store = defaultNeonStore(databaseUrl);
  }

  const rawKey =
    dependencies.encryptionKey ?? process.env.CODEX_OAUTH_ENCRYPTION_KEY;
  let configured = false;
  if (rawKey?.trim()) {
    try {
      parseCodexOAuthEncryptionKey(rawKey);
      configured = true;
    } catch {
      // Reset must remain available when a key was lost or misconfigured.
    }
  }

  return {
    store,
    model: configuredCodexModel(dependencies),
    configured,
  };
}

async function resolveChatRuntimeConfig(
  dependencies: CodexAuthDependencies,
): Promise<RuntimeConfig | null> {
  const dashboardPassword =
    dependencies.dashboardPassword ?? process.env.DASHBOARD_PASSWORD;
  const rawKey =
    dependencies.encryptionKey ?? process.env.CODEX_OAUTH_ENCRYPTION_KEY;
  const databaseUrl = dependencies.databaseUrl ?? process.env.DATABASE_URL;
  const availableStore = dependencies.store ?? (
    databaseUrl?.trim() ? defaultNeonStore(databaseUrl) : null
  );

  if (!rawKey?.trim()) {
    // No key normally means the optional subscription feature was never
    // enabled. But if secure storage still contains a credential, silently
    // selecting a metered provider would be a billing surprise. Detect that
    // recoverable misconfiguration without ever decrypting the row.
    if (dashboardPassword?.trim() && availableStore) {
      const record = await safeReadStore(availableStore);
      if (record?.encryptedCredentials) {
        throw new CodexOAuthError(
          "codex_auth_not_configured",
          503,
          "Stored ChatGPT credentials require CODEX_OAUTH_ENCRYPTION_KEY; restore it or reset the connection",
        );
      }
    }
    return null;
  }

  // A non-empty key is explicit subscription-integration intent. Any malformed
  // or incomplete secure configuration must surface instead of falling back to
  // a potentially metered provider.
  try {
    parseCodexOAuthEncryptionKey(rawKey);
  } catch {
    throw new CodexOAuthError(
      "codex_auth_not_configured",
      503,
      "CODEX_OAUTH_ENCRYPTION_KEY is invalid",
    );
  }
  if (!dashboardPassword?.trim()) {
    throw new CodexOAuthError(
      "codex_auth_not_configured",
      503,
      "Codex subscription auth requires DASHBOARD_PASSWORD",
    );
  }
  if (!availableStore) {
    throw new CodexOAuthError(
      "codex_auth_not_configured",
      503,
      "Codex credential storage is not configured",
    );
  }

  // Preconditions above make this non-null. Reuse the canonical constructor so
  // fetch/model/key behavior cannot drift between auth actions and chat.
  const config = resolveRuntimeConfig({
    ...dependencies,
    dashboardPassword,
    encryptionKey: rawKey,
    store: availableStore,
  });
  if (!config) {
    throw new CodexOAuthError(
      "codex_auth_not_configured",
      503,
      "Codex subscription auth is not configured",
    );
  }
  return config;
}

function encryptJson(value: unknown, key: Buffer, aad: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

function decryptJson(value: string, key: Buffer, aad: Buffer): unknown {
  if (value.length > 32_768) throw new Error("encrypted payload too large");
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("invalid encrypted payload");
  }
  const iv = Buffer.from(parts[1], "base64url");
  const ciphertext = Buffer.from(parts[2], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("invalid encrypted payload");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0
    ? number
    : null;
}

/** Decode the non-secret routing metadata needed for Codex requests. */
export function extractCodexJwtMetadata(accessToken: string): JwtMetadata {
  try {
    const segments = accessToken.split(".");
    if (segments.length < 2) throw new Error("not a JWT");
    const claims = asObject(
      JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")),
    );
    const authClaims = asObject(claims?.["https://api.openai.com/auth"]);
    const accountId = nonEmptyString(authClaims?.chatgpt_account_id);
    const planType =
      nonEmptyString(authClaims?.chatgpt_plan_type) ??
      nonEmptyString(claims?.chatgpt_plan_type) ??
      undefined;
    const expiresAtSeconds = positiveNumber(claims?.exp);
    if (!accountId || !expiresAtSeconds) {
      throw new Error("required JWT claims missing");
    }
    return { accountId, planType, expiresAtSeconds };
  } catch {
    throw new CodexOAuthError(
      "codex_auth_stored_credentials_invalid",
      500,
      "Stored Codex credentials are invalid",
    );
  }
}

function validateStoredCredentials(value: unknown): StoredCredentials {
  const payload = asObject(value);
  const accessToken = nonEmptyString(payload?.access_token);
  const refreshToken = nonEmptyString(payload?.refresh_token);
  if (
    payload?.kind !== "private-codex-credentials" ||
    payload.version !== 1 ||
    !accessToken ||
    !refreshToken
  ) {
    throw new CodexOAuthError(
      "codex_auth_stored_credentials_invalid",
      500,
      "Stored Codex credentials are invalid",
    );
  }
  return {
    kind: "private-codex-credentials",
    version: 1,
    access_token: accessToken,
    refresh_token: refreshToken,
    received_at: nonEmptyString(payload.received_at) ?? new Date(0).toISOString(),
  };
}

function decryptStoredCredentials(
  record: CodexCredentialRecord,
  key: Buffer,
): StoredCredentials {
  try {
    if (!record.encryptedCredentials) throw new Error("disconnected");
    return validateStoredCredentials(
      decryptJson(record.encryptedCredentials, key, CREDENTIAL_AAD),
    );
  } catch (error) {
    if (error instanceof CodexOAuthError) throw error;
    throw new CodexOAuthError(
      "codex_auth_stored_credentials_invalid",
      500,
      "Stored Codex credentials are invalid",
    );
  }
}

function validateDeviceLoginState(value: unknown): DeviceLoginState {
  const payload = asObject(value);
  const deviceAuthId = nonEmptyString(payload?.device_auth_id);
  const userCode = nonEmptyString(payload?.user_code);
  const intervalSeconds = positiveNumber(payload?.interval_seconds);
  const loginId = nonEmptyString(payload?.login_id);
  const issuedAt = positiveNumber(payload?.issued_at);
  const expiresAt = positiveNumber(payload?.expires_at);
  if (
    payload?.kind !== "private-codex-device-login" ||
    payload.version !== 1 ||
    !deviceAuthId ||
    !userCode ||
    !intervalSeconds ||
    !loginId ||
    !issuedAt ||
    !expiresAt ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > DEVICE_LOGIN_LIFETIME_SECONDS
  ) {
    throw new Error("invalid login state");
  }
  return {
    kind: "private-codex-device-login",
    version: 1,
    device_auth_id: deviceAuthId,
    user_code: userCode,
    interval_seconds: intervalSeconds,
    login_id: loginId,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
}

function decryptDeviceLoginState(token: string, key: Buffer): DeviceLoginState {
  try {
    if (!nonEmptyString(token)) throw new Error("missing token");
    return validateDeviceLoginState(decryptJson(token, key, LOGIN_AAD));
  } catch {
    throw new CodexOAuthError(
      "codex_auth_invalid_login_token",
      400,
      "Invalid or expired Codex login session",
    );
  }
}

function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = (async () => {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      // `fetch()` resolves when headers arrive. Consume and buffer the body
      // under the same deadline so a stalled token response is bounded. If its
      // outcome is ambiguous, the durable marker remains fenced until Reset.
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > MAX_UPSTREAM_BODY_BYTES) {
        controller.abort();
        throw new CodexOAuthError(
          "codex_auth_invalid_upstream_response",
          502,
          "Codex authentication service returned an invalid response",
        );
      }
      return new Response(body.byteLength > 0 ? body : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    })();
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new CodexOAuthError(
          "codex_auth_upstream_unavailable",
          502,
          "Codex authentication service is unavailable",
        ));
      }, UPSTREAM_TIMEOUT_MS);
    });
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (error instanceof CodexOAuthError) throw error;
    throw new CodexOAuthError(
      "codex_auth_upstream_unavailable",
      502,
      "Codex authentication service is unavailable",
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    const object = asObject(value);
    if (!object) throw new Error("not an object");
    return object;
  } catch {
    throw new CodexOAuthError(
      "codex_auth_invalid_upstream_response",
      502,
      "Codex authentication service returned an invalid response",
    );
  }
}

function throwForUpstreamStatus(response: Response): never {
  if (response.status === 429) {
    throw new CodexOAuthError(
      "codex_auth_rate_limited",
      429,
      "Codex authentication is temporarily rate limited",
      parseRetryAfter(response),
    );
  }
  throw new CodexOAuthError(
    "codex_auth_upstream_unavailable",
    502,
    "Codex authentication service is unavailable",
  );
}

async function safeReadStore(
  store: CodexCredentialStore,
): Promise<CodexCredentialRecord | null> {
  try {
    return await store.read();
  } catch {
    throw new CodexOAuthError(
      "codex_auth_storage_unavailable",
      503,
      "Codex credential storage is unavailable",
    );
  }
}

async function safeStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new CodexOAuthError(
      "codex_auth_storage_unavailable",
      503,
      "Codex credential storage is unavailable",
    );
  }
}

async function safeStoreOperationWithDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("credential store deadline exceeded")),
        timeoutMs,
      );
    });
    return await Promise.race([operation(), deadline]);
  } catch {
    throw new CodexOAuthError(
      "codex_auth_storage_unavailable",
      503,
      "Codex credential storage is unavailable",
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function runtimeCredentialsFromRecord(
  record: CodexCredentialRecord,
  stored: StoredCredentials,
  configuredDefault: CodexModelId,
): CodexRuntimeCredentials {
  const metadata = extractCodexJwtMetadata(stored.access_token);
  return {
    accessToken: stored.access_token,
    accountId: metadata.accountId,
    ...(metadata.planType ? { planType: metadata.planType } : {}),
    expiresAt: new Date(metadata.expiresAtSeconds * 1000).toISOString(),
    baseUrl: PRIVATE_CODEX_BASE_URL,
    model: effectiveCodexModel(record, configuredDefault),
    updatedAt: record.updatedAt,
  };
}

export async function getCodexOAuthStatus(
  dependencies: CodexAuthDependencies = {},
): Promise<CodexAuthStatus> {
  const model = configuredCodexModel(dependencies);
  const disconnected: CodexAuthStatus = {
    connected: false,
    configured: false,
    model,
    model_options: CODEX_MODEL_OPTIONS,
    experimental: true,
  };
  const dashboardPassword =
    dependencies.dashboardPassword ?? process.env.DASHBOARD_PASSWORD;
  if (!dashboardPassword?.trim()) return disconnected;

  const config = resolveRuntimeConfig(dependencies);
  if (!config) {
    const databaseUrl = dependencies.databaseUrl ?? process.env.DATABASE_URL;
    const store = dependencies.store ?? (
      databaseUrl?.trim() ? defaultNeonStore(databaseUrl) : null
    );
    if (!store) return disconnected;
    const record = await safeReadStore(store);
    const modelFromRecord = effectiveCodexModel(record, model);
    return record?.encryptedCredentials
      ? {
          ...disconnected,
          model: modelFromRecord,
          reset_required: true,
        }
      : { ...disconnected, model: modelFromRecord };
  }

  const record = await safeReadStore(config.store);
  if (!record?.encryptedCredentials) {
    return {
      ...disconnected,
      configured: true,
      model: effectiveCodexModel(record, config.model),
    };
  }
  const stored = decryptStoredCredentials(record, config.key);
  const metadata = extractCodexJwtMetadata(stored.access_token);
  return {
    connected: true,
    configured: true,
    ...(metadata.planType ? { plan_type: metadata.planType } : {}),
    model: effectiveCodexModel(record, config.model),
    model_options: CODEX_MODEL_OPTIONS,
    updated_at: record.updatedAt,
    ...(hasExpiredRefreshFence(record, config.now())
      ? { reset_required: true as const }
      : {}),
    experimental: true,
  };
}

export async function startPrivateCodexDeviceLogin(
  dependencies: CodexAuthDependencies = {},
): Promise<CodexDeviceLoginStart> {
  const config = requireRuntimeConfig(dependencies);
  const loginId = randomBytes(32).toString("base64url");
  // Register the operation before the comparatively slow upstream request.
  // Disconnect or a newer Start can now invalidate this nonce immediately;
  // an older response is never allowed to recreate pending state afterward.
  await safeStoreOperation(() => config.store.beginLogin(loginId));

  let userCode: string;
  let deviceAuthId: string;
  let intervalSeconds: number;
  try {
    const response = await fetchWithTimeout(config.fetch, DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        originator: "chumainichi",
      },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    });
    if (response.status !== 200) throwForUpstreamStatus(response);

    const data = await readJsonObject(response);
    // Official Codex accepts both spellings because the auth service has
    // emitted each shape (`UserCodeResp` serde aliases in device_code_auth.rs).
    userCode =
      nonEmptyString(data.user_code) ?? nonEmptyString(data.usercode) ?? "";
    deviceAuthId = nonEmptyString(data.device_auth_id) ?? "";
    if (!userCode || !deviceAuthId) {
      throw new CodexOAuthError(
        "codex_auth_invalid_upstream_response",
        502,
        "Codex authentication service returned an invalid response",
      );
    }
    intervalSeconds = Math.max(
      3,
      Math.min(60, Math.floor(positiveNumber(data.interval) ?? 5)),
    );
  } catch (error) {
    // Clear only this operation's nonce. If a newer Start already replaced it,
    // the conditional update is a no-op and the newer login remains valid.
    await safeStoreOperation(() => config.store.cancelLogin(loginId));
    throw error;
  }

  const issuedAt = Math.floor(config.now().getTime() / 1000);
  const expiresAt = issuedAt + DEVICE_LOGIN_LIFETIME_SECONDS;
  const state: DeviceLoginState = {
    kind: "private-codex-device-login",
    version: 1,
    device_auth_id: deviceAuthId,
    user_code: userCode,
    interval_seconds: intervalSeconds,
    login_id: loginId,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };

  const activeLogin = await safeReadStore(config.store);
  if (!activeLogin || activeLogin.pendingLoginId !== loginId) {
    throw new CodexOAuthError(
      "codex_auth_login_superseded",
      409,
      "Codex login was cancelled or replaced by a newer login",
    );
  }

  return {
    status: "pending",
    login_token: encryptJson(state, config.key, LOGIN_AAD),
    user_code: userCode,
    verification_url: DEVICE_VERIFICATION_URL,
    interval_seconds: intervalSeconds,
    expires_at: new Date(expiresAt * 1000).toISOString(),
    experimental: true,
  };
}

async function exchangeAuthorizationCode(
  config: RuntimeConfig,
  authorizationCode: string,
  codeVerifier: string,
): Promise<StoredCredentials> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: DEVICE_REDIRECT_URI,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const response = await fetchWithTimeout(config.fetch, OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: body.toString(),
  });
  if (response.status !== 200) throwForUpstreamStatus(response);

  const data = await readJsonObject(response);
  const accessToken = nonEmptyString(data.access_token);
  const refreshToken = nonEmptyString(data.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new CodexOAuthError(
      "codex_auth_invalid_upstream_response",
      502,
      "Codex authentication service returned an invalid response",
    );
  }
  extractCodexJwtMetadata(accessToken);
  return {
    kind: "private-codex-credentials",
    version: 1,
    access_token: accessToken,
    refresh_token: refreshToken,
    received_at: config.now().toISOString(),
  };
}

export async function pollPrivateCodexDeviceLogin(
  loginToken: string,
  dependencies: CodexAuthDependencies = {},
): Promise<CodexDeviceLoginPoll> {
  const config = requireRuntimeConfig(dependencies);
  const state = decryptDeviceLoginState(loginToken, config.key);
  const nowSeconds = Math.floor(config.now().getTime() / 1000);
  if (nowSeconds >= state.expires_at) {
    return { status: "expired", experimental: true };
  }

  // The durable nonce is replaced by a newer login and cleared by Disconnect.
  // Check before touching OpenAI so stale browser state cannot consume a code.
  const activeLogin = await safeReadStore(config.store);
  if (!activeLogin || activeLogin.pendingLoginId !== state.login_id) {
    return { status: "expired", experimental: true };
  }

  const response = await fetchWithTimeout(config.fetch, DEVICE_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      originator: "chumainichi",
    },
    body: JSON.stringify({
      device_auth_id: state.device_auth_id,
      user_code: state.user_code,
    }),
  });
  if (response.status === 403 || response.status === 404) {
    return { status: "pending", experimental: true };
  }
  if (response.status === 410) {
    return { status: "expired", experimental: true };
  }
  if (response.status !== 200) throwForUpstreamStatus(response);

  const data = await readJsonObject(response);
  const authorizationCode = nonEmptyString(data.authorization_code);
  const codeVerifier = nonEmptyString(data.code_verifier);
  if (!authorizationCode || !codeVerifier) {
    throw new CodexOAuthError(
      "codex_auth_invalid_upstream_response",
      502,
      "Codex authentication service returned an invalid response",
    );
  }

  const stored = await exchangeAuthorizationCode(
    config,
    authorizationCode,
    codeVerifier,
  );
  const encrypted = encryptJson(stored, config.key, CREDENTIAL_AAD);
  const record = await safeStoreOperation(() =>
    config.store.completeLogin(state.login_id, encrypted));
  if (!record) {
    // Disconnect or a newer login won while the upstream exchange was in
    // flight. Discard these plaintext tokens instead of resurrecting state.
    return { status: "expired", experimental: true };
  }
  const metadata = extractCodexJwtMetadata(stored.access_token);
  return {
    status: "connected",
    connected: true,
    configured: true,
    ...(metadata.planType ? { plan_type: metadata.planType } : {}),
    model: effectiveCodexModel(record, config.model),
    model_options: CODEX_MODEL_OPTIONS,
    updated_at: record.updatedAt,
    experimental: true,
  };
}

export async function setCodexOAuthModel(
  model: unknown,
  dependencies: CodexAuthDependencies = {},
): Promise<CodexModelSelection> {
  if (!isCodexModelId(model)) {
    throw new CodexOAuthError(
      "codex_auth_invalid_model",
      400,
      "Unsupported ChatGPT model",
    );
  }

  // Model preference is independent from the encrypted OAuth lifecycle. It
  // needs authenticated storage, but never the encryption key, and must not
  // change the credential revision or refresh fence.
  const config = requireDisconnectConfig(dependencies);
  const record = await safeStoreOperation(() => config.store.setModel(model));
  return {
    model: effectiveCodexModel(record, config.model),
    model_options: CODEX_MODEL_OPTIONS,
    experimental: true,
  };
}

export async function disconnectCodexOAuth(
  dependencies: CodexAuthDependencies = {},
): Promise<CodexAuthStatus> {
  const config = requireDisconnectConfig(dependencies);
  const record = await safeStoreOperation(() => config.store.disconnect());
  return {
    connected: false,
    configured: config.configured,
    model: effectiveCodexModel(record, config.model),
    model_options: CODEX_MODEL_OPTIONS,
    experimental: true,
  };
}

async function requestRefreshedCredentials(
  config: RuntimeConfig,
  stored: StoredCredentials,
): Promise<StoredCredentials> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });
  const response = await fetchWithTimeout(config.fetch, OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: body.toString(),
  });
  if (response.status === 429) {
    throw new CodexOAuthError(
      "codex_auth_rate_limited",
      429,
      "Codex authentication is temporarily rate limited",
      parseRetryAfter(response),
    );
  }
  if ([400, 401, 403].includes(response.status)) {
    throw new CodexOAuthError(
      "codex_auth_reauthentication_required",
      401,
      "Codex authentication must be renewed",
    );
  }
  if (response.status !== 200) throwForUpstreamStatus(response);

  const data = await readJsonObject(response);
  const accessToken = nonEmptyString(data.access_token);
  const refreshToken =
    nonEmptyString(data.refresh_token) ?? stored.refresh_token;
  if (!accessToken) {
    throw new CodexOAuthError(
      "codex_auth_invalid_upstream_response",
      502,
      "Codex authentication service returned an invalid response",
    );
  }
  extractCodexJwtMetadata(accessToken);
  return {
    kind: "private-codex-credentials",
    version: 1,
    access_token: accessToken,
    refresh_token: refreshToken,
    received_at: config.now().toISOString(),
  };
}

async function refreshRecord(
  config: RuntimeConfig,
  record: CodexCredentialRecord,
  stored: StoredCredentials,
): Promise<CodexRuntimeCredentials> {
  const lockId = randomBytes(24).toString("base64url");

  for (let attempt = 0; attempt < REFRESH_WAIT_ATTEMPTS; attempt++) {
    const claimed = await safeStoreOperation(() =>
      config.store.claimRefresh(
        record.revision,
        lockId,
        REFRESH_LEASE_SECONDS,
      ));

    if (claimed) {
      let refreshed: StoredCredentials;
      try {
        // Only the invocation holding the durable DB marker may consume the
        // potentially one-time refresh token.
        refreshed = await requestRefreshedCredentials(config, stored);
      } catch (error) {
        const knownPreRotationFailure =
          error instanceof CodexOAuthError &&
          (error.code === "codex_auth_rate_limited" ||
            error.code === "codex_auth_reauthentication_required");
        if (knownPreRotationFailure) {
          await safeStoreOperation(() =>
            config.store.releaseRefresh(record.revision, lockId));
        }
        const latest = await safeReadStore(config.store);
        if (!latest?.encryptedCredentials) {
          throw codexConnectionChangedError();
        }
        if (latest.revision !== record.revision) {
          const latestStored = decryptStoredCredentials(latest, config.key);
          return runtimeCredentialsFromRecord(
            latest,
            latestStored,
            config.model,
          );
        }
        // Network errors, 5xx responses, invalid success bodies, and timeouts
        // are ambiguous: OpenAI may already have consumed RT1. Keep the marker
        // indefinitely so no invocation can replay RT1; authenticated Reset is
        // the recovery path if this owner cannot commit RT2.
        throw error;
      }

      const encrypted = encryptJson(refreshed, config.key, CREDENTIAL_AAD);
      // Receiving RT2 consumes (or may consume) RT1 upstream. Extend our
      // fenced marker before persistence so another invocation cannot claim the
      // still-old database row while this commit is in flight.
      const renewed = await safeStoreOperation(() =>
        config.store.renewRefresh(
          record.revision,
          lockId,
          REFRESH_LEASE_SECONDS,
        ));
      if (!renewed) {
        const latest = await safeReadStore(config.store);
        if (!latest?.encryptedCredentials) {
          throw codexConnectionChangedError();
        }
        if (latest.revision !== record.revision) {
          const latestStored = decryptStoredCredentials(latest, config.key);
          return runtimeCredentialsFromRecord(
            latest,
            latestStored,
            config.model,
          );
        }
        throw new CodexOAuthError(
          "codex_auth_storage_unavailable",
          503,
          "Codex credential refresh ownership was lost",
        );
      }

      // A timed-out Neon call has an uncertain outcome and may still complete
      // server-side. Do not release the marker on this path. The revision +
      // lock-id fence makes a delayed commit harmless if a later owner wins,
      // while the non-stealable marker prevents replay of consumed RT1 even
      // after its diagnostic deadline. Reset is the fail-closed recovery.
      const updated = await safeStoreOperationWithDeadline(() =>
        config.store.commitRefresh(
          record.revision,
          lockId,
          encrypted,
        ), REFRESH_COMMIT_TIMEOUT_MS);
      if (updated) {
        return runtimeCredentialsFromRecord(updated, refreshed, config.model);
      }

      // Disconnect or a completed login invalidated the generation while the
      // refresh request was in flight. Never overwrite that newer decision.
      const latest = await safeReadStore(config.store);
      if (!latest?.encryptedCredentials) {
        throw codexConnectionChangedError();
      }
      if (latest.revision !== record.revision) {
        const latestStored = decryptStoredCredentials(latest, config.key);
        return runtimeCredentialsFromRecord(latest, latestStored, config.model);
      }
      break;
    }

    const latest = await safeReadStore(config.store);
    if (!latest?.encryptedCredentials) {
      throw codexConnectionChangedError();
    }
    if (latest.revision !== record.revision) {
      const latestStored = decryptStoredCredentials(latest, config.key);
      return runtimeCredentialsFromRecord(latest, latestStored, config.model);
    }
    if (hasExpiredRefreshFence(latest, config.now())) {
      throw codexRefreshStateUnknownError();
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, REFRESH_WAIT_INTERVAL_MS));
  }

  throw new CodexOAuthError(
    "codex_auth_storage_unavailable",
    503,
    "Codex credential refresh is already in progress",
  );
}

export type ResolveCodexOAuthOptions = {
  forceRefresh?: boolean;
  refreshSkewSeconds?: number;
  dependencies?: CodexAuthDependencies;
};

/**
 * Resolve server-only Codex credentials for the chat transport.
 *
 * Returns null only when the optional feature is genuinely absent with no
 * stored credential, or when the initial row is a disconnect tombstone.
 * Explicit misconfiguration, post-selection Disconnect, and invalid or
 * unrefreshable rows throw CodexOAuthError so callers never silently fall back
 * to a metered provider and hide an authentication failure.
 */
export async function resolveCodexOAuthCredentials(
  options: ResolveCodexOAuthOptions = {},
): Promise<CodexRuntimeCredentials | null> {
  const config = await resolveChatRuntimeConfig(options.dependencies ?? {});
  if (!config) return null;
  const record = await safeReadStore(config.store);
  if (!record?.encryptedCredentials) return null;
  const stored = decryptStoredCredentials(record, config.key);
  const metadata = extractCodexJwtMetadata(stored.access_token);
  const skew = Math.max(
    0,
    Math.min(600, options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS),
  );
  const shouldRefresh =
    options.forceRefresh === true ||
    metadata.expiresAtSeconds <= config.now().getTime() / 1000 + skew;
  if (shouldRefresh) return refreshRecord(config, record, stored);
  return runtimeCredentialsFromRecord(record, stored, config.model);
}

export async function refreshCodexOAuthCredentials(
  dependencies: CodexAuthDependencies = {},
): Promise<CodexRuntimeCredentials | null> {
  return resolveCodexOAuthCredentials({
    forceRefresh: true,
    dependencies,
  });
}
