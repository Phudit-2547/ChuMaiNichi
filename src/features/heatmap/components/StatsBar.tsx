import type { HeatmapStats, Game } from "../types/types";
import { GAME_ACCENT } from "../lib/constants";

type StatKey = "today" | "this-week" | "total-year" | "current-streak" | "longest-streak";

function getStatState(value: number) {
  return value > 0 ? "active" : "zero";
}

function StatItem({
  stat,
  value,
  label,
  prominence = "standard",
}: {
  stat: StatKey;
  value: string | number;
  label: string;
  prominence?: "primary" | "standard";
}) {
  const numericValue =
    typeof value === "number" ? value : Number(value.replaceAll(",", ""));
  const valueStyle =
    prominence === "primary" ? { color: "var(--foreground)" } : undefined;

  return (
    <div
      className={`stats-bar__item stats-bar__item--${stat}`}
      data-prominence={prominence}
      data-stat={stat}
      data-state={getStatState(numericValue)}
    >
      <span
        className="stats-bar__item-value"
        style={valueStyle}
      >
        {value}
      </span>
      <span className="stats-bar__item-label">
        {label}
      </span>
    </div>
  );
}

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
  const hasPlaysToday = stats.today > 0;
  const emphasizeWeek = !hasPlaysToday && stats.thisWeek > 0;

  return (
    <div
      className="stats-bar"
      data-today-state={getStatState(stats.today)}
    >
      {hasPlaysToday ? (
        <div
          className="stats-bar__today"
          data-prominence="accent"
          data-stat="today"
          data-state="active"
        >
          <span
            className="stats-bar__today-value"
            style={{ color: accent }}
          >
            {stats.today.toLocaleString()}
          </span>
          <span className="stats-bar__today-label">
            today
          </span>
        </div>
      ) : (
        <StatItem
          stat="today"
          value={stats.today}
          label="today"
        />
      )}

      {hasPlaysToday ? (
        <div
          className="stats-bar__divider"
          aria-hidden="true"
        />
      ) : (
        <span
          className="stats-bar__dot"
          aria-hidden="true"
        >
          ·
        </span>
      )}

      <StatItem
        stat="this-week"
        value={stats.thisWeek}
        label="this week"
        prominence={emphasizeWeek ? "primary" : "standard"}
      />

      <span
        className="stats-bar__dot"
        aria-hidden="true"
      >
        ·
      </span>

      <StatItem
        stat="total-year"
        value={stats.total.toLocaleString()}
        label={`total ${year}`}
      />

      <span
        className="stats-bar__dot"
        aria-hidden="true"
      >
        ·
      </span>

      <StatItem
        stat="current-streak"
        value={stats.currentStreak}
        label="streak"
      />

      <span
        className="stats-bar__dot"
        aria-hidden="true"
      >
        ·
      </span>

      <StatItem
        stat="longest-streak"
        value={stats.longestStreak}
        label="longest"
      />
    </div>
  );
}
