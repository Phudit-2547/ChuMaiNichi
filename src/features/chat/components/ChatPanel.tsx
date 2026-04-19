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
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; streaming?: boolean }
  | { role: "tool"; name: string; result: unknown }
  | { role: "error"; content: string };

const CHAT_STORAGE_KEY = "chumai-chat-messages";
const CHAT_MAX_STORED = 100;

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
        valid.push({ role: "user", content });
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
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  }, [input]);

  const send = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || busy) return;
      setInput("");
      setBusy(true);

      const userMsg: UiMessage = { role: "user", content: text };
      const streamingMsg: UiMessage = {
        role: "assistant",
        content: "",
        streaming: true,
      };

      setMessages((prev) => [...prev, userMsg, streamingMsg]);

      const apiHistory: ChatMessage[] = [...messages, userMsg]
        .filter(
          (m): m is Extract<UiMessage, { role: "user" | "assistant" }> =>
            m.role === "user" || m.role === "assistant",
        )
        .map((m) => ({ role: m.role, content: m.content }));

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
            next[i] = { ...m, streaming: false };
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

      <div className="chat-panel__scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <EmptyState onPick={(t) => send(t)} />
        ) : (
          messages
            .filter((m) => showToolCalls || m.role !== "tool")
            .map((m, i) => <MessageRow key={i} m={m} />)
        )}
      </div>

      <div className="chat-composer">
        <div className="chat-composer__box">
          <textarea
            ref={taRef}
            className="chat-composer__input"
            placeholder="Ask about your play history, rating, or song picks…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={busy}
          />
          <button
            type="button"
            className="chat-composer__send"
            disabled={!input.trim() || busy}
            onClick={() => send()}
            title="Send"
          >
            <Send size={14} />
          </button>
        </div>
        <div className="chat-composer__hints">
          <span>
            <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
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
