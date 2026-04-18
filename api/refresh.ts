import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkAuth } from "../src/api/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!checkAuth(req.headers.authorization, process.env.DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const githubPat = process.env.GITHUB_PAT;
  const githubRepo = process.env.GITHUB_REPO;

  if (!githubPat || !githubRepo) {
    return res.status(500).json({ error: "GitHub credentials not configured" });
  }

  const [owner, repo] = githubRepo.split("/");
  if (!owner || !repo) {
    return res.status(500).json({ error: "Invalid GITHUB_REPO format" });
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/scrape-user-data.yml/dispatches`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubPat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: "main",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("GitHub API error:", response.status, errorText);
      return res.status(500).json({ error: "Failed to trigger workflow" });
    }

    // Construct a plausible run URL to the actions tab
    const runUrl = `https://github.com/${owner}/${repo}/actions/workflows/scrape-user-data.yml`;
    return res.status(200).json({ run_url: runUrl });
  } catch (err) {
    console.error("Workflow trigger error:", err);
    return res.status(500).json({ error: "Failed to trigger workflow" });
  }
}
