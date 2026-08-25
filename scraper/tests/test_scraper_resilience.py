import pytest

import play_counter.scraper as scraper


class FakePage:
    def __init__(self, url: str, body: str):
        self.url = url
        self.body = body

    async def inner_text(self, selector: str) -> str:
        assert selector == "body"
        return self.body


class FakeResponse:
    def __init__(self, status: int):
        self.status = status


def test_retry_delay_uses_bounded_exponential_backoff():
    assert [scraper.get_retry_delay(attempt) for attempt in range(1, 4)] == [
        15,
        30,
        60,
    ]


@pytest.mark.parametrize(
    ("url", "game", "expected"),
    [
        (
            "https://maimaidx-eng.com/maimai-mobile/home/",
            "maimai",
            "authenticated",
        ),
        (
            "https://lng-tgk-aime-gw.am-all.net/common_auth/login?site_id=maimaidxex",
            "maimai",
            "login_required",
        ),
        (
            "https://maimaidx-eng.com/maimai-mobile/?ssid=temporary",
            "maimai",
            "unexpected",
        ),
    ],
)
def test_classify_session_url(url, game, expected):
    assert scraper.classify_session_url(url, game) == expected


def test_redact_sensitive_url_removes_ssid():
    redacted = scraper.redact_sensitive_url(
        "https://maimaidx-eng.com/maimai-mobile/?ssid=secret-token&foo=bar"
    )

    assert "secret-token" not in redacted
    assert "ssid=[REDACTED]" in redacted
    assert "foo=bar" in redacted


def test_redact_sensitive_text_removes_credentials(monkeypatch):
    monkeypatch.setattr(scraper, "SEGA_USERNAME", "account@example.com")
    monkeypatch.setattr(scraper, "SEGA_PASSWORD", "super-secret")

    redacted = scraper.redact_sensitive_text(
        "account@example.com super-secret ?ssid=session-secret"
    )

    assert "account@example.com" not in redacted
    assert "super-secret" not in redacted
    assert "session-secret" not in redacted
    assert redacted.count("[REDACTED]") == 3


@pytest.mark.asyncio
async def test_capture_failure_details_keeps_useful_safe_response_text():
    page = FakePage(
        "https://maimaidx-eng.com/maimai-mobile/?ssid=session-secret",
        "404 Not Found nginx",
    )

    details = await scraper.capture_failure_details(page, FakeResponse(404))

    assert "status: 404" in details
    assert "404 Not Found nginx" in details
    assert "session-secret" not in details
    assert "ssid=[REDACTED]" in details
