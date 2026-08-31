import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkAuth } from "../src/api/auth.js";
import {
  CodexOAuthError,
  disconnectCodexOAuth,
  getCodexOAuthStatus,
  pollPrivateCodexDeviceLogin,
  setCodexOAuthModel,
  startPrivateCodexDeviceLogin,
} from "../src/api/chat/codex-auth.js";

type RequestBody = {
  action?: unknown;
  login_token?: unknown;
  model?: unknown;
};

function parseBody(body: unknown): RequestBody {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as RequestBody;
  }
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as RequestBody;
      }
    } catch {
      // The caller receives the same bounded validation error below.
    }
  }
  throw new CodexOAuthError(
    "codex_auth_invalid_login_token",
    400,
    "Invalid request body",
  );
}

function sendSafeError(error: unknown, res: VercelResponse) {
  if (error instanceof CodexOAuthError) {
    if (error.retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    }
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      experimental: true,
    });
  }

  // Do not log the exception object: fetch and database errors can contain
  // request headers, connection strings, or OAuth response details.
  console.error("codex-auth error: unexpected_internal_error");
  return res.status(500).json({
    error: "Internal error",
    code: "codex_auth_internal_error",
    experimental: true,
  });
}

/**
 * Private/experimental Codex-subscription auth endpoint.
 * Access and refresh tokens are never returned to the browser.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const password = process.env.DASHBOARD_PASSWORD;
  const hasPassword = Boolean(password?.trim());
  if (hasPassword && !checkAuth(req.headers.authorization, password)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    if (req.method === "GET") {
      // When DASHBOARD_PASSWORD is absent, the core intentionally returns only
      // configured:false and never reads or exposes stored token metadata.
      return res.status(200).json(await getCodexOAuthStatus());
    }

    // Unlike legacy routes, this sensitive endpoint must never fail open when
    // DASHBOARD_PASSWORD is absent. The core enforces this too for direct use.
    if (!hasPassword) {
      throw new CodexOAuthError(
        "codex_auth_not_configured",
        503,
        "Codex subscription auth requires DASHBOARD_PASSWORD",
      );
    }
    if (!checkAuth(req.headers.authorization, password)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = parseBody(req.body);
    if (body.action === "start") {
      return res.status(200).json(await startPrivateCodexDeviceLogin());
    }
    if (body.action === "poll") {
      if (typeof body.login_token !== "string" || !body.login_token.trim()) {
        throw new CodexOAuthError(
          "codex_auth_invalid_login_token",
          400,
          "login_token is required",
        );
      }
      return res
        .status(200)
        .json(await pollPrivateCodexDeviceLogin(body.login_token));
    }
    if (body.action === "disconnect") {
      return res.status(200).json(await disconnectCodexOAuth());
    }
    if (body.action === "set_model") {
      return res.status(200).json(await setCodexOAuthModel(body.model));
    }

    return res.status(400).json({
      error: "Invalid action",
      code: "codex_auth_invalid_action",
      experimental: true,
    });
  } catch (error) {
    return sendSafeError(error, res);
  }
}
