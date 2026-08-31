const CHAT_MAX_STORED = 100;

export type UiMessage =
  | { role: "user"; content: string; timestamp?: string }
  | { role: "assistant"; content: string; streaming?: boolean }
  | { role: "tool"; name: string; result: unknown }
  | { role: "error"; content: string };

export function parseStoredMessages(raw: string): UiMessage[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid: UiMessage[] = [];
    for (const m of parsed) {
      if (!m || typeof m !== "object") continue;
      const role = (m as { role?: unknown }).role;
      const content = (m as { content?: unknown }).content;
      if (role === "user" && typeof content === "string") {
        const timestamp = (m as { timestamp?: unknown }).timestamp;
        valid.push({
          role: "user",
          content,
          ...(typeof timestamp === "string" ? { timestamp } : {}),
        });
      } else if (
        role === "assistant" &&
        typeof content === "string" &&
        content
      ) {
        valid.push({ role: "assistant", content });
      } else if (role === "error" && typeof content === "string") {
        valid.push({ role: "error", content });
      }
    }
    return valid;
  } catch {
    return [];
  }
}

export function messagesForStorage(messages: UiMessage[]): UiMessage[] {
  const toSave: UiMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role === "assistant") {
      if (message.content) {
        toSave.push({ role: "assistant", content: message.content });
      }
    } else {
      toSave.push(message);
    }
  }
  return toSave.slice(-CHAT_MAX_STORED);
}

interface ChatHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadAndMigrateStoredMessages(
  storage: ChatHistoryStorage,
  key: string,
): UiMessage[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const valid = parseStoredMessages(raw);
    if (valid.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(messagesForStorage(valid)));
    return valid;
  } catch {
    return [];
  }
}
