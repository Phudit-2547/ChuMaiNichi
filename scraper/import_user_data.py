"""
Import user data from chuumai-tools JSON outputs into the user_scores table.

This script:
1. Scans the outputs/ directory for JSON files
2. Detects game type (maimai or chunithm) from the data structure
3. Inserts JSON payload into user_scores table
4. Prunes old snapshots to keep only the 5 most recent per game

Usage:
    uv run python import_user_data.py [outputs_dir]

Environment:
    DATABASE_URL - PostgreSQL connection string
"""
import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import asyncpg
from pydantic import BaseModel, ValidationError

from play_counter.db import init_schema, upsert_daily_play_single_game

BKK = timezone(timedelta(hours=7))

# ---- Configuration ----
MAX_SNAPSHOTS_PER_GAME = 5


# ---- Pydantic models for validation ----
class MaimaiChart(BaseModel):
    """MAIMAI chart schema (subset of full schema)."""
    title: str
    chartType: str
    difficulty: str
    score: float
    dxScore: float | None = None
    dxScoreMax: float | None = None


class ChunithmChart(BaseModel):
    """CHUNITHM chart schema (subset of full schema)."""
    id: int | None = None
    title: str
    difficulty: str
    score: float
    clearMark: str | None = None
    fc: bool = False
    aj: bool = False
    fullChain: int | None = None  # Chunithm specific


class MaimaiProfile(BaseModel):
    """MAIMAI profile schema."""
    characterImage: str
    honorText: str
    honorRarity: str
    playerName: str
    rating: int
    star: int
    lastPlayed: str


class ChunithmProfile(BaseModel):
    """CHUNITHM profile schema."""
    characterImage: str
    honorText: str
    honorRarity: str
    playerName: str
    rating: float
    overpowerValue: float | None = None
    overpowerPercent: float | None = None
    lastPlayed: str


class ImportedData(BaseModel):
    """Full imported data structure."""
    profile: dict
    best: list[dict]
    current: list[dict]
    allRecords: list[dict] | None = None
    history: list[dict] | None = None
    hidden: list[dict] | None = None


# ---- Database functions ----
MISSING_DATABASE_URL_MESSAGE = (
    "DATABASE_URL is not configured. Set it in environment variables."
)


async def connect_db():
    """Create a database connection."""
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError(MISSING_DATABASE_URL_MESSAGE)
    return await asyncpg.connect(database_url)


async def import_user_data(data: dict[str, Any], game: str) -> dict[str, Any]:
    """
    Import user data into the user_scores table.

    Args:
        data: Parsed JSON data from chuumai-tools output
        game: 'maimai' or 'chunithm'

    Returns:
        dict with 'game' and 'scraped_at' keys
    """
    # Naive Asia/Bangkok wall-clock matches the TIMESTAMP column and keeps
    # scraped_at consistent with daily_play.play_date (also BKK-local).
    scraped_at = datetime.now(BKK).replace(tzinfo=None)

    conn = await connect_db()
    try:
        await conn.execute(
            """
            INSERT INTO public.user_scores (game, scraped_at, data)
            VALUES ($1, $2, $3)
            ON CONFLICT (game, (scraped_at::date)) DO UPDATE SET
                scraped_at = EXCLUDED.scraped_at,
                data = EXCLUDED.data
            """,
            game,
            scraped_at,
            json.dumps(data),
        )
        print(f"[OK] Upserted {game} snapshot at {scraped_at.isoformat()}")
        return {"game": game, "scraped_at": scraped_at}
    finally:
        await conn.close()


def extract_daily_stats(data: dict[str, Any], game: str) -> tuple[int, float | int] | None:
    """Extract (cumulative_play_count, rating) from profile, or None if missing.

    maimai uses `playCountTotal` + int rating; chunithm uses `playCount` + float rating.
    """
    profile = data.get("profile", {})
    if game == "maimai":
        cumulative = profile.get("playCountTotal")
    else:
        cumulative = profile.get("playCount")
    rating = profile.get("rating")

    if cumulative is None or rating is None:
        return None
    return cumulative, rating


async def prune_old_snapshots(conn: asyncpg.Connection) -> int:
    """
    Prune old snapshots to keep only the MAX_SNAPSHOTS_PER_GAME most recent per game.
    
    Args:
        conn: Database connection
        
    Returns:
        Number of deleted records
    """
    # Find IDs to keep (most recent N per game)
    # This uses a subquery with ROW_NUMBER partitioned by game
    query = """
        WITH ranked AS (
            SELECT id, game,
                   ROW_NUMBER() OVER (PARTITION BY game ORDER BY scraped_at DESC) as rn
            FROM public.user_scores
        )
        SELECT id FROM ranked WHERE rn <= $1
    """
    rows = await conn.fetch(query, MAX_SNAPSHOTS_PER_GAME)
    ids_to_keep = [row["id"] for row in rows]
    
    if not ids_to_keep:
        return 0
    
    # Delete all NOT in the keep list
    delete_query = """
        DELETE FROM public.user_scores
        WHERE id NOT IN (SELECT unnest($1::int[]))
    """
    deleted = await conn.execute(delete_query, ids_to_keep)
    # execute returns 'DELETE N' where N is the number of deleted rows
    deleted_count = int(deleted.split()[-1]) if deleted else 0
    
    if deleted_count > 0:
        print(f"[OK] Pruned {deleted_count} old snapshot(s)")
    
    return deleted_count


# ---- Game detection ----
VALID_GAMES = {"maimai", "chunithm"}


def detect_game(data: dict[str, Any]) -> str:
    """
    Detect game type from the JSON data structure.
    
    Looks for distinguishing fields:
    - Maimai: profile has 'star' field, charts have 'chartType' or 'dxScore'
    - Chunithm: profile has 'overpowerValue', charts have 'fullChain'
    
    Args:
        data: Parsed JSON data
        
    Returns:
        'maimai' or 'chunithm'
        
    Raises:
        ValueError: If game cannot be determined
    """
    profile = data.get("profile", {})
    best = data.get("best", [])
    current = data.get("current", [])
    all_charts = best + current
    
    # Check for maimai indicators
    if "star" in profile:
        return "maimai"
    
    if all_charts:
        first_chart = all_charts[0]
        if "chartType" in first_chart or "dxScore" in first_chart:
            return "maimai"
    
    # Check for chunithm indicators
    if "overpowerValue" in profile or "overpowerPercent" in profile:
        return "chunithm"
    
    if all_charts and "fullChain" in all_charts[0]:
        return "chunithm"
    
    raise ValueError(
        f"Could not detect game from data. "
        f"Profile keys: {list(profile.keys())}, "
        f"Chart keys: {list(all_charts[0].keys()) if all_charts else []}"
    )


# ---- Rating image import ----
IMAGE_EXTS = (".webp", ".png", ".jpg", ".jpeg")
# chuumai-tools doesn't document the exact filename. Match by JSON stem first,
# then fall back to any image whose name contains a game-name hint.
GAME_FILENAME_HINTS = {
    "maimai": ("maimai", "mai"),
    "chunithm": ("chunithm", "chuni"),
}


FRESH_IMAGE_CUSHION_SECONDS = 60


def find_image_for_game(
    outputs_dir: Path, json_path: Path, game: str
) -> Path | None:
    """Locate an image file in outputs_dir that pairs with this JSON/game.

    Strategy: same stem first (e.g. full-maimai-CiRCLE.json → .webp),
    then the newest hint-matching image whose mtime is no older than the
    JSON itself (minus a small clock-skew cushion). The mtime check stops
    us re-importing leftovers from a previous local run.
    """
    for ext in IMAGE_EXTS:
        candidate = outputs_dir / f"{json_path.stem}{ext}"
        if candidate.exists():
            return candidate

    json_mtime = json_path.stat().st_mtime
    threshold = json_mtime - FRESH_IMAGE_CUSHION_SECONDS

    hints = GAME_FILENAME_HINTS.get(game, (game,))
    fresh: list[tuple[float, Path]] = []
    for hint in hints:
        for ext in IMAGE_EXTS:
            for path in outputs_dir.glob(f"*{hint}*{ext}"):
                mtime = path.stat().st_mtime
                if mtime >= threshold:
                    fresh.append((mtime, path))
    if not fresh:
        return None
    # Newest first.
    fresh.sort(key=lambda p: p[0], reverse=True)
    return fresh[0][1]


MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB


def detect_content_type(img_bytes: bytes) -> str | None:
    """Return content-type derived from the file's magic bytes, or None.

    Defends against renamed/garbled files; the chuumai-tools docker write
    is the only legitimate writer to outputs/, but the cost of one byte
    comparison is negligible.
    """
    if len(img_bytes) >= 12 and img_bytes[:4] == b"RIFF" and img_bytes[8:12] == b"WEBP":
        return "image/webp"
    if img_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if img_bytes.startswith(b"\xFF\xD8\xFF"):
        return "image/jpeg"
    return None


async def import_rating_image(image_path: Path, game: str) -> None:
    """Upsert the rating image bytes into user_rating_images (one row per game)."""
    size = image_path.stat().st_size
    if size > MAX_IMAGE_BYTES:
        print(
            f"[WARN] Skipping {image_path.name}: {size} bytes exceeds "
            f"the {MAX_IMAGE_BYTES}-byte cap"
        )
        return

    img_bytes = image_path.read_bytes()
    content_type = detect_content_type(img_bytes)
    if content_type is None:
        print(
            f"[WARN] Skipping {image_path.name}: bytes don't match "
            f"webp/png/jpeg signatures"
        )
        return

    updated_at = datetime.now(BKK).replace(tzinfo=None)

    conn = await connect_db()
    try:
        await conn.execute(
            """
            INSERT INTO public.user_rating_images
                (game, image_data, content_type, updated_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (game) DO UPDATE SET
                image_data = EXCLUDED.image_data,
                content_type = EXCLUDED.content_type,
                updated_at = EXCLUDED.updated_at
            """,
            game,
            img_bytes,
            content_type,
            updated_at,
        )
        print(
            f"[OK] Upserted {game} rating image "
            f"({len(img_bytes)} bytes, {content_type}) from {image_path.name}"
        )
    finally:
        await conn.close()


# ---- File reading ----
def read_json_file(path: Path) -> dict[str, Any]:
    """
    Read and validate a JSON file.
    
    Args:
        path: Path to JSON file
        
    Returns:
        Parsed JSON data
        
    Raises:
        pydantic.ValidationError: If JSON doesn't match expected structure
        ValueError: If JSON is malformed
    """
    with open(path) as f:
        try:
            raw_data = json.load(f)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON in {path}: {e}")
    
    # Validate with Pydantic
    validated = ImportedData.model_validate(raw_data)
    return validated.model_dump()


def scan_outputs_directory(outputs_dir: Path) -> list[Path]:
    """
    Scan outputs directory for JSON files.
    
    Only imports "full" export files (prefixed with "full-") to avoid
    duplicate snapshots from scrapers that produce both standard and full exports.
    
    Args:
        outputs_dir: Path to outputs directory
        
    Returns:
        List of JSON file paths
        
    Raises:
        FileNotFoundError: If directory doesn't exist
    """
    if not outputs_dir.exists():
        raise FileNotFoundError(f"Directory not found: {outputs_dir}")
    
    # Filter to only "full-*.json" files to avoid duplicates
    return sorted(outputs_dir.glob("full-*.json"))


# ---- Main entry point ----
async def main(outputs_dir: Path | None = None):
    """
    Main entry point.
    
    Args:
        outputs_dir: Path to outputs directory. Defaults to ./outputs
    """
    if outputs_dir is None:
        outputs_dir = Path(__file__).parent / "outputs"

    print(f"Scanning {outputs_dir} for JSON files...")
    json_files = list(scan_outputs_directory(outputs_dir))

    if not json_files:
        print("[WARN] No JSON files found in outputs directory")
        return

    await init_schema()
    
    print(f"Found {len(json_files)} JSON file(s)")
    
    today_str = datetime.now(BKK).strftime("%Y-%m-%d")

    imported_count = 0
    for json_file in json_files:
        try:
            print(f"Processing {json_file.name}...")
            data = read_json_file(json_file)
            game = detect_game(data)
            await import_user_data(data, game)
            imported_count += 1

            image_path = find_image_for_game(outputs_dir, json_file, game)
            if image_path is None:
                print(f"[WARN] No rating image found for {game} in {outputs_dir}")
            else:
                try:
                    await import_rating_image(image_path, game)
                except Exception as e:
                    print(f"[ERROR] rating image import failed for {game}: {e}")

            # Refresh today's daily_play row with the latest rating + play count.
            # Column-scoped so maimai and chunithm can refresh independently.
            stats = extract_daily_stats(data, game)
            if stats is None:
                print(f"[WARN] {game} profile missing rating or play count; skipping daily_play")
            else:
                cumulative, rating = stats
                try:
                    await upsert_daily_play_single_game(game, today_str, cumulative, rating)
                except Exception as e:
                    print(f"[ERROR] daily_play upsert failed for {game}: {e}")
        except ValidationError as e:
            print(f"[ERROR] Invalid data in {json_file.name}: {e}")
        except Exception as e:
            print(f"[ERROR] Failed to import {json_file.name}: {e}")
    
    # Prune old snapshots after all imports
    if imported_count > 0:
        print("Pruning old snapshots...")
        conn = await connect_db()
        try:
            await prune_old_snapshots(conn)
        finally:
            await conn.close()
    
    print(f"Done. Imported {imported_count} file(s)")


if __name__ == "__main__":
    import os
    
    # Allow passing outputs directory as argument
    if len(sys.argv) > 1:
        outputs_path = Path(sys.argv[1])
    else:
        outputs_path = Path(__file__).parent / "outputs"
    
    asyncio.run(main(outputs_path))
