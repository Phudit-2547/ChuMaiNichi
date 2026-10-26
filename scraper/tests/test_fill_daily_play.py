import os
from datetime import date, datetime, timezone
from decimal import Decimal

import asyncpg
import pytest
import pytest_asyncio

import fill_daily_play
from fill_daily_play import bangkok_yesterday, fill_missing_days

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
needs_db = pytest.mark.skipif(
    not TEST_DATABASE_URL, reason="set TEST_DATABASE_URL to run SQL tests (temp tables only)"
)

TABLE = "pg_temp.daily_play"


def test_yesterday_follows_bangkok_midnight():
    # 17:30 UTC on 25 Oct is 00:30 on 26 Oct in Bangkok.
    assert bangkok_yesterday(datetime(2026, 10, 25, 17, 30, tzinfo=timezone.utc)) == date(2026, 10, 25)
    assert bangkok_yesterday(datetime(2026, 10, 25, 16, 30, tzinfo=timezone.utc)) == date(2026, 10, 24)


@pytest.mark.asyncio
@pytest.mark.parametrize("argv,code", [(["--help"], 0), (["--dry_run"], 2), (["-n"], 2)])
async def test_help_and_unknown_flags_exit_before_connecting(monkeypatch, argv, code):
    async def refuse():
        raise AssertionError("connected to the database")
    monkeypatch.setattr(fill_daily_play, "connect_db", refuse)
    with pytest.raises(SystemExit) as exited:
        await fill_daily_play.main(argv)
    assert exited.value.code == code


@pytest_asyncio.fixture
async def conn():
    connection = await asyncpg.connect(TEST_DATABASE_URL)
    try:
        await connection.execute("""
            CREATE TEMP TABLE daily_play (
                play_date DATE PRIMARY KEY,
                maimai_play_count INTEGER, chunithm_play_count INTEGER,
                maimai_cumulative INTEGER, chunithm_cumulative INTEGER,
                maimai_rating NUMERIC, chunithm_rating NUMERIC,
                scrape_failed BOOLEAN DEFAULT FALSE, failure_reason TEXT)""")
        yield connection
    finally:
        await connection.close()


async def insert(conn, day, m, c, mc, cc, mr, cr, failed=False, reason=None):
    await conn.execute(
        f"INSERT INTO {TABLE} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        date.fromisoformat(day), m, c, mc, cc, mr, cr, failed, reason,
    )


async def rows(conn):
    return {
        str(r["play_date"]): tuple(r)[1:]
        for r in await conn.fetch(f"SELECT * FROM {TABLE} ORDER BY play_date")
    }


@needs_db
@pytest.mark.asyncio
async def test_fills_inner_and_trailing_gaps_with_zero_plays_and_previous_values(conn):
    await insert(conn, "2026-10-13", 0, 0, 730, 338, 14561, Decimal("15.26"))
    await insert(conn, "2026-10-15", 1, 0, 731, 338, 14561, Decimal("15.26"))
    await insert(conn, "2026-10-22", 2, 0, 735, 339, 14561, Decimal("15.26"))

    filled = await fill_missing_days(conn, date(2026, 10, 24), table=TABLE)

    assert filled == [date(2026, 10, 14)] + [date(2026, 10, d) for d in range(16, 22)] + [
        date(2026, 10, 23), date(2026, 10, 24)]
    data = await rows(conn)
    assert data["2026-10-14"] == (0, 0, 730, 338, 14561, Decimal("15.26"), False, None)
    assert data["2026-10-16"] == (0, 0, 731, 338, 14561, Decimal("15.26"), False, None)
    assert data["2026-10-24"] == (0, 0, 735, 339, 14561, Decimal("15.26"), False, None)
    assert "2026-10-25" not in data


@needs_db
@pytest.mark.asyncio
async def test_never_overwrites_a_recorded_day_and_is_idempotent(conn):
    await insert(conn, "2026-10-20", 0, 0, 733, 339, 14561, Decimal("15.26"))
    await insert(conn, "2026-10-22", 2, 0, 735, 339, 14600, Decimal("15.30"))

    assert await fill_missing_days(conn, date(2026, 10, 22), table=TABLE) == [date(2026, 10, 21)]
    assert await fill_missing_days(conn, date(2026, 10, 22), table=TABLE) == []
    data = await rows(conn)
    assert data["2026-10-22"] == (2, 0, 735, 339, 14600, Decimal("15.30"), False, None)


@needs_db
@pytest.mark.asyncio
async def test_does_nothing_without_an_earlier_record(conn):
    assert await fill_missing_days(conn, date(2026, 10, 24), table=TABLE) == []
    await insert(conn, "2026-10-22", 2, 0, 735, 339, 14561, Decimal("15.26"))
    assert await fill_missing_days(conn, date(2026, 10, 21), table=TABLE) == []
    assert list(await rows(conn)) == ["2026-10-22"]


@needs_db
@pytest.mark.asyncio
async def test_unverified_totals_stay_flagged_after_a_failed_day(conn):
    await insert(conn, "2026-10-22", None, None, 733, 339, 14561, Decimal("15.26"),
                 failed=True, reason="SEGA NET maintenance")

    await fill_missing_days(conn, date(2026, 10, 23), table=TABLE)

    m, c, mc, cc, mr, cr, failed, reason = (await rows(conn))["2026-10-23"]
    assert (m, c, mc, cc, mr, cr, failed) == (0, 0, 733, 339, 14561, Decimal("15.26"), True)
    assert "2026-10-22" in reason
