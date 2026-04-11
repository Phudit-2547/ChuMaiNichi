import axios from "axios";
import useAuthStore from "../stores/auth-store";

export async function queryDB<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  signal?: AbortSignal,
): Promise<T[]> {
  const { getAuthHeaders } = useAuthStore.getState();

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

  if (res.status === 401) throw new Error("unauthorized");
  if (!res.data) throw new Error(`query failed: ${res.status}`);
  return res.data.rows;
}
