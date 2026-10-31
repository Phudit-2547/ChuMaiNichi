import axios from "axios";
import useAuthStore from "../../auth/stores/auth-store";
import { isJapanWrite, type DayState, type DayWrite } from "../../../global/lib/play-log";
import type { DataRegion } from "../../../global/lib/regions";

export type SaveResult =
  | { kind: "saved"; day: DayState }
  | { kind: "conflict"; day: DayState }
  | { kind: "exceeds"; day: DayState; message: string }
  | { kind: "unauthorized" }
  | { kind: "failed"; message: string };

function isDay(value: unknown, date: string, region: DataRegion): value is DayState {
  const day = value as DayState | undefined;
  return (
    day?.date === date &&
    day.region === region &&
    typeof day.games === "object" &&
    day.games !== null
  );
}

export async function fetchDay(
  date: string,
  region: DataRegion,
  signal?: AbortSignal,
): Promise<DayState> {
  const res = await axios.get("/api/daily-play", {
    params: { date, region },
    headers: { ...useAuthStore.getState().getAuthHeaders() },
    signal,
  });
  if (!isDay(res.data?.day, date, region)) throw new Error("Unexpected day response");
  return res.data.day;
}

/** One attempt, never retried: a lost response is resolved by the next compare-and-set. */
export async function saveWrite(write: DayWrite): Promise<SaveResult> {
  const region: DataRegion = isJapanWrite(write) ? "japan" : "international";
  try {
    const res = await axios.put("/api/daily-play", write, {
      headers: {
        "Content-Type": "application/json",
        ...useAuthStore.getState().getAuthHeaders(),
      },
    });
    if (!isDay(res.data?.day, write.date, region))
      return { kind: "failed", message: "Not saved. Unexpected response." };
    return { kind: "saved", day: res.data.day };
  } catch (err) {
    if (!axios.isAxiosError(err) || !err.response)
      return { kind: "failed", message: "Not saved. Check your connection." };
    const { status, data } = err.response;
    if (status === 401) return { kind: "unauthorized" };
    if (status === 409 && isDay(data?.day, write.date, region)) return { kind: "conflict", day: data.day };
    if (
      (data?.code === "TICKETS_EXCEED_PLAYS" || data?.code === "JOURNAL_DAY") &&
      isDay(data?.day, write.date, region)
    )
      return { kind: "exceeds", day: data.day, message: data.error };
    return {
      kind: "failed",
      message: typeof data?.error === "string" ? data.error : "Not saved.",
    };
  }
}
