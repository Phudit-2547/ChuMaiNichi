import type { HeatmapStats } from "../types/types";

export function StatsBar({
  stats,
  year,
}: {
  stats: HeatmapStats;
  year: number;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-secondary-foreground mb-2">
      <span title="Total credited plays this year">
        <strong className="text-foreground font-semibold">
          {stats.total.toLocaleString()}
        </strong>{" "}
        plays in {year}
      </span>
      <span title="Plays since Sunday">
        <strong className="text-foreground font-semibold">
          {stats.thisWeek}
        </strong>{" "}
        this week
      </span>
      <span title="Consecutive days with at least one play, ending today">
        streak{" "}
        <strong className="text-foreground font-semibold">
          {stats.currentStreak}
        </strong>{" "}
        days
      </span>
      <span title="Longest consecutive play streak this year">
        longest{" "}
        <strong className="text-foreground font-semibold">
          {stats.longestStreak}
        </strong>{" "}
        days
      </span>
    </div>
  );
}
