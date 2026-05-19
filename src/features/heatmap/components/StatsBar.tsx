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
    <div className="stats-bar">
      <div className="stats-bar__today">
        <span
          className="stats-bar__today-value"
          style={{ color: accent }}
        >
          {stats.today}
        </span>
        <span className="stats-bar__today-label">
          today
        </span>
      </div>

      <div
        className="stats-bar__divider"
        aria-hidden="true"
      />

      <div className="stats-bar__item">
        <span className="stats-bar__item-value text-foreground">
          {stats.thisWeek}
        </span>
        <span className="stats-bar__item-label">
          this week
        </span>
      </div>

      <span className="stats-bar__dot">·</span>

      <div className="stats-bar__item">
        <span className="stats-bar__item-value">
          {stats.total.toLocaleString()}
        </span>
        <span className="stats-bar__item-label">
          total {year}
        </span>
      </div>

      <span className="stats-bar__dot">·</span>

      <div className="stats-bar__item">
        <span className="stats-bar__item-value">
          {stats.currentStreak}
        </span>
        <span className="stats-bar__item-label">
          streak
        </span>
      </div>

      <span className="stats-bar__dot">·</span>

      <div className="stats-bar__item">
        <span className="stats-bar__item-value">
          {stats.longestStreak}
        </span>
        <span className="stats-bar__item-label">
          longest
        </span>
      </div>
    </div>
  );
}
