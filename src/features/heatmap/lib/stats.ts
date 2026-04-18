import type { DailyRow, Game, HeatmapStats } from "../types/types";
import { PLAY_KEY } from "./constants";

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function computeStats(
  data: DailyRow[],
  game: Game,
  year: number,
): HeatmapStats {
  const key = PLAY_KEY[game];
  const yearPrefix = String(year);
  const yearData = data
    .filter((d) => d.play_date.startsWith(yearPrefix))
    .sort((a, b) => a.play_date.localeCompare(b.play_date));

  const total = yearData.reduce((sum, d) => sum + (d[key] as number), 0);

  // This week (Sunday start)
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  const weekStartStr = toDateStr(weekStart);
  const todayStr = toDateStr(now);
  const thisWeek = yearData
    .filter((d) => d.play_date >= weekStartStr && d.play_date <= todayStr)
    .reduce((sum, d) => sum + (d[key] as number), 0);

  // Build play-date set
  const playDates = new Set(
    yearData.filter((d) => (d[key] as number) > 0).map((d) => d.play_date),
  );

  // Longest streak
  let longestStreak = 0;
  let tempStreak = 0;
  const endDate = new Date(
    Math.min(new Date(`${year + 1}-01-01`).getTime(), Date.now()),
  );
  for (
    let d = new Date(`${year}-01-01`);
    d < endDate;
    d.setDate(d.getDate() + 1)
  ) {
    if (playDates.has(toDateStr(d))) {
      tempStreak++;
      if (tempStreak > longestStreak) longestStreak = tempStreak;
    } else {
      tempStreak = 0;
    }
  }

  // Current streak (backwards from today)
  let currentStreak = 0;
  for (
    let d = new Date(now);
    d >= new Date(`${year}-01-01`);
    d.setDate(d.getDate() - 1)
  ) {
    if (playDates.has(toDateStr(d))) {
      currentStreak++;
    } else {
      break;
    }
  }

  return { total, thisWeek, currentStreak, longestStreak };
}
