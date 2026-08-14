#!/usr/bin/env bash
# Scrape maimai player data locally via Docker.
# Outputs: scripts/maimai-player.json
#
# Usage:
#   bash scripts/scrape-maimai.sh

set -euo pipefail
cd "$(dirname "$0")/.."

# Load credentials from scraper/.env
if [[ ! -f scraper/.env ]]; then
  echo "Error: scraper/.env not found"
  exit 1
fi
source scraper/.env

if [[ -z "${SEGA_USERNAME:-}" || -z "${SEGA_PASSWORD:-}" ]]; then
  echo "Error: SEGA_USERNAME or SEGA_PASSWORD not set in scraper/.env"
  exit 1
fi

MAIMAI_VERSION=$(node -e '
const fs = require("fs");
const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const version = config.game_versions?.maimai?.scraper;
if (typeof version !== "string" || version.length === 0) process.exit(1);
process.stdout.write(version);
') || {
  echo "Error: config.json is missing game_versions.maimai.scraper"
  exit 1
}

OUT_DIR="$(pwd)/scripts/outputs"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "Running maimai scraper for $MAIMAI_VERSION..."
docker run --rm \
  -v "$OUT_DIR:/app/outputs" \
  -e "USERNAME=$SEGA_USERNAME" \
  -e "PASSWORD=$SEGA_PASSWORD" \
  -e "VERSION=$MAIMAI_VERSION" \
  -e TZ=Asia/Bangkok \
  -e LANG=th_TH.UTF-8 \
  ghcr.io/leomotors/maimai-scraper:v1

echo ""
echo "Docker output:"
ls -la "$OUT_DIR"

# Keep only full*.json, remove everything else
find "$OUT_DIR" -type f ! -name 'full*.json' -delete
find "$OUT_DIR" -type d -empty -delete 2>/dev/null || true

echo ""
echo "After cleanup (full*.json only):"
ls -la "$OUT_DIR"

# Copy the first full*.json to scripts/maimai-player.json
FULL_FILE=$(find "$OUT_DIR" -name 'full*.json' -type f | head -1)
if [[ -z "$FULL_FILE" ]]; then
  echo "Error: no full*.json found in output"
  exit 1
fi

cp "$FULL_FILE" scripts/maimai-player.json
rm -rf "$OUT_DIR"

echo ""
echo "Saved to scripts/maimai-player.json"
