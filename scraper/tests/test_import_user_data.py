"""Tests for import_user_data.py"""
import json
import asyncio
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

from import_user_data import (
    detect_game,
    read_json_file,
    scan_outputs_directory,
    import_user_data,
    prune_old_snapshots,
    MAX_SNAPSHOTS_PER_GAME,
)


# ---- Maimai test data ----
MAIMAI_FULL_DATA = {
    "profile": {
        "characterImage": "https://example.com/char.png",
        "honorText": "每日酋长",
        "honorRarity": "gold",
        "playerName": "TestPlayer",
        "rating": 12345,
        "star": 50,
        "lastPlayed": "2026-04-01T12:00:00Z",
    },
    "best": [
        {
            "title": "Test Song",
            "chartType": "dx",
            "difficulty": "master",
            "score": 1005000,
            "dxScore": 10000,
            "dxScoreMax": 15000,
        }
    ],
    "current": [
        {
            "title": "New Song",
            "chartType": "dx",
            "difficulty": "master",
            "score": 990000,
            "dxScore": 5000,
            "dxScoreMax": 10000,
        }
    ],
    "allRecords": [],
    "history": [],
}

MAIMAI_MINIMAL = {
    "profile": {
        "characterImage": "https://example.com/char.png",
        "honorText": "每日酋长",
        "honorRarity": "gold",
        "playerName": "TestPlayer",
        "rating": 12345,
        "star": 50,
        "lastPlayed": "2026-04-01T12:00:00Z",
    },
    "best": [],
    "current": [],
}

# ---- Chunithm test data ----
CHUNITHM_FULL_DATA = {
    "profile": {
        "characterImage": "https://example.com/char.png",
        "characterRarity": "gold",
        "teamName": "TestTeam",
        "teamEmblem": "gold",
        "honorText": "TestHonor",
        "honorRarity": "gold",
        "playerLevel": 100,
        "playerName": "ChuniPlayer",
        "rating": 15000,
        "overpowerValue": 500,
        "overpowerPercent": 10.5,
        "lastPlayed": "2026-04-01T12:00:00Z",
        "playCount": 500,
    },
    "best": [
        {
            "id": 1,
            "title": "Chuni Song",
            "difficulty": "master",
            "score": 1000000,
            "clearMark": "complete",
            "fc": True,
            "aj": False,
        }
    ],
    "current": [
        {
            "id": 2,
            "title": "Chuni New Song",
            "difficulty": "master",
            "score": 990000,
            "clearMark": "complete",
            "fc": False,
            "aj": False,
        }
    ],
    "hidden": [],
    "allRecords": [],
    "history": [],
}


class TestDetectGame:
    """Tests for detect_game function."""

    def test_detect_maimai(self):
        """Maimai profile has 'star' field."""
        assert detect_game(MAIMAI_FULL_DATA) == "maimai"

    def test_detect_maimai_minimal(self):
        """Maimai minimal data also detects correctly."""
        assert detect_game(MAIMAI_MINIMAL) == "maimai"

    def test_detect_chunithm(self):
        """Chunithm profile has 'overpowerValue' field."""
        assert detect_game(CHUNITHM_FULL_DATA) == "chunithm"

    def test_detect_chunithm_by_overpower(self):
        """Chunithm detection relies on overpowerValue presence."""
        data = {
            "profile": {
                "playerName": "Test",
                "rating": 100,
                "overpowerValue": 50,
            },
            "best": [],
            "current": [],
        }
        assert detect_game(data) == "chunithm"

    def test_detect_maimai_by_star(self):
        """Maimai detection relies on star field."""
        data = {
            "profile": {
                "playerName": "Test",
                "rating": 100,
                "star": 5,
            },
            "best": [],
            "current": [],
        }
        assert detect_game(data) == "maimai"

    def test_detect_maimai_by_dxscore(self):
        """Maimai charts have dxScore field."""
        data = {
            "profile": {"playerName": "Test", "rating": 100, "star": 5},
            "best": [{"title": "S", "chartType": "dx", "difficulty": "master", "score": 1000000, "dxScore": 5000}],
            "current": [],
        }
        assert detect_game(data) == "maimai"

    def test_detect_chunithm_by_fullchain(self):
        """Chunithm charts have fullChain field."""
        data = {
            "profile": {"playerName": "Test", "rating": 100, "overpowerValue": 50},
            "best": [{"id": 1, "title": "S", "difficulty": "master", "score": 1000000, "fullChain": 1}],
            "current": [],
        }
        assert detect_game(data) == "chunithm"

    def test_unknown_game_raises(self):
        """Data that matches neither game raises ValueError."""
        data = {
            "profile": {"playerName": "Test", "rating": 100},
            "best": [],
            "current": [],
        }
        with pytest.raises(ValueError, match="Could not detect game"):
            detect_game(data)


class TestReadJsonFile:
    """Tests for read_json_file function."""

    def test_read_valid_file(self, tmp_path):
        """Successfully reads and parses a JSON file."""
        test_file = tmp_path / "test.json"
        test_file.write_text(json.dumps(MAIMAI_FULL_DATA))

        data = read_json_file(test_file)
        assert data["profile"]["playerName"] == "TestPlayer"

    def test_read_invalid_json(self, tmp_path):
        """Invalid JSON raises ValueError."""
        test_file = tmp_path / "bad.json"
        test_file.write_text("not valid json {{{")

        with pytest.raises(ValueError, match="Invalid JSON"):
            read_json_file(test_file)


class TestScanOutputsDirectory:
    """Tests for scan_outputs_directory function."""

    def test_scan_finds_json_files(self, tmp_path):
        """Finds all JSON files in outputs directory."""
        # Create dummy JSON files
        (tmp_path / "maimai_data.json").write_text(json.dumps(MAIMAI_FULL_DATA))
        (tmp_path / "chunithm_data.json").write_text(json.dumps(CHUNITHM_FULL_DATA))
        (tmp_path / "other.txt").write_text("not json")

        files = list(scan_outputs_directory(tmp_path))
        assert len(files) == 2
        assert any("maimai" in str(f) for f in files)
        assert any("chunithm" in str(f) for f in files)

    def test_scan_empty_directory(self, tmp_path):
        """Empty directory returns empty list."""
        files = list(scan_outputs_directory(tmp_path))
        assert files == []

    def test_scan_nonexistent_directory(self):
        """Nonexistent directory raises FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            list(scan_outputs_directory(Path("/nonexistent/path")))


class TestImportUserData:
    """Tests for import_user_data function (DB operations)."""

    @pytest_asyncio.fixture
    async def mock_conn(self):
        """Mock asyncpg connection."""
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={"id": 1})
        conn.execute = AsyncMock()
        conn.close = AsyncMock()
        return conn

    @pytest.mark.asyncio
    async def test_import_maimai_data(self, mock_conn):
        """Successfully imports maimai data."""
        with patch("import_user_data.connect_db", return_value=mock_conn):
            result = await import_user_data(MAIMAI_FULL_DATA)
            
        assert result["game"] == "maimai"
        assert "scraped_at" in result
        mock_conn.execute.assert_called_once()
        
        # Check the INSERT query was called with correct params
        call_args = mock_conn.execute.call_args
        assert "INSERT INTO public.user_scores" in call_args[0][0]

    @pytest.mark.asyncio
    async def test_import_chunithm_data(self, mock_conn):
        """Successfully imports chunithm data."""
        with patch("import_user_data.connect_db", return_value=mock_conn):
            result = await import_user_data(CHUNITHM_FULL_DATA)
            
        assert result["game"] == "chunithm"
        assert "scraped_at" in result
        mock_conn.execute.assert_called_once()


class TestPruneOldSnapshots:
    """Tests for prune_old_snapshots function."""

    @pytest.mark.asyncio
    async def test_prune_keeps_5_most_recent(self):
        """Prune deletes all but 5 most recent records per game."""
        mock_conn = AsyncMock()
        
        # Simulate having 7 maimai records - should keep 5, delete 2
        mock_conn.fetch = AsyncMock(return_value=[
            {"id": 10, "game": "maimai", "scraped_at": "2026-04-07"},
            {"id": 9, "game": "maimai", "scraped_at": "2026-04-06"},
            {"id": 8, "game": "maimai", "scraped_at": "2026-04-05"},
            {"id": 7, "game": "maimai", "scraped_at": "2026-04-04"},
            {"id": 6, "game": "maimai", "scraped_at": "2026-04-03"},
            {"id": 5, "game": "maimai", "scraped_at": "2026-04-02"},
            {"id": 4, "game": "maimai", "scraped_at": "2026-04-01"},
        ])
        mock_conn.execute = AsyncMock(return_value="DELETE 2")
        mock_conn.close = AsyncMock()

        with patch("import_user_data.connect_db", return_value=mock_conn):
            deleted = await prune_old_snapshots(mock_conn)
        
        # Should delete 2 records (7 - 5 = 2)
        assert deleted == 2
        mock_conn.execute.assert_called_once()
        
        # Verify DELETE query structure
        delete_query = mock_conn.execute.call_args[0][0]
        assert "DELETE FROM public.user_scores" in delete_query
        assert "id NOT IN" in delete_query

    @pytest.mark.asyncio
    async def test_prune_keeps_5_per_game(self):
        """Prune keeps 5 most recent per game when under limit."""
        mock_conn = AsyncMock()
        
        # 3 maimai, 4 chunithm = 7 total
        # Both under limit of 5, so nothing should be deleted
        mock_conn.fetch = AsyncMock(return_value=[
            {"id": 10, "game": "maimai", "scraped_at": "2026-04-07"},
            {"id": 9, "game": "maimai", "scraped_at": "2026-04-06"},
            {"id": 8, "game": "maimai", "scraped_at": "2026-04-05"},
            {"id": 7, "game": "chunithm", "scraped_at": "2026-04-07"},
            {"id": 6, "game": "chunithm", "scraped_at": "2026-04-06"},
            {"id": 5, "game": "chunithm", "scraped_at": "2026-04-05"},
            {"id": 4, "game": "chunithm", "scraped_at": "2026-04-04"},
        ])
        mock_conn.execute = AsyncMock(return_value="DELETE 0")
        mock_conn.close = AsyncMock()

        with patch("import_user_data.connect_db", return_value=mock_conn):
            deleted = await prune_old_snapshots(mock_conn)
        
        # Nothing deleted since both games have <= 5 records
        assert deleted == 0
        # execute should still be called since we need to delete any extras
        mock_conn.execute.assert_called_once()


class TestMaxSnapshotsConstant:
    """Tests for MAX_SNAPSHOTS_PER_GAME constant."""

    def test_max_snapshots_value(self):
        """MAX_SNAPSHOTS_PER_GAME should be 5."""
        assert MAX_SNAPSHOTS_PER_GAME == 5
