import { Calendar, Coins, Sparkles, TrendingUp } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

interface Suggestion {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  text: string;
}

const SUGGESTIONS: Suggestion[] = [
  { icon: Calendar, text: "How many times did I play this week?" },
  { icon: Sparkles, text: "Suggest songs to reach rating 15000" },
  { icon: TrendingUp, text: "Show my rating progress this month" },
  { icon: Coins, text: "How much have I spent on arcade this year?" },
];

interface EmptyStateProps {
  onPick: (text: string) => void;
}

export default function EmptyState({ onPick }: EmptyStateProps) {
  return (
    <div className="chat-empty">
      <div className="chat-empty__hello">ChuMaiNichi assistant</div>
      <p className="chat-empty__desc">
        Ask about play counts, ratings, spending, or request maimai song picks
        to improve your rating. I query your Neon snapshots in read-only mode —
        nothing is written.
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
