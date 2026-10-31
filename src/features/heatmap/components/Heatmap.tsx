import { useEffect, useRef, useState, useCallback } from "react";
import "cal-heatmap/cal-heatmap.css";
import type {
  DailyRow,
  DataRegion,
  Game,
  HeatmapGame,
} from "../types/types";
import { fetchData, fetchLastUpdated, fetchYears } from "../lib/fetch";
import { formatLastUpdated } from "../lib/formatting";
import {
  ACTIVITY_UNIT,
  GAME_ACCENT,
  GAME_LABELS,
  JAPAN_GAMES,
} from "../lib/constants";
import { GameHeatmap } from "./GameHeatmap";
import { YearDropdown } from "./YearDropdown";
import HeatmapSkeletonBlock from "./heatmap-skeleton/HeatmapSkeletonBlock";
import usePlayLogStore from "../../play-log/stores/play-log-store";
import { isEditableDate, regionToday } from "../../../global/lib/play-log";

export default function Heatmap({
  games,
  region = "international",
  refreshNonce = 0,
}: {
  games: Game[];
  region?: DataRegion;
  refreshNonce?: number;
}) {
  const [years, setYears] = useState<number[]>([]);
  const [selectedYear, setSelectedYear] = useState<number>(
    new Date().getFullYear(),
  );
  const [data, setData] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const isInitialLoad = useRef(true);
  const openPlayLog = usePlayLogStore((state) => state.openDay);
  const visibleGames: HeatmapGame[] =
    region === "japan" ? JAPAN_GAMES : games;

  useEffect(() => {
    let cancelled = false;
    const currentYear = new Date().getFullYear();
    Promise.all([
      fetchYears(region),
      fetchLastUpdated(region),
    ])
      .then(([yrs, latestDate]) => {
        if (cancelled) return;
        const set = new Set<number>(yrs);
        if (region === "international") {
          set.add(currentYear);
          set.add(currentYear - 1);
        } else if (set.size === 0) {
          set.add(currentYear);
        }
        const list = Array.from(set).sort((a, b) => a - b);
        setYears(list);
        if (isInitialLoad.current) {
          setSelectedYear(list[list.length - 1]);
          isInitialLoad.current = false;
        } else {
          setSelectedYear((year) =>
            list.includes(year) ? year : list[list.length - 1],
          );
        }
        setLastUpdated(latestDate);
      })
      .catch(() => {
        if (cancelled) return;
        setLastUpdated(null);
        if (isInitialLoad.current) {
          setYears(
            region === "international"
              ? [currentYear - 1, currentYear]
              : [currentYear],
          );
          setSelectedYear(currentYear);
          isInitialLoad.current = false;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [region, refreshNonce]);

  const [isStale, setIsStale] = useState(false);

  useEffect(() => {
    if (lastUpdated == null || region === "japan") {
      const id = setTimeout(() => setIsStale(false), 0);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => {
      const ageMs = Date.now() - new Date(lastUpdated + "T00:00:00").getTime();
      setIsStale(ageMs > 2 * 86400000);
    }, 0);
    return () => clearTimeout(id);
  }, [lastUpdated, region]);

  const abortRef = useRef<AbortController | null>(null);

  const loadData = useCallback(async (year: number, spillover: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      setData(
        await fetchData(year, spillover, controller.signal, region),
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      setData([]);
      const raw = err instanceof Error ? err.message : "";
      if (raw.includes("unauthorized")) {
        setError("Session expired. Reload, sign in, and retry.");
      } else if (
        raw.includes("fetch") ||
        raw.includes("network") ||
        raw.includes("Failed to fetch")
      ) {
        setError(
          "Dashboard API unreachable. Check your connection, then retry.",
        );
      } else {
        setError("Play data did not load. Saved data is unchanged.");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [region]);

  useEffect(() => {
    if (!years.length) return;
    const id = setTimeout(() => loadData(selectedYear, true), 0);
    return () => {
      clearTimeout(id);
      abortRef.current?.abort();
    };
  }, [selectedYear, years, loadData, refreshNonce]);

  const lastUpdatedLabel = lastUpdated
    ? formatLastUpdated(lastUpdated)
    : null;
  const updateStatusText = lastUpdatedLabel
    ? region === "japan"
      ? `Last recorded ${lastUpdatedLabel}`
      : isStale
        ? `Last update ${lastUpdatedLabel}. Refresh to check for new sessions.`
        : `Last updated ${lastUpdatedLabel}`
    : null;
  const hasSelectedYearData = data.some((row) =>
    row.play_date.startsWith(String(selectedYear)),
  );
  // Japan days through the last Journal day are not logged in the day editor.
  const journalThrough =
    data.filter((row) => row.source != null && row.source !== "manual").at(-1)?.play_date ?? null;
  const canEditDay = (date: string) =>
    isEditableDate(date, regionToday(region)) &&
    (journalThrough == null || date > journalThrough);

  return (
    <div data-region={region}>
      <div className="heatmap-toolbar flex flex-wrap items-center gap-2 mb-4">
        <label className="text-sm text-secondary-foreground">Year</label>
        <YearDropdown
          value={selectedYear}
          years={years}
          onChange={setSelectedYear}
        />
        {!loading && lastUpdated && (
          <span
            className={`w-full sm:w-auto sm:ml-auto text-xs ${region === "international" && isStale ? "text-destructive" : "text-muted-foreground"}`}
            title={updateStatusText ?? undefined}
            aria-live="polite"
          >
            {updateStatusText}
          </span>
        )}
      </div>

      {!loading && !error && region === "international" &&
        data.some((row) => row.scrape_failed || row.failure_reason) && (
          <div role="alert" className="content-panel p-4 mb-4 text-sm text-destructive">
            <p>Some daily counts need verification. Totals and streaks may be incomplete.</p>
            <ul>
              {data.filter((row) => row.scrape_failed || row.failure_reason).map((row) => (
                <li key={row.play_date}>
                  {row.play_date}: {row.scrape_failed ? "Scrape failed. " : ""}
                  {row.failure_reason || "Backfill required."}
                </li>
              ))}
            </ul>
          </div>
        )}

      {loading && (
        <div className="flex flex-col gap-8" aria-label="Loading play data">
          {visibleGames.map((game) => (
            <HeatmapSkeletonBlock key={game} />
          ))}
        </div>
      )}

      {!loading && error && (
        <div
          className="content-panel p-6 border border-border rounded-lg text-center text-secondary-foreground"
          role="alert"
        >
          <p className="m-0 mb-3">{error}</p>
          <button
            type="button"
            className="glass-control glass-control--primary px-4 py-1.5 text-sm cursor-pointer
                       focus:outline-none focus:ring-2 focus:ring-accent/30
                       transition-colors duration-150"
            onClick={() => loadData(selectedYear, true)}
          >
            Retry
          </button>
        </div>
      )}

      {!loading &&
        !error &&
        visibleGames.map((game) => (
          <div key={game} className="game-section mb-8">
            <h2 className="game-heading">
              <span
                className="game-heading__mark"
                style={{ backgroundColor: GAME_ACCENT[game] }}
                aria-hidden="true"
              />
              <span>{GAME_LABELS[game]}</span>
              {ACTIVITY_UNIT[game] === "track" && (
                <span className="game-heading__unit">tracks</span>
              )}
            </h2>
            {hasSelectedYearData ? (
              <GameHeatmap
                game={game}
                data={data}
                year={selectedYear}
                onEditDay={openPlayLog}
                canEditDay={canEditDay}
              />
            ) : (
              <div className="heatmap-empty content-panel p-8 text-center text-muted-foreground border border-border rounded-lg">
                <p className="m-0">
                  {region === "japan"
                    ? `No Japan activity recorded in ${selectedYear}`
                    : `No plays in ${selectedYear}`}
                </p>
                <p className="mt-2 text-xs m-0">
                  {region === "japan"
                    ? "Choose another year, or log a day with Log."
                    : "Choose another year, or refresh after the first scrape finishes."}
                </p>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
