import asyncio
import sys
from datetime import datetime, timezone, timedelta

from play_counter.config import CONFIG
from play_counter.attribution import daily_count
from play_counter.daily_play_notifier import send_notification
from play_counter.db import get_previous_cumulative, get_previous_observation, get_previous_rating, get_rating_on, init_schema, test_db_connection, upsert_daily_play
from play_counter.reports.monthly import generate_monthly_report
from play_counter.reports.weekly import generate_weekly_report
from play_counter.scraper import fetch_player_data


async def main():
    # Backfill mode: fix a past failed day
    if "--backfill" in sys.argv:
        idx = sys.argv.index("--backfill")
        target_date = sys.argv[idx + 1]

        await init_schema()

        maimai_cumulative = await get_previous_cumulative("maimai", target_date)
        chunithm_cumulative = await get_previous_cumulative("chunithm", target_date)
        maimai_rating = await get_previous_rating("maimai", target_date)
        chunithm_rating = await get_previous_rating("chunithm", target_date)

        await upsert_daily_play(
            target_date,
            0,                   # maimai_play_count
            0,                   # chunithm_play_count
            maimai_cumulative,
            chunithm_cumulative,
            maimai_rating,
            chunithm_rating,
            scrape_failed=True,
            failure_reason="manual backfill — carried forward from previous day",
        )
        print(f"Backfilled {target_date} with carried-forward values.")
        return

    # Quick Docker health check: python main.py --test
    if "--test" in sys.argv:
        print("[TEST] Docker health check...")
        print(f"   Timezone:  {datetime.now().astimezone().tzinfo}")
        print(f"   Python:    {sys.version.split()[0]}")
        print(f"   Timestamp: {datetime.now():%Y-%m-%d %H:%M:%S}")

        # Test Playwright browser
        try:
            from playwright.async_api import async_playwright

            async with async_playwright() as p:
                browser = await p.firefox.launch(headless=True)
                await browser.close()
            print("   Playwright: [OK] Firefox OK")
        except Exception as e:
            print(f"   Playwright: [ERROR] {e}")
            sys.exit(1)

        # Test DB connections
        db_ok = await test_db_connection()
        if db_ok:
            print("\n[OK] All systems go! Docker setup is working.")
        else:
            print("\n[ERROR] Database connection failed.")
            sys.exit(1)
        return

    BKK = timezone(timedelta(hours=7))
    today = datetime.now(BKK)
    today_str = today.strftime("%Y-%m-%d")

    # Test DB connection first
    if not await test_db_connection():
        print("Exiting: Database is unreachable.")
        sys.exit(1)

    await init_schema()

    # Fetch all player data in one browser session per game.
    # maimai returns both cumulative count and record-page daily count.
    tasks = {
        game: fetch_player_data(game, today_str)
        for game, enable in CONFIG.items()
        if enable
    }
    player_data_results = await asyncio.gather(*tasks.values())
    player_data = dict(zip(tasks.keys(), player_data_results))

    # Extract cumulative, ratings, and failure info
    cumulative = {game: data["cumulative"] for game, data in player_data.items()}
    ratings = {game: data["rating"] for game, data in player_data.items()}
    scrape_failed = any(data.get("failed", False) for data in player_data.values())
    failure_reason = " | ".join(
        f"{game}: {data.get('failure_reason', 'unknown')}"
        for game, data in player_data.items()
        if data.get("failed", False)
    )

    # Carry forward previous values only for games that individually failed
    for game, data in player_data.items():
        if data.get("failed", False):
            cumulative[game] = await get_previous_cumulative(game, today_str)
            if ratings[game] is None or ratings[game] == 0:
                # Keep a rating already recorded today (e.g. typed in the day editor).
                kept = await get_rating_on(game, today_str)
                ratings[game] = kept if kept is not None else await get_previous_rating(game, today_str)

    # Preserve the observation date: a recovery delta can cover several days.
    new_plays = {}
    attribution_errors = []
    for game, data in player_data.items():
        if data.get("failed", False):
            new_plays[game] = None
            continue
        previous = await get_previous_observation(game, today_str)
        exact = (data.get("record_play_count")
                 if game == "maimai" and data.get("record_play_count_complete")
                 else None)
        new_plays[game], reason = daily_count(previous, today_str, cumulative[game], exact)
        if reason:
            attribution_errors.append(f"{game}: {reason}")
        print(f"[OK] {game} daily plays: {new_plays[game]}")
    failure_reason = " | ".join(filter(None, [failure_reason, *attribution_errors]))

    # Insert with ratings and failure info
    await upsert_daily_play(
        today_str,
        new_plays.get("maimai") if "maimai" in cumulative else None,
        new_plays.get("chunithm") if "chunithm" in cumulative else None,
        cumulative.get("maimai") if "maimai" in cumulative else None,
        cumulative.get("chunithm") if "chunithm" in cumulative else None,
        ratings.get("maimai"),
        ratings.get("chunithm"),
        scrape_failed=scrape_failed,
        failure_reason=failure_reason or None,
    )

    for game in ("chunithm", "maimai"):
        data = player_data.get(game)
        if (data is not None and not data.get("failed", False)
                and new_plays.get(game) is not None):
            if not send_notification(game, new_plays.get(game, 0)):
                raise RuntimeError(f"{game}: daily notification delivery failed")

    if scrape_failed or attribution_errors:
        print(
            "[ERROR] Scrape or daily attribution incomplete: " + failure_reason
        )
        raise SystemExit(1)

    if today.day == 1:
        await generate_monthly_report()
    if today.weekday() == 0:
        await generate_weekly_report()


if __name__ == "__main__":
    asyncio.run(main())
