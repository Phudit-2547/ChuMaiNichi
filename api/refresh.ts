import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash, timingSafeEqual } from "node:crypto";

function checkAuth(header: string | undefined, password: string | undefined): boolean {
  if (!password) return true;
  const token = header?.replace("Bearer ", "") ?? "";
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(password).digest();
  return timingSafeEqual(a, b);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!checkAuth(req.headers.authorization, process.env.DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.status(200).json({ status: "ok" });
}
