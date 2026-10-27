import { useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Minus,
  Plus,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/global/components/ui/dialog";
import { APP_CONFIG } from "@/global/lib/config";
import { GAME_ACCENT, GAME_LABELS, type Game } from "@/global/lib/games";
import {
  addDays,
  bangkokToday,
  dayCredits,
  earliestEditableDate,
  formatRating,
  isEditableDate,
  isRating,
  MAX_COUNT,
  RATING_FORMAT,
  ticketCatalog,
  type DayState,
} from "@/global/lib/play-log";
import usePlayLogStore from "../stores/play-log-store";
import { fetchDay, saveWrite, type SaveResult } from "../lib/api";
import {
  applyResult,
  keyFor,
  markSent,
  mergeDay,
  nextWrite,
  parseKey,
  queueFromDay,
  ratingKey,
  retryFailed,
  setDesired,
  stepDesired,
  type KeyState,
  type Queue,
} from "../lib/save-queue";

// One queue per day: a day left mid-save keeps saving in the background.
interface State {
  queues: Record<string, Queue>;
  /** The open/day session whose load has finished; taps are accepted only then. */
  loadedKey: string | null;
}

type Action =
  | { type: "load"; day: DayState; loadKey: string }
  | { type: "refresh"; day: DayState }
  | { type: "set"; date: string; key: string; value: number }
  | { type: "step"; date: string; key: string; delta: number }
  | { type: "sent"; date: string; key: string }
  | { type: "result"; date: string; key: string; result: SaveResult }
  | { type: "retry"; date: string };

function reducer(state: State, action: Action): State {
  if (action.type === "load") {
    const existing = state.queues[action.day.date];
    return {
      queues: {
        ...state.queues,
        [action.day.date]: existing ? mergeDay(existing, action.day) : queueFromDay(action.day),
      },
      loadedKey: action.loadKey,
    };
  }
  if (action.type === "refresh") {
    const existing = state.queues[action.day.date];
    if (!existing) return state;
    return {
      ...state,
      queues: { ...state.queues, [action.day.date]: mergeDay(existing, action.day, true) },
    };
  }
  const queue = state.queues[action.date];
  if (!queue) return state;
  const next =
    action.type === "set"
      ? setDesired(queue, action.key, action.value)
      : action.type === "step"
        ? stepDesired(queue, action.key, action.delta)
        : action.type === "sent"
        ? markSent(queue, action.key)
        : action.type === "result"
          ? applyResult(queue, action.key, action.date, action.result)
          : retryFailed(queue);
  return { ...state, queues: { ...state.queues, [action.date]: next } };
}

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export default function PlayLogDialog() {
  const { open, date, session, openDay, close } = usePlayLogStore();
  const [state, dispatch] = useReducer(reducer, { queues: {}, loadedKey: null });
  const [errorDate, setErrorDate] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [picking, setPicking] = useState(false);
  const savedRef = useRef(false);
  const today = bangkokToday();
  const earliest = earliestEditableDate(today);

  const loadKey = `${session}:${reloadNonce}`;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetchDay(date, controller.signal)
      .then((day) => dispatch({ type: "load", day, loadKey }))
      .catch(() => {
        if (!controller.signal.aborted) setErrorDate(loadKey);
      });
    return () => controller.abort();
  }, [open, date, loadKey]);

  useEffect(() => {
    for (const queue of Object.values(state.queues)) {
      const games = new Set(Object.keys(queue.keys).map((key) => parseKey(key).game));
      for (const game of games) {
        const next = nextWrite(queue, game);
        if (!next) continue;
        const { key, write } = next;
        const sentDate = queue.date;
        dispatch({ type: "sent", date: sentDate, key });
        void saveWrite(write).then((result) => {
          if (result.kind === "saved") {
            savedRef.current = true;
            const shown = usePlayLogStore.getState();
            // A save that lands after the editor closed still refreshes the heatmap.
            if (!shown.open) {
              savedRef.current = false;
              shown.close(true);
            } else if (parseKey(key).rating && shown.date > sentDate) {
              // The rating may have carried into the day on screen.
              void fetchDay(shown.date)
                .then((day) => dispatch({ type: "refresh", day }))
                .catch(() => {});
            }
          }
          dispatch({ type: "result", date: sentDate, key, result });
        });
      }
    }
  }, [state.queues]);

  const handleClose = () => {
    setPicking(false);
    close(savedRef.current);
    savedRef.current = false;
  };

  const queue = state.queues[date] ?? null;
  const ready = queue != null && state.loadedKey === loadKey;
  const failedToLoad = !ready && errorDate === loadKey;
  const label = DAY_LABEL.format(new Date(`${date}T00:00:00Z`));
  const set = (key: string, value: number) => dispatch({ type: "set", date, key, value });
  const step = (key: string, delta: number) => dispatch({ type: "step", date, key, delta });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogContent
        className="modal glass-modal play-log gap-0 p-0 sm:max-w-none"
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          // Escape while typing a count cancels the typed value, not the editor.
          if ((e.target as HTMLElement | null)?.dataset?.editing === "true") e.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">Play log, {label}</DialogTitle>
        <DialogDescription className="sr-only">
          Log plays, paid tickets and rating for one day. Each change saves on its own.
        </DialogDescription>
        <div className="modal-head play-log__head">
          <button
            type="button"
            className="play-log__nav glass-control glass-control--clear"
            aria-label="Previous day"
            disabled={date <= earliest}
            onClick={() => openDay(addDays(date, -1))}
          >
            <ChevronLeft size={18} />
          </button>
          <div className="play-log__title">
            {picking ? (
              <input
                type="date"
                className="play-log__date-input"
                aria-label="Choose a date"
                min={earliest}
                max={today}
                value={date}
                autoFocus
                onChange={(e) => {
                  if (isEditableDate(e.target.value, today)) openDay(e.target.value);
                }}
                onBlur={() => setPicking(false)}
              />
            ) : (
              <button
                type="button"
                className="play-log__date"
                title="Choose a date"
                onClick={() => setPicking(true)}
              >
                {label}
              </button>
            )}
            {date === today && <span className="play-log__today">Today</span>}
          </div>
          <button
            type="button"
            className="play-log__nav glass-control glass-control--clear"
            aria-label="Next day"
            disabled={date >= today}
            onClick={() => openDay(addDays(date, 1))}
          >
            <ChevronRight size={18} />
          </button>
          <button
            type="button"
            className="modal-close glass-control glass-control--clear"
            aria-label="Close"
            onClick={handleClose}
          >
            <X size={14} />
          </button>
        </div>

        <div
          className="play-log__body"
          // While another day loads, keep the previous one on screen (dimmed and
          // inert) so the dialog keeps its size and the arrows stay under the pointer.
          data-loading={!ready && !failedToLoad ? "true" : undefined}
          aria-busy={!ready && !failedToLoad}
          inert={!ready && !failedToLoad}
        >
          {queue && !failedToLoad ? (
            APP_CONFIG.games.map((game) => (
              <GameBlock
                key={game}
                game={game}
                queue={queue}
                onSet={set}
                onStep={step}
                onRetry={() => dispatch({ type: "retry", date })}
              />
            ))
          ) : failedToLoad ? (
            <div className="play-log__message" role="alert">
              <p>Could not load this day.</p>
              <button
                type="button"
                className="glass-control glass-control--primary play-log__retry"
                onClick={() => {
                  setErrorDate(null);
                  setReloadNonce((n) => n + 1);
                }}
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="play-log__message" aria-live="polite">
              <LoaderCircle size={16} className="icon-spin" aria-hidden="true" />
              <span>Loading {label}…</span>
            </div>
          )}
        </div>

        <div className="play-log__footer">
          <p>Each change saves on its own.</p>
          <button
            type="button"
            className="glass-control glass-control--primary play-log__done"
            onClick={handleClose}
          >
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GameBlock({
  game,
  queue,
  onSet,
  onStep,
  onRetry,
}: {
  game: Game;
  queue: Queue;
  onSet: (key: string, value: number) => void;
  onStep: (key: string, delta: number) => void;
  onRetry: () => void;
}) {
  const name = GAME_LABELS[game];
  const playKey = keyFor(game);
  const catalogIds = new Set(ticketCatalog(game).map((t) => t.id));
  const chips = [
    ...ticketCatalog(game),
    ...Object.keys(queue.keys)
      .map((key) => parseKey(key))
      .filter((k) => k.game === game && k.ticket && !catalogIds.has(k.ticket))
      .map((k) => ({ id: k.ticket!, label: k.ticket!, extra_credits: queue.credits[game]?.[k.ticket!] ?? 0, retired: true })),
  ];
  const plays = queue.keys[playKey]?.desired ?? null;
  const tickets = Object.fromEntries(
    chips.map((t) => [t.id, queue.keys[keyFor(game, t.id)]?.desired ?? 0]),
  );
  const totals = dayCredits(game, { plays, tickets, ticketCredits: queue.credits[game] });
  const rateKey = ratingKey(game);
  const rating = queue.keys[rateKey]?.desired ?? null;
  const states = [playKey, ...chips.map((t) => keyFor(game, t.id)), rateKey]
    .map((key) => queue.keys[key])
    .filter((state): state is KeyState => Boolean(state));
  const saving = states.some(
    (s) =>
      s.inFlight ||
      (s.desired !== s.server && s.status !== "failed" && s.status !== "unauthorized"),
  );
  const problem = states.find((s) =>
    ["failed", "conflict", "exceeds", "unauthorized"].includes(s.status),
  );
  const saved = states.some((s) => s.status === "saved");
  const unknown = plays == null;

  return (
    <section
      className="play-log__game"
      aria-label={name}
      style={{ "--game-accent": GAME_ACCENT[game] } as CSSProperties}
    >
      <h3 className="play-log__game-name">
        <span className="play-log__dot" aria-hidden="true" />
        {name}
      </h3>
      <div className="play-log__stepper">
        <button
          type="button"
          className="play-log__step glass-control"
          aria-label={`Remove one ${name} play`}
          disabled={unknown || plays <= 0 || plays <= totals.tickets}
          onClick={() => onStep(playKey, -1)}
        >
          <Minus size={20} />
        </button>
        <CountInput
          value={plays}
          label={`${name} plays`}
          onCommit={(n) => onSet(playKey, n)}
        />
        <button
          type="button"
          className="play-log__step play-log__step--add glass-control"
          aria-label={`Add one ${name} play`}
          disabled={unknown || plays >= MAX_COUNT}
          onClick={() => onStep(playKey, 1)}
        >
          <Plus size={24} />
        </button>
      </div>
      {unknown && (
        <p className="play-log__hint">Unknown. Type the total to log it.</p>
      )}

      {chips.length > 0 && !unknown && (
        <div className="play-log__tickets" role="group" aria-label={`${name} paid tickets`}>
          {chips.map((ticket) => {
            const key = keyFor(game, ticket.id);
            const count = tickets[ticket.id];
            const retired = "retired" in ticket;
            if (retired && count === 0) return null;
            const extra = queue.credits[game]?.[ticket.id] ?? ticket.extra_credits;
            return (
              <div key={ticket.id} className="play-log__ticket">
                <button
                  type="button"
                  className="play-log__chip glass-control"
                  data-active={count > 0}
                  aria-label={`Add ${ticket.label} ticket`}
                  title={
                    retired
                      ? "No longer in the ticket list. You can only remove it."
                      : totals.tickets >= (plays ?? 0)
                        ? "Each ticket rides on one play. Add a play first."
                        : undefined
                  }
                  disabled={retired || totals.tickets >= (plays ?? 0)}
                  onClick={() => onStep(key, 1)}
                >
                  <span>{ticket.label}</span>
                  <span className="play-log__chip-extra">+{extra} cr</span>
                  {count > 0 && <span className="play-log__badge">{count}</span>}
                </button>
                {count > 0 && (
                  <button
                    type="button"
                    className="play-log__chip-remove glass-control"
                    aria-label={`Remove one ${ticket.label} ticket`}
                    onClick={() => onStep(key, -1)}
                  >
                    <Minus size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <RatingInput
        key={queue.date}
        game={game}
        value={rating}
        label={`${name} rating`}
        onCommit={(n) => onSet(rateKey, n)}
      />

      <div className="play-log__status" role="status" aria-live="polite">
        <span>
          {plural(totals.plays, "play")}
          {totals.tickets > 0 &&
            ` · ${plural(totals.tickets, "ticket")} · ${plural(totals.credits, "credit")}`}
          {` · ฿${totals.baht}`}
        </span>
        {problem ? (
          <span className="play-log__problem">
            {problem.message}
            {problem.status === "failed" && (
              <button type="button" className="quiet-btn play-log__retry-inline" onClick={onRetry}>
                Retry
              </button>
            )}
          </span>
        ) : saving ? (
          <span className="play-log__saving">
            <LoaderCircle size={13} className="icon-spin" aria-hidden="true" />
            Saving…
          </span>
        ) : saved ? (
          <span className="play-log__saved">
            <Check size={13} aria-hidden="true" />
            Saved
          </span>
        ) : null}
      </div>
    </section>
  );
}

function CountInput({
  value,
  label,
  onCommit,
}: {
  value: number | null;
  label: string;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const n = Number(draft);
    if (draft !== "" && Number.isInteger(n) && n <= MAX_COUNT && n !== value) onCommit(n);
    setDraft(null);
  };
  return (
    <input
      className="play-log__count"
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      aria-label={label}
      data-editing={draft != null ? "true" : undefined}
      placeholder="?"
      value={draft ?? (value == null ? "" : String(value))}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 2))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape" && draft != null) setDraft(null);
      }}
    />
  );
}

const RATING_HINT: Record<Game, string> = {
  maimai: "Type a whole number up to 20000.",
  chunithm: "Type a number like 15.26, up to 20.",
};

/** Keeps digits and, where the game uses them, one decimal point and its decimals. */
function cleanRating(text: string, decimals: number): string {
  const kept = text.replace(",", ".").replace(decimals ? /[^\d.]/g : /\D/g, "");
  const [whole, ...rest] = kept.split(".");
  return (rest.length ? `${whole}.${rest.join("").slice(0, decimals)}` : whole).slice(0, 6);
}

function RatingInput({
  game,
  value,
  label,
  onCommit,
}: {
  game: Game;
  value: number | null;
  label: string;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const { decimals } = RATING_FORMAT[game];
  const commit = () => {
    if (draft == null) return;
    const n = Number(draft);
    const valid = draft !== "" && isRating(game, n);
    if (valid && n !== value) onCommit(n);
    setInvalid(draft !== "" && !valid);
    setDraft(null);
  };
  return (
    <>
      <label className="play-log__rating">
        <span>Rating</span>
        <input
          className="play-log__rating-input"
          type="text"
          inputMode={decimals ? "decimal" : "numeric"}
          aria-label={label}
          aria-invalid={invalid || undefined}
          data-editing={draft != null ? "true" : undefined}
          placeholder="Not set"
          value={draft ?? (value == null ? "" : formatRating(game, value))}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setInvalid(false);
            setDraft(cleanRating(e.target.value, decimals));
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape" && draft != null) setDraft(null);
          }}
        />
      </label>
      {invalid && (
        <p className="play-log__hint play-log__hint--error" role="alert">
          {RATING_HINT[game]}
        </p>
      )}
    </>
  );
}
