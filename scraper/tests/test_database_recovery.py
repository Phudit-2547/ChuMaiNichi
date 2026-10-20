from datetime import date
from unittest.mock import AsyncMock

import asyncpg
import pytest

from play_counter import db
from play_counter.attribution import daily_count
from repair_daily_play import build_repair, validate_plan


@pytest.mark.asyncio
async def test_timeout_retries_then_recovers_without_logging_secret(monkeypatch, capsys):
    monkeypatch.setattr(db, 'DATABASE_URL', 'postgres://secret')
    connection = object()
    connect = AsyncMock(side_effect=[TimeoutError(), OSError('postgres://secret'), connection])
    sleep = AsyncMock()
    monkeypatch.setattr(db.asyncpg, 'connect', connect)
    monkeypatch.setattr(db.asyncio, 'sleep', sleep)
    assert await db.connect_db() is connection
    assert connect.await_count == 3
    assert [call.args[0] for call in sleep.await_args_list] == [2, 4]
    output = capsys.readouterr().out
    assert 'TimeoutError' in output
    assert 'secret' not in output


@pytest.mark.asyncio
async def test_exhausted_timeout_fails_health_check(monkeypatch, capsys):
    monkeypatch.setattr(db, 'DATABASE_URL', 'postgres://secret')
    connect = AsyncMock(side_effect=TimeoutError)
    monkeypatch.setattr(db.asyncpg, 'connect', connect)
    monkeypatch.setattr(db.asyncio, 'sleep', AsyncMock())
    assert await db.test_db_connection() is False
    assert connect.await_count == 4
    assert 'TimeoutError' in capsys.readouterr().out


@pytest.mark.asyncio
async def test_auth_error_is_not_retried(monkeypatch):
    monkeypatch.setattr(db, 'DATABASE_URL', 'postgres://secret')
    connect = AsyncMock(side_effect=asyncpg.InvalidPasswordError)
    monkeypatch.setattr(db.asyncpg, 'connect', connect)
    with pytest.raises(asyncpg.InvalidPasswordError):
        await db.connect_db()
    assert connect.await_count == 1


@pytest.mark.parametrize('delta,exact,expected,warning', [
    (1, None, None, True), (1, 0, 0, True), (0, None, 0, False),
    (2, 1, 1, True), (-1, None, None, True),
])
def test_recovery_does_not_attribute_mondays_play_to_tuesday(delta, exact, expected, warning):
    count, reason = daily_count({'play_date': date(2026, 10, 18), 'cumulative': 338},
                               '2026-10-20', 338 + delta, exact)
    assert count == expected
    assert bool(reason) is warning


def test_consecutive_observation_and_first_run():
    previous = {'play_date': date(2026, 10, 19), 'cumulative': 338}
    assert daily_count(previous, '2026-10-20', 339) == (1, None)
    assert daily_count(previous, '2026-10-20', 339, 0) == (0, None)
    assert daily_count(None, '2026-10-20', 339) == (0, None)
    assert daily_count(None, '2026-10-20', 339, 2) == (2, None)


def plan():
    return {'baseline_date': '2026-10-18',
            'baseline': {'maimai': 732, 'chunithm': 338},
            'end': {'maimai': 733, 'chunithm': 339},
            'days': [{'date': '2026-10-19', 'maimai': 1, 'chunithm': 1},
                     {'date': '2026-10-20', 'maimai': 0, 'chunithm': 0}]}


def rows():
    return [{'play_date': date(2026, 10, 18), 'maimai_cumulative': 732,
             'chunithm_cumulative': 338, 'scrape_failed': False},
            {'play_date': date(2026, 10, 20), 'maimai_cumulative': 733,
             'chunithm_cumulative': 339, 'scrape_failed': False,
             'maimai_rating': 14561, 'chunithm_rating': 15.26}]


def test_backfill_restores_both_days_without_inventing_ratings():
    changes, digest = build_repair(plan(), rows())
    assert len(digest) == 64
    assert [r['maimai_play_count'] for r in changes] == [1, 0]
    assert [r['chunithm_play_count'] for r in changes] == [1, 0]
    assert [r['maimai_cumulative'] for r in changes] == [733, 733]
    assert [r['chunithm_cumulative'] for r in changes] == [339, 339]
    assert changes[0]['maimai_rating'] is None
    assert changes[1]['maimai_rating'] == 14561


def test_backfill_refuses_wrong_anchor_and_nonconsecutive_days():
    wrong = rows()
    wrong[-1]['maimai_cumulative'] = 734
    with pytest.raises(ValueError, match='cumulative changed'):
        build_repair(plan(), wrong)
    bad = plan()
    bad['days'][0]['date'] = '2026-10-17'
    with pytest.raises(ValueError, match='consecutive'):
        validate_plan(bad)


def test_backfill_fingerprint_detects_intervening_edits():
    before = rows()
    _, first = build_repair(plan(), before)
    before[-1]['maimai_play_count'] = 7
    _, second = build_repair(plan(), before)
    assert first != second


@pytest.mark.asyncio
async def test_refresh_uses_same_gap_guard(monkeypatch):
    conn = AsyncMock()
    monkeypatch.setattr(db, 'connect_db', AsyncMock(return_value=conn))
    monkeypatch.setattr(db, 'get_previous_observation', AsyncMock(return_value={
        'play_date': date(2026, 10, 18), 'cumulative': 338,
    }))
    await db.upsert_daily_play_single_game('chunithm', '2026-10-20', 339, 15.26)
    args = conn.execute.await_args.args
    assert args[2] is None
    assert 'Backfill required' in args[5]
    assert 'COALESCE(EXCLUDED.chunithm_play_count' in args[0]


@pytest.mark.asyncio
async def test_main_gap_saved_as_unknown_and_fails(monkeypatch):
    import main as runner
    from datetime import datetime, timezone, timedelta
    from unittest.mock import Mock
    class Clock:
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 20, 22, tzinfo=timezone(timedelta(hours=7)))
    monkeypatch.setattr(runner, 'datetime', Clock)
    monkeypatch.setattr(runner.sys, 'argv', ['main.py'])
    monkeypatch.setattr(runner, 'CONFIG', {'chunithm': True})
    monkeypatch.setattr(runner, 'test_db_connection', AsyncMock(return_value=True))
    monkeypatch.setattr(runner, 'init_schema', AsyncMock())
    monkeypatch.setattr(runner, 'fetch_player_data', AsyncMock(return_value={
        'cumulative': 339, 'rating': 15.26, 'failed': False,
    }))
    monkeypatch.setattr(runner, 'get_previous_observation', AsyncMock(return_value={
        'play_date': date(2026, 10, 18), 'cumulative': 338,
    }))
    save, notify = AsyncMock(), Mock()
    monkeypatch.setattr(runner, 'upsert_daily_play', save)
    monkeypatch.setattr(runner, 'send_notification', notify)
    with pytest.raises(SystemExit):
        await runner.main()
    args, kwargs = save.await_args
    assert args[0] == '2026-10-20'
    assert args[2] is None
    assert args[4] == 339
    assert kwargs['scrape_failed'] is False
    assert 'Backfill required' in kwargs['failure_reason']
    notify.assert_not_called()


@pytest.mark.asyncio
async def test_repair_dry_run_and_stale_digest_never_write(monkeypatch):
    import repair_daily_play as repairer
    from unittest.mock import MagicMock
    conn = AsyncMock()
    conn.transaction = MagicMock(return_value=AsyncMock())
    conn.fetch.return_value = rows()
    monkeypatch.setattr(repairer, 'connect_db', AsyncMock(return_value=conn))
    await repairer.repair(plan())
    assert conn.execute.await_count == 1  # table lock only
    conn.execute.reset_mock()
    with pytest.raises(ValueError, match='changed since dry-run'):
        await repairer.repair(plan(), apply=True, expected_digest='stale')
    assert conn.execute.await_count == 1
    conn.close.assert_awaited()


@pytest.mark.asyncio
async def test_repair_apply_verifies_in_transaction(monkeypatch):
    import repair_daily_play as repairer
    from unittest.mock import MagicMock
    changes, digest = build_repair(plan(), rows())
    conn = AsyncMock()
    transaction = AsyncMock()
    conn.transaction = MagicMock(return_value=transaction)
    conn.fetch.side_effect = [rows(), changes]
    monkeypatch.setattr(repairer, 'connect_db', AsyncMock(return_value=conn))
    await repairer.repair(plan(), apply=True, expected_digest=digest)
    assert conn.execute.await_count == 3
    assert transaction.__aexit__.await_args.args == (None, None, None)
