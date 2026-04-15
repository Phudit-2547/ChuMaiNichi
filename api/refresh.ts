import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkAuth } from "../src/api/auth";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!checkAuth(req.headers.authorization, process.env.DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.status(200).json({ status: "ok" });
}
