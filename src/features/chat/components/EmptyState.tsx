import { Calendar, Coins, Target, TrendingUp } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

interface Suggestion {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  text: string;
}

const SUGGESTIONS: Suggestion[] = [
  { icon: Calendar, text: "How many times did I play this week?" },
  { icon: Target, text: "Find efficient maimai songs for rating" },
  { icon: TrendingUp, text: "Show my rating progress this month" },
  { icon: Coins, text: "How much have I spent this year?" },
];

interface EmptyStateProps {
  onPick: (text: string) => void;
}

export default function EmptyState({ onPick }: EmptyStateProps) {
  return (
    <div className="chat-empty">
      <div className="chat-empty__hello">Assistant</div>
      <p className="chat-empty__desc">
        Ask about play counts, rating movement, spending, or maimai song picks.
        Responses use your read-only play data and history.
      </p>
      <div className="chat-empty__section">Try asking</div>
      <div className="chat-suggested">
        {SUGGESTIONS.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.text}
              type="button"
              className="chat-suggested__btn"
              onClick={() => onPick(s.text)}
            >
              <Icon className="chat-suggested__icon" />
              <span>{s.text}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
