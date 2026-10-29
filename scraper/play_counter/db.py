import asyncio
from pathlib import Path

import asyncpg
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP

from play_counter.config import DATABASE_URL

MISSING_DATABASE_URL_MESSAGE = (
    "DATABASE_URL is not configured. Set it in environment variables or .env."
)

VALID_GAMES = {"maimai", "chunithm"}

INIT_SQL_PATH = Path(__file__).resolve().parent.parent / "init.sql"


def _validate_game(game: str) -> None:
    if game not in VALID_GAMES:
        raise ValueError(f"Invalid game: {game!r}")


async def connect_db():
    if not DATABASE_URL:
        raise RuntimeError(MISSING_DATABASE_URL_MESSAGE)
    # Retry connection establishment only: never replay a possibly committed write.
    for attempt in range(1, 5):
        try:
            return await asyncpg.connect(DATABASE_URL, timeout=20, command_timeout=30)
        except (OSError, TimeoutError, asyncpg.CannotConnectNowError,
                asyncpg.TooManyConnectionsError) as exc:
            # Exception type is useful even for TimeoutError with an empty message.
            # Do not log the DSN or server message (which can contain credentials).
            print(f"[WARN] Database connection attempt {attempt}/4: {type(exc).__name__}")
            if attempt == 4:
                raise
            await asyncio.sleep(2 ** attempt)


async def init_schema() -> None:
    """Execute init.sql to ensure tables exist. Idempotent."""
    sql = INIT_SQL_PATH.read_text()
    conn = await connect_db()
    try:
        await conn.execute(sql)
    finally:
        await conn.close()


async def get_cumulative(game: str, date_str: str) -> int:
    _validate_game(game)
    conn = await connect_db()
    try:
        date_obj = datetime.strptime(date_str, "%Y-%m-%d")
        col = f"{game}_cumulative"
        row = await conn.fetchrow(
            f"SELECT {col} FROM public.daily_play WHERE play_date = $1", date_obj
        )
        return row[col] if row and row[col] is not None else 0
    finally:
        await conn.close()


async def get_previous_cumulative(game: str, today_str: str) -> int:
    """Get the most recent cumulative before today. Used to correctly calculate new plays across runs."""
    _validate_game(game)
    conn = await connect_db()
    try:
        date_obj = datetime.strptime(today_str, "%Y-%m-%d")
        col = f"{game}_cumulative"
        row = await conn.fetchrow(
            f"SELECT {col} FROM public.daily_play WHERE play_date < $1 ORDER BY play_date DESC LIMIT 1",
            date_obj,
        )
        return row[col] if row and row[col] is not None else 0
    finally:
        await conn.close()


async def get_previous_observation(game: str, today_str: str):
    """Successful observations, including nightly no-play rows; never flagged carry-forwards."""
    _validate_game(game)
    conn = await connect_db()
    try:
        return await conn.fetchrow(
            f"""SELECT play_date, {game}_cumulative AS cumulative
                FROM public.daily_play
                WHERE play_date < $1 AND {game}_cumulative IS NOT NULL
                  AND scrape_failed = FALSE
                ORDER BY play_date DESC LIMIT 1""",
            datetime.strptime(today_str, "%Y-%m-%d").date(),
        )
    finally:
        await conn.close()


async def get_previous_rating(game: str, exclude_date: str) -> float | None:
    """Get the most recent rating before a given date, excluding failed scrapes."""
    _validate_game(game)
    conn = await connect_db()
    try:
        date_obj = datetime.strptime(exclude_date, "%Y-%m-%d")
        col = f"{game}_rating"
        row = await conn.fetchrow(
            f"""
                SELECT {col} FROM public.daily_play
                WHERE play_date < $1
                  AND {col} IS NOT NULL
                  AND scrape_failed = FALSE
                ORDER BY play_date DESC
                LIMIT 1
            """,
            date_obj,
        )
        return row[col] if row else None
    finally:
        await conn.close()


async def get_rating_on(game: str, date_str: str) -> float | None:
    """That day's stored rating, such as one typed in the day editor."""
    _validate_game(game)
    conn = await connect_db()
    try:
        col = f"{game}_rating"
        return await conn.fetchval(
            f"SELECT {col} FROM public.daily_play WHERE play_date = $1",
            datetime.strptime(date_str, "%Y-%m-%d"),
        )
    finally:
        await conn.close()


async def upsert_daily_play(
    date_str: str,
    maimai_new: int | None,
    chunithm_new: int | None,
    maimai_cumulative: int | None,
    chunithm_cumulative: int | None,
    maimai_rating: float | int | Decimal | None,
    chunithm_rating: float | int | Decimal | None,
    scrape_failed: bool = False,
    failure_reason: str | None = None,
):
    upsert_query = """
        INSERT INTO public.daily_play
            (play_date, maimai_play_count, chunithm_play_count,
             maimai_cumulative, chunithm_cumulative,
             maimai_rating, chunithm_rating, scrape_failed, failure_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (play_date) DO UPDATE
          SET maimai_play_count=COALESCE(EXCLUDED.maimai_play_count, daily_play.maimai_play_count),
              chunithm_play_count=COALESCE(EXCLUDED.chunithm_play_count, daily_play.chunithm_play_count),
              maimai_cumulative=EXCLUDED.maimai_cumulative,
              chunithm_cumulative=EXCLUDED.chunithm_cumulative,
              maimai_rating=EXCLUDED.maimai_rating,
              chunithm_rating=EXCLUDED.chunithm_rating,
              scrape_failed=EXCLUDED.scrape_failed,
              failure_reason=EXCLUDED.failure_reason
    """
    if chunithm_rating is not None and not isinstance(chunithm_rating, (int, Decimal)):
        chunithm_rating = Decimal(str(chunithm_rating)).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )

    date_obj = datetime.strptime(date_str, "%Y-%m-%d")
    params = (
        date_obj,
        maimai_new,
        chunithm_new,
        maimai_cumulative,
        chunithm_cumulative,
        maimai_rating,
        chunithm_rating,
        scrape_failed,
        failure_reason,
    )

    # Write to cloud DB
    conn = await connect_db()
    try:
        await conn.execute(upsert_query, *params)
        print(
            f"[OK] Cloud DB saved: {date_str} | Maimai new: {maimai_new}, Chunithm new: {chunithm_new} | "
            f"Maimai cumulative: {maimai_cumulative}, Chunithm cumulative: {chunithm_cumulative}"
        )
    finally:
        await conn.close()


async def verify_editor_day(conn, day: date, reasons: list[str], table: str = "public.daily_play") -> bool:
    """Clear the unverified flag that the day editor or a one-game Refresh copied
    onto a day that Refresh has now observed.

    Call only after every configured game's totals for that day came from SEGA.
    The upsert keeps an existing failure_reason, so this one also records the
    importer's own attribution reasons.
    """
    result = await conn.execute(
        f"""
        UPDATE {table} SET scrape_failed = FALSE, failure_reason = $2
        WHERE play_date = $1 AND scrape_failed
          AND (failure_reason LIKE 'Logged in the day editor;%'
               OR failure_reason LIKE 'Refreshed % only;%')
        """,
        day,
        " | ".join(reasons) or None,
    )
    return result == "UPDATE 1"


async def write_single_game_day(
    conn,
    game: str,
    day: date,
    new_plays: int | None,
    cumulative: int,
    rating: float | int | Decimal | None,
    reason: str | None,
    table: str = "public.daily_play",
) -> None:
    """Write one game's columns for a day.

    A new row gives the other game no plays and the previous row's totals and
    rating, like the nightly fill. Totals carried from an unverified row keep
    the new row flagged until a Refresh of every game verifies it.
    """
    _validate_game(game)
    other = "chunithm" if game == "maimai" else "maimai"
    await conn.execute(
        f"""
        INSERT INTO {table}
            (play_date, {game}_play_count, {game}_cumulative, {game}_rating,
             {other}_play_count, {other}_cumulative, {other}_rating,
             scrape_failed, failure_reason)
        SELECT $1, $2, $3, $4, 0, prev.{other}_cumulative, prev.{other}_rating,
               COALESCE(prev.scrape_failed, FALSE),
               CASE WHEN prev.scrape_failed THEN concat_ws(' | ',
                   'Refreshed {game} only; {other} totals carried from '
                   || prev.play_date || ', which is unverified.',
                   $5::text)
               ELSE $5::text END
        FROM (SELECT 1) AS seed
        LEFT JOIN LATERAL (
            SELECT * FROM {table} d
            WHERE d.play_date < $1
            ORDER BY d.play_date DESC LIMIT 1
        ) prev ON TRUE
        ON CONFLICT (play_date) DO UPDATE SET
            {game}_play_count = COALESCE(EXCLUDED.{game}_play_count, daily_play.{game}_play_count),
            {game}_cumulative = EXCLUDED.{game}_cumulative,
            {game}_rating = EXCLUDED.{game}_rating,
            failure_reason = COALESCE(daily_play.failure_reason, EXCLUDED.failure_reason)
        """,
        day, new_plays, cumulative, rating, reason,
    )


async def upsert_daily_play_single_game(
    game: str,
    date_str: str,
    cumulative: int,
    rating: float | int | Decimal | None,
) -> str | None:
    """Upsert one game's columns for a date without clobbering the other game.

    Used by the chuumai-tools import path (refresh button) so maimai and chunithm
    can refresh independently. new_plays is recomputed from the previous day's
    cumulative so repeated calls are idempotent.
    """
    _validate_game(game)

    # chunithm rating is a float; round to 2 decimals via Decimal so the NUMERIC
    # column doesn't end up with binary-float noise.
    if rating is not None and not isinstance(rating, (int, Decimal)):
        rating = Decimal(str(rating)).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )

    from play_counter.attribution import daily_count

    previous = await get_previous_observation(game, date_str)
    new_plays, reason = daily_count(previous, date_str, cumulative)
    if reason:
        reason = f"{game}: {reason}"
        print(f"[WARN] {reason}")

    conn = await connect_db()
    try:
        await write_single_game_day(
            conn, game, datetime.strptime(date_str, "%Y-%m-%d").date(),
            new_plays, cumulative, rating, reason,
        )
        print(
            f"[OK] daily_play upsert: {date_str} {game} "
            f"cumulative={cumulative}, rating={rating}, new_plays={new_plays}"
        )
    finally:
        await conn.close()

    return reason


async def test_db_connection():
    if not DATABASE_URL:
        print(f"Database connection failed: {MISSING_DATABASE_URL_MESSAGE}")
        return False

    try:
        conn = await connect_db()
        await conn.close()
        print("[OK] Cloud DB connection OK")
    except Exception as e:
        print(f"Database connection failed: {type(e).__name__}")
        return False

    return True
