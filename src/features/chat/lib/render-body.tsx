import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { ThoughtBlock } from "../components/ThoughtBlock";

type Segment =
  | { type: "md"; content: string }
  | { type: "think"; content: string; done: boolean };

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

export function renderBody(text: string, streaming: boolean): ReactNode {
  const segs = parseSegments(text);
  return (
    <>
      {segs.map((s, i) =>
        s.type === "think" ? (
          <ThoughtBlock key={i} content={s.content} done={s.done} />
        ) : (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            urlTransform={normalizeUrl}
          >
            {s.content}
          </ReactMarkdown>
        ),
      )}
      {streaming && <span className="chat-cursor" />}
    </>
  );
}
