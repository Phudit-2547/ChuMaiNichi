"""Do not assign a multi-day cumulative delta to the recovery date."""
from datetime import date, timedelta


def daily_count(previous, target: str, cumulative: int, record_count=None):
    if previous is None:
        return (record_count if record_count is not None else 0), None
    delta = cumulative - previous["cumulative"]
    if delta < 0:
        return record_count, "Cumulative counter decreased; verify version reset/baseline."
    gap = previous["play_date"] != date.fromisoformat(target) - timedelta(days=1)
    if gap and delta > 0:
        reason = (
            f"Missing reliable daily baseline after {previous['play_date']}; "
            f"{delta} play(s) across multiple dates. Backfill required."
        )
        # A complete record page proves today's count but not the missing days.
        return record_count, reason
    if record_count is not None:
        return record_count, None
    return delta, None
