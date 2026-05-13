import type { HeatmapStats, Game } from "../types/types";
import { GAME_ACCENT } from "../lib/constants";

export function StatsBar({
  stats,
  year,
  game,
}: {
  stats: HeatmapStats;
  year: number;
  game: Game;
}) {
  const accent = GAME_ACCENT[game];

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-3">
      {/* Primary — today's plays, accent colored */}
      <div className="flex items-baseline gap-1.5">
        <span
          className="text-3xl font-bold tracking-tight leading-none"
          style={{ color: accent }}
        >
          {stats.today}
        </span>
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
          today
        </span>
      </div>

      <div
        className="w-px h-6 bg-border-subtle mx-1"
        aria-hidden="true"
      />

      {/* Secondary — this week */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-semibold text-foreground">
          {stats.thisWeek}
        </span>
        <span className="text-xs text-muted-foreground">
          this week
        </span>
      </div>

      <span className="text-xs text-muted-foreground">·</span>

      {/* Tertiary — total plays */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-semibold text-muted-foreground">
          {stats.total.toLocaleString()}
        </span>
        <span className="text-xs text-muted-foreground">
          total {year}
        </span>
      </div>

      <span className="text-xs text-muted-foreground">·</span>

      {/* Quaternary — streaks */}
      <div className="flex items-baseline gap-1">
        <span className="text-sm font-semibold text-muted-foreground">
          {stats.currentStreak}
        </span>
        <span className="text-xs text-muted-foreground">
          streak
        </span>
      </div>

      <span className="text-xs text-muted-foreground">·</span>

      <div className="flex items-baseline gap-1">
        <span className="text-sm font-semibold text-muted-foreground">
          {stats.longestStreak}
        </span>
        <span className="text-xs text-muted-foreground">
          longest
        </span>
      </div>
    </div>
  );
}
