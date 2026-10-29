import { useState, type CSSProperties, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { RotateCw } from "lucide-react";
import { GAME_ACCENT, GAME_LABELS, type Game } from "@/global/lib/games";
import type { RefreshGameResults } from "@/global/lib/api";

interface RefreshMenuProps {
  games: Game[];
  lastResults: RefreshGameResults;
  onRefresh: (games: Game[]) => void;
  children: ReactNode;
}

export default function RefreshMenu({
  games,
  lastResults,
  onRefresh,
  children,
}: RefreshMenuProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Game[]>(games);

  const chosen = games.filter((game) => selected.includes(game));
  const submitLabel =
    chosen.length === 0
      ? "Select a game"
      : chosen.length === 1
        ? `Refresh ${GAME_LABELS[chosen[0]]}`
        : "Refresh all";

  function toggle(game: Game) {
    setSelected((current) =>
      current.includes(game)
        ? current.filter((g) => g !== game)
        : [...current, game],
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="refresh-menu"
          align="end"
          sideOffset={8}
          collisionPadding={12}
        >
          <p className="refresh-menu__title" id="refresh-menu-title">
            Refresh scores
          </p>
          <div
            className="refresh-menu__games"
            role="group"
            aria-labelledby="refresh-menu-title"
          >
            {games.map((game) => (
              <label
                key={game}
                className="refresh-menu__game"
                style={{ "--game-accent": GAME_ACCENT[game] } as CSSProperties}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(game)}
                  onChange={() => toggle(game)}
                />
                <span className="refresh-menu__label">{GAME_LABELS[game]}</span>
                {lastResults[game] === "failure" && (
                  <span className="refresh-menu__note">Failed last time</span>
                )}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="refresh-menu__submit text-btn glass-control glass-control--primary"
            disabled={chosen.length === 0}
            onClick={() => {
              setOpen(false);
              onRefresh(chosen);
            }}
          >
            <RotateCw size={14} aria-hidden="true" />
            {submitLabel}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
