import { HEATMAP_COLORS } from "../lib/constants";
import type { HeatmapGame } from "../types/types";

export function Legend({
  game,
  showInference = false,
}: {
  game: HeatmapGame;
  showInference?: boolean;
}) {
  const colors = HEATMAP_COLORS[game];
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-secondary-foreground ml-auto">
      {showInference && (
        <span
          className="whitespace-nowrap text-muted-foreground"
          aria-label="Inferred from Journal context"
        >
          <span aria-hidden="true">* </span>
          inferred from Journal context
        </span>
      )}
      <div className="flex items-center gap-[3px]" aria-hidden="true">
        <span className="mx-1">Less</span>
        {colors.map((color, i) => (
          <span
            key={i}
            className="inline-block w-3 h-3 rounded-[2px]"
            style={{ background: color }}
          />
        ))}
        <span className="mx-1">More</span>
      </div>
    </div>
  );
}
