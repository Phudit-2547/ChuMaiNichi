import { COLORS } from "../lib/constants";
import type { Game } from "../types/types";

export function Legend({ game }: { game: Game }) {
  const colors = COLORS[game];
  return (
    <div
      className="flex items-center gap-[3px] text-xs text-secondary-foreground ml-auto"
      aria-hidden="true"
    >
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
  );
}
