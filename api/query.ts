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
  const trimmed = query.trim();
  if (!trimmed.toUpperCase().startsWith("SELECT")) {
    return res.status(403).json({ error: "Only SELECT statements are allowed" });
  }

  // Block multi-statement attacks and dangerous keywords
  const forbidden = /;|--|\/\*|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|COPY)\b/i;
  if (forbidden.test(trimmed)) {
    return res.status(403).json({ error: "Forbidden SQL pattern detected" });
  }

  try {
    const sql = neon(process.env.DATABASE_URL!);
    const rows = await sql.query(query, params);
    return res.status(200).json({ rows, rowCount: rows.length });
  } catch (err) {
    console.error("Query execution error:", err);
    return res.status(500).json({ error: "Query execution failed" });
  }
}
