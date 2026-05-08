import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Send, X } from "lucide-react";
import useShellStore from "@/features/shell/stores/shell-store";
import useSettingsStore from "@/features/settings/stores/settings-store";
import { fetchModel } from "@/global/lib/api";
import { streamChat, type ChatMessage, type StreamEvent } from "../lib/stream";
import { renderBody } from "../lib/render-body";
import ToolCall from "./ToolCall";
import EmptyState from "./EmptyState";

type UiMessage =
  | { role: "user"; content: string; timestamp?: string }
  | { role: "assistant"; content: string; streaming?: boolean }
  | { role: "tool"; name: string; result: unknown }
  | { role: "error"; content: string };

const CHAT_STORAGE_KEY = "chumai-chat-messages";
const CHAT_MAX_STORED = 100;

function currentTimestampIct(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")} ICT`;
}

function formatAgo(timestamp: string, now: Date): string {
  const m = timestamp.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) ICT$/);
  if (!m) return "";
  const [, y, mo, d, h, mi] = m;
  const then = new Date(`${y}-${mo}-${d}T${h}:${mi}:00+07:00`);
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm > 0 ? `${hrs}h ${rm}m ago` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d ${rh}h ago` : `${days}d ago`;
}

function loadMessages(): UiMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid: UiMessage[] = [];
    for (const m of parsed) {
      if (!m || typeof m !== "object") continue;
      const r = (m as { role?: unknown }).role;
      const content = (m as { content?: unknown }).content;
      if (r === "user" && typeof content === "string") {
        const ts = (m as { timestamp?: unknown }).timestamp;
        valid.push({
          role: "user",
          content,
          ...(typeof ts === "string" ? { timestamp: ts } : {}),
        });
      } else if (r === "assistant" && typeof content === "string" && content) {
        valid.push({ role: "assistant", content });
      } else if (r === "tool") {
        const name = (m as { name?: unknown }).name;
        if (typeof name === "string") {
          valid.push({
            role: "tool",
            name,
            result: (m as { result?: unknown }).result,
          });
        }
      } else if (r === "error" && typeof content === "string") {
        valid.push({ role: "error", content });
      }
    }
    return valid;
  } catch {
    return [];
  }
}

function saveMessages(messages: UiMessage[]): void {
  try {
    const toSave: UiMessage[] = [];
    for (const m of messages) {
      if (m.role === "assistant") {
        if (m.content) toSave.push({ role: "assistant", content: m.content });
      } else {
        toSave.push(m);
      }
    }
    const capped = toSave.slice(-CHAT_MAX_STORED);
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(capped));
  } catch {
    /* quota or serialization error — drop silently */
  }
}

export default function ChatPanel() {
  const { setChatOpen } = useShellStore();
  const { showToolCalls } = useSettingsStore();
  const [messages, setMessages] = useState<UiMessage[]>(loadMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draft, setDraft] = useState("");

  // Escape key to close chat panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        useShellStore.getState().setChatOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const userMessages = messages.filter((m) => m.role === "user");

  useEffect(() => {
    const ctrl = new AbortController();
    fetchModel(ctrl.signal)
      .then(setModelLabel)
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const handle = setTimeout(() => saveMessages(messages), 300);
    return () => clearTimeout(handle);
  }, [messages]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!input) {
      ta.style.height = "";
      return;
    }
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  }, [input]);

  const send = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || busy) return;
      setInput("");
      setHistoryIndex(-1);
      setBusy(true);

      const userMsg: UiMessage = {
        role: "user",
        content: text,
        timestamp: currentTimestampIct(),
      };
      const streamingMsg: UiMessage = {
        role: "assistant",
        content: "",
        streaming: true,
      };

      setMessages((prev) => [...prev, userMsg, streamingMsg]);

      // Build apiHistory: the LLM can't see tool UI messages, so after a
      // tool call the conversation can contain empty or consecutive assistant
      // turns that many providers reject. Drop empties and merge runs.
      // User messages are prefixed with their send timestamp and a
      // pre-computed "X ago" delta so the model can reason about when
      // each was sent without doing datetime math itself.
      const apiHistory: ChatMessage[] = [];
      const now = new Date();
      for (const m of [...messages, userMsg]) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        if (m.role === "assistant" && !m.content) continue;
        const last = apiHistory[apiHistory.length - 1];
        let content = m.content;
        if (m.role === "user" && m.timestamp) {
          const ago = formatAgo(m.timestamp, now);
          content = ago
            ? `[${m.timestamp}, ${ago}] ${m.content}`
            : `[${m.timestamp}] ${m.content}`;
        }
        if (last && last.role === "assistant" && m.role === "assistant") {
          last.content = `${last.content}\n\n${content}`;
        } else {
          apiHistory.push({ role: m.role, content });
        }
      }

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        await streamChat(apiHistory, handleEvent, ctrl.signal);
        finalizeStreaming();
      } catch (err) {
        if (!ctrl.signal.aborted) {
          setMessages((prev) => {
            const next = dropEmptyStreaming(prev);
            next.push({
              role: "error",
              content:
                err instanceof Error
                  ? `Stream failed: ${err.message}`
                  : "Stream failed — please retry.",
            });
            return next;
          });
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [input, busy, messages],
  );

  function handleEvent(ev: StreamEvent) {
    if (ev.type === "content") {
      setMessages((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i];
          if (m.role === "assistant" && m.streaming) {
            next[i] = { ...m, content: m.content + ev.content };
            break;
          }
        }
        return next;
      });
    } else if (ev.type === "tool") {
      setMessages((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i];
          if (m.role === "assistant" && m.streaming) {
            if (!m.content) {
              next.splice(i, 1);
            } else {
              next[i] = { ...m, streaming: false };
            }
            break;
          }
        }
        next.push({ role: "tool", name: ev.name, result: ev.result });
        next.push({ role: "assistant", content: "", streaming: true });
        return next;
      });
    } else if (ev.type === "done") {
      finalizeStreaming();
    } else if (ev.type === "error") {
      setMessages((prev) => {
        const next = dropEmptyStreaming(prev);
        next.push({ role: "error", content: ev.error });
        return next;
      });
    }
  }

  function finalizeStreaming() {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i];
        if (m.role === "assistant" && m.streaming) {
          if (!m.content) {
            next.splice(i, 1);
          } else {
            next[i] = { ...m, streaming: false };
          }
          break;
        }
      }
      return next;
    });
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (userMessages.length === 0) return;
      const newIndex =
        historyIndex === -1
          ? userMessages.length - 1
          : Math.max(0, historyIndex - 1);
      if (historyIndex === -1) setDraft(input);
      setHistoryIndex(newIndex);
      setInput(userMessages[newIndex].content);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex === -1) return;
      const newIndex = historyIndex + 1;
      if (newIndex >= userMessages.length) {
        setHistoryIndex(-1);
        setInput(draft);
      } else {
        setHistoryIndex(newIndex);
        setInput(userMessages[newIndex].content);
      }
    }
  };

  const clear = () => {
    abortRef.current?.abort();
    setMessages([]);
    try {
      localStorage.removeItem(CHAT_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  return (
    <aside className="chat-panel" aria-label="Assistant chat">
      <ChatResizer />
      <div className="chat-panel__header">
        <MessageCircle
          size={16}
          style={{ color: "var(--color-accent-hover)" }}
        />
        <div className="chat-panel__title">Assistant</div>
        <div className="chat-panel__sub">
          <span className="chat-panel__status-dot" />
          {modelLabel ?? "…"}
        </div>
        <button
          type="button"
          className="chat-panel__close"
          onClick={() => setChatOpen(false)}
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      <div
        className="chat-panel__scroll"
        style={{ marginBottom: -30, paddingBottom: 30 }}
        ref={scrollRef}
      >
        {messages.length === 0 ? (
          <EmptyState onPick={(t) => send(t)} />
        ) : (
          messages
            .filter((m) => showToolCalls || m.role !== "tool")
            .map((m, i) => <MessageRow key={i} m={m} />)
        )}
      </div>

      <div className="chat-composer">
        <div
          className="chat-composer__box"
          style={{
            borderRadius: 25,
            paddingBottom: 8,
            paddingTop: 8,
            overflow: "hidden",
          }}
        >
          <textarea
            ref={taRef}
            className="chat-composer__input"
            placeholder="Ask about your play history, rating, or song picks…"
            value={input}
            style={{ transform: "translateY(-10%)" }}
            onChange={(e) => {
              setInput(e.target.value);
              if (historyIndex !== -1) setHistoryIndex(-1);
            }}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={busy}
          />
          <button
            type="button"
            className="chat-composer__send"
            style={{ borderRadius: 200 }}
            disabled={!input.trim() || busy}
            onClick={() => send()}
            title="Send"
          >
            <Send size={14} className="mt-px mr-px" />
          </button>
        </div>
        <div className="chat-composer__hints">
          <span>
            <kbd>↑</kbd>/<kbd>↓</kbd> history · <kbd>Enter</kbd> send ·{" "}
            <kbd>Esc</kbd> close
          </span>
          {messages.length > 0 && (
            <button
              type="button"
              className="chat-composer__clear"
              onClick={clear}
            >
              clear
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function MessageRow({ m }: { m: UiMessage }) {
  if (m.role === "user") {
    return (
      <div className="chat-msg chat-msg--user">
        <div className="chat-msg__role">you</div>
        <div className="chat-msg__body">{m.content}</div>
      </div>
    );
  }
  if (m.role === "tool") {
    return <ToolCall name={m.name} result={m.result} />;
  }
  if (m.role === "error") {
    return <div className="chat-err">{m.content}</div>;
  }
  return (
    <div className="chat-msg chat-msg--assistant">
      <div className="chat-msg__role">chumai</div>
      <div className="chat-msg__body">
        {renderBody(m.content, m.streaming ?? false)}
      </div>
    </div>
  );
}

function ChatResizer() {
  const setChatWidth = useShellStore((s) => s.setChatWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!shell) return;
    dragRef.current = {
      startX: e.clientX,
      startWidth: useShellStore.getState().chatWidth,
    };
    shell.dataset.resizing = "true";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setChatWidth(d.startWidth + (d.startX - e.clientX));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (shell) delete shell.dataset.resizing;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  return (
    <div
      className="chat-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat panel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}

function dropEmptyStreaming(prev: UiMessage[]): UiMessage[] {
  const next = [...prev];
  for (let i = next.length - 1; i >= 0; i--) {
    const m = next[i];
    if (m.role === "assistant" && m.streaming && !m.content) {
      next.splice(i, 1);
      break;
    }
  }
  return next;
}
