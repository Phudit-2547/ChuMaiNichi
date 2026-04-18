import { useEffect, useMemo, useRef, useState } from "react";
import type { DailyRow, Game } from "../types/types";
import CalHeatmap from "cal-heatmap";
import { computeStats } from "../lib/stats";
import { COLORS, PLAY_KEY, RATING_KEY } from "../lib/constants";
import Tooltip from "cal-heatmap/plugins/Tooltip";
import CalendarLabel from "cal-heatmap/plugins/CalendarLabel";
import { trimOverflow } from "../lib/trim-overflow";
import { StatsBar } from "./StatsBar";
import { Legend } from "./Legend";

export function GameHeatmap({
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

  const stats = useMemo(
    () => computeStats(data, game, year),
    [data, game, year],
  );

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
    <div className="w-full max-w-[1100px]">
      <StatsBar stats={stats} year={year} />
      <div className="relative overflow-x-auto scrollbar-thin">
        <div
          ref={containerRef}
          role="figure"
          aria-label={`${gameName} play activity heatmap for ${year}`}
          aria-roledescription="heatmap"
        />
      </div>
      <span className="sr-only">
        {stats.total} total plays in {year}. Current streak:{" "}
        {stats.currentStreak} days. Longest streak: {stats.longestStreak} days.
      </span>
      <div className="flex items-center justify-between mt-2 min-h-[1.6em]">
        <p
          className={`text-xs text-muted-foreground m-0 transition-colors duration-150 ${tapInfo ? "text-foreground" : ""}`}
        >
          {tapInfo || "Click a cell for details"}
        </p>
        <Legend game={game} />
      </div>
    </div>
  );
}
