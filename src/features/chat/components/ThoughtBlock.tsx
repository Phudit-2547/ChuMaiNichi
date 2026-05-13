import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";

export function ThoughtBlock({
  content,
  done,
}: {
  content: string;
  done: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-thought" data-open={open} data-done={done}>
      <button
        type="button"
        className="chat-thought__head"
        onClick={() => setOpen((o) => !o)}
      >
        <Brain className="chat-thought__icon" />
        <span className="chat-thought__label">
          {done ? "Thoughts" : "Thinking\u2026"}
        </span>
        <ChevronRight className="chat-thought__chev" />
      </button>
      {open && <div className="chat-thought__body">{content.trim()}</div>}
    </div>
  );
}
