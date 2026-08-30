import { useEffect, useMemo, useRef, useState } from "react";
import type { DailyRow, HeatmapGame } from "../types/types";
import CalHeatmap from "cal-heatmap";
import { computeStats, toDateStr } from "../lib/stats";
import {
  ACTIVITY_UNIT,
  GAME_LABELS,
  HEATMAP_COLORS,
  PLAY_KEY,
  RATING_KEY,
} from "../lib/constants";
import Tooltip from "cal-heatmap/plugins/Tooltip";
import CalendarLabel from "cal-heatmap/plugins/CalendarLabel";
import { trimOverflow } from "../lib/trim-overflow";
import {
  getInferredDates,
  INFERENCE_NOTE,
  timestampToDateKey,
} from "../lib/inference";
import { StatsBar } from "./StatsBar";
import { Legend } from "./Legend";

const CELL_SIZE = 15;

function formatCellText({
  dateKey,
  formattedDate,
  value,
  recordedDates,
  ratingLookup,
  ratingSeparator,
  todayKey,
  unit,
  inferredDates,
  accessible = false,
}: {
  dateKey: string;
  formattedDate: string;
  value: number | null | undefined;
  recordedDates: Set<string>;
  ratingLookup: Record<string, number>;
  ratingSeparator: string;
  todayKey: string;
  unit: "play" | "track";
  inferredDates: Set<string>;
  accessible?: boolean;
}) {
  if (!recordedDates.has(dateKey)) {
    return dateKey > todayKey
      ? `Not recorded yet: ${formattedDate}`
      : `No record for ${formattedDate}`;
  }

  const count = value ?? 0;
  const label = count === 1 ? unit : `${unit}s`;
  const rating = ratingLookup[dateKey];
  const inferred = inferredDates.has(dateKey);
  const marker = inferred && !accessible ? "*" : "";
  let line = `${count} ${label}${marker} on ${formattedDate}`;
  if (rating != null) line += `${ratingSeparator}Rating: ${rating.toFixed(2)}`;
  if (inferred) {
    line += `${ratingSeparator}${accessible ? "Inferred from Journal context" : INFERENCE_NOTE}`;
  }
  return line;
}

export function GameHeatmap({
  game,
  data,
  year,
}: {
  game: HeatmapGame;
  data: DailyRow[];
  year: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const calRef = useRef<CalHeatmap | null>(null);
  const [tapInfo, setTapInfo] = useState("");
  const unit = ACTIVITY_UNIT[game];

  const stats = useMemo(
    () => computeStats(data, game, year),
    [data, game, year],
  );
  const inferredDates = useMemo(
    () => getInferredDates(data, game),
    [data, game],
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const wrapper = document.createElement("div");
    wrapper.style.position = "absolute";
    wrapper.style.visibility = "hidden";
    container.appendChild(wrapper);

    const gameData = data.map((d) => ({
      date: d.play_date,
      value: Number(d[PLAY_KEY[game]] ?? 0),
    }));

    const recordedDates = new Set(data.map((d) => d.play_date));
    const todayKey = toDateStr(new Date());
    const ratingLookup: Record<string, number> = {};
    const ratingKey = RATING_KEY[game];
    if (ratingKey) {
      for (const d of data) {
        const rating = d[ratingKey];
        if (rating != null) ratingLookup[d.play_date] = Number(rating);
      }
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
            width: CELL_SIZE,
            height: CELL_SIZE,
            gutter: 4,
            label:
              inferredDates.size > 0
                ? (timestamp: number) =>
                    inferredDates.has(timestampToDateKey(timestamp)) ? "*" : ""
                : null,
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
              range: HEATMAP_COLORS[game],
              domain: [1, 2, 3, 5],
            },
          },
          theme: "light",
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
                const dateKey = dayjsDate.format("YYYY-MM-DD");
                return formatCellText({
                  dateKey,
                  formattedDate: dayjsDate.format("MMM D, YYYY"),
                  value,
                  recordedDates,
                  ratingLookup,
                  ratingSeparator: "\n",
                  todayKey,
                  unit,
                  inferredDates,
                });
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

      wrapper
        .querySelectorAll<SVGRectElement>("rect.ch-subdomain-bg")
        .forEach((rect) => {
          const datum = (
            rect as unknown as { __data__?: { t: number; v: number } }
          ).__data__;
          if (!datum?.t) return;

          const dateKey = timestampToDateKey(datum.t);
          if (!inferredDates.has(dateKey)) return;

          const formatted = new Date(`${dateKey}T00:00:00Z`).toLocaleDateString(
            "en-US",
            {
              month: "short",
              day: "numeric",
              year: "numeric",
              timeZone: "UTC",
            },
          );
          rect.dataset.inferred = "true";
          rect.setAttribute("tabindex", "0");
          rect.setAttribute("role", "button");
          rect.setAttribute(
            "aria-label",
            formatCellText({
              dateKey,
              formattedDate: formatted,
              value: datum.v,
              recordedDates,
              ratingLookup,
              ratingSeparator: ". ",
              todayKey,
              unit,
              inferredDates,
              accessible: true,
            }),
          );
        });

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
      const dateKey = toDateStr(dateObj);
      const formatted = dateObj.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

      setTapInfo(
        formatCellText({
          dateKey,
          formattedDate: formatted,
          value: datum.v,
          recordedDates,
          ratingLookup,
          ratingSeparator: " · ",
          todayKey,
          unit,
          inferredDates,
        }),
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const rect = (e.target as Element).closest?.<SVGRectElement>(
        'rect[data-inferred="true"]',
      );
      if (!rect) return;
      e.preventDefault();
      rect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };

    wrapper.addEventListener("click", handleClick);
    wrapper.addEventListener("keydown", handleKeyDown);

    return () => {
      cancelled = true;
      wrapper.removeEventListener("click", handleClick);
      wrapper.removeEventListener("keydown", handleKeyDown);
      cal.destroy();
    };
  }, [game, data, year, unit, inferredDates]);

  const gameName = GAME_LABELS[game];
  const pluralUnit = `${unit}s`;

  return (
    <div
      className="content-panel w-full max-w-[1100px] rounded-2xl px-4 pt-3 pb-2"
      data-game={game}
    >
      <StatsBar stats={stats} year={year} game={game} />
      <div className="relative overflow-x-auto scrollbar-thin">
        <div
          className="heatmap-figure"
          ref={containerRef}
          role="figure"
          aria-label={`${gameName} ${unit} activity heatmap for ${year}`}
          aria-roledescription="heatmap"
        />
      </div>
      <span className="sr-only">
        {stats.total} total {pluralUnit} in {year}. Current streak:{" "}
        {stats.currentStreak} days. Longest streak: {stats.longestStreak} days.
      </span>
      <div className="flex items-center justify-between mt-2 min-h-[1.6em]">
        <p
          className={`text-xs text-muted-foreground m-0 transition-colors duration-150 ${tapInfo ? "text-foreground" : ""}`}
          aria-live="polite"
        >
          {tapInfo || "Click a cell for details"}
        </p>
        <Legend game={game} showInference={inferredDates.size > 0} />
      </div>
    </div>
  );
}
