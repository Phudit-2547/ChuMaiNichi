import { useEffect, useState } from "react";
import { fetchRatingImage } from "../../../global/lib/api";
import { GAME_ACCENT, GAME_LABELS, type Game } from "../../../global/lib/games";

type Status = "loading" | "ready" | "missing" | "error";

function GameRatingImage({ game }: { game: Game }) {
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;

    fetchRatingImage(game, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        if (!blob) {
          setStatus("missing");
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
        setStatus("ready");
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("rating-image fetch failed:", err);
        setStatus("error");
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [game]);

  if (status === "missing") return null;

  const label = GAME_LABELS[game];

  return (
    <section className="mt-8" aria-labelledby={`rating-image-${game}-heading`}>
      <h2
        id={`rating-image-${game}-heading`}
        className="text-lg font-semibold m-0 mb-2 pl-2 border-l-[3px]"
        style={{ borderLeftColor: GAME_ACCENT[game] }}
      >
        {label} rating breakdown
      </h2>

      {status === "loading" && (
        <div
          className="w-full max-w-235 h-80 bg-surface rounded animate-skeleton-pulse"
          aria-busy="true"
          aria-label={`Loading ${label} rating image`}
        />
      )}

      {status === "error" && (
        <div
          className="p-6 border border-border rounded-lg text-center text-secondary-foreground"
          role="alert"
        >
          <p className="m-0">Couldn't load the rating image.</p>
          <p className="mt-2 text-xs m-0 text-muted-foreground">
            Try refreshing in a moment.
          </p>
        </div>
      )}

      {status === "ready" && src && (
        <img
          src={src}
          alt={`${label} top-50 chart breakdown contributing to DX rating`}
          className="block w-full max-w-235 h-auto rounded border border-border"
          loading="lazy"
        />
      )}
    </section>
  );
}

export default function RatingImage({
  games,
  refreshNonce = 0,
}: {
  games: Game[];
  refreshNonce?: number;
}) {
  return (
    <>
      {games.map((game) => (
        <GameRatingImage key={`${game}-${refreshNonce}`} game={game} />
      ))}
    </>
  );
}
