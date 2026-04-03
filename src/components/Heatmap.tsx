import { useEffect, useRef, useState, useCallback } from "react";
import CalHeatmap from "cal-heatmap";
import Tooltip from "cal-heatmap/plugins/Tooltip";
import "cal-heatmap/cal-heatmap.css";
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
  maimai: ["#161b22", "#4a2600", "#7a4100", "#c46200", "#ff8c00"],
  chunithm: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
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
  const rows = await queryDB<{ y: number }>(
    "SELECT DISTINCT EXTRACT(YEAR FROM play_date)::int AS y FROM daily_play ORDER BY y",
  );
  return rows.map((r) => r.y);
}

async function fetchData(year: number): Promise<DailyRow[]> {
  // Fetch the selected year + first week of next year (spillover)
  return queryDB<DailyRow>(
    `SELECT play_date::text, maimai_play_count, chunithm_play_count,
            maimai_rating, chunithm_rating
     FROM daily_play
     WHERE play_date >= $1 AND play_date < ($2::date + interval '7 days')
     ORDER BY play_date`,
    [`${year}-01-01`, `${year + 1}-01-01`],
  );
}

// ── single game heatmap ────────────────────────────────

function GameHeatmap({ game, data, year }: { game: Game; data: DailyRow[]; year: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const calRef = useRef<CalHeatmap | null>(null);
  const [tapInfo, setTapInfo] = useState("");

  useEffect(() => {
    if (!containerRef.current) return;

    // Clean up previous instance
    calRef.current?.destroy();
    containerRef.current.innerHTML = "";

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
    calRef.current = cal;

    cal.paint(
      {
        itemSelector: containerRef.current,
        range: 13,
        domain: {
          type: "month",
          gutter: 4,
          label: {
            text: (ts: number) => {
              const d = new Date(ts);
              if (d.getFullYear() > year) return "";
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

    containerRef.current.addEventListener("click", handleClick);
    const node = containerRef.current;

    return () => {
      node.removeEventListener("click", handleClick);
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
    fetchYears()
      .then((yrs) => {
        const list = yrs.length ? yrs : [new Date().getFullYear()];
        setYears(list);
        setSelectedYear(list[list.length - 1]);
      })
      .catch(() => setYears([new Date().getFullYear()]));
  }, []);

  // Fetch data when year changes
  const loadData = useCallback(async (year: number) => {
    setLoading(true);
    try {
      setData(await fetchData(year));
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(selectedYear);
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
