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
  image?: string;
  cover_url?: string;
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
  const label = getToolLabel(name);
  const meta = hasError ? "error" : buildMeta(name, r);
  const detailAction = open ? "Hide details" : "Show details";

  return (
    <div className="chat-tool" data-open={open} data-tool={name}>
      <button
        type="button"
        className="chat-tool__head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${label}${meta ? `, ${meta}` : ""}. ${detailAction}. Tool: ${name}.`}
        title={`${label} (${name})`}
      >
        {isQuery ? (
          <Database className="chat-tool__icon" />
        ) : (
          <Wand className="chat-tool__icon" />
        )}
        <span className="chat-tool__name">{label}</span>
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

function getToolLabel(name: string): string {
  if (name === "query_database") return "Checked scores";
  if (name === "maimai_suggest_songs") return "Found song picks";
  return "Ran assistant check";
}

function buildMeta(name: string, r: Record<string, unknown>): string {
  if (name === "query_database") {
    const rc = typeof r.rowCount === "number" ? r.rowCount : 0;
    if (rc === 0) return "No rows";
    return `${rc} row${rc === 1 ? "" : "s"}`;
  }
  if (name === "maimai_suggest_songs") {
    const moves = Array.isArray(r.moves) ? r.moves : [];
    if (moves.length === 0) return "No picks";

    const gain = moves.reduce((total, move) => {
      if (
        typeof move === "object" &&
        move !== null &&
        "rating_gain" in move &&
        typeof move.rating_gain === "number"
      ) {
        return total + move.rating_gain;
      }
      return total;
    }, 0);

    return gain > 0
      ? `${moves.length} picks · +${gain} total`
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
  if (!result.sql) return <div className="chat-tool__meta">No query details</div>;
  return <pre>{renderSQL(result.sql)}</pre>;
}

function SuggestBody({ result }: { result: SuggestResult }) {
  const moves = result.moves ?? [];
  return (
    <>
      <div className="chat-tool__meta" style={{ marginBottom: "0.55rem" }}>
        {formatSuggestMeta(result)}
      </div>
      <div className="song-list">
        {moves.map((s, i) => (
          <div className="song-row" key={i}>
            {s.cover_url ? (
              <img
                className="song-jacket"
                src={s.cover_url}
                alt=""
                loading="lazy"
              />
            ) : (
              <div className="song-jacket song-jacket--placeholder" aria-hidden />
            )}
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

function formatSuggestMeta(result: SuggestResult): string {
  const parts = [
    result.mode === "target"
      ? "Target plan"
      : result.mode === "best_effort"
        ? "Rating picks"
        : "Song-pick check",
  ];

  if (result.target_rating != null) {
    parts.push(`Target ${formatRating(result.target_rating)}`);
  }
  if (result.current_rating != null) {
    parts.push(`Current ${formatRating(result.current_rating)}`);
  }

  return parts.join(" · ");
}

function formatRating(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
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
