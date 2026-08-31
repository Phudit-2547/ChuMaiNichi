import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkAuth } from "../src/api/auth.js";
import { createClient, defaultModel } from "../src/api/chat/client.js";
import {
  CodexOAuthError,
  resolveCodexOAuthCredentials,
} from "../src/api/chat/codex-auth.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!checkAuth(req.headers.authorization, process.env.DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const codexCredentials = await resolveCodexOAuthCredentials();
    if (!codexCredentials) {
      try {
        // Construction is local and validates that a fallback credential is
        // actually configured; defaultModel() alone always has a display
        // default and must not be treated as provider availability.
        createClient();
      } catch {
        return res.status(503).json({ error: "AI provider not configured" });
      }
    }
    return res.status(200).json({
      model: codexCredentials?.model ?? defaultModel(),
    });
  } catch (error) {
    if (error instanceof CodexOAuthError) {
      return res.status(error.statusCode).json({
        error: error.message,
        code: error.code,
      });
    }
    return res.status(500).json({ error: "AI provider status unavailable" });
  }
}
