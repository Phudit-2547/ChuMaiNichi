"""Record days with no daily_play row as days without play.

With the daily scraper off, a missing date means the owner did not play: the
row gets 0 plays and the previous day's cumulative totals and ratings. Fills
every missing date after the first recorded day, through yesterday in
Asia/Bangkok. Existing rows are never changed. A day copied from a failed
(unverified) row stays flagged so it never becomes a scraper baseline.
Pass --dry-run to print the dates without writing.
"""
import argparse
import asyncio
from datetime import date, datetime, timedelta

from play_counter.db import connect_db, init_schema
from play_counter.utils.date_helpers import BKK


def bangkok_yesterday(now: datetime) -> date:
    return now.astimezone(BKK).date() - timedelta(days=1)


async def fill_missing_days(conn, through: date, table: str = "public.daily_play") -> list[date]:
    rows = await conn.fetch(
        f"""
        WITH missing AS (
            SELECT day::date AS play_date
            FROM generate_series(
                (SELECT MIN(play_date) FROM {table}), $1::date, INTERVAL '1 day'
            ) AS day
            WHERE NOT EXISTS (SELECT 1 FROM {table} d WHERE d.play_date = day::date)
        )
        INSERT INTO {table}
            (play_date, maimai_play_count, chunithm_play_count,
             maimai_cumulative, chunithm_cumulative,
             maimai_rating, chunithm_rating, scrape_failed, failure_reason)
        SELECT m.play_date, 0, 0,
               prev.maimai_cumulative, prev.chunithm_cumulative,
               prev.maimai_rating, prev.chunithm_rating,
               COALESCE(prev.scrape_failed, FALSE),
               CASE WHEN prev.scrape_failed THEN
                   'No play logged; totals carried from ' || prev.play_date
                   || ', which is unverified.'
               END
        FROM missing m
        CROSS JOIN LATERAL (
            SELECT * FROM {table} d
            WHERE d.play_date < m.play_date
            ORDER BY d.play_date DESC LIMIT 1
        ) prev
        ON CONFLICT (play_date) DO NOTHING
        RETURNING play_date
        """,
        through,
    )
    return sorted(r["play_date"] for r in rows)


async def main(argv: list[str] | None = None) -> None:
    # Parse before connecting: --help or a mistyped flag must never reach the database.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="print the dates without writing")
    dry_run = parser.parse_args(argv).dry_run
    through = bangkok_yesterday(datetime.now(BKK))
    if not dry_run:
        await init_schema()  # also creates daily_ticket on deployments that never ran a scrape
    conn = await connect_db()
    try:
        transaction = conn.transaction()
        await transaction.start()
        filled = await fill_missing_days(conn, through)
        if dry_run:
            await transaction.rollback()
        else:
            await transaction.commit()
    finally:
        await conn.close()
    verb = "Would fill" if dry_run else "Filled"
    days = ", ".join(str(d) for d in filled) or "nothing"
    print(f"{verb} through {through}: {days}")


if __name__ == "__main__":
    asyncio.run(main())
