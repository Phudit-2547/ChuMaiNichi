"""Import Japan arcade totals from Obsidian Journal notes.

The importer is deliberately dry-run by default.  Passing ``--apply`` is the
only path that opens ``DATABASE_URL`` and writes to ``japan_daily_play``.

Journal values are cumulative.  An explicit dash carries the previous
cumulative value forward.  A missing total is not automatically treated as a
dash: any ambiguous daily attribution must be resolved before ``--apply``.
ONGEKI is stored as tracks rather than plays.

Usage:
    uv run python import_japan_journal.py /path/to/Obsidian/Journal
    uv run python import_japan_journal.py /path/to/Obsidian/Journal --apply
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Iterable, Mapping, Sequence

import asyncpg

from play_counter.config import DATABASE_URL


SOURCE = "obsidian_journal"
DEFAULT_THROUGH = date(2026, 7, 22)
GAME_ORDER = ("maimai", "chunithm", "ongeki")
INIT_SQL_PATH = Path(__file__).with_name("init.sql")
DEFAULT_ATTRIBUTION_PATH = Path(__file__).with_name("japan_daily_attribution.json")
JAPAN_DDL_START = "-- BEGIN JAPAN_DAILY_PLAY"
JAPAN_DDL_END = "-- END JAPAN_DAILY_PLAY"

# The first written totals live in the 2026-05-25 note, but that note records
# no arcade activity.  The 2026-05-24 note explicitly records playing all three
# games, so only this initial 4/4/10 delta is attributed one day earlier.  All
# later deltas use their note filename date without inference.
INITIAL_SNAPSHOT_DATE = date(2026, 5, 25)
INITIAL_ACTIVITY_DATE = date(2026, 5, 24)

FILENAME_RE = re.compile(r"^(?P<date>\d{4}-\d{2}-\d{2})\.md$")
STANDARD_COUNT_RE = re.compile(
    r"^\s*[-*]\s*(?P<game>maimai|chuni(?:thm)?|ongeki)\s*:\s*"
    r"(?P<value>\d+|-)\s*$",
    re.IGNORECASE,
)
GAME_PATTERNS = {
    "maimai": re.compile(r"\bmaimai\b", re.IGNORECASE),
    "chunithm": re.compile(r"\bchuni(?:thm)?\b", re.IGNORECASE),
    "ongeki": re.compile(r"\bongeki\b", re.IGNORECASE),
}
JP_PLAYS_RE = re.compile(r"\bJP\s+(?P<value>\d+)\s+plays?\b", re.IGNORECASE)
PAREN_TRACKS_RE = re.compile(r"\((?P<value>\d+)\s+tracks?\b", re.IGNORECASE)
TOTAL_WITH_COLON_RE = re.compile(
    r"\btotal\b[^:\n]{0,48}:\s*(?P<value>\d+)", re.IGNORECASE
)
TOTAL_DIRECT_RE = re.compile(r"\btotal\s*:?[ ]*(?P<value>\d+)\b", re.IGNORECASE)
COLON_VALUE_RE = re.compile(r":\s*(?P<value>\d+)\b")
COUNT_MARKER_RE = re.compile(
    r"\b(total|play\s*counts?|playcounts?|played\s+tracks?|tracks?)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class SourceRef:
    path: str
    sha256: str


@dataclass(frozen=True)
class JournalDay:
    play_date: date
    source: SourceRef
    values: Mapping[str, int | None]
    mentioned_games: frozenset[str]


@dataclass(frozen=True)
class JapanDailyPlay:
    play_date: date
    maimai_play_count: int
    chunithm_play_count: int
    ongeki_track_count: int
    maimai_cumulative: int
    chunithm_cumulative: int
    ongeki_cumulative_tracks: int
    source_paths: tuple[str, ...]
    source_hashes: tuple[str, ...]
    inferred_games: tuple[str, ...] = ()

    def db_params(self) -> tuple[object, ...]:
        return (
            self.play_date,
            self.maimai_play_count,
            self.chunithm_play_count,
            self.ongeki_track_count,
            self.maimai_cumulative,
            self.chunithm_cumulative,
            self.ongeki_cumulative_tracks,
            SOURCE,
            list(self.source_paths),
            list(self.source_hashes),
            list(self.inferred_games),
        )


class UnresolvedAttributionError(ValueError):
    """Raised when a missing Journal total has no audited daily count."""


def _load_japan_table_sql(path: Path = INIT_SQL_PATH) -> str:
    """Load the canonical Japan table DDL from ``init.sql``."""

    init_sql = path.read_text(encoding="utf-8")
    try:
        body = init_sql.split(JAPAN_DDL_START, maxsplit=1)[1].split(
            JAPAN_DDL_END, maxsplit=1
        )[0]
    except IndexError as error:
        raise RuntimeError("Japan DDL markers are missing from init.sql") from error
    statement = body.strip()
    if not statement.startswith("CREATE TABLE IF NOT EXISTS public.japan_daily_play"):
        raise RuntimeError("Japan DDL marker contains an unexpected statement")
    return statement


CREATE_TABLE_SQL = _load_japan_table_sql()


UPSERT_SQL = """
    INSERT INTO public.japan_daily_play (
        play_date,
        maimai_play_count,
        chunithm_play_count,
        ongeki_track_count,
        maimai_cumulative,
        chunithm_cumulative,
        ongeki_cumulative_tracks,
        source,
        source_paths,
        source_hashes,
        inferred_games
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (play_date) DO UPDATE SET
        maimai_play_count = EXCLUDED.maimai_play_count,
        chunithm_play_count = EXCLUDED.chunithm_play_count,
        ongeki_track_count = EXCLUDED.ongeki_track_count,
        maimai_cumulative = EXCLUDED.maimai_cumulative,
        chunithm_cumulative = EXCLUDED.chunithm_cumulative,
        ongeki_cumulative_tracks = EXCLUDED.ongeki_cumulative_tracks,
        source = EXCLUDED.source,
        source_paths = EXCLUDED.source_paths,
        source_hashes = EXCLUDED.source_hashes,
        inferred_games = EXCLUDED.inferred_games
"""


def _canonical_game(raw_game: str) -> str:
    lowered = raw_game.lower()
    return "chunithm" if lowered.startswith("chuni") else lowered


def parse_count_line(line: str) -> tuple[str, int | None] | None:
    """Parse one high-confidence cumulative-count line.

    ``None`` as the returned value means an explicit ``-`` carry marker.  A
    return value of ``None`` for the whole function means the line is not a
    supported count line.
    """

    standard = STANDARD_COUNT_RE.match(line)
    if standard:
        game = _canonical_game(standard.group("game"))
        raw_value = standard.group("value")
        return game, None if raw_value == "-" else int(raw_value)

    game = next(
        (name for name, pattern in GAME_PATTERNS.items() if pattern.search(line)),
        None,
    )
    if game is None:
        return None

    # The oldest snapshot uses "maimai JP 4 plays" / "chuni JP 4 plays".
    jp_plays = JP_PLAYS_RE.search(line)
    if jp_plays and game != "ongeki":
        return game, int(jp_plays.group("value"))

    if game == "ongeki":
        # "ongeki 3 plays (10 tracks)" means 10 tracks; 3 is the number of
        # sessions/credits and must not enter the track series.
        parenthesized_tracks = PAREN_TRACKS_RE.search(line)
        if parenthesized_tracks:
            return game, int(parenthesized_tracks.group("value"))

    if not COUNT_MARKER_RE.search(line):
        return None

    # Prefer an explicitly labelled total over a daily number in prose, e.g.
    # "Played ONGEKI for 3 tracks. (Total: 70)".
    total = TOTAL_WITH_COLON_RE.search(line) or TOTAL_DIRECT_RE.search(line)
    if total:
        return game, int(total.group("value"))

    value_after_colon = COLON_VALUE_RE.search(line)
    if value_after_colon:
        return game, int(value_after_colon.group("value"))

    return None


def parse_journal_file(path: Path, journal_root: Path) -> JournalDay:
    match = FILENAME_RE.match(path.name)
    if not match:
        raise ValueError(f"Journal filename is not YYYY-MM-DD.md: {path.name}")

    raw_bytes = path.read_bytes()
    text = raw_bytes.decode("utf-8")
    parsed: dict[str, int | None] = {}
    mentioned: set[str] = set()

    for line_number, line in enumerate(text.splitlines(), start=1):
        result = parse_count_line(line)
        if result is None:
            continue
        game, value = result
        if game in mentioned and parsed[game] != value:
            raise ValueError(
                f"Conflicting {game} totals in {path.name} at line {line_number}: "
                f"{parsed[game]!r} and {value!r}"
            )
        parsed[game] = value
        mentioned.add(game)

    relative_path = path.relative_to(journal_root).as_posix()
    return JournalDay(
        play_date=date.fromisoformat(match.group("date")),
        source=SourceRef(
            path=relative_path,
            sha256=hashlib.sha256(raw_bytes).hexdigest(),
        ),
        values={game: parsed.get(game) for game in GAME_ORDER},
        mentioned_games=frozenset(mentioned),
    )


def load_journal_days(journal_root: Path, through: date) -> dict[date, JournalDay]:
    if not journal_root.is_dir():
        raise FileNotFoundError(f"Journal directory does not exist: {journal_root}")

    days: dict[date, JournalDay] = {}
    for path in sorted(journal_root.glob("*.md")):
        match = FILENAME_RE.match(path.name)
        if not match:
            continue
        play_date = date.fromisoformat(match.group("date"))
        if play_date > through:
            continue
        if play_date in days:
            raise ValueError(f"Duplicate journal date: {play_date.isoformat()}")
        days[play_date] = parse_journal_file(path, journal_root)
    return days


def load_daily_attributions(
    path: Path,
) -> tuple[
    dict[tuple[date, str], int],
    dict[date, tuple[str, ...]],
    SourceRef,
]:
    raw_bytes = path.read_bytes()
    payload = json.loads(raw_bytes)
    raw_counts = payload.get("daily_counts")
    if not isinstance(raw_counts, dict):
        raise ValueError("Attribution file must contain a daily_counts object")

    counts: dict[tuple[date, str], int] = {}
    for raw_date, game_counts in raw_counts.items():
        try:
            play_date = date.fromisoformat(raw_date)
        except (TypeError, ValueError) as error:
            raise ValueError(f"Invalid attribution date: {raw_date!r}") from error
        if not isinstance(game_counts, dict):
            raise ValueError(f"Attribution for {raw_date} must be an object")
        for game, count in game_counts.items():
            if game not in GAME_ORDER:
                raise ValueError(f"Invalid attribution game on {raw_date}: {game!r}")
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise ValueError(
                    f"Attribution for {raw_date} {game} must be a non-negative integer"
                )
            counts[(play_date, game)] = count

    raw_inferred = payload.get("inferred_games", {})
    if not isinstance(raw_inferred, dict):
        raise ValueError("Attribution file inferred_games must be an object")
    inferred: dict[date, tuple[str, ...]] = {}
    for raw_date, raw_games in raw_inferred.items():
        try:
            play_date = date.fromisoformat(raw_date)
        except (TypeError, ValueError) as error:
            raise ValueError(f"Invalid inferred date: {raw_date!r}") from error
        if not isinstance(raw_games, list) or any(
            game not in GAME_ORDER for game in raw_games
        ):
            raise ValueError(
                f"Inferred games for {raw_date} must contain known game names"
            )
        inferred[play_date] = tuple(dict.fromkeys(raw_games))

    return (
        counts,
        inferred,
        SourceRef(
            path=path.name,
            sha256=hashlib.sha256(raw_bytes).hexdigest(),
        ),
    )


def _date_range(start: date, end: date) -> Iterable[date]:
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def _unique_sources(sources: Iterable[SourceRef]) -> tuple[SourceRef, ...]:
    result: list[SourceRef] = []
    seen: set[tuple[str, str]] = set()
    for source in sources:
        identity = (source.path, source.sha256)
        if identity not in seen:
            seen.add(identity)
            result.append(source)
    return tuple(result)


def _make_row(
    play_date: date,
    cumulative: Mapping[str, int],
    previous: Mapping[str, int],
    sources: Sequence[SourceRef],
    inferred_games: Sequence[str] = (),
) -> JapanDailyPlay:
    deltas = {game: cumulative[game] - previous[game] for game in GAME_ORDER}
    negative = {game: value for game, value in deltas.items() if value < 0}
    if negative:
        details = ", ".join(f"{game}={value}" for game, value in negative.items())
        raise ValueError(
            f"Cumulative totals decreased on {play_date.isoformat()}: {details}"
        )

    unique_sources = _unique_sources(sources)
    return JapanDailyPlay(
        play_date=play_date,
        maimai_play_count=deltas["maimai"],
        chunithm_play_count=deltas["chunithm"],
        ongeki_track_count=deltas["ongeki"],
        maimai_cumulative=cumulative["maimai"],
        chunithm_cumulative=cumulative["chunithm"],
        ongeki_cumulative_tracks=cumulative["ongeki"],
        source_paths=tuple(source.path for source in unique_sources),
        source_hashes=tuple(source.sha256 for source in unique_sources),
        inferred_games=tuple(inferred_games),
    )


def build_daily_rows(
    journal_root: Path,
    through: date = DEFAULT_THROUGH,
    attribution_path: Path = DEFAULT_ATTRIBUTION_PATH,
) -> list[JapanDailyPlay]:
    """Build a continuous Japan series without touching a database."""

    if through < INITIAL_SNAPSHOT_DATE:
        raise ValueError(
            f"through must be on or after {INITIAL_SNAPSHOT_DATE.isoformat()}"
        )

    days = load_journal_days(journal_root, through)
    attributions, inferred_by_date, attribution_source = load_daily_attributions(
        attribution_path
    )
    required_dates = tuple(_date_range(INITIAL_ACTIVITY_DATE, through))
    missing_dates = [day for day in required_dates if day not in days]
    if missing_dates:
        rendered = ", ".join(day.isoformat() for day in missing_dates)
        raise ValueError(f"Missing journal notes in requested range: {rendered}")

    unresolved = [
        (play_date, game)
        for play_date in required_dates
        if play_date > INITIAL_SNAPSHOT_DATE
        for game in GAME_ORDER
        if game not in days[play_date].mentioned_games
        and (play_date, game) not in attributions
    ]
    if unresolved:
        rendered = ", ".join(
            f"{play_date.isoformat()} {game}" for play_date, game in unresolved
        )
        raise UnresolvedAttributionError(
            "Missing Journal totals require audited daily counts before import: "
            f"{rendered}. Add the count to {attribution_path.name}; an explicit '-' "
            "does not need an attribution."
        )

    redundant = [
        (play_date, game)
        for play_date, game in attributions
        if play_date in days and game in days[play_date].mentioned_games
    ]
    if redundant:
        rendered = ", ".join(
            f"{play_date.isoformat()} {game}" for play_date, game in redundant
        )
        raise ValueError(f"Attributions duplicate explicit Journal totals: {rendered}")

    snapshot_day = days[INITIAL_SNAPSHOT_DATE]
    missing_initial = [
        game
        for game in GAME_ORDER
        if game not in snapshot_day.mentioned_games
        or snapshot_day.values[game] is None
    ]
    if missing_initial:
        raise ValueError(
            "Initial 2026-05-25 snapshot must contain integer totals for: "
            + ", ".join(missing_initial)
        )

    initial = {game: int(snapshot_day.values[game]) for game in GAME_ORDER}
    zero = {game: 0 for game in GAME_ORDER}
    activity_source = days[INITIAL_ACTIVITY_DATE].source

    # Explicit one-off attribution: the initial snapshot describes the play
    # recorded in the prior day's activity note.
    rows = [
        _make_row(
            INITIAL_ACTIVITY_DATE,
            initial,
            zero,
            (activity_source, snapshot_day.source),
        ),
        _make_row(
            INITIAL_SNAPSHOT_DATE,
            initial,
            initial,
            (snapshot_day.source,),
        ),
    ]

    previous = dict(initial)
    last_value_sources = {
        game: (snapshot_day.source,) for game in GAME_ORDER
    }

    for current_date in _date_range(
        INITIAL_SNAPSHOT_DATE + timedelta(days=1), through
    ):
        day = days[current_date]
        cumulative = dict(previous)
        provenance: list[SourceRef] = [day.source]

        for game in GAME_ORDER:
            value = day.values[game]
            # A daily delta is a subtraction between the previous snapshot and
            # today's snapshot, so retain both source identities even when the
            # current note contains an explicit number.
            provenance.extend(last_value_sources[game])
            if game not in day.mentioned_games:
                cumulative[game] = previous[game] + attributions[(current_date, game)]
                provenance.append(attribution_source)
                last_value_sources[game] = _unique_sources(
                    (*last_value_sources[game], day.source, attribution_source)
                )
            elif value is not None:
                cumulative[game] = value
                last_value_sources[game] = (day.source,)
            else:
                # An explicit dash means exactly the previous day's cumulative
                # value.  Keep both notes because the dash depends on the prior
                # snapshot for its numeric meaning.
                last_value_sources[game] = _unique_sources(
                    (*last_value_sources[game], day.source)
                )

        rows.append(
            _make_row(
                current_date,
                cumulative,
                previous,
                provenance,
                inferred_by_date.get(current_date, ()),
            )
        )
        previous = cumulative

    return rows


async def upsert_daily_rows(
    connection: asyncpg.Connection, rows: Sequence[JapanDailyPlay]
) -> None:
    """Create and idempotently populate ``japan_daily_play``."""

    ordered_rows = sorted(rows, key=lambda row: row.play_date)
    await connection.execute(CREATE_TABLE_SQL)
    await connection.executemany(UPSERT_SQL, [row.db_params() for row in ordered_rows])


async def apply_daily_rows(database_url: str, rows: Sequence[JapanDailyPlay]) -> None:
    connection = await asyncpg.connect(database_url)
    try:
        async with connection.transaction():
            await upsert_daily_rows(connection, rows)
    finally:
        await connection.close()


def _iso_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected YYYY-MM-DD") from error


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("journal_dir", type=Path)
    parser.add_argument(
        "--through",
        type=_iso_date,
        default=DEFAULT_THROUGH,
        help=f"last Journal date to import (default: {DEFAULT_THROUGH.isoformat()})",
    )
    parser.add_argument(
        "--attribution-file",
        type=Path,
        default=DEFAULT_ATTRIBUTION_PATH,
        help="audited daily counts for dates whose Journal total is omitted",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write to DATABASE_URL; without this flag the command is read-only",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        rows = build_daily_rows(
            args.journal_dir.resolve(),
            args.through,
            args.attribution_file.resolve(),
        )
    except UnresolvedAttributionError as error:
        print(f"Import blocked: {error}", file=sys.stderr)
        return 2
    last = rows[-1]
    print(
        f"Prepared {len(rows)} Japan rows: {rows[0].play_date.isoformat()}.."
        f"{last.play_date.isoformat()} | cumulative maimai={last.maimai_cumulative}, "
        f"chunithm={last.chunithm_cumulative}, "
        f"ongeki_tracks={last.ongeki_cumulative_tracks}"
    )
    inferred = [
        f"{row.play_date.isoformat()} {game}"
        for row in rows
        for game in row.inferred_games
    ]
    if inferred:
        print("Inferred daily counts (*): " + ", ".join(inferred))

    if not args.apply:
        print("Dry run only; database was not opened. Pass --apply to upsert rows.")
        return 0

    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required with --apply")
    asyncio.run(apply_daily_rows(DATABASE_URL, rows))
    print(f"Upserted {len(rows)} rows into public.japan_daily_play.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
