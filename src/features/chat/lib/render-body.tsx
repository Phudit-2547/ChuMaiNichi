import { Fragment, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { ThoughtBlock } from "../components/ThoughtBlock";

type Segment =
  | { type: "md"; content: string }
  | { type: "think"; content: string; done: boolean };

interface AnswerSummary {
  title: string;
  score: string;
  gain: string;
}

interface SummaryMarkdown {
  before: string;
  tableAndAfter: string;
  summary: AnswerSummary;
}

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const re = /<think>([\s\S]*?)(<\/think>|$)/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > lastEnd) {
      segments.push({ type: "md", content: text.slice(lastEnd, m.index) });
    }
    segments.push({
      type: "think",
      content: m[1],
      done: m[2] === "</think>",
    });
    lastEnd = re.lastIndex;
  }
  if (lastEnd < text.length) {
    segments.push({ type: "md", content: text.slice(lastEnd) });
  }
  return segments;
}

const COVER_FILENAME_RE = /([a-f0-9]{16}\.png)/i;

function normalizeUrl(url: string, key: string): string {
  if (key !== "src") return url;
  const match = COVER_FILENAME_RE.exec(url);
  if (match) return `/api/cover?img=${match[1]}`;
  return url;
}

function splitMaimaiSuggestionTable(markdown: string): SummaryMarkdown | null {
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length - 2; i += 1) {
    const headers = splitMarkdownTableRow(lines[i]);
    if (!isSuggestionHeader(headers)) continue;
    if (!isMarkdownSeparator(splitMarkdownTableRow(lines[i + 1]))) continue;

    const firstRow = splitMarkdownTableRow(lines[i + 2]);
    if (!firstRow || firstRow.length !== 3) return null;

    const summary = buildAnswerSummary(firstRow);
    if (!summary) return null;

    return {
      before: lines.slice(0, i).join("\n"),
      tableAndAfter: lines.slice(i).join("\n"),
      summary,
    };
  }

  return null;
}

function splitMarkdownTableRow(line: string): string[] | null {
  let row = line.trim();
  if (!row.startsWith("|")) return null;
  row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let escaped = false;

  for (const char of row) {
    if (char === "|" && !escaped) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
    escaped = char === "\\" && !escaped;
    if (char !== "\\" && escaped) escaped = false;
  }

  cells.push(cell.trim());
  return cells;
}

function isSuggestionHeader(cells: string[] | null): boolean {
  if (!cells || cells.length !== 3) return false;
  return (
    normalizeCell(cells[0]) === "song" &&
    normalizeCell(cells[1]) === "score" &&
    normalizeCell(cells[2]) === "gain"
  );
}

function isMarkdownSeparator(cells: string[] | null): boolean {
  return Boolean(
    cells?.length === 3 &&
      cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, ""))),
  );
}

function buildAnswerSummary(cells: string[]): AnswerSummary | null {
  const title = extractSongTitle(cells[0]);
  const score = cleanCellText(cells[1]);
  const gain = cleanFirstCellLine(cells[2]);

  if (!title || !score || !gain) return null;
  return { title, score, gain };
}

function extractSongTitle(cell: string): string {
  const boldTitle = /\*\*([\s\S]*?)\*\*/.exec(cell);
  if (boldTitle) return cleanCellText(boldTitle[1]);

  const withoutImage = cell.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  const [beforeMeta] = withoutImage.split(/<br\s*\/?>/i);
  return cleanCellText(beforeMeta);
}

function cleanCellText(cell: string): string {
  return decodeBasicEntities(
    cell
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/[*_`~]/g, "")
      .replace(/\\([\\|*_`~])/g, "$1")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function cleanFirstCellLine(cell: string): string {
  const [firstLine] = cell.split(/<br\s*\/?>/i);
  return cleanCellText(firstLine || cell) || cleanCellText(cell);
}

function normalizeCell(cell: string): string {
  return cleanCellText(cell).toLowerCase();
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function renderMarkdownBody(content: string): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw]}
      urlTransform={normalizeUrl}
    >
      {content}
    </ReactMarkdown>
  );
}

function renderMaimaiAnswerSummary(summary: AnswerSummary): ReactNode {
  return (
    <div className="chat-answer-summary" data-kind="maimai-suggestion">
      <span className="chat-answer-summary__label">Top pick</span>{" "}
      <strong className="chat-answer-summary__title">{summary.title}</strong>{" "}
      <span className="chat-answer-summary__score">Score {summary.score}</span>{" "}
      <span className="chat-answer-summary__gain">Gain {summary.gain}</span>
    </div>
  );
}

function renderMarkdownWithAnswerSummary(content: string): ReactNode {
  const split = splitMaimaiSuggestionTable(content);
  if (!split) return renderMarkdownBody(content);

  return (
    <>
      {split.before.trim() && renderMarkdownBody(split.before)}
      {renderMaimaiAnswerSummary(split.summary)}
      {renderMarkdownBody(split.tableAndAfter)}
    </>
  );
}

export function renderBody(text: string, streaming: boolean): ReactNode {
  const segs = parseSegments(text);
  return (
    <>
      {segs.map((s, i) =>
        s.type === "think" ? (
          <ThoughtBlock key={i} content={s.content} done={s.done} />
        ) : (
          <Fragment key={i}>
            {renderMarkdownWithAnswerSummary(s.content)}
          </Fragment>
        ),
      )}
      {streaming && <span className="chat-cursor" />}
    </>
  );
}
