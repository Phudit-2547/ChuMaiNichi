import json
from pathlib import Path

from envparse import env

# Only read .env file if it exists on disk.
# In Docker, env vars are injected via docker-compose env_file — no .env file needed.
_env_path = Path(__file__).resolve().parent.parent / ".env"
if _env_path.is_file():
    env.read_envfile(str(_env_path))

DISCORD_WEBHOOK_URL = env.str("DISCORD_WEBHOOK_URL", default="")
WEEKREPORT_WEBHOOK = env.str("WEEKREPORT_WEBHOOK", default=DISCORD_WEBHOOK_URL)
DATABASE_URL = env.str("DATABASE_URL", default="")
SEGA_USERNAME = env.str("SEGA_USERNAME", default="")
SEGA_PASSWORD = env.str("SEGA_PASSWORD", default="")

_config_json_path = Path(__file__).resolve().parent.parent.parent / "config.json"
_config_json: dict = json.loads(_config_json_path.read_text())
_games_list: list[str] = _config_json["games"]
CONFIG = {"maimai": "maimai" in _games_list, "chunithm": "chunithm" in _games_list}
NOTIFICATION_CONFIG = _config_json.get(
    "discord_notification",
    {
        "default": {
            "username": "毎日みのり",
            "avatar_url": "https://pbs.twimg.com/media/GjfKtY6acAIo5Ga?format=jpg",
        },
        "weekly": {
            "username": "毎週みのり",
            "avatar_url": "https://cdn.discordapp.com/attachments/917303163470635018/1381649633981239407/GCaygD2XUAAFTrl.png",
        },
        "maimai": {
            "username": "毎日みのり",
            "avatar_url": "https://cdn.discordapp.com/attachments/917303163470635018/1383463722483449859/3a9fa41c9b0ef014.png",
            "message_template": "**{game}**: You played **{new_plays}** credit(s) today!",
            "emoji": "🎵",
        },
        "chunithm": {
            "username": "毎日みのり",
            "avatar_url": "https://cdn.discordapp.com/attachments/917303163470635018/1383463722483449859/3a9fa41c9b0ef014.png",
            "message_template": "**{game}**: You played **{new_plays}** credit(s) today!",
            "emoji": "🎶",
        },
    },
)
