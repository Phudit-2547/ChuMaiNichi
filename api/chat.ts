import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Stub: canned chat response
  return res.status(200).json({
    role: "assistant",
    content: "Hello! I'm your ChuMaiNichi assistant. Ask me about your play history, ratings, or song suggestions!",
  });
}
