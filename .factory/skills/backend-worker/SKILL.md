---
name: backend-worker
description: A worker for Python scripts and backend API/DB features.
---

# Backend Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill
Use this skill for implementing python backend logic, writing queries, and developing utility scripts.

## Required Skills
None

## Work Procedure
1. Create/Update tests first (e.g., `test_import_user_data.py`). Ensure they fail.
2. Implement the missing logic (e.g., `import_user_data.py`).
3. Ensure the code respects `.factory/services.yaml` commands (`test`).
4. Run `uv run pytest` to ensure tests pass.
5. Manually verify the behavior if applicable.

## Example Handoff
{
  "salientSummary": "Implemented import_user_data.py and added unit tests covering valid parsing, upsert logic, and pruning older snapshots. All 5 tests pass.",
  "whatWasImplemented": "Created import_user_data.py which reads JSON, uses asyncpg to connect to DB, inserts records, and prunes old records keeping only latest 5.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "uv run pytest scraper/tests/",
        "exitCode": 0,
        "observation": "5 passed"
      }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {
        "file": "scraper/tests/test_import_user_data.py",
        "cases": [
          { "name": "test_import", "verifies": "Imports JSON successfully" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}

## When to Return to Orchestrator
- Required DB tables or structure is ambiguous.
