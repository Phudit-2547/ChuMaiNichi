import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import CalHeatmap from "cal-heatmap";
import Tooltip from "cal-heatmap/plugins/Tooltip";
import CalendarLabel from "cal-heatmap/plugins/CalendarLabel";
import "cal-heatmap/cal-heatmap.css";
import { select } from "d3";
import { queryDB } from "../lib/api";

// ── types ──────────────────────────────────────────────

interface DailyRow {
  play_date: string;
  maimai_play_count: number;
  chunithm_play_count: number;
  maimai_rating: number | null;
  chunithm_rating: number | null;
}

type Game = "maimai" | "chunithm";

interface HeatmapStats {
  total: number;
  thisWeek: number;
  currentStreak: number;
  longestStreak: number;
}

const COLORS: Record<Game, string[]> = {
  maimai: ["#161b22", "#5a2040", "#8a3560", "#b84a80", "#ff69aa"],
  chunithm: ["#161b22", "#1a3066", "#254a99", "#2d59a3", "#3d67e3"],
};

const PLAY_KEY: Record<Game, keyof DailyRow> = {
  maimai: "maimai_play_count",
  chunithm: "chunithm_play_count",
};

const RATING_KEY: Record<Game, keyof DailyRow> = {
  maimai: "maimai_rating",
  chunithm: "chunithm_rating",
};

// ── stats computation ─────────────────────────────────

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function computeStats(data: DailyRow[], game: Game, year: number): HeatmapStats {
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
  const endDate = new Date(Math.min(new Date(`${year + 1}-01-01`).getTime(), Date.now()));
  for (let d = new Date(`${year}-01-01`); d < endDate; d.setDate(d.getDate() + 1)) {
    if (playDates.has(toDateStr(d))) {
      tempStreak++;
      if (tempStreak > longestStreak) longestStreak = tempStreak;
    } else {
      tempStreak = 0;
    }
  }

  // Current streak (backwards from today)
  let currentStreak = 0;
  for (let d = new Date(now); d >= new Date(`${year}-01-01`); d.setDate(d.getDate() - 1)) {
    if (playDates.has(toDateStr(d))) {
      currentStreak++;
    } else {
      break;
    }
  }

  return { total, thisWeek, currentStreak, longestStreak };
}

// ── formatting helpers ─────────────────────────────────

function formatLastUpdated(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString("en-US", opts);
}

// ── data fetching ──────────────────────────────────────

async function fetchYears(): Promise<number[]> {
  const rows = await queryDB<{ year: number }>(
    "SELECT DISTINCT CAST(EXTRACT(YEAR FROM play_date) AS integer) AS year FROM daily_play ORDER BY year",
  );
  return rows.map((r) => r.year);
}

async function fetchData(year: number, spillover = true, signal?: AbortSignal): Promise<DailyRow[]> {
  if (spillover) {
    const jan1 = new Date(`${year}-01-01`);
    const dayOfWeek = jan1.getDay();
    const spillStart = new Date(jan1);
    spillStart.setDate(jan1.getDate() - dayOfWeek);
    const startStr = spillStart.toISOString().slice(0, 10);

    return queryDB<DailyRow>(
      `SELECT play_date::text, maimai_play_count, chunithm_play_count,
              maimai_rating, chunithm_rating
       FROM daily_play
       WHERE play_date >= $1::date
         AND play_date <= $2::date
       ORDER BY play_date`,
      [startStr, `${year + 1}-01-07`],
      signal,
    );
  } else {
    return queryDB<DailyRow>(
      `SELECT play_date::text, maimai_play_count, chunithm_play_count,
              maimai_rating, chunithm_rating
       FROM daily_play
       WHERE EXTRACT(YEAR FROM play_date) = $1
       ORDER BY play_date`,
      [year],
      signal,
    );
  }
}

// ── trim overflow cells + mark today ──────────────────

function trimOverflow(container: HTMLElement, startYear: number) {
  const svg = container.querySelector("svg");
  if (!svg) return;

  const jan1Start = new Date(startYear, 0, 1);
  const minTs = jan1Start.getTime() - jan1Start.getDay() * 86400000;

  const jan1End = new Date(startYear + 1, 0, 1);
  const endDow = jan1End.getDay();
  const spilloverEnd = new Date(jan1End);
  spilloverEnd.setDate(jan1End.getDate() + (6 - endDow));
  const maxTs = spilloverEnd.getTime() + 86400000;

  const sel = select(container);
  const now = new Date();
  const todayTs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  sel.selectAll(".ch-domain").each(function () {
    const g = this as SVGGElement;
    const firstRect = g.querySelector("rect.ch-subdomain-bg");
    if (!firstRect) return;
    const datum = select(firstRect).datum() as { t?: number } | null;
    if (!datum?.t) return;
    if (datum.t < minTs || datum.t >= maxTs) {
      g.remove();
      return;
    }
    select(g)
      .selectAll("rect")
      .each(function () {
        const d = select(this).datum() as { t?: number } | null;
        if (!d?.t) return;
        if (d.t < minTs || d.t >= maxTs) {
          (this as Element).remove();
        } else if (d.t === todayTs) {
          select(this as Element).classed("heatmap-today", true);
        }
      });
  });

  // Collapse gap left by removed overflow months:
  // After trimming Dec (x=0), Jan stays at its original x (e.g. 76),
  // leaving dead space. Shift all remaining domains left to close it.
  const remaining = svg.querySelectorAll<SVGSVGElement>(".ch-domain");
  if (remaining.length > 0) {
    let minX = Infinity;
    remaining.forEach((d) => {
      const x = parseFloat(d.getAttribute("x") || "0");
      if (x < minX) minX = x;
    });
    const labelGap = 6;
    if (minX > labelGap) {
      remaining.forEach((d) => {
        const x = parseFloat(d.getAttribute("x") || "0");
        d.setAttribute("x", String(x - minX + labelGap));
      });
    }
  }

  // Resize SVG to fit remaining content
  const bbox = svg.getBBox();
  const newWidth = Math.ceil(bbox.width + 4);
  const newHeight = Math.ceil(bbox.height);
  svg.setAttribute("width", String(newWidth));
  svg.setAttribute("height", String(newHeight));
  svg.setAttribute(
    "viewBox",
    `${Math.floor(bbox.x)} ${Math.floor(bbox.y)} ${newWidth} ${newHeight}`,
  );
}

// ── sub-components ────────────────────────────────────

function Legend({ game }: { game: Game }) {
  const colors = COLORS[game];
  return (
    <div className="heatmap-legend" aria-hidden="true">
      <span className="heatmap-legend-label">Less</span>
      {colors.map((color, i) => (
        <span key={i} className="heatmap-legend-cell" style={{ background: color }} />
      ))}
      <span className="heatmap-legend-label">More</span>
    </div>
  );
}

function StatsBar({ stats, year }: { stats: HeatmapStats; year: number }) {
  return (
    <div className="heatmap-stats">
      <span title="Total credited plays this year">
        <strong>{stats.total.toLocaleString()}</strong> plays in {year}
      </span>
      <span className="heatmap-stats-sep" aria-hidden="true">
        &middot;
      </span>
      <span title="Plays since Sunday">
        <strong>{stats.thisWeek}</strong> this week
      </span>
      <span className="heatmap-stats-sep" aria-hidden="true">
        &middot;
      </span>
      <span title="Consecutive days with at least one play, ending today">
        streak <strong>{stats.currentStreak}</strong> days
      </span>
      <span className="heatmap-stats-sep" aria-hidden="true">
        &middot;
      </span>
      <span title="Longest consecutive play streak this year">
        longest <strong>{stats.longestStreak}</strong> days
      </span>
    </div>
  );
}

// ── single game heatmap ────────────────────────────────

function GameHeatmap({
  game,
  data,
  year,
}: {
  game: Game;
  data: DailyRow[];
  year: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const calRef = useRef<CalHeatmap | null>(null);
  const [tapInfo, setTapInfo] = useState("");

  const stats = useMemo(() => computeStats(data, game, year), [data, game, year]);

  useEffect(() => {
    if (!containerRef.current) return;

    const wrapper = document.createElement("div");
    wrapper.style.position = "absolute";
    wrapper.style.visibility = "hidden";
    containerRef.current.appendChild(wrapper);

    const gameData = data.map((d) => ({
      date: d.play_date,
      value: d[PLAY_KEY[game]] as number,
    }));

    const ratingLookup: Record<string, number> = {};
    for (const d of data) {
      const r = d[RATING_KEY[game]];
      if (r != null) ratingLookup[d.play_date] = Number(r);
    }

    const cal = new CalHeatmap();
    let cancelled = false;

    void (async () => {
      await cal.paint(
        {
          itemSelector: wrapper,
          range: 13,
          domain: {
            type: "month",
            gutter: 4,
            label: {
              text: (ts: number) => {
                const d = new Date(ts);
                if (d.getFullYear() !== year) return "";
                return d.toLocaleDateString("en-US", { month: "short" });
              },
              textAlign: "start" as const,
              position: "top" as const,
            },
          },
          subDomain: {
            type: "ghDay",
            radius: 2,
            width: 15,
            height: 15,
            gutter: 4,
          },
          date: { start: new Date(`${year}-01-01T00:00:00`) },
          data: {
            source: gameData,
            type: "json",
            x: "date",
            y: "value",
            groupY: "sum",
          },
          scale: {
            color: {
              type: "threshold",
              range: COLORS[game],
              domain: [1, 2, 3, 5],
            },
          },
          theme: "dark",
        },
        [
          [
            Tooltip,
            {
              text: (
                _timestamp: number,
                value: number | null,
                dayjsDate: { format: (f: string) => string },
              ) => {
                const count = value ?? 0;
                const label = count === 1 ? "play" : "plays";
                const dateKey = dayjsDate.format("YYYY-MM-DD");
                const rating = ratingLookup[dateKey];
                let line = `${count} ${label} on ${dayjsDate.format("MMM D, YYYY")}`;
                if (rating != null) line += `\nRating: ${rating.toFixed(2)}`;
                return line;
              },
            },
          ],
          [
            CalendarLabel,
            {
              position: "left",
              key: "left",
              text: () => ["", "Mon", "", "Wed", "", "Fri", ""],
              textAlign: "end",
              width: 24,
              padding: [25, 0, 0, 0],
            },
          ],
        ],
      );
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        trimOverflow(wrapper, year);
        const container = containerRef.current;
        if (!container) return;
        Array.from(container.children).forEach((child) => {
          if (child !== wrapper) child.remove();
        });
        calRef.current?.destroy();
        calRef.current = cal;
        wrapper.style.position = "";
        wrapper.style.visibility = "";
      });
    })();

    const handleClick = (e: MouseEvent) => {
      const rect = (e.target as Element).closest?.("rect");
      if (!rect) return;

      const datum = (rect as unknown as { __data__?: { t: number; v: number } })
        .__data__;
      if (!datum?.t) return;

      const dateObj = new Date(datum.t);
      const dateKey = dateObj.toISOString().slice(0, 10);
      const formatted = dateObj.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

      const count = datum.v ?? 0;
      const lbl = count === 1 ? "play" : "plays";
      const rating = ratingLookup[dateKey];
      let text = `${count} ${lbl} on ${formatted}`;
      if (rating != null) text += ` · Rating: ${rating.toFixed(2)}`;
      setTapInfo(text);
    };

    wrapper.addEventListener("click", handleClick);

    return () => {
      cancelled = true;
      wrapper.removeEventListener("click", handleClick);
      cal.destroy();
    };
  }, [game, data, year]);

  const gameName = game === "maimai" ? "maimai" : "CHUNITHM";

  return (
    <div className="heatmap-section">
      <StatsBar stats={stats} year={year} />
      <div className="heatmap-scroll-wrapper">
        <div
          className="heatmap-container"
          ref={containerRef}
          role="figure"
          aria-label={`${gameName} play activity heatmap for ${year}`}
          aria-roledescription="heatmap"
        />
      </div>
      <span className="sr-only">
        {stats.total} total plays in {year}. Current streak: {stats.currentStreak} days.
        Longest streak: {stats.longestStreak} days.
      </span>
      <div className="heatmap-footer">
        <p className={`tap-info${tapInfo ? " active" : ""}`}>
          {tapInfo || "Click a cell for details"}
        </p>
        <Legend game={game} />
      </div>
    </div>
  );
}

// ── main component ─────────────────────────────────────

export default function Heatmap({ games }: { games: Game[] }) {
  const [years, setYears] = useState<number[]>([]);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [data, setData] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

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
        setSelectedYear(list[list.length - 1]);
        if (lastRows[0]?.last_date) setLastUpdated(lastRows[0].last_date);
      })
      .catch(() => {
        setYears([currentYear, currentYear - 1]);
        setSelectedYear(currentYear);
      });
  }, []);

  const isStale =
    lastUpdated != null &&
    Date.now() - new Date(lastUpdated + "T00:00:00").getTime() > 2 * 86400000;

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
        setError("Session expired. Reload the page to sign in again.");
      } else if (raw.includes("fetch") || raw.includes("network") || raw.includes("Failed to fetch")) {
        setError("Couldn't connect. Check your internet and try again.");
      } else {
        setError("Something went wrong loading play data.");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!years.length) return;
    loadData(selectedYear, true);
    return () => { abortRef.current?.abort(); };
  }, [selectedYear, years, loadData]);

  return (
    <div>
      <div className="heatmap-header">
        <label className="year-select-label" htmlFor="heatmap-year">
          Year
        </label>
        <select
          id="heatmap-year"
          className="year-select"
          value={selectedYear}
          onChange={(e) => setSelectedYear(Number(e.target.value))}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        {lastUpdated && (
          <span className={`heatmap-last-updated${isStale ? " stale" : ""}`}>
            Updated {formatLastUpdated(lastUpdated)}
          </span>
        )}
      </div>

      {loading && (
        <div className="heatmap-skeleton" aria-label="Loading heatmap data">
          {games.map((game) => (
            <div key={game} className="heatmap-skeleton-block">
              <div className="heatmap-skeleton-title" />
              <div className="heatmap-skeleton-grid" />
            </div>
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="heatmap-error" role="alert">
          <p>{error}</p>
          <button
            className="heatmap-retry-btn"
            onClick={() => loadData(selectedYear, true)}
          >
            Retry
          </button>
        </div>
      )}

      {!loading &&
        !error &&
        games.map((game) => (
          <div key={game} className="heatmap-game-block">
            <h2 className="heatmap-game-title" data-game={game}>
              {game === "maimai" ? "maimai" : "CHUNITHM"}
            </h2>
            {data.length > 0 ? (
              <GameHeatmap game={game} data={data} year={selectedYear} />
            ) : (
              <div className="heatmap-empty">
                <p>No plays recorded in {selectedYear}</p>
                <p className="heatmap-empty-hint">
                  Plays appear automatically after each arcade session is recorded.
                </p>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
