import { Calendar, Coins, Disc3, Target, TrendingUp } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { DataRegion } from "@/global/lib/regions";

interface Suggestion {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  text: string;
}

const INTERNATIONAL_SUGGESTIONS: Suggestion[] = [
  { icon: Calendar, text: "How many plays this week?" },
  { icon: Target, text: "Find efficient maimai rating gains" },
  { icon: TrendingUp, text: "Show rating movement this month" },
  { icon: Coins, text: "How much did I spend this year?" },
];

const JAPAN_SUGGESTIONS: Suggestion[] = [
  { icon: Calendar, text: "How many times did I play in Japan?" },
  { icon: Disc3, text: "Which day had the most ONGEKI tracks?" },
  { icon: TrendingUp, text: "Show my Japan arcade streaks" },
  { icon: Target, text: "Compare my Japan maimai and CHUNITHM totals" },
];

interface EmptyStateProps {
  onPick: (text: string) => void;
  region: DataRegion;
}

export default function EmptyState({ onPick, region }: EmptyStateProps) {
  const isJapan = region === "japan";
  const suggestions = isJapan
    ? JAPAN_SUGGESTIONS
    : INTERNATIONAL_SUGGESTIONS;
  return (
    <div className="chat-empty">
      <div className="chat-empty__hello">Assistant</div>
      <p className="chat-empty__desc">
        {isJapan
          ? "Ask about your Japan maimai, CHUNITHM, or ONGEKI activity. ONGEKI is counted in tracks."
          : "Ask for play counts, rating movement, spending, or maimai song picks. Assistant uses your saved play data only."}
      </p>
      <div className="chat-empty__section">Try asking</div>
      <div className="chat-suggested">
        {suggestions.map((s) => {
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
