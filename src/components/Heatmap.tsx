import { useEffect, useRef, useState, useCallback } from "react";
import CalHeatmap from "cal-heatmap";
import Tooltip from "cal-heatmap/plugins/Tooltip";
import "cal-heatmap/cal-heatmap.css";
import * as d3 from "d3";
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

// ── data fetching ──────────────────────────────────────

async function fetchYears(): Promise<number[]> {
  const rows = await queryDB<{ year: number }>(
    "SELECT DISTINCT CAST(EXTRACT(YEAR FROM play_date) AS integer) AS year FROM daily_play ORDER BY year",
  );
  return rows.map((r) => r.year);
}

async function fetchData(year: number, spillover = true): Promise<DailyRow[]> {
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
    );
  } else {
    return queryDB<DailyRow>(
      `SELECT play_date::text, maimai_play_count, chunithm_play_count,
              maimai_rating, chunithm_rating
       FROM daily_play
       WHERE EXTRACT(YEAR FROM play_date) = $1
       ORDER BY play_date`,
      [year],
    );
  }
}

// ── trim overflow cells ───────────────────────────────

function trimOverflow(container: HTMLElement, startYear: number) {
  const svg = container.querySelector("svg");
  if (!svg) return;

  // Start boundary: Sunday of the week containing Jan 1 of startYear
  const jan1Start = new Date(startYear, 0, 1);
  const minTs = jan1Start.getTime() - jan1Start.getDay() * 86400000; // rewind to Sunday

  // End boundary: first Saturday of January next year (end of spillover week)
  const jan1End = new Date(startYear + 1, 0, 1);
  const endDow = jan1End.getDay(); // 0=Sun
  const spilloverEnd = new Date(jan1End);
  spilloverEnd.setDate(jan1End.getDate() + (6 - endDow)); // next Saturday
  const maxTs = spilloverEnd.getTime() + 86400000; // exclusive

  // Remove entire domain groups that fall outside the year
  // Cal-heatmap uses class "m_12" for December domains from the previous year
  const sel = d3.select(container);
  sel.selectAll(".ch-domain").each(function () {
    const g = this as SVGGElement;
    // Check first rect's timestamp to determine if this domain is out of range
    const firstRect = g.querySelector("rect.ch-subdomain-bg");
    if (!firstRect) return;
    const datum = d3.select(firstRect).datum() as { t?: number } | null;
    if (!datum?.t) return;
    if (datum.t < minTs || datum.t >= maxTs) {
      g.remove();
      return;
    }
    // For partially-overlapping domains, remove individual out-of-range cells
    d3.select(g).selectAll("rect").each(function () {
      const d = d3.select(this).datum() as { t?: number } | null;
      if (!d?.t) return;
      if (d.t < minTs || d.t >= maxTs) {
        (this as Element).remove();
      }
    });
  });

  // Resize SVG to tightly fit remaining visible content
  const bbox = svg.getBBox();
  const newWidth = Math.ceil(bbox.width + 4);
  const newHeight = Math.ceil(bbox.height);
  svg.setAttribute("width", String(newWidth));
  svg.setAttribute("height", String(newHeight));
  svg.setAttribute("viewBox", `${Math.floor(bbox.x)} ${Math.floor(bbox.y)} ${newWidth} ${newHeight}`);
}

// ── single game heatmap ────────────────────────────────

function GameHeatmap({ game, data, year }: { game: Game; data: DailyRow[]; year: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const calRef = useRef<CalHeatmap | null>(null);
  const [tapInfo, setTapInfo] = useState("");

  useEffect(() => {
    if (!containerRef.current) return;

    // Build new heatmap off-screen, swap in only after paint is done
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
              text: (_timestamp: number, value: number | null, dayjsDate: { format: (f: string) => string }) => {
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
        ],
      );
      if (cancelled) return;
      // Trim after paint resolves + one frame to ensure DOM is flushed
      requestAnimationFrame(() => {
        if (cancelled) return;
        trimOverflow(wrapper, year);
        // Swap: remove old content, reveal new
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

    // Mobile tap support
    const handleClick = (e: MouseEvent) => {
      const rect = (e.target as Element).closest?.("rect");
      if (!rect) return;

      // cal-heatmap stores datum via d3 — access __data__
      const datum = (rect as unknown as { __data__?: { t: number; v: number } }).__data__;
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

  return (
    <div className="heatmap-section">
      <p className={`tap-info${tapInfo ? " active" : ""}`}>{tapInfo}</p>
      <div className="heatmap-container" ref={containerRef} />
    </div>
  );
}

// ── main component ─────────────────────────────────────

export default function Heatmap({ games }: { games: Game[] }) {
  const [years, setYears] = useState<number[]>([]);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [data, setData] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch available years on mount
  useEffect(() => {
    const currentYear = new Date().getFullYear();
    fetchYears()
      .then((yrs) => {
        const set = new Set<number>(yrs);
        set.add(currentYear);
        set.add(currentYear - 1); // ensure last year is available
        const list = Array.from(set).sort((a, b) => a - b);
        setYears(list);
        setSelectedYear(list[list.length - 1]);
      })
      .catch(() => {
        setYears([currentYear, currentYear - 1]);
        setSelectedYear(currentYear);
      });
  }, []);

  // Fetch data when year changes
  const loadData = useCallback(async (year: number, spillover: boolean) => {
    setLoading(true);
    try {
      setData(await fetchData(year, spillover));
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(selectedYear, true);
  }, [selectedYear, loadData]);

  return (
    <div>
      <div className="heatmap-header">
        <select
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
      </div>

      {loading && <p style={{ color: "#8b949e" }}>Loading…</p>}

      {!loading &&
        games.map((game) => (
          <div key={game} style={{ marginBottom: "2rem" }}>
            <h2 className="heatmap-game-title">
              {game === "maimai" ? "maimai" : "CHUNITHM"}
            </h2>
            <GameHeatmap game={game} data={data} year={selectedYear} />
          </div>
        ))}
    </div>
  );
}
