import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { MessageCircle, Square, Trash2, X } from "lucide-react";
import useShellStore from "@/features/shell/stores/shell-store";
import useSettingsStore from "@/features/settings/stores/settings-store";
import { fetchModel } from "@/global/lib/api";
import { APP_CONFIG } from "@/global/lib/config";
import { streamChat, type ChatMessage, type StreamEvent } from "../lib/stream";
import { renderBody } from "../lib/render-body";
import { GlassComposer, GlassSendButton } from "./LiquidComposer";
import ToolCall from "./ToolCall";
import EmptyState from "./EmptyState";

type UiMessage =
  | { role: "user"; content: string; timestamp?: string }
  | { role: "assistant"; content: string; streaming?: boolean }
  | { role: "tool"; name: string; result: unknown }
  | { role: "error"; content: string };

const CHAT_STORAGE_KEY = "chumai-chat-messages";
const CHAT_MAX_STORED = 100;
interface SlashCommand {
  id: string;
  title: string;
  label: string;
  description: string;
  draft: string;
  example: string;
  hint: string;
  keywords: string[];
}

const SLASH_COMMANDS = [
  ...(APP_CONFIG.games.includes("chunithm")
    ? [
        {
          id: "chuni-rating-target",
          title: "CHUNITHM target table",
          label: "CHUNITHM",
          description: "Build a target play-rating table.",
          draft: "/chuni rating ",
          example: "/chuni rating 15.00",
          hint: "Add a target play rating, e.g. 15.00.",
          keywords: ["chuni", "chunithm", "target", "table", "score"],
        },
      ]
    : []),
  ...(APP_CONFIG.games.includes("maimai")
    ? [
        {
          id: "mai-rating-target",
          title: "maimai target table",
          label: "maimai",
          description: "Build a target song-rating table.",
          draft: "/mai rating ",
          example: "/mai rating 300",
          hint: "Add a target song rating, e.g. 300.",
          keywords: ["mai", "maimai", "target", "song", "table"],
        },
        {
          id: "mai-rating-chart",
          title: "maimai chart rating",
          label: "maimai",
          description: "Calculate one chart rating.",
          draft: "/mai rating ",
          example: "/mai rating 14.0 100.0000%",
          hint: "Add chart constant and achievement, e.g. 14.0 100.0000%.",
          keywords: ["mai", "maimai", "chart", "constant", "achievement"],
        },
      ]
    : []),
] satisfies SlashCommand[];

function matchesSlashCommand(command: SlashCommand, rawInput: string): boolean {
  const query = rawInput.trim().replace(/^\/+/, "").toLowerCase();
  if (!query) return true;
  return [
    command.title,
    command.label,
    command.description,
    command.draft,
    command.example,
    ...command.keywords,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

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

function settleStreaming(prev: UiMessage[]): UiMessage[] {
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
}

function friendlyStreamError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Response stopped.";
  }

  const retryPath =
    "Press ↑ to restore your last question, then send it again.";
  const message =
    typeof error === "string"
      ? error.trim()
      : error instanceof Error
        ? error.message.trim()
        : "";

  if (message.includes("401") || message.includes("Unauthorized")) {
    return `The Assistant could not authenticate. Check the dashboard password, then retry. ${retryPath}`;
  }
  if (message.includes("429") || /rate limit/i.test(message)) {
    return `The AI provider is busy or rate-limited. Wait a moment, then retry. ${retryPath}`;
  }
  if (message) {
    return `${message} ${retryPath}`;
  }
  return `The response could not finish. ${retryPath}`;
}

export default function ChatPanel() {
  const { chatOpen, setChatOpen } = useShellStore();
  const { showToolCalls } = useSettingsStore();
  const [messages, setMessages] = useState<UiMessage[]>(loadMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draft, setDraft] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [selectedSlashId, setSelectedSlashId] = useState<string | null>(null);

  const userMessages = messages.filter((m) => m.role === "user");
  const selectedSlashCommand =
    SLASH_COMMANDS.find((command) => command.id === selectedSlashId) ?? null;
  const slashMatches =
    input.startsWith("/") && !slashDismissed
      ? SLASH_COMMANDS.filter((command) => matchesSlashCommand(command, input))
      : [];
  const slashMenuOpen = slashMatches.length > 0;
  const activeSlashCommand = slashMatches[slashIndex] ?? slashMatches[0];
  const slashInputIsExact = activeSlashCommand?.example === input.trim();
  const draftHint =
    selectedSlashCommand && input.startsWith(selectedSlashCommand.draft)
      ? selectedSlashCommand.hint
      : null;
  const modelStatusText = modelLabel ?? "Checking...";
  const modelStatusDescription = modelLabel
    ? `Assistant ready. Current model: ${modelLabel}.`
    : "Assistant is checking model availability.";

  useEffect(() => {
    setSlashIndex(0);
  }, [input]);

  // Global shortcuts for opening/focusing and closing the chat panel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        !e.isComposing &&
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        const nextOpen = !useShellStore.getState().chatOpen;
        setChatOpen(nextOpen);
        if (nextOpen) {
          requestAnimationFrame(() => taRef.current?.focus());
        }
        return;
      }

      if (e.key === "Escape") {
        setChatOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setChatOpen]);

  useEffect(() => {
    if (chatOpen) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (!panelRef.current?.contains(active)) return;
    document.getElementById("chat-toggle-button")?.focus();
  }, [chatOpen]);

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

  const handleEvent = useCallback((ev: StreamEvent) => {
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
      setMessages(settleStreaming);
    } else if (ev.type === "error") {
      setMessages((prev) => {
        const next = dropEmptyStreaming(prev);
        next.push({ role: "error", content: friendlyStreamError(ev.error) });
        return next;
      });
    }
  }, []);

  const send = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || busy) return;
      setInput("");
      setSelectedSlashId(null);
      setSlashDismissed(false);
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
        setMessages(settleStreaming);
      } catch (err) {
        if (!ctrl.signal.aborted) {
          setMessages((prev) => {
            const next = dropEmptyStreaming(prev);
            next.push({
              role: "error",
              content: friendlyStreamError(err),
            });
            return next;
          });
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [input, busy, messages, handleEvent],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages(settleStreaming);
    setBusy(false);
  }, []);

  const applySlashCommand = (command: SlashCommand) => {
    const nextInput = input.startsWith(command.draft) ? input : command.draft;
    const caretPosition = nextInput.length;
    setInput(nextInput);
    setSelectedSlashId(command.id);
    setSlashDismissed(true);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(caretPosition, caretPosition);
    });
  };

  const openSlashCommands = () => {
    setInput((value) => {
      if (!value.trim()) return "/";
      return value.startsWith("/") ? value : value;
    });
    setSelectedSlashId(null);
    setSlashDismissed(false);
    setSlashIndex(0);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((idx) => (idx + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((idx) => (idx - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (activeSlashCommand) applySlashCommand(activeSlashCommand);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !slashInputIsExact) {
        e.preventDefault();
        if (activeSlashCommand) applySlashCommand(activeSlashCommand);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSlashDismissed(true);
        return;
      }
    }

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
    <aside
      ref={panelRef}
      className="chat-panel chat-panel--assistant"
      data-open={chatOpen ? "true" : "false"}
      style={
        {
          left: chatOpen ? "0px" : "100vw",
          opacity: chatOpen ? 1 : 0,
          visibility: chatOpen ? "visible" : "hidden",
          "--chat-panel-mobile-left": chatOpen ? "0px" : "100vw",
        } as CSSProperties
      }
      aria-label="Assistant chat"
      aria-hidden={chatOpen ? undefined : true}
      inert={chatOpen ? undefined : true}
    >
      <ChatResizer />
      <div className="chat-panel__header">
        <MessageCircle
          className="chat-panel__icon"
          size={16}
          style={{ color: "var(--color-text-muted)" }}
        />
        <div className="chat-panel__title">Assistant</div>
        <div
          className="chat-panel__sub"
          title={modelStatusDescription}
          aria-label={modelStatusDescription}
          aria-live="polite"
        >
          {modelLabel ? (
            <span className="chat-panel__status-dot" aria-hidden="true" />
          ) : null}
          <span aria-hidden="true">{modelStatusText}</span>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            className="chat-panel__close chat-panel__action chat-panel__action--clear"
            onClick={clear}
            title="Clear conversation"
            aria-label="Clear Assistant conversation"
          >
            <Trash2 size={14} />
          </button>
        )}
        <button
          type="button"
          className="chat-panel__close chat-panel__action chat-panel__action--close"
          onClick={() => setChatOpen(false)}
          title="Close"
          aria-label="Close Assistant"
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
        {slashMenuOpen && (
          <div
            id="slash-command-menu"
            className="slash-menu"
            role="listbox"
            aria-label="Slash commands"
          >
            <div className="slash-menu__header">
              <span>Commands</span>
              <span>draft</span>
            </div>
            <div className="slash-menu__list">
              {slashMatches.map((command, index) => (
                <button
                  key={command.id}
                  id={`slash-command-${index}`}
                  type="button"
                  className="slash-menu__item"
                  data-active={index === slashIndex}
                  role="option"
                  aria-selected={index === slashIndex}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applySlashCommand(command);
                  }}
                >
                  <span
                    className="slash-menu__icon"
                    data-game={command.label.toLowerCase()}
                    aria-hidden="true"
                  >
                    {command.label === "CHUNITHM" ? "CH" : "M"}
                  </span>
                  <span className="slash-menu__main">
                    <span className="slash-menu__title">{command.title}</span>
                    <span>{command.description}</span>
                    <code>{command.example}</code>
                  </span>
                </button>
              ))}
            </div>
            <div className="slash-menu__footer">
              <kbd>↑</kbd>/<kbd>↓</kbd> move · <kbd>Tab</kbd> insert
            </div>
          </div>
        )}
        <GlassComposer className="chat-composer__surface">
          <div className="chat-composer__row">
            <button
              type="button"
              className="chat-composer__command chat-composer__command--slash"
              onClick={openSlashCommands}
              disabled={busy || Boolean(input && !input.startsWith("/"))}
              data-active={slashMenuOpen}
              aria-pressed={slashMenuOpen}
              aria-haspopup="listbox"
              aria-keyshortcuts="/"
              aria-label="Open slash commands"
              title="Commands (/)"
            >
              <span className="chat-composer__command-glyph" aria-hidden="true">
                /
              </span>
            </button>
            <textarea
              ref={taRef}
              className="chat-composer__input flex-1 bg-transparent border-none outline-none text-foreground
                         placeholder:text-muted-foreground resize-none min-h-[22px] max-h-[140px]
                         py-1 px-1 scrollbar-thin"
              placeholder="Ask about plays, rating, or song picks…"
              aria-expanded={slashMenuOpen}
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-controls={slashMenuOpen ? "slash-command-menu" : undefined}
              aria-activedescendant={
                slashMenuOpen ? `slash-command-${slashIndex}` : undefined
              }
              value={input}
              onChange={(e) => {
                const nextInput = e.target.value;
                setInput(nextInput);
                if (
                  selectedSlashCommand &&
                  nextInput.startsWith(selectedSlashCommand.draft)
                ) {
                  setSlashDismissed(true);
                } else {
                  setSelectedSlashId(null);
                  setSlashDismissed(false);
                }
                if (historyIndex !== -1) setHistoryIndex(-1);
              }}
              onKeyDown={onKeyDown}
              rows={1}
              disabled={busy}
            />
            <GlassSendButton
              disabled={!busy && !input.trim()}
              onClick={() => (busy ? stop() : send())}
              title={busy ? "Stop response" : "Send"}
              aria-label={busy ? "Stop response" : "Send message"}
              data-busy={busy}
            >
              {busy ? <Square size={12} fill="currentColor" /> : undefined}
            </GlassSendButton>
          </div>
        </GlassComposer>
        <div className="chat-composer__hints">
          {draftHint ? (
            <span className="chat-composer__draft-hint">{draftHint}</span>
          ) : (
            <span className="chat-composer__shortcut-hints">
              <kbd>Enter</kbd> send · <kbd>↑</kbd> history · <kbd>/</kbd>{" "}
              commands
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}

function MessageRow({ m }: { m: UiMessage }) {
  if (m.role === "user") {
    return (
      <div className="chat-msg chat-msg--user" data-message-role="user">
        <div className="chat-msg__role">You</div>
        <div className="chat-msg__body">{m.content}</div>
      </div>
    );
  }
  if (m.role === "tool") {
    return <ToolCall name={m.name} result={m.result} />;
  }
  if (m.role === "error") {
    return (
      <div className="chat-err" data-message-role="error">
        {m.content}
      </div>
    );
  }
  return (
    <div
      className="chat-msg chat-msg--assistant"
      data-message-role="assistant"
      data-streaming={m.streaming ? "true" : undefined}
    >
      <div className="chat-msg__role">Assistant</div>
      <div
        className="chat-msg__body"
        aria-live={m.streaming ? "polite" : undefined}
      >
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
