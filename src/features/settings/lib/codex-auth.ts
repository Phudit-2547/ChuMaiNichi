import axios from "axios";
import useAuthStore from "@/features/auth/stores/auth-store";
import {
  SharedErrorHandler,
  type GeneralErrorCode,
} from "@/global/lib/error-handling";

export class CodexAuthRequestError extends Error {
  readonly generalCode: GeneralErrorCode;
  readonly serverCode?: string;
  readonly statusCode?: number;
  readonly retryAfterSeconds?: number;

  constructor({
    message,
    generalCode,
    serverCode,
    statusCode,
    retryAfterSeconds,
  }: {
    message: string;
    generalCode: GeneralErrorCode;
    serverCode?: string;
    statusCode?: number;
    retryAfterSeconds?: number;
  }) {
    super(message);
    this.name = "CodexAuthRequestError";
    this.generalCode = generalCode;
    this.serverCode = serverCode;
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface CodexAuthStatus {
  connected: boolean;
  configured: boolean;
  plan_type?: string;
  model?: string;
  model_options?: CodexModelOption[];
  updated_at?: string;
  reset_required?: true;
  experimental: true;
}

export interface CodexModelOption {
  id: string;
  label: string;
  description: string;
  recommended?: true;
}

export interface CodexModelSelection {
  model: string;
  model_options: CodexModelOption[];
  experimental: true;
}

export interface CodexAuthStartResponse {
  status: "pending";
  login_token: string;
  user_code: string;
  verification_url: string;
  interval_seconds: number;
  expires_at: string;
}

export interface CodexAuthPollResponse {
  status: "pending" | "connected" | "expired";
  connected?: boolean;
  plan_type?: string;
}

export type CodexAuthDisconnectResponse = CodexAuthStatus;

type CodexAuthRequest =
  | { action: "start" }
  | { action: "poll"; login_token: string }
  | { action: "disconnect" }
  | { action: "set_model"; model: string };

async function postCodexAuth<T>(
  body: CodexAuthRequest,
  signal?: AbortSignal,
): Promise<T> {
  const { getAuthHeaders } = useAuthStore.getState();

  try {
    const response = await axios.post<T>("/api/codex-auth", body, {
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      signal,
    });
    return response.data;
  } catch (error) {
    throw wrapCodexAuthError(error);
  }
}

export async function fetchCodexAuthStatus(
  signal?: AbortSignal,
): Promise<CodexAuthStatus> {
  const { getAuthHeaders } = useAuthStore.getState();

  try {
    const response = await axios.get<CodexAuthStatus>("/api/codex-auth", {
      headers: { ...getAuthHeaders() },
      signal,
    });
    return response.data;
  } catch (error) {
    throw wrapCodexAuthError(error);
  }
}

export function nextCodexAuthPollDelay(
  error: unknown,
  intervalMs: number,
): number | null {
  const requestError =
    error instanceof CodexAuthRequestError ? error : null;
  const generalCode =
    requestError?.generalCode ?? SharedErrorHandler.getErrorCode(error);
  if (
    generalCode === "INVALID_CREDENTIALS" ||
    requestError?.serverCode === "codex_auth_invalid_login_token"
  ) {
    return null;
  }

  const baseDelay = Number.isFinite(intervalMs)
    ? Math.max(0, intervalMs)
    : 5_000;
  const retryAfterMs = requestError?.retryAfterSeconds == null
    ? 0
    : Math.max(0, requestError.retryAfterSeconds * 1_000);
  return Math.max(baseDelay, retryAfterMs);
}

export function requiresCodexAuthReset(error: unknown): boolean {
  return (
    error instanceof CodexAuthRequestError &&
    error.serverCode === "codex_auth_stored_credentials_invalid"
  );
}

export function statusRequiresCodexAuthReset(
  status: CodexAuthStatus,
): boolean {
  return status.reset_required === true;
}

function wrapCodexAuthError(error: unknown): CodexAuthRequestError {
  if (error instanceof CodexAuthRequestError) return error;

  const generalError = SharedErrorHandler.wrapError(error);
  if (!axios.isAxiosError(error)) {
    return new CodexAuthRequestError({
      message: generalError.message,
      generalCode: generalError.code,
    });
  }

  const responseData: unknown = error.response?.data;
  const serverCode =
    responseData &&
    typeof responseData === "object" &&
    "code" in responseData &&
    typeof responseData.code === "string" &&
    responseData.code.trim()
      ? responseData.code
      : undefined;
  const retryAfterRaw = error.response?.headers?.["retry-after"];
  const retryAfterNumber =
    typeof retryAfterRaw === "string" || typeof retryAfterRaw === "number"
      ? Number(retryAfterRaw)
      : Number.NaN;

  return new CodexAuthRequestError({
    message: generalError.message,
    generalCode: generalError.code,
    ...(serverCode ? { serverCode } : {}),
    ...(error.response?.status != null
      ? { statusCode: error.response.status }
      : {}),
    ...(Number.isFinite(retryAfterNumber) && retryAfterNumber >= 0
      ? { retryAfterSeconds: Math.ceil(retryAfterNumber) }
      : {}),
  });
}

export function startCodexAuth(
  signal?: AbortSignal,
): Promise<CodexAuthStartResponse> {
  return postCodexAuth({ action: "start" }, signal);
}

export function pollCodexAuth(
  loginToken: string,
  signal?: AbortSignal,
): Promise<CodexAuthPollResponse> {
  return postCodexAuth({ action: "poll", login_token: loginToken }, signal);
}

export function disconnectCodexAuth(
  signal?: AbortSignal,
): Promise<CodexAuthDisconnectResponse> {
  return postCodexAuth({ action: "disconnect" }, signal);
}

export function setCodexModel(
  model: string,
  signal?: AbortSignal,
): Promise<CodexModelSelection> {
  return postCodexAuth({ action: "set_model", model }, signal);
}
