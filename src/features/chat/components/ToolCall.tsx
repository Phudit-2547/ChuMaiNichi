import { useState } from "react";
import { ChevronRight, Database, Wand } from "lucide-react";
import { renderSQL } from "../lib/render-sql";

interface QueryResult {
  sql?: string;
  rows?: unknown[];
  rowCount?: number;
  error?: string;
}

interface SuggestedMove {
  title: string;
  difficulty: string;
  level: string;
  current_score: number;
  current_rank: string;
  current_pct: string;
  target_rank: string;
  target_pct: string;
  rating_gain: number;
  section?: string;
  type?: "improve" | "new";
}

interface SuggestResult {
  mode?: "target" | "best_effort";
  target_rating?: number | null;
  current_rating?: number;
  rating_needed?: number;
  moves?: SuggestedMove[];
  message?: string;
  error?: string;
}

interface ToolCallProps {
  name: string;
  result: unknown;
}

export default function ToolCall({ name, result }: ToolCallProps) {
  const [open, setOpen] = useState(false);
  const isQuery = name === "query_database";
  const isSuggest = name === "maimai_suggest_songs";
  const r = (result ?? {}) as Record<string, unknown>;
  const hasError = typeof r.error === "string";
  const meta = hasError ? "error" : buildMeta(name, r);

  return (
    <div className="chat-tool" data-open={open}>
      <button
        type="button"
        className="chat-tool__head"
        onClick={() => setOpen((o) => !o)}
      >
        {isQuery ? (
          <Database className="chat-tool__icon" />
        ) : (
          <Wand className="chat-tool__icon" />
        )}
        <span className="chat-tool__name">{name}</span>
        <span className="chat-tool__meta">{meta}</span>
        <ChevronRight className="chat-tool__chev" />
      </button>
      {open && (
        <div className="chat-tool__body">
          {hasError ? (
            <ErrorBody result={r as QueryResult & SuggestResult} />
          ) : isQuery ? (
            <QueryBody result={r as QueryResult} />
          ) : isSuggest ? (
            <SuggestBody result={r as SuggestResult} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function buildMeta(name: string, r: Record<string, unknown>): string {
  if (name === "query_database") {
    const rc = typeof r.rowCount === "number" ? r.rowCount : 0;
    return `${rc} row${rc === 1 ? "" : "s"}`;
  }
  if (name === "maimai_suggest_songs") {
    const moves = Array.isArray(r.moves) ? r.moves : [];
    const rn = r.rating_needed;
    return typeof rn === "number" && rn > 0
      ? `${moves.length} picks · gain +${rn}`
      : `${moves.length} picks`;
  }
  return "";
}

function ErrorBody({ result }: { result: QueryResult & SuggestResult }) {
  return (
    <div className="chat-err" style={{ margin: 0 }}>
      {result.error}
      {result.sql && <pre style={{ marginTop: "0.5rem" }}>{renderSQL(result.sql)}</pre>}
    </div>
  );
}

function QueryBody({ result }: { result: QueryResult }) {
  if (!result.sql) return <div className="chat-tool__meta">(no sql)</div>;
  return <pre>{renderSQL(result.sql)}</pre>;
}

function SuggestBody({ result }: { result: SuggestResult }) {
  const moves = result.moves ?? [];
  return (
    <>
      <div className="chat-tool__meta" style={{ marginBottom: "0.55rem" }}>
        mode={result.mode ?? "?"}
        {result.target_rating != null && ` · target=${result.target_rating}`}
        {result.current_rating != null && ` · current=${result.current_rating}`}
      </div>
      <div className="song-list">
        {moves.map((s, i) => (
          <div className="song-row" key={i}>
            <span className="song-diff" data-d={shortDiff(s.difficulty)}>
              {shortDiff(s.difficulty)}
            </span>
            <div className="song-meta">
              <div className="song-title">
                {s.title}
                {s.type === "new" && <span className="song-title__badge">NEW</span>}
              </div>
              <div className="song-sub">
                Lv {s.level} · {s.current_pct || "unplayed"}{" "}
                {s.current_rank} → {s.target_rank} ({s.target_pct})
              </div>
            </div>
            <div className="song-gain">+{s.rating_gain}</div>
          </div>
        ))}
      </div>
      {result.message && (
        <div className="chat-tool__meta" style={{ marginTop: "0.55rem" }}>
          {result.message}
        </div>
      )}
    </>
  );
}

function shortDiff(d: string): string {
  const up = d?.toUpperCase() ?? "";
  if (up.startsWith("RE")) return "RE:M";
  if (up.startsWith("MAS")) return "MAS";
  if (up.startsWith("EXP")) return "EXP";
  if (up.startsWith("ADV")) return "ADV";
  if (up.startsWith("BAS")) return "BAS";
  return up.slice(0, 3);
}
