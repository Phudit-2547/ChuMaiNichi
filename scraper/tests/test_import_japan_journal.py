from datetime import date
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from import_japan_journal import (
    CREATE_TABLE_SQL,
    DEFAULT_ATTRIBUTION_PATH,
    SOURCE,
    UPSERT_SQL,
    JapanDailyPlay,
    UnresolvedAttributionError,
    build_daily_rows,
    load_daily_attributions,
    parse_count_line,
    upsert_daily_rows,
)


FIXTURES = Path(__file__).parent / "fixtures" / "japan_journal"


def test_audited_june_maimai_attribution_is_one_play():
    counts, inferred, _ = load_daily_attributions(DEFAULT_ATTRIBUTION_PATH)

    assert counts[(date(2026, 6, 1), "maimai")] == 1
    assert inferred[date(2026, 6, 1)] == ("maimai",)
    assert inferred[date(2026, 6, 6)] == ("maimai",)


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("- maimai JP 4 plays", ("maimai", 4)),
        ("- chuni JP 4 plays", ("chunithm", 4)),
        ("- ongeki 3 plays (10 tracks)", ("ongeki", 10)),
        ("- Total chunithm playcount: 7", ("chunithm", 7)),
        ("- Total maimai playcount: 6", ("maimai", 6)),
        ("- Ongeki play total: 25 tracks (delta 12)", ("ongeki", 25)),
        ("- maimai play count : 10", ("maimai", 10)),
        ("- Ongeki total tracks: 37", ("ongeki", 37)),
        ("- ONGEKI played tracks: 55", ("ongeki", 55)),
        ("- Ongeki tracks: 61", ("ongeki", 61)),
        (
            "- Played ONGEKI for 3 tracks. (Total: 70)",
            ("ongeki", 70),
        ),
        ("- Went to ongeki for 3 tracks. (Total 73)", ("ongeki", 73)),
        ("- Played ONGEKI (Total: 80 tracks now.)", ("ongeki", 80)),
        ("- maimai total play counts: 18. Rating is 10K", ("maimai", 18)),
        ("- maimai: 23", ("maimai", 23)),
        ("- chunithm: -", ("chunithm", None)),
        ("- ongeki: 148", ("ongeki", 148)),
    ],
)
def test_parse_supported_journal_formats(line, expected):
    assert parse_count_line(line) == expected


def test_narrative_game_mentions_are_not_mistaken_for_totals():
    assert parse_count_line("- Played maimai with friends.") is None
    assert parse_count_line("- Starting to enjoy ONGEKI after 127 songs played.") is None


def test_build_rows_applies_only_the_explicit_initial_date_override():
    rows = build_daily_rows(FIXTURES, through=date(2026, 5, 28))

    assert [row.play_date for row in rows] == [
        date(2026, 5, 24),
        date(2026, 5, 25),
        date(2026, 5, 26),
        date(2026, 5, 27),
        date(2026, 5, 28),
    ]

    first = rows[0]
    assert (
        first.maimai_play_count,
        first.chunithm_play_count,
        first.ongeki_track_count,
    ) == (4, 4, 10)
    assert first.source_paths == ("2026-05-24.md", "2026-05-25.md")

    snapshot_day = rows[1]
    assert (
        snapshot_day.maimai_play_count,
        snapshot_day.chunithm_play_count,
        snapshot_day.ongeki_track_count,
    ) == (0, 0, 0)
    assert (
        snapshot_day.maimai_cumulative,
        snapshot_day.chunithm_cumulative,
        snapshot_day.ongeki_cumulative_tracks,
    ) == (4, 4, 10)

    assert (
        rows[2].maimai_play_count,
        rows[2].chunithm_play_count,
        rows[2].ongeki_track_count,
    ) == (2, 3, 3)

    # The audited attribution file records zero for all three omitted totals.
    assert (
        rows[3].maimai_play_count,
        rows[3].chunithm_play_count,
        rows[3].ongeki_track_count,
    ) == (0, 0, 0)
    assert rows[3].source_paths == (
        "2026-05-27.md",
        "2026-05-26.md",
        "japan_daily_attribution.json",
    )

    # Missing chunithm on 05-28 also carries forward, never becomes unknown.
    assert (
        rows[4].maimai_play_count,
        rows[4].chunithm_play_count,
        rows[4].ongeki_track_count,
    ) == (1, 0, 12)
    assert (
        rows[4].maimai_cumulative,
        rows[4].chunithm_cumulative,
        rows[4].ongeki_cumulative_tracks,
    ) == (7, 7, 25)


def test_build_rows_rejects_a_missing_journal_day(tmp_path):
    for fixture in FIXTURES.glob("*.md"):
        if fixture.name != "2026-05-27.md":
            (tmp_path / fixture.name).write_bytes(fixture.read_bytes())

    with pytest.raises(ValueError, match="Missing journal notes.*2026-05-27"):
        build_daily_rows(tmp_path, through=date(2026, 5, 28))


def test_build_rows_rejects_decreasing_cumulative(tmp_path):
    for fixture in FIXTURES.glob("*.md"):
        (tmp_path / fixture.name).write_bytes(fixture.read_bytes())
    (tmp_path / "2026-05-28.md").write_text(
        "- maimai: 3\n- ongeki: 25\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="Cumulative totals decreased.*maimai=-3"):
        build_daily_rows(tmp_path, through=date(2026, 5, 28))


def test_build_rows_blocks_an_omitted_total_without_audited_count(tmp_path):
    payload = DEFAULT_ATTRIBUTION_PATH.read_text(encoding="utf-8").replace(
        '    "2026-05-28": {\n      "chunithm": 0\n    },\n',
        "",
    )
    attribution_path = tmp_path / "attribution.json"
    attribution_path.write_text(payload, encoding="utf-8")

    with pytest.raises(
        UnresolvedAttributionError,
        match="2026-05-28 chunithm",
    ):
        build_daily_rows(
            FIXTURES,
            through=date(2026, 5, 28),
            attribution_path=attribution_path,
        )


def test_explicit_dashes_carry_without_an_attribution(tmp_path):
    for fixture in FIXTURES.glob("*.md"):
        (tmp_path / fixture.name).write_bytes(fixture.read_bytes())
    (tmp_path / "2026-05-29.md").write_text(
        "- maimai: -\n- chunithm: -\n- ongeki: -\n",
        encoding="utf-8",
    )

    rows = build_daily_rows(tmp_path, through=date(2026, 5, 29))
    dash_day = rows[-1]

    assert (
        dash_day.maimai_play_count,
        dash_day.chunithm_play_count,
        dash_day.ongeki_track_count,
    ) == (0, 0, 0)
    assert (
        dash_day.maimai_cumulative,
        dash_day.chunithm_cumulative,
        dash_day.ongeki_cumulative_tracks,
    ) == (7, 7, 25)


@pytest.mark.asyncio
async def test_upsert_is_ordered_and_uses_on_conflict():
    connection = AsyncMock()
    later = JapanDailyPlay(
        play_date=date(2026, 5, 25),
        maimai_play_count=0,
        chunithm_play_count=0,
        ongeki_track_count=0,
        maimai_cumulative=4,
        chunithm_cumulative=4,
        ongeki_cumulative_tracks=10,
        source_paths=("2026-05-25.md",),
        source_hashes=("a" * 64,),
    )
    earlier = JapanDailyPlay(
        play_date=date(2026, 5, 24),
        maimai_play_count=4,
        chunithm_play_count=4,
        ongeki_track_count=10,
        maimai_cumulative=4,
        chunithm_cumulative=4,
        ongeki_cumulative_tracks=10,
        source_paths=("2026-05-24.md", "2026-05-25.md"),
        source_hashes=("b" * 64, "a" * 64),
    )

    await upsert_daily_rows(connection, [later, earlier])

    connection.execute.assert_awaited_once_with(CREATE_TABLE_SQL)
    connection.executemany.assert_awaited_once()
    query, parameters = connection.executemany.await_args.args
    assert query == UPSERT_SQL
    assert "ON CONFLICT (play_date) DO UPDATE" in query
    assert [params[0] for params in parameters] == [
        date(2026, 5, 24),
        date(2026, 5, 25),
    ]
    assert all(params[7] == SOURCE for params in parameters)
