import type { VercelRequest, VercelResponse } from "@vercel/node";
import { neon } from "@neondatabase/serverless";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { sql: query, params = [] } = req.body ?? {};

  if (typeof query !== "string") {
    return res.status(400).json({ error: "sql is required" });
  }

  // Read-only guard: only allow SELECT statements
  const trimmed = query.trim().toUpperCase();
  if (!trimmed.startsWith("SELECT")) {
    return res.status(403).json({ error: "Only SELECT statements are allowed" });
  }

  const sql = neon(process.env.DATABASE_URL!);
  const rows = await sql.query(query, params);
  return res.status(200).json({ rows, rowCount: rows.length });
}
