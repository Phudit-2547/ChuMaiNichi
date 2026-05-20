import { useEffect, useRef, useState, useCallback } from "react";
import "cal-heatmap/cal-heatmap.css";
import { queryDB } from "../../../global/lib/api";
import type { DailyRow, Game } from "../types/types";
import { fetchData, fetchYears } from "../lib/fetch";
import { formatLastUpdated } from "../lib/formatting";
import { GAME_ACCENT } from "../lib/constants";
import { GameHeatmap } from "./GameHeatmap";
import { YearDropdown } from "./YearDropdown";
import HeatmapSkeletonBlock from "./heatmap-skeleton/HeatmapSkeletonBlock";

export default function Heatmap({
  games,
  refreshNonce = 0,
}: {
  games: Game[];
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

  useEffect(() => {
    const currentYear = new Date().getFullYear();
    Promise.all([
      fetchYears(),
      queryDB<{ last_date: string }>(
        "SELECT MAX(play_date)::text AS last_date FROM daily_play",
      ),
    ])
      .then(([yrs, lastRows]) => {
        const set = new Set<number>(yrs);
        set.add(currentYear);
        set.add(currentYear - 1);
        const list = Array.from(set).sort((a, b) => a - b);
        setYears(list);
        if (isInitialLoad.current) {
          setSelectedYear(list[list.length - 1]);
          isInitialLoad.current = false;
        }
        if (lastRows[0]?.last_date) setLastUpdated(lastRows[0].last_date);
      })
      .catch(() => {
        if (isInitialLoad.current) {
          setYears([currentYear, currentYear - 1]);
          setSelectedYear(currentYear);
          isInitialLoad.current = false;
        }
      });
  }, [refreshNonce]);

  const [isStale, setIsStale] = useState(false);

  useEffect(() => {
    if (lastUpdated == null) {
      const id = setTimeout(() => setIsStale(false), 0);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => {
      const ageMs = Date.now() - new Date(lastUpdated + "T00:00:00").getTime();
      setIsStale(ageMs > 2 * 86400000);
    }, 0);
    return () => clearTimeout(id);
  }, [lastUpdated]);

  const abortRef = useRef<AbortController | null>(null);

  const loadData = useCallback(async (year: number, spillover: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchData(year, spillover, controller.signal));
    } catch (err) {
      if (controller.signal.aborted) return;
      setData([]);
      const raw = err instanceof Error ? err.message : "";
      if (raw.includes("unauthorized")) {
        setError("Session expired. Reload the page, sign in, then retry.");
      } else if (
        raw.includes("fetch") ||
        raw.includes("network") ||
        raw.includes("Failed to fetch")
      ) {
        setError(
          "Couldn't reach the dashboard API. Check your connection, then retry.",
        );
      } else {
        setError(
          "Play data couldn't load. Retry; your saved scores are unchanged.",
        );
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

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
    ? isStale
      ? `Last update ${lastUpdatedLabel}. Refresh scores to check for new sessions.`
      : `Last updated ${lastUpdatedLabel}`
    : null;

  return (
    <div>
      <div className="heatmap-toolbar flex flex-wrap items-center gap-2 mb-4">
        <label className="text-sm text-secondary-foreground">Year</label>
        <YearDropdown
          value={selectedYear}
          years={years}
          onChange={setSelectedYear}
        />
        {lastUpdated && (
          <span
            className={`w-full sm:w-auto sm:ml-auto text-xs ${isStale ? "text-destructive" : "text-muted-foreground"}`}
            title={updateStatusText ?? undefined}
            aria-live="polite"
          >
            {updateStatusText}
          </span>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-8" aria-label="Loading heatmap data">
          {games.map((game) => (
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
            className="glass-control glass-control--primary px-4 py-1.5 text-sm cursor-pointer
                       focus:outline-none focus:ring-2 focus:ring-accent/30
                       transition-colors duration-150"
            onClick={() => loadData(selectedYear, true)}
          >
            Retry loading
          </button>
        </div>
      )}

      {!loading &&
        !error &&
        games.map((game) => (
          <div key={game} className="game-section mb-8">
            <h2 className="game-heading">
              <span
                className="game-heading__mark"
                style={{ backgroundColor: GAME_ACCENT[game] }}
                aria-hidden="true"
              />
              <span>{game === "maimai" ? "maimai" : "CHUNITHM"}</span>
            </h2>
            {data.length > 0 ? (
              <GameHeatmap
                game={game}
                data={data}
                year={selectedYear}
              />
            ) : (
              <div className="heatmap-empty content-panel p-8 text-center text-muted-foreground border border-border rounded-lg">
                <p className="m-0">No plays recorded in {selectedYear}</p>
                <p className="mt-2 text-xs m-0">
                  Choose another year, or use Refresh scores after your first
                  scrape finishes. Future sessions will appear here
                  automatically.
                </p>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
