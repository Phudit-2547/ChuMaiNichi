import asyncio
import json
import re
import time
from pathlib import Path
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlsplit

BKK = timezone(timedelta(hours=7))

import requests
from playwright.async_api import async_playwright

from play_counter.config import SEGA_PASSWORD, SEGA_USERNAME
from play_counter.utils.constants import DISCORD_WEBHOOK_URL, HOME_URLS, LOGIN_URLS

MAX_RETRIES = 3
RETRY_BASE_DELAY_SECONDS = 15
AIME_AUTH_HOST = "lng-tgk-aime-gw.am-all.net"
MAIMAI_PLAYER_DATA_URL = "https://maimaidx-eng.com/maimai-mobile/playerData/"
MAIMAI_RECORD_URL = "https://maimaidx-eng.com/maimai-mobile/record/"
MAIMAI_PLAYLOG_PAGE_SIZE = 50
MAIMAI_PLAYLOG_TEXT_RE = re.compile(
    r"(TRACK\s+\d+)\s+(\d{4}/\d{2}/\d{2})\s+\d{2}:\d{2}"
)

# Cookie storage path (local only - users manage their own)
COOKIES_DIR = Path("cookies")
COOKIES_DIR.mkdir(exist_ok=True)

# Trace/screenshot storage path
TRACES_DIR = Path("traces")
TRACES_DIR.mkdir(exist_ok=True)


def get_cookies_path(game: str) -> Path:
    """Get path to cookies file for a game."""
    return COOKIES_DIR / f"{game}_state.json"


def get_retry_delay(attempt: int) -> int:
    """Return exponential retry delay after a failed attempt."""
    if attempt < 1:
        raise ValueError("attempt must be at least 1")
    return RETRY_BASE_DELAY_SECONDS * (2 ** (attempt - 1))


def redact_sensitive_url(url: str) -> str:
    """Redact session-like query values before logging or persisting them."""
    return re.sub(
        r"(?i)([?&]ssid=)[^&#\s]+",
        r"\1[REDACTED]",
        url,
    )


def redact_sensitive_text(value: str) -> str:
    """Redact known credentials and session query values from diagnostics."""
    redacted = redact_sensitive_url(value)
    for secret in (SEGA_USERNAME, SEGA_PASSWORD):
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    return redacted


def classify_session_url(url: str, game: str) -> str:
    """Classify the result of navigating through the Aime login entrypoint."""
    if url.startswith(HOME_URLS[game]):
        return "authenticated"
    if urlsplit(url).hostname == AIME_AUTH_HOST:
        return "login_required"
    return "unexpected"


def send_discord_notification(
    game: str, failure_reason: str, diagnostic_path: str | None = None
) -> None:
    """Send notification to Discord when scraping fails."""
    if not DISCORD_WEBHOOK_URL:
        print(
            f"[SKIP] Skipping failure notification for {game} — "
            "DISCORD_WEBHOOK_URL not configured"
        )
        return

    diagnostic_info = (
        f"\n[DIAGNOSTIC] Saved: {diagnostic_path}" if diagnostic_path else ""
    )
    safe_reason = redact_sensitive_text(failure_reason)

    payload = {
        "content": (
            "[FAIL] **Scraping Failed** [FAIL]\n\n"
            f"**Game:** {game}\n"
            f"**Reason:** {safe_reason}\n"
            f"**All {MAX_RETRIES} attempts exhausted.**"
            f"{diagnostic_info}"
        )
    }

    try:
        response = requests.post(DISCORD_WEBHOOK_URL, json=payload, timeout=10)
        if response.status_code == 204:
            print("[OK] Discord notification sent successfully")
        else:
            print(
                "[WARN] Failed to send Discord notification: "
                f"{response.status_code}"
            )
    except Exception as e:
        print(
            "[WARN] Error sending Discord notification: "
            f"{redact_sensitive_text(str(e))}"
        )


async def login_with_sega(page, game: str) -> None:
    """Perform SEGA ID login."""
    response = await page.goto(LOGIN_URLS[game], wait_until="domcontentloaded")
    session_state = classify_session_url(page.url, game)

    if session_state == "authenticated":
        return
    if session_state != "login_required":
        details = await capture_failure_details(page, response)
        raise RuntimeError(f"portal_unavailable | {details}")

    await page.locator("span.c-button--openid--segaId").click()
    await page.locator("#sid").fill(SEGA_USERNAME)
    await page.locator("#password").fill(SEGA_PASSWORD)

    if game == "maimai":
        await page.locator("label.c-form__label--bg.agree input#agree").click()
        await page.wait_for_timeout(1000)

        for i in range(3):
            is_checked = await page.locator(
                "label.c-form__label--bg.agree input#agree"
            ).is_checked()
            if is_checked:
                break
            print(f"[RETRY] Checkbox unchecked, clicking again... (attempt {i + 1})")
            await page.locator(
                "label.c-form__label--bg.agree input#agree"
            ).click()
            await page.wait_for_timeout(500)

    elif game == "chunithm":
        await page.get_by_text("Agree to the terms of use for Aime service").click()
        await page.wait_for_timeout(1000)

        for i in range(3):
            is_checked = await page.locator(
                "label.c-form__label--bg:not(.agree) input#agree"
            ).is_checked()
            if is_checked:
                break
            print(f"[RETRY] Checkbox unchecked, clicking again... (attempt {i + 1})")
            await page.get_by_text(
                "Agree to the terms of use for Aime service"
            ).click()
            await page.wait_for_timeout(500)

    await page.wait_for_selector("button#btnSubmit:not([disabled])", timeout=10000)
    await page.locator("button#btnSubmit").click()
    print("[OK] Login button clicked successfully")


async def is_logged_in(page, game: str) -> bool:
    """Return whether cached cookies reached home; reject unexpected responses."""
    response = await page.goto(LOGIN_URLS[game], wait_until="domcontentloaded")
    session_state = classify_session_url(page.url, game)

    if session_state == "authenticated":
        print("[RETRY] Using cached session (already logged in)")
        return True
    if session_state == "login_required":
        return False

    details = await capture_failure_details(page, response)
    raise RuntimeError(f"portal_unavailable | {details}")


async def save_cookies(context, game: str) -> None:
    """Save cookies to file for future use."""
    cookies = await context.cookies()
    cookies_path = get_cookies_path(game)
    with open(cookies_path, "w") as f:
        json.dump(cookies, f)
    print(f"[SAVE] Saved cookies to {cookies_path}")


async def load_cookies(context, game: str) -> bool:
    """Load cookies from file. Returns True if cookies were loaded."""
    cookies_path = get_cookies_path(game)
    if not cookies_path.exists():
        return False
    try:
        with open(cookies_path) as f:
            cookies = json.load(f)
        await context.add_cookies(cookies)
        print(f"[LOAD] Loaded cookies from {cookies_path}")
        return True
    except Exception as e:
        print(
            "[WARN] Failed to load cookies: "
            f"{redact_sensitive_text(str(e))}"
        )
        return False


async def capture_failure_details(page, response=None) -> str:
    """Capture a redacted URL, HTTP status, and bounded page text."""
    url = "N/A"
    status = "unknown"
    page_text = "(could not capture page text)"

    if page is not None:
        try:
            url = redact_sensitive_url(page.url)
        except Exception:
            pass
        try:
            page_text = await page.inner_text("body")
            page_text = redact_sensitive_text(page_text.strip()[:500])
        except Exception:
            pass

    if response is not None:
        try:
            status = str(response.status)
        except Exception:
            pass

    return f"url: {url} | status: {status} | body: {page_text}"


async def save_failure_diagnostics(
    context,
    game: str,
    attempt: int,
    failure_reason: str,
    tracing_started: bool,
) -> str | None:
    """Persist sanitized failure details and a post-auth trace when available."""
    timestamp = datetime.now(BKK).strftime("%Y%m%d_%H%M%S_%f")
    stem = f"{game}_failure_{timestamp}_attempt{attempt}"
    report_path = TRACES_DIR / f"{stem}.txt"
    safe_reason = redact_sensitive_text(failure_reason)

    try:
        report_path.write_text(f"{safe_reason}\n", encoding="utf-8")
    except Exception as e:
        print(
            "[WARN] Failed to save diagnostic report: "
            f"{redact_sensitive_text(str(e))}"
        )
        return None

    if tracing_started and context is not None:
        trace_path = TRACES_DIR / f"{stem}.zip"
        try:
            await context.tracing.stop(path=str(trace_path))
        except Exception as e:
            print(
                "[WARN] Failed to save post-auth trace: "
                f"{redact_sensitive_text(str(e))}"
            )

    return str(report_path)


async def stop_success_trace(context, tracing_started: bool) -> None:
    """Stop and discard a successful post-auth trace."""
    if not tracing_started:
        return
    try:
        await context.tracing.stop()
    except Exception as e:
        print(
            "[WARN] Failed to stop successful trace: "
            f"{redact_sensitive_text(str(e))}"
        )


def _coerce_bkk_date(target_date: date | datetime | str | None) -> date:
    """Return the BKK date used for daily playlog matching."""
    if target_date is None:
        return datetime.now(BKK).date()
    if isinstance(target_date, datetime):
        if target_date.tzinfo is None:
            return target_date.date()
        return target_date.astimezone(BKK).date()
    if isinstance(target_date, date):
        return target_date
    return datetime.strptime(target_date, "%Y-%m-%d").date()


def count_maimai_record_plays(
    playlog_texts: list[str], target_date: date | datetime | str | None = None
) -> dict:
    """Count maimai credits from playlog text rows.

    maimai's record page lists one row per track. A credit/session starts at
    TRACK 01, so daily play count is the number of TRACK 01 rows for the date.
    """
    target = _coerce_bkk_date(target_date)
    target_key = target.strftime("%Y/%m/%d")

    parsed_dates = []
    play_count = 0
    track_count = 0

    for text in playlog_texts:
        normalized = re.sub(r"\s+", " ", text.strip())
        match = MAIMAI_PLAYLOG_TEXT_RE.search(normalized)
        if not match:
            continue

        track_label, date_text = match.groups()
        entry_date = datetime.strptime(date_text, "%Y/%m/%d").date()
        parsed_dates.append(entry_date)

        if date_text != target_key:
            continue

        track_count += 1
        if track_label == "TRACK 01":
            play_count += 1

    # The page shows the latest 50 rows. Once we see any older date, all rows
    # for the target date are present. Fewer than 50 rows also means no truncation.
    complete = bool(parsed_dates) and (
        len(parsed_dates) < MAIMAI_PLAYLOG_PAGE_SIZE
        or any(entry_date < target for entry_date in parsed_dates)
    )

    return {
        "play_count": play_count,
        "track_count": track_count,
        "complete": complete,
        "entry_count": len(parsed_dates),
        "target_date": target.strftime("%Y-%m-%d"),
    }


async def extract_maimai_record_play_count(
    page, target_date: date | datetime | str | None = None
) -> dict:
    """Navigate to maimai record page and count daily credits from playlog rows."""
    await page.goto(MAIMAI_RECORD_URL, wait_until="domcontentloaded")
    await page.wait_for_selector(".playlog_top_container", timeout=10000)
    playlog_texts = await page.locator(
        ".playlog_top_container .sub_title"
    ).all_inner_texts()
    return count_maimai_record_plays(playlog_texts, target_date)


async def fetch_player_data(
    game: str, target_date: date | datetime | str | None = None
) -> dict:
    """
    Log into the game website and retrieve rating and play-count data.

    Cached cookies are replaced only after the portal confirms the game's
    authenticated home page. Unexpected callback responses are treated as
    transient upstream failures rather than expired sessions.
    """
    start_time = time.perf_counter()

    if not SEGA_USERNAME or not SEGA_PASSWORD:
        default_rating = 0 if game == "maimai" else 0.0
        print("[WARN] SEGA credentials are not configured. Returning default values.")
        return {
            "rating": default_rating,
            "cumulative": 0,
            "record_play_count": None,
            "record_play_count_complete": False,
            "failed": True,
            "failure_reason": "credentials_not_configured",
        }

    last_failure_reason = None
    last_diagnostic_path = None

    for attempt in range(1, MAX_RETRIES + 1):
        browser = None
        context = None
        page = None
        tracing_started = False
        attempt_failure_reason = None
        attempt_diagnostic_path = None
        last_response = None
        using_cached_session = False

        try:
            async with async_playwright() as p:
                browser = await p.firefox.launch(headless=True)
                context = await browser.new_context()
                page = await context.new_page()

                def remember_navigation_response(response) -> None:
                    nonlocal last_response
                    try:
                        if response.request.is_navigation_request():
                            last_response = response
                    except Exception:
                        pass

                page.on("response", remember_navigation_response)

                try:
                    login_start = time.perf_counter()
                    cookies_path = get_cookies_path(game)
                    cookies_loaded = await load_cookies(context, game)

                    if cookies_loaded and await is_logged_in(page, game):
                        using_cached_session = True
                        print(f"[OK] Using cached session for {game}")
                    else:
                        using_cached_session = False
                        if cookies_loaded:
                            print(
                                "[RETRY] Cached session requires fresh login; "
                                "preserving it until replacement succeeds..."
                            )
                        else:
                            print("[RETRY] No cached cookies found, logging in...")
                        await login_with_sega(page, game)

                    login_time = time.perf_counter() - login_start

                    print(f"[RETRY] Waiting for {game} home page...")
                    try:
                        await page.wait_for_url(
                            lambda url: url.startswith(HOME_URLS[game]),
                            timeout=30000,
                        )
                    except Exception as e:
                        details = await capture_failure_details(page, last_response)
                        raise RuntimeError(
                            f"home_page_timeout | {details}"
                        ) from e

                    # Persist only a confirmed authenticated session.
                    await save_cookies(context, game)

                    # Login traces can contain entered credentials. Trace only the
                    # authenticated scraping phase; auth failures use the sanitized
                    # text diagnostic written below.
                    try:
                        await context.tracing.start(
                            screenshots=True,
                            snapshots=True,
                            sources=False,
                        )
                        tracing_started = True
                    except Exception as e:
                        print(
                            "[WARN] Failed to start post-auth trace: "
                            f"{redact_sensitive_text(str(e))}"
                        )

                    print(f"[RETRY] Extracting {game} rating from home page...")

                    if game == "chunithm":
                        rating_block = page.locator(".player_rating_num_block")
                        images = await rating_block.locator("img").all()

                        rating_str = ""
                        for img in images:
                            src = await img.get_attribute("src")
                            if not src:
                                continue

                            filename = src.split("/")[-1]

                            if "comma" in filename:
                                rating_str += "."
                            elif "rating_" in filename:
                                digit = filename.split("_")[-1].replace(".png", "")
                                rating_str += str(int(digit))

                        rating = float(rating_str) if rating_str else 0.0

                    elif game == "maimai":
                        rating_text = await page.locator(".rating_block").inner_text()
                        rating = int(rating_text) if rating_text.isdigit() else 0
                    else:
                        raise ValueError(f"Unsupported game: {game!r}")

                    print(f"[OK] {game} rating: {rating}")
                    print(f"[RETRY] Navigating to {game} play data page...")

                    record_stats = None
                    if game == "chunithm":
                        await page.goto(
                            f"{HOME_URLS[game]}playerData",
                            wait_until="domcontentloaded",
                        )
                        play_count_text = await page.locator(
                            "div.user_data_play_count div.user_data_text"
                        ).inner_text()
                        cumulative = (
                            int(play_count_text) if play_count_text.isdigit() else 0
                        )

                    elif game == "maimai":
                        await page.goto(
                            MAIMAI_PLAYER_DATA_URL,
                            wait_until="domcontentloaded",
                        )
                        play_count_text = await page.locator(
                            "div.m_5.m_b_5.t_r.f_12"
                        ).inner_text()
                        match = re.search(
                            r"maimaiDX total play count：([\d,]+)",
                            play_count_text,
                        )
                        cumulative = (
                            int(match.group(1).replace(",", "")) if match else 0
                        )

                        try:
                            record_stats = await extract_maimai_record_play_count(
                                page, target_date
                            )
                            print(
                                "[OK] maimai record page: "
                                f"{record_stats['play_count']} credit(s), "
                                f"{record_stats['track_count']} track(s), "
                                f"complete={record_stats['complete']} "
                                f"for {record_stats['target_date']}"
                            )
                        except Exception as e:
                            print(
                                "[WARN] maimai record page count failed; "
                                "using cumulative delta only: "
                                f"{redact_sensitive_text(str(e))}"
                            )

                    await save_cookies(context, game)
                    await stop_success_trace(context, tracing_started)
                    tracing_started = False

                    total_time = time.perf_counter() - start_time
                    session_type = "cached" if using_cached_session else "fresh login"
                    print(
                        f"[OK] [{session_type}] {game} done in {total_time:.2f}s "
                        f"(login: {login_time:.2f}s) - "
                        f"Rating: {rating}, Cumulative: {cumulative}"
                    )
                    return {
                        "rating": rating,
                        "cumulative": cumulative,
                        "record_play_count": (
                            record_stats["play_count"] if record_stats else None
                        ),
                        "record_play_count_complete": (
                            record_stats["complete"] if record_stats else False
                        ),
                        "failed": False,
                        "failure_reason": None,
                    }

                except Exception as e:
                    details = await capture_failure_details(page, last_response)
                    safe_error = redact_sensitive_text(str(e))
                    attempt_failure_reason = f"{type(e).__name__}: {safe_error}"
                    if details not in attempt_failure_reason:
                        attempt_failure_reason += f" | {details}"

                    attempt_diagnostic_path = await save_failure_diagnostics(
                        context,
                        game,
                        attempt,
                        attempt_failure_reason,
                        tracing_started,
                    )
                    tracing_started = False

                    if "100106" in attempt_failure_reason:
                        msg = (
                            f"New {game} version detected — go play {game} at "
                            "the arcade to register your Aime card!"
                        )
                        print(f"[SKIP] {msg}")
                        send_discord_notification(
                            game, msg, attempt_diagnostic_path
                        )
                        return {
                            "rating": 0 if game == "maimai" else 0.0,
                            "cumulative": 0,
                            "record_play_count": None,
                            "record_play_count_complete": False,
                            "failed": True,
                            "failure_reason": msg,
                        }

                    raise

        except Exception as e:
            last_failure_reason = attempt_failure_reason or (
                f"{type(e).__name__}: {redact_sensitive_text(str(e))}"
            )
            if attempt_diagnostic_path:
                last_diagnostic_path = attempt_diagnostic_path

            print(f"[WARN] Attempt {attempt} failed")
            print(f"   Details: {last_failure_reason}")

            if attempt < MAX_RETRIES:
                delay = get_retry_delay(attempt)
                print(f"[WAIT] Retrying in {delay} seconds...")
                await asyncio.sleep(delay)
            else:
                total_time = time.perf_counter() - start_time
                print(f"[ERROR] {game} failed after {total_time:.2f}s")
                send_discord_notification(
                    game,
                    last_failure_reason,
                    last_diagnostic_path,
                )
                return {
                    "rating": 0 if game == "maimai" else 0.0,
                    "cumulative": 0,
                    "record_play_count": None,
                    "record_play_count_complete": False,
                    "failed": True,
                    "failure_reason": last_failure_reason,
                }
        finally:
            if context:
                try:
                    await context.close()
                except Exception:
                    pass

            if browser:
                try:
                    await browser.close()
                except Exception:
                    pass


# Backward compatibility wrapper (if needed elsewhere)
async def fetch_cumulative(game: str) -> int:
    """Legacy function - returns only cumulative count"""
    data = await fetch_player_data(game)
    return data["cumulative"]
