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
