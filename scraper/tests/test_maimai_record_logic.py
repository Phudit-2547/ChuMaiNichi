from play_counter.scraper import count_maimai_record_plays


def _row(track: int, date_text: str, time_text: str = "12:00") -> str:
    return f"TRACK {track:02d} {date_text} {time_text}"


def test_counts_track_01_as_credits_for_target_date():
    rows = [
        _row(4, "2026/05/08", "23:48"),
        _row(3, "2026/05/08", "23:45"),
        _row(2, "2026/05/08", "23:40"),
        _row(1, "2026/05/08", "23:36"),
        _row(3, "2026/05/08", "15:33"),
        _row(2, "2026/05/08", "15:29"),
        _row(1, "2026/05/08", "15:25"),
        _row(4, "2026/05/06", "17:33"),
    ]

    result = count_maimai_record_plays(rows, "2026-05-08")

    assert result["play_count"] == 2
    assert result["track_count"] == 7
    assert result["complete"] is True


def test_50_rows_without_older_date_is_unsafe_for_target_date():
    rows = [_row((idx % 4) + 1, "2026/05/08") for idx in range(50)]

    result = count_maimai_record_plays(rows, "2026-05-08")

    assert result["entry_count"] == 50
    assert result["complete"] is False


def test_50_rows_with_older_date_is_complete_for_target_date():
    rows = [_row((idx % 4) + 1, "2026/05/08") for idx in range(49)]
    rows.append(_row(4, "2026/05/06"))

    result = count_maimai_record_plays(rows, "2026-05-08")

    assert result["entry_count"] == 50
    assert result["complete"] is True


def test_50_rows_all_older_than_target_is_complete_zero():
    rows = [_row((idx % 4) + 1, "2026/05/07") for idx in range(50)]

    result = count_maimai_record_plays(rows, "2026-05-08")

    assert result["play_count"] == 0
    assert result["track_count"] == 0
    assert result["complete"] is True


def test_50_rows_newer_than_backfill_target_is_unsafe():
    rows = [_row((idx % 4) + 1, "2026/05/08") for idx in range(50)]

    result = count_maimai_record_plays(rows, "2026-05-07")

    assert result["play_count"] == 0
    assert result["track_count"] == 0
    assert result["complete"] is False
