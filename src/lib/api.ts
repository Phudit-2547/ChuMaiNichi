import useAuthStore from "../stores/auth-store";

export async function queryDB<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  signal?: AbortSignal,
): Promise<T[]> {
  const { getAuthHeaders } = useAuthStore.getState();

  const res = await fetch("/api/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: JSON.stringify({ sql, params }),
    signal,
  });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`query failed: ${res.status}`);
  const json = await res.json();
  return json.rows;
}
