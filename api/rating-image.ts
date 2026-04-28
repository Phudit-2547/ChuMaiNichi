import type { VercelRequest, VercelResponse } from "@vercel/node";
import { neon } from "@neondatabase/serverless";
import { checkAuth } from "../src/api/auth.js";

const VALID_GAMES = new Set(["maimai", "chunithm"]);

type Row = {
  image_b64: string;
  content_type: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!checkAuth(req.headers.authorization, process.env.DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const game =
    typeof req.query.game === "string" ? req.query.game : "";
  if (!VALID_GAMES.has(game)) {
    return res.status(400).json({ error: "Invalid game" });
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(500).json({ error: "DATABASE_URL not set" });
  }

  try {
    const sql = neon(dbUrl);

    // Cheap HEAD-style probe: avoids encoding/transferring the bytes when
    // the client's cached copy is still valid.
    const head = (await sql.query(
      "SELECT updated_at FROM public.user_rating_images WHERE game = $1",
      [game],
    )) as Array<{ updated_at: string }>;
    if (head.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    const updatedAt = new Date(head[0].updated_at);
    const lastModified = updatedAt.toUTCString();
    const ifMod = req.headers["if-modified-since"];
    if (typeof ifMod === "string") {
      const since = new Date(ifMod);
      if (!Number.isNaN(since.getTime()) && since >= updatedAt) {
        res.setHeader("Cache-Control", "private, max-age=300");
        res.setHeader("Last-Modified", lastModified);
        return res.status(304).end();
      }
    }

    const rows = (await sql.query(
      `SELECT encode(image_data, 'base64') AS image_b64,
              content_type
         FROM public.user_rating_images
        WHERE game = $1`,
      [game],
    )) as Row[];
    if (rows.length === 0) {
      // Row vanished between the two queries — race with a delete.
      return res.status(404).json({ error: "Not found" });
    }

    const buf = Buffer.from(rows[0].image_b64, "base64");
    res.setHeader("Content-Type", rows[0].content_type || "image/webp");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Last-Modified", lastModified);
    return res.status(200).send(buf);
  } catch (e) {
    // The user_rating_images table is created by init.sql, which only runs
    // during a scraper invocation. Before the first workflow run the table
    // simply doesn't exist — surface that as 404 so the UI hides cleanly.
    if (e instanceof Error && /does not exist/i.test(e.message)) {
      return res.status(404).json({ error: "Not found" });
    }
    console.error("rating-image error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
}
