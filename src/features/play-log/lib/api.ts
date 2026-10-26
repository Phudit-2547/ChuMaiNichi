import axios from "axios";
import useAuthStore from "../../auth/stores/auth-store";
import type { DayState, DayWrite } from "../../../global/lib/play-log";

export type SaveResult =
  | { kind: "saved"; day: DayState }
  | { kind: "conflict"; day: DayState }
  | { kind: "exceeds"; day: DayState; message: string }
  | { kind: "unauthorized" }
  | { kind: "failed"; message: string };

function isDay(value: unknown, date: string): value is DayState {
  const day = value as DayState | undefined;
  return day?.date === date && typeof day.games === "object" && day.games !== null;
}

export async function fetchDay(date: string, signal?: AbortSignal): Promise<DayState> {
  const res = await axios.get("/api/daily-play", {
    params: { date },
    headers: { ...useAuthStore.getState().getAuthHeaders() },
    signal,
  });
  if (!isDay(res.data?.day, date)) throw new Error("Unexpected day response");
  return res.data.day;
}

/** One attempt, never retried: a lost response is resolved by the next compare-and-set. */
export async function saveWrite(write: DayWrite): Promise<SaveResult> {
  try {
    const res = await axios.put("/api/daily-play", write, {
      headers: {
        "Content-Type": "application/json",
        ...useAuthStore.getState().getAuthHeaders(),
      },
    });
    if (!isDay(res.data?.day, write.date))
      return { kind: "failed", message: "Not saved. Unexpected response." };
    return { kind: "saved", day: res.data.day };
  } catch (err) {
    if (!axios.isAxiosError(err) || !err.response)
      return { kind: "failed", message: "Not saved. Check your connection." };
    const { status, data } = err.response;
    if (status === 401) return { kind: "unauthorized" };
    if (status === 409 && isDay(data?.day, write.date)) return { kind: "conflict", day: data.day };
    if (data?.code === "TICKETS_EXCEED_PLAYS" && isDay(data?.day, write.date))
      return { kind: "exceeds", day: data.day, message: data.error };
    return {
      kind: "failed",
      message: typeof data?.error === "string" ? data.error : "Not saved.",
    };
  }
}
