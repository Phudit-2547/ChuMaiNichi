## Validation Surface
The surface for this feature is the CLI script execution (`python import_user_data.py`).
Tests should verify that the JSON data is correctly parsed, the database receives the data, and old snapshots are pruned correctly.
Required tools: `curl` or DB client (via `psql` or Python test scripts) to check the DB state.

## Validation Concurrency
- Max concurrent validators: 2 (since it interacts with a single Postgres database and could have race conditions if testing the exact same table concurrently without transaction isolation).
