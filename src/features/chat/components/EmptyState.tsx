import { Calendar, Coins, Target, TrendingUp } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

interface Suggestion {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  text: string;
}

const SUGGESTIONS: Suggestion[] = [
  { icon: Calendar, text: "How many plays this week?" },
  { icon: Target, text: "Find efficient maimai rating gains" },
  { icon: TrendingUp, text: "Show rating movement this month" },
  { icon: Coins, text: "How much did I spend this year?" },
];

interface EmptyStateProps {
  onPick: (text: string) => void;
}

export default function EmptyState({ onPick }: EmptyStateProps) {
  return (
    <div className="chat-empty">
      <div className="chat-empty__hello">Assistant</div>
      <p className="chat-empty__desc">
        Ask for play counts, rating movement, spending, or maimai song picks.
        Assistant uses your saved play data only.
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
