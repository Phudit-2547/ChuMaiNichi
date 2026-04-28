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

export async function triggerRefresh(): Promise<{ run_url: string }> {
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

export async function fetchRatingImage(
  game: "maimai" | "chunithm",
  signal?: AbortSignal,
): Promise<Blob | null> {
  const { getAuthHeaders } = useAuthStore.getState();
  const res = await fetch(`/api/rating-image?game=${encodeURIComponent(game)}`, {
    headers: { ...getAuthHeaders() },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`rating-image request failed: ${res.status}`);
  }
  return res.blob();
}
