import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkAuth } from "../src/api/auth.js";

// Lightweight login probe: validates the dashboard password ONLY.
// It never touches the database or the AI provider, so a correct password
// logs the user in even when DATABASE_URL is misconfigured or Neon is
// unreachable. Data-layer failures then surface in the panels that need
// the database, not at the login gate.
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!checkAuth(req.headers.authorization, process.env.DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.status(200).json({ ok: true });
}
