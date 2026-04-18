import useAuthStore from "@/features/auth/stores/auth-store";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type StreamEvent =
  | { type: "content"; content: string }
  | { type: "tool"; name: string; result: unknown }
  | { type: "done" }
  | { type: "error"; error: string };

export async function streamChat(
  messages: ChatMessage[],
  onEvent: (e: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { getAuthHeaders } = useAuthStore.getState();
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`Chat request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const evt of events) {
      const line = evt.trim();
      if (!line.startsWith("data: ")) continue;
      try {
        const payload = JSON.parse(line.slice(6)) as StreamEvent;
        onEvent(payload);
      } catch {
        // ignore malformed chunks
      }
    }
  }
}
