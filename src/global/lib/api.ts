import axios from "axios";
import useAuthStore from "../../features/auth/stores/auth-store";
import { SharedErrorHandler } from "./error-handling";

export async function verifyAuth(signal?: AbortSignal): Promise<void> {
  const { getAuthHeaders } = useAuthStore.getState();

  try {
    await axios.get("/api/auth", {
      headers: { ...getAuthHeaders() },
      signal,
    });
  } catch (err) {
    throw SharedErrorHandler.wrapError(err);
  }
}

// Neon (free tier) scales to zero after idle, so the first query following a
// cold period pays a warmup penalty and can transiently fail or time out. Retry
// those failures with exponential backoff so a waking database resolves
// transparently instead of surfacing an error on the first data load.
const COLD_START_RETRIES = 3; // retries after the first try -> 4 attempts total
const COLD_START_BASE_DELAY_MS = 400; // backoff: 400ms, 800ms, 1600ms

export function isColdStartError(err: unknown): boolean {
  if (axios.isCancel(err)) return false; // caller aborted — never retry
  if (!axios.isAxiosError(err)) return false;
  // No response → connection reset / timeout while the database wakes.
  if (!err.response) return true;
  // 5xx → server-side failure, including a cold Neon connection surfaced as 500.
  return err.response.status >= 500;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function queryDB<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  signal?: AbortSignal,
): Promise<T[]> {
  const { getAuthHeaders } = useAuthStore.getState();
  let lastErr: unknown;

  for (let attempt = 0; attempt <= COLD_START_RETRIES; attempt++) {
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
      lastErr = err;
      const canRetry =
        attempt < COLD_START_RETRIES &&
        !signal?.aborted &&
        isColdStartError(err);
      if (!canRetry) break;
      try {
        await sleep(COLD_START_BASE_DELAY_MS * 2 ** attempt, signal);
      } catch {
        break; // aborted during backoff — surface the query error below
      }
    }
  }

  throw SharedErrorHandler.wrapError(lastErr);
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
