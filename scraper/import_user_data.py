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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import asyncpg
from pydantic import BaseModel, ValidationError

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


async def import_user_data(data: dict[str, Any]) -> dict[str, Any]:
    """
    Import user data into the user_scores table.
    
    Args:
        data: Parsed JSON data from chuumai-tools output
        
    Returns:
        dict with 'game' and 'scraped_at' keys
    """
    game = detect_game(data)
    scraped_at = datetime.now(timezone.utc)
    
    conn = await connect_db()
    try:
        await conn.execute(
            """
            INSERT INTO public.user_scores (game, scraped_at, data)
            VALUES ($1, $2, $3)
            """,
            game,
            scraped_at,
            json.dumps(data),
        )
        print(f"[OK] Inserted {game} snapshot at {scraped_at.isoformat()}")
        return {"game": game, "scraped_at": scraped_at}
    finally:
        await conn.close()


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
    
    print(f"Found {len(json_files)} JSON file(s)")
    
    imported_count = 0
    for json_file in json_files:
        try:
            print(f"Processing {json_file.name}...")
            data = read_json_file(json_file)
            await import_user_data(data)
            imported_count += 1
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
