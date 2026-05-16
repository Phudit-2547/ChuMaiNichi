import axios from "axios";
import useAuthStore from "../../features/auth/stores/auth-store";
import { SharedErrorHandler } from "./error-handling";

export async function queryDB<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  signal?: AbortSignal,
): Promise<T[]> {
  const { getAuthHeaders } = useAuthStore.getState();

  try {
    const res = await axios.post(
      "/api/query",
      { sql, params },
      {
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        signal,
      },
    );
    return res.data.rows;
  } catch (err) {
    throw SharedErrorHandler.wrapError(err);
  }
}

export async function fetchModel(signal?: AbortSignal): Promise<string> {
  const { getAuthHeaders } = useAuthStore.getState();

  try {
    const res = await axios.get("/api/model", {
      headers: { ...getAuthHeaders() },
      signal,
    });
    return res.data.model;
  } catch (err) {
    throw SharedErrorHandler.wrapError(err);
  }
}

export type WorkflowStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "requested"
  | "waiting"
  | "pending";

export type WorkflowConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral";

export async function triggerRefresh(): Promise<{ run_id: string; run_url: string }> {
  const { getAuthHeaders } = useAuthStore.getState();

  try {
    const res = await axios.post(
      "/api/refresh",
      {},
      {
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
      },
    );
    return res.data;
  } catch (err) {
    throw SharedErrorHandler.wrapError(err);
  }
}

export async function pollRefreshStatus(
  runId: string,
  onProgress?: (status: WorkflowStatus) => void,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ status: WorkflowStatus; conclusion?: WorkflowConclusion; run_url?: string }> {
  const { timeoutMs = 10 * 60 * 1000, intervalMs = 8000 } = options;
  const { getAuthHeaders } = useAuthStore.getState();
  const startTime = Date.now();
  let lastPoll = 0;

  while (Date.now() - startTime < timeoutMs) {
    const res = await axios.get("/api/refresh", {
      params: { run_id: runId },
      headers: {
        ...getAuthHeaders(),
        "x-poll-since": String(lastPoll),
      },
    });
    lastPoll = Date.now();
    const data = res.data as {
      status: WorkflowStatus;
      conclusion?: WorkflowConclusion;
      run_url?: string;
    };
    onProgress?.(data.status);

    if (data.status === "completed") {
      return data;
    }

    // Wait interval, but stop early if we're about to timeout
    const remaining = timeoutMs - (Date.now() - startTime);
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }

  throw new Error("Polling timed out");
}

export async function fetchRatingImage(
  game: "maimai" | "chunithm",
  signal?: AbortSignal,
  cacheBust?: number,
): Promise<Blob | null> {
  const { getAuthHeaders } = useAuthStore.getState();
  const params = new URLSearchParams({ game });
  if (cacheBust != null) params.set("_", String(cacheBust));
  const res = await fetch(`/api/rating-image?${params}`, {
    cache: "no-store",
    headers: { ...getAuthHeaders() },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`rating-image request failed: ${res.status}`);
  }
  return res.blob();
}
