import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkAuth } from "../src/api/auth.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !checkAuth(
      req.headers.authorization,
      process.env.DASHBOARD_PASSWORD,
      req.headers.cookie,
      req.headers.origin,
    )
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.status(200).json({ ok: true });
}
