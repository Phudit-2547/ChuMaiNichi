import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkAuth } from "../src/api/auth.js";

type WorkflowStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "requested"
  | "waiting"
  | "pending";
type WorkflowConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral";

const GITHUB_API = "https://api.github.com";
const WORKFLOW_FILE = "scrape-user-data.yml";
const DEFAULT_WORKFLOW_REF = "main";

type WorkflowRun = {
  id: number | string;
  html_url: string;
  status: WorkflowStatus;
  conclusion: WorkflowConclusion | null;
  event: string;
  head_branch: string;
  created_at: string;
  updated_at: string;
};

async function githubFetch(path: string, pat: string, init: RequestInit = {}) {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWorkflowRef() {
  return (
    process.env.GITHUB_BRANCH ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    DEFAULT_WORKFLOW_REF
  ).trim();
}

function parseRepo(value: string) {
  const [owner, repo, extra] = value
    .trim()
    .split("/")
    .map((part) => part.trim());
  if (!owner || !repo || extra) return null;
  return { owner, repo };
}

function formatGithubError(status: number, body: string, action: string) {
  const detail = body.trim() ? ` ${body.trim()}` : "";
  if (status === 404) {
    return (
      `GitHub API 404 while ${action}. Check GITHUB_REPO, that ` +
      `.github/workflows/${WORKFLOW_FILE} exists on the configured branch, ` +
      `and that GITHUB_PAT can access this repo and Actions.${detail}`
    );
  }
  if (status === 403) {
    return (
      `GitHub API 403 while ${action}. Check that GITHUB_PAT has repository ` +
      `access plus Actions read/write permission.${detail}`
    );
  }
  if (status === 422) {
    return (
      `GitHub API 422 while ${action}. Check that the configured workflow ` +
      `branch/ref exists.${detail}`
    );
  }
  return `GitHub API ${status} while ${action}.${detail}`;
}

async function assertOk(response: Response, action: string) {
  if (response.ok) return;
  const body = await response.text();
  throw new Error(formatGithubError(response.status, body, action));
}

async function listWorkflowDispatchRuns(
  pat: string,
  owner: string,
  repo: string,
  ref: string,
) {
  const params = new URLSearchParams({
    per_page: "10",
    event: "workflow_dispatch",
    branch: ref,
  });
  const runsUrl = `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?${params}`;
  const runsRes = await githubFetch(runsUrl, pat);
  await assertOk(runsRes, "listing workflow runs");
  const runsData = (await runsRes.json()) as { workflow_runs?: WorkflowRun[] };
  return (runsData.workflow_runs ?? []).filter(
    (run) =>
      run.event === "workflow_dispatch" &&
      (!run.head_branch || run.head_branch === ref),
  );
}

async function findTriggeredRun(
  pat: string,
  owner: string,
  repo: string,
  ref: string,
  seenRunIds: Set<string>,
  dispatchStartedAt: number,
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * attempt, 5000));

    const matchingRuns = await listWorkflowDispatchRuns(pat, owner, repo, ref);
    const newRun = matchingRuns.find(
      (run) =>
        !seenRunIds.has(String(run.id)) &&
        new Date(run.created_at).getTime() >= dispatchStartedAt - 30_000,
    );
    if (newRun) {
      return { run_id: String(newRun.id), run_url: newRun.html_url };
    }
  }

  throw new Error("No workflow run found after trigger");
}

async function triggerWorkflow(
  pat: string,
  owner: string,
  repo: string,
  ref: string,
) {
  const dispatchUrl = `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const seenRunIds = new Set(
    (await listWorkflowDispatchRuns(pat, owner, repo, ref)).map((run) =>
      String(run.id),
    ),
  );
  const dispatchStartedAt = Date.now();
  const response = await githubFetch(dispatchUrl, pat, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
  });
  await assertOk(response, `dispatching ${WORKFLOW_FILE}`);
  return findTriggeredRun(pat, owner, repo, ref, seenRunIds, dispatchStartedAt);
}

async function getRunStatus(pat: string, owner: string, repo: string, runId: string): Promise<{
  status: WorkflowStatus;
  conclusion?: WorkflowConclusion;
  updated_at: string;
  run_url: string;
}> {
  const url = `/repos/${owner}/${repo}/actions/runs/${runId}`;
  const response = await githubFetch(url, pat);
  await assertOk(response, "getting workflow status");
  const data = (await response.json()) as WorkflowRun;
  return {
    status: data.status,
    conclusion: data.conclusion ?? undefined,
    updated_at: data.updated_at,
    run_url: data.html_url,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const githubPat = process.env.GITHUB_PAT ?? "";
  const githubRepo = process.env.GITHUB_REPO ?? "";
  const workflowRef = getWorkflowRef();

  if (!checkAuth(req.headers.authorization, process.env.DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const query = req.query ?? {};
  const isStatusPoll = req.method === "GET" && query.run_id;
  if (req.method !== "POST" && !isStatusPoll) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!githubPat || !githubRepo) {
    return res.status(500).json({ error: "GitHub credentials not configured" });
  }

  const parsedRepo = parseRepo(githubRepo);
  if (!parsedRepo) {
    return res.status(500).json({ error: "Invalid GITHUB_REPO format" });
  }
  const { owner, repo } = parsedRepo;

  // GET /api/refresh?run_id=xxx — poll status
  if (isStatusPoll) {
    const runId = String(Array.isArray(query.run_id) ? query.run_id[0] : query.run_id);
    if (!/^\d+$/.test(runId)) {
      return res.status(400).json({ error: "Invalid run_id" });
    }
    // Optional: enforce a minimum interval between polls
    const sinceHeader = req.headers["x-poll-since"];
    const sinceMs = sinceHeader
      ? parseInt(String(Array.isArray(sinceHeader) ? sinceHeader[0] : sinceHeader), 10)
      : 0;
    const delay = Number(sinceMs) > 0 && Date.now() - Number(sinceMs) < 5000 ? 5000 - Number(sinceMs) : 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    try {
      const statusData = await getRunStatus(githubPat, owner, repo, runId);
      return res.status(200).json(statusData);
    } catch (err) {
      console.error("[refresh] status poll error:", err);
      const message = err instanceof Error ? err.message : "Failed to get workflow status";
      return res.status(500).json({ error: message });
    }
  }

  // POST /api/refresh — trigger workflow
  if (req.method === "POST") {
    try {
      const result = await triggerWorkflow(githubPat, owner, repo, workflowRef);
      return res.status(200).json(result);
    } catch (err) {
      console.error("[refresh] trigger error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
