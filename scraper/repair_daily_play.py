"""Verified, transactional repair of an explicitly supplied daily-count interval.

REPAIR_PLAN is JSON with baseline_date, days [{date, maimai, chunithm}],
baseline {maimai, chunithm}, and end {maimai, chunithm} cumulative anchors.
A day may specify rating_source_date: a later successful observation within
the interval with the same cumulative totals (no intervening plays).
Dry-run by default. Applying requires REPAIR_APPLY=true and the SHA256 printed
by the dry-run in REPAIR_EXPECTED_SHA256. No credentials are printed.
"""
import asyncio
import hashlib
import json
import os
from datetime import date, timedelta

from play_counter.db import connect_db

GAMES = ("maimai", "chunithm")


def validate_plan(plan):
    baseline = date.fromisoformat(plan["baseline_date"])
    days = plan["days"]
    if not 1 <= len(days) <= 31:
        raise ValueError("Repair must contain 1..31 consecutive days")
    for i, day in enumerate(days, 1):
        if date.fromisoformat(day["date"]) != baseline + timedelta(days=i):
            raise ValueError("Repair dates must be consecutive after baseline")
        for game in GAMES:
            if type(day[game]) is not int or day[game] < 0:
                raise ValueError("Daily counts must be non-negative integers")
    for game in GAMES:
        for anchor in ("baseline", "end"):
            if type(plan[anchor][game]) is not int or plan[anchor][game] < 0:
                raise ValueError("Cumulative anchors must be non-negative integers")
        if plan["baseline"][game] + sum(d[game] for d in days) != plan["end"][game]:
            raise ValueError(f"{game}: daily totals do not reconcile with anchors")
    return baseline, date.fromisoformat(days[-1]["date"])


def build_repair(plan, rows):
    baseline, end = validate_plan(plan)
    by_date = {r["play_date"]: dict(r) for r in rows}
    for anchor, when in (("baseline", baseline), ("end", end)):
        row = by_date.get(when)
        if not row or row["scrape_failed"]:
            raise ValueError(f"Missing successful {anchor} observation")
        for game in GAMES:
            if row[f"{game}_cumulative"] != plan[anchor][game]:
                raise ValueError(f"{game}: {anchor} cumulative changed; refusing repair")
    changes = []
    cumulative = dict(plan["baseline"])
    for day in plan["days"]:
        when = date.fromisoformat(day["date"])
        old = by_date.get(when, {})
        result = {"play_date": when, "scrape_failed": False, "failure_reason": None}
        for game in GAMES:
            cumulative[game] += day[game]
            result[f"{game}_play_count"] = day[game]
            result[f"{game}_cumulative"] = cumulative[game]
            # Never invent a historical rating; retain it only if already recorded.
            result[f"{game}_rating"] = old.get(f"{game}_rating")
        source_date = day.get("rating_source_date")
        if source_date:
            source_day = date.fromisoformat(source_date)
            if not when <= source_day <= end:
                raise ValueError("Rating source must be within the repaired interval after the target")
            source = by_date.get(source_day)
            if not source or source["scrape_failed"]:
                raise ValueError("Rating source must be a successful observation")
            for game in GAMES:
                if source[f"{game}_cumulative"] != result[f"{game}_cumulative"]:
                    raise ValueError(f"{game}: intervening plays; cannot use source rating")
                if source.get(f"{game}_rating") is None:
                    raise ValueError(f"{game}: source rating is missing")
                # Explicit opt-in based on a verified no-play interval. Existing
                # historical ratings always win over a later observation.
                if result[f"{game}_rating"] is None:
                    result[f"{game}_rating"] = source[f"{game}_rating"]
        for game in GAMES:
            if result[f"{game}_rating"] is None:
                raise ValueError(f"{game}: rating missing for {when}; complete backfill requires a verified rating source")
        changes.append(result)
    digest = hashlib.sha256(json.dumps(
        {"plan": plan, "before": [dict(r) for r in rows]},
        default=str, sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()
    return changes, digest


async def repair(plan, apply=False, expected_digest=None):
    baseline, end = validate_plan(plan)
    conn = await connect_db()
    try:
        async with conn.transaction():
            # Serializes with both daily scraper and Refresh writes, including inserts.
            await conn.execute("LOCK TABLE public.daily_play IN SHARE ROW EXCLUSIVE MODE")
            rows = await conn.fetch(
                "SELECT * FROM public.daily_play WHERE play_date BETWEEN $1 AND $2 ORDER BY play_date",
                baseline, end,
            )
            changes, digest = build_repair(plan, rows)
            print("Before: " + json.dumps([dict(r) for r in rows], default=str))
            print("Proposed: " + json.dumps(changes, default=str))
            print("REPAIR_SHA256=" + digest)
            if not apply:
                print("DRY RUN: no rows changed")
                return
            if digest != expected_digest:
                raise ValueError("Database/plan changed since dry-run; refusing repair")
            for row in changes:
                await conn.execute("""
                    INSERT INTO public.daily_play
                        (play_date, maimai_play_count, chunithm_play_count,
                         maimai_cumulative, chunithm_cumulative, maimai_rating,
                         chunithm_rating, scrape_failed, failure_reason)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,NULL)
                    ON CONFLICT (play_date) DO UPDATE SET
                        maimai_play_count=EXCLUDED.maimai_play_count,
                        chunithm_play_count=EXCLUDED.chunithm_play_count,
                        maimai_cumulative=EXCLUDED.maimai_cumulative,
                        chunithm_cumulative=EXCLUDED.chunithm_cumulative,
                        maimai_rating=COALESCE(daily_play.maimai_rating, EXCLUDED.maimai_rating),
                        chunithm_rating=COALESCE(daily_play.chunithm_rating, EXCLUDED.chunithm_rating),
                        scrape_failed=FALSE, failure_reason=NULL
                """, row["play_date"], row["maimai_play_count"], row["chunithm_play_count"],
                    row["maimai_cumulative"], row["chunithm_cumulative"],
                    row["maimai_rating"], row["chunithm_rating"])
            after = await conn.fetch(
                "SELECT * FROM public.daily_play WHERE play_date > $1 AND play_date <= $2 ORDER BY play_date",
                baseline, end,
            )
            for actual, desired in zip(after, changes, strict=True):
                if any(actual[key] != value for key, value in desired.items()):
                    raise RuntimeError("Repair verification failed; rolling back")
            print("Verified: " + json.dumps([dict(r) for r in after], default=str))
        print("COMMITTED: repaired dates and cumulative totals verified")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(repair(json.loads(os.environ["REPAIR_PLAN"]),
                       os.environ.get("REPAIR_APPLY") == "true",
                       os.environ.get("REPAIR_EXPECTED_SHA256")))
