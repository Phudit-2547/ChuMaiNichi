# CLAUDE.md — ChuMaiNichi

> Repository: https://github.com/Phudit-2547/ChuMaiNichi
> Owner: Phudit (Big), CEDT Year 3, Chulalongkorn University

## What is this project?

ChuMaiNichi (Chunithm + maimai + 毎日/mainichi = "playing daily") is a personal dashboard for CHUNITHM and maimai DX arcade rhythm game players. It tracks daily play counts, ratings over time, and uses an AI agent to suggest songs for efficient rating improvement.

This repo merges two previous repos:
- `Phudit-2547/Chunimai-tracker` (Python Playwright scraper, 63 commits — code lives in `scraper/`)
- `Phudit-2547/Chunimai_dashboard` (old Bun/Elysia dashboard — fully replaced, no code carried over)

## Architecture overview

```
Browser (React SPA on Vercel)
    │
    ├── GET  /api/auth    → password check only (no DB) — the login gate
    ├── POST /api/query   → Neon PostgreSQL (read-only SQL; client retries cold starts)
    ├── POST /api/chat    → Codex subscription or OpenAI-compatible API (tool-use, streaming)
    ├── GET/POST /api/codex-auth → ChatGPT device login/status/disconnect
    ├── POST /api/refresh → GitHub API (trigger workflow_dispatch) + GET poll
    └── GET  /api/model, /api/rating-image, /api/cover

GitHub Actions (cron + manual trigger)
    ├── scrape-daily.yml        → Playwright scraper → Neon → Discord webhook
    └── scrape-user-data.yml    → chuumai-tools Docker → Neon (no git commit)

Neon PostgreSQL (free tier, serverless — scales to zero, so first query pays a warmup cost)
    ├── daily_play         — International: one row per date, both games combined
    ├── japan_daily_play   — Journal-derived Japan activity, including ONGEKI tracks
    ├── user_scores        — International JSONB snapshots from chuumai-tools scraper
    ├── user_rating_images — rendered rating-frame images (served by /api/rating-image)
    └── codex_oauth_credentials — encrypted Codex credential + model preference
```

**Key constraint:** All secrets (DATABASE_URL, provider keys, Codex OAuth tokens, GITHUB_PAT) live exclusively in Vercel env vars, encrypted Neon storage, and GitHub repo secrets. The browser NEVER sees connection strings, API keys, or ChatGPT access/refresh tokens. This is why we use Vercel (serverless functions) instead of GitHub Pages (static-only).

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TypeScript |
| Hosting | Vercel (free Hobby plan) |
| API routes | Vercel serverless functions (`api/*.ts`) |
| Database | Neon PostgreSQL (`@neondatabase/serverless`) |
| Scraper | Python 3.12 + Playwright (Firefox, headless) |
| Package manager (Python) | `uv` — NOT pip. Use `uv sync` / `uv run`. |
| Package manager (JS) | pnpm |
| AI | ChatGPT/Codex subscription (experimental) or OpenAI-compatible API with tool-use (server-side) |
| CI/CD | GitHub Actions |
| Notifications | Discord webhooks |
| User data scraper | leomotors/chuumai-tools Docker images |

## Repository structure

```
ChuMaiNichi/
├── .github/workflows/
│   ├── scrape-daily.yml          # Cron: daily at 22:00 Asia/Bangkok
│   ├── scrape-user-data.yml      # Manual: workflow_dispatch for user.json
│   └── refresh-songs.yml         # Weekly: cache maimai-songs.json from wonderhoy API
├── scraper/                      # Python — migrated from Chunimai-tracker
│   ├── play_counter/
│   │   ├── config.py             # Env var loading, notification config
│   │   ├── scraper.py            # Playwright scraper for SEGA portals
│   │   ├── db.py                 # Async PostgreSQL via asyncpg
│   │   ├── daily_play_notifier.py
│   │   ├── reports/
│   │   │   ├── weekly.py
│   │   │   └── monthly.py
│   │   └── utils/
│   │       ├── constants.py      # URLs, webhook refs, cost per play
│   │       └── date_helpers.py
│   ├── import_user_data.py       # NEW: parse chuumai-tools output → Neon
│   ├── import_japan_journal.py    # Dry-run-first Obsidian Journal → japan_daily_play
│   ├── japan_daily_attribution.json # Audited counts for omitted Journal totals
│   ├── main.py
│   ├── pyproject.toml
│   ├── uv.lock
│   └── init.sql                  # Schema: International + Japan tables
├── api/                          # Vercel serverless functions (thin handlers)
│   ├── query.ts                  # DB proxy (read-only SELECT only)
│   ├── auth.ts                   # Login probe — password check ONLY, no DB
│   ├── chat.ts                   # AI agent proxy (streaming, tool-use)
│   ├── codex-auth.ts             # ChatGPT device login/status/disconnect
│   ├── refresh.ts                # Trigger + poll GitHub Actions workflow
│   ├── model.ts                  # Returns the active AI model name
│   ├── rating-image.ts           # Serves stored rating-frame image from Neon
│   ├── cover.ts                  # Proxies maimai song cover art (public upstream)
│   └── *.test.ts                 # Vitest suites for auth + refresh
├── src/                          # React frontend (single-page app, NO router)
│   ├── api/                      # Server-side logic imported by api/*.ts handlers
│   │   ├── auth.ts               # checkAuth(): sha256 + timingSafeEqual
│   │   ├── query.ts              # handleRequest/runQuery, SELECT-only guard
│   │   ├── query/errors.ts       # QueryException + status-code mapping
│   │   ├── config.ts             # loadConfig() reads config.json (server)
│   │   ├── error-handling.ts     # Vite/Vercel error responders
│   │   ├── vite-adapter.ts       # Emulates Vercel functions in `vite dev`
│   │   └── chat/                 # prompt, tools, providers, encrypted Codex OAuth
│   ├── features/                 # Feature-first UI (components + stores + lib)
│   │   ├── auth/                 # PasswordGate, AuthLoading, auth-store (zustand)
│   │   ├── heatmap/              # Heatmap, GameHeatmap, stats, fetch
│   │   ├── chat/                 # ChatPanel, composer, streaming render
│   │   ├── settings/            # SettingsModal, settings-store
│   │   ├── shell/                # Header, shell-store
│   │   └── rating-image/         # RatingImage component
│   ├── global/
│   │   ├── lib/                  # api.ts (fetch wrappers), auth.ts, config.ts,
│   │   │                         #   maimai-rating.ts, maimai-suggest.ts,
│   │   │                         #   chunithm-rating.ts, error-handling.ts, games.ts
│   │   └── components/ui/        # shadcn primitives
│   ├── App.tsx                   # Single page: gate → main view + sidebar + modal
│   ├── index.css
│   └── main.tsx
├── public/
│   └── maimai-songs.json         # Cached from maimai.wonderhoy.me/api/musicData (weekly refresh)
├── config.json                   # USER EDITS THIS: games, currency (see "Config" section)
├── package.json
├── tsconfig*.json
├── vite.config.ts                # Also wires the dev API proxy (see src/api/vite-adapter.ts)
├── vercel.json
├── AGENTS.md                     # Mirror of this file for non-Claude agents — keep in sync
└── CLAUDE.md
```

> **Structure note:** the frontend is organized **feature-first** (`src/features/*`) with cross-cutting code in `src/global/*`; server logic lives in `src/api/*` and is imported by the thin `api/*.ts` Vercel handlers. There is no flat `src/components/` or `src/lib/` directory.

## config.json

The one file friends edit after forking. Read by GitHub Actions (which scrapers to run) and the React app (which UI to render).

```json
{
  "games": ["maimai", "chunithm"],
  "currency_per_play": 40
}
```

| Field | Values | Effect |
|---|---|---|
| `games` | `["maimai"]`, `["chunithm"]`, or `["maimai", "chunithm"]` | Controls which scrapers run in Actions, which heatmap columns render, and whether `maimai_suggest_songs` is available (maimai only) |
| `currency_per_play` | Number (THB) | Used in spending calculations on the dashboard |

**Do NOT put secrets in this file.** It is committed to git and publicly visible.

## UI layout

Single-page app. No `react-router-dom`. No client-side routing.

```
┌──────────────────────────────────────────────┐
│  Header bar                    [⚙] [💬]      │
├──────────────────────────────┬───────────────┤
│                              │               │
│  Main view                   │  Chat panel   │
│  ├── Region switch           │  (sidebar,    │
│  └── Heatmaps                │   region-aware)│
│                              │   collapsible)│
│                              │               │
├──────────────────────────────┴───────────────┤
│  Settings modal (overlay, triggered by ⚙)    │
└──────────────────────────────────────────────┘
```

- **Main view**: Page-level International/Japan switch plus heatmaps
- **International**: configured maimai/CHUNITHM heatmaps, rating images, Refresh, and score-aware chat
- **Japan**: Journal-derived maimai/CHUNITHM heatmaps plus ONGEKI tracks; no Refresh, rating image, or spending calculation
- **Chat panel**: Right sidebar with isolated history per region. Japan uses a static structured activity tool and cannot issue free-form SQL. International retains the generic read-only SQL tool; its direct Japan-table guard prevents accidental mixing but is not a database security boundary because both contexts share `DATABASE_URL`.
- **Settings modal**: Overlay triggered by gear icon. Theme toggle and display preferences. Stored in `localStorage`
- **Game selection and currency**: `config.json` controls International only; the Japan view always uses its Journal schema
- **Refresh button**: In header or settings. Calls `/api/refresh` to trigger `scrape-user-data.yml`
- No separate pages, no route transitions

## Config (`config.json`)

Single config file at repo root. Friends edit this once after forking.

```json
{
  "games": ["maimai", "chunithm"],
  "currency_per_play": 40
}
```

| Field | Values | Effect |
|---|---|---|
| `games` | `["maimai"]`, `["chunithm"]`, or `["maimai", "chunithm"]` | Controls International scrapers/heatmaps and whether `maimai_suggest_songs` is available |
| `currency_per_play` | Integer (THB) | Used to calculate money spent in reports and Discord notifications |

**Who reads it:**
- GitHub Actions workflows: decides which Docker scrapers to run and which Playwright portals to scrape
- Vercel API routes: `api/chat.ts` reads it to configure available tools (`maimai_suggest_songs` only when `"maimai"` is in `games`)
- React frontend: imports `config.json` at build time via `src/global/lib/config.ts` to decide which UI components to render (heatmap columns). Baked into the bundle, so editing requires a redeploy.

**Do NOT put secrets in config.json** — it is committed to git and served publicly.

## Database schema

```sql
-- Table 1: Daily play tracking (one row per date, both games combined)
CREATE TABLE IF NOT EXISTS daily_play (
    play_date            DATE PRIMARY KEY,
    maimai_play_count    INTEGER DEFAULT 0,
    chunithm_play_count  INTEGER DEFAULT 0,
    maimai_cumulative    INTEGER DEFAULT 0,
    chunithm_cumulative  INTEGER DEFAULT 0,
    maimai_rating        NUMERIC,
    chunithm_rating      NUMERIC,
    scrape_failed        BOOLEAN DEFAULT FALSE,
    failure_reason       TEXT
);

-- Table 2: Per-song score snapshots (JSONB from chuumai-tools)
CREATE TABLE IF NOT EXISTS user_scores (
    id         SERIAL PRIMARY KEY,
    game       TEXT NOT NULL,           -- 'maimai' or 'chunithm'
    scraped_at TIMESTAMP NOT NULL,      -- naive Asia/Bangkok wall-clock
    data       JSONB NOT NULL           -- Full chuumai-tools output
);
-- One snapshot per game per day (newest wins); enforced by:
CREATE UNIQUE INDEX IF NOT EXISTS user_scores_game_day_key
    ON user_scores (game, (scraped_at::date));

-- Table 3: Rendered rating-frame images (served by /api/rating-image)
CREATE TABLE IF NOT EXISTS user_rating_images (
    game         TEXT PRIMARY KEY,      -- 'maimai' or 'chunithm'
    image_data   BYTEA NOT NULL,        -- binary image blob
    content_type TEXT NOT NULL,         -- e.g. 'image/webp'
    updated_at   TIMESTAMP NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Bangkok')
);

-- Table 4: Japan Journal history; ONGEKI uses tracks rather than plays.
CREATE TABLE IF NOT EXISTS japan_daily_play (
    play_date                   DATE PRIMARY KEY,
    maimai_play_count           INTEGER NOT NULL,
    chunithm_play_count         INTEGER NOT NULL,
    ongeki_track_count          INTEGER NOT NULL,
    maimai_cumulative           INTEGER NOT NULL,
    chunithm_cumulative         INTEGER NOT NULL,
    ongeki_cumulative_tracks    INTEGER NOT NULL,
    source                      TEXT NOT NULL,
    source_paths                TEXT[] NOT NULL,
    source_hashes               TEXT[] NOT NULL,
    inferred_games              TEXT[] NOT NULL
);

-- Table 5: Private/experimental single-user Codex OAuth lifecycle state.
-- encrypted_credentials is AES-256-GCM ciphertext and is NULL while disconnected.
CREATE TABLE IF NOT EXISTS codex_oauth_credentials (
    singleton_id          SMALLINT PRIMARY KEY DEFAULT 1
                          CHECK (singleton_id = 1),
    encrypted_credentials TEXT,
    selected_model        TEXT,
    revision              BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    pending_login_id       TEXT,
    refresh_lock_id        TEXT,
    refresh_lock_until     TIMESTAMPTZ,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

All five tables are created idempotently by `scraper/init.sql`, which runs during a scraper invocation (not on Vercel). The OAuth route also lazily creates/migrates its own table so subscription login does not depend on a later scraper run. Before the first scrape, `/api/rating-image` treats a missing `user_rating_images` table as a 404 so the UI hides cleanly.

**Critical schema rules:** `daily_play` remains International-only and has ONE row per date with columns for BOTH games; any upsert logic that loops per game and inserts twice is a bug. `japan_daily_play` also has ONE row per date, adds ONGEKI tracks, and is written only by the dry-run-first Journal importer. Never merge cumulative values across these tables.

**Japan attribution rule:** An explicit `-` means the cumulative value is unchanged from the previous day. A game omitted from a Journal total is not automatically a dash; `import_japan_journal.py` must find a non-negative audited daily count in `japan_daily_attribution.json` or block the import. The 2026-06-01 maimai count is a user-estimated 1 play; the 2026-06-06 snapshot therefore contributes the remaining 4 plays. Both cells are listed in `inferred_games` and must display an explanatory `*` in the Japan UI. Reserve `inferred_games` for judgment-based ambiguous splits; deterministic differences between audited totals do not receive a marker.

## Rating system (maimai DX)

### DX Rating composition (CiRCLE version)
- **Top 35 "old" charts**: best scores from all versions BEFORE PRiSM+
- **Top 15 "new" charts**: best scores from PRiSM+ and CiRCLE (current + previous version)
- Total DX Rating = sum of song ratings from these 50 charts
- Rating can only go UP (except when version changes reclassify "new" → "old")

### Song rating formula (validated against real data)

```
song_rating = floor(chart_constant × rank_multiplier × min(achievement, 100.5) / 100)
```

Rank multipliers (RANK_FACTORS):
| Rank | Min Score | Multiplier |
|------|-----------|-----------|
| SSS+ | 1005000 | 22.4 |
| SSS  | 1000000 | 21.6 |
| SS+  | 995000  | 21.1 |
| SS   | 990000  | 20.8 |
| S+   | 980000  | 20.3 |

Achievement is score / 10000 (e.g., 1005000 = 100.5%).

### Chart constants source
- Cached in `public/maimai-songs.json` from `maimai.wonderhoy.me/api/musicData`
- Refreshed weekly by GitHub Actions (constants change on version updates)
- Do NOT call the API at runtime — read the cached file instead (avoids 60s timeout risk)
- `maimai.wonderhoy.me/api/calcRating` is usable as a data source BUT has a known discrepancy: if a player hasn't unlocked a song (e.g., "7 wonders"), it won't appear in their play_data scrape but CAN appear in the API's top-50 calculation, causing the API to overestimate rating for that player

## Vercel API routes specification

Every route validates the dashboard password with `checkAuth` (`src/api/auth.ts`,
sha256 + `timingSafeEqual`) except `/api/cover`, which proxies public art. When
`DASHBOARD_PASSWORD` is unset, `checkAuth` returns `true` (auth disabled).

### GET /api/auth
- Login probe. Validates `DASHBOARD_PASSWORD` **only** — no database, no AI provider.
- Returns `200 { ok: true }` on match, `401` otherwise.
- **Why it exists:** the frontend `authenticate()` calls this, so a correct
  password signs in even when the database is cold, unreachable, or
  `DATABASE_URL` is unset. Login is decoupled from database availability;
  DB errors surface in the data panels instead of blocking the gate.

### POST /api/query
- Body: `{ sql: string, params?: any[] }`
- Read-only guard: reject any SQL that is not a SELECT statement (plus a
  forbidden-pattern regex blocking `;`, comments, and write keywords)
- A shared private-data boundary rejects the OAuth credential table, PostgreSQL
  system catalogs, encoded or quoted identifiers, and callable SQL outside a
  small analytics allowlist. This is application-layer defense, not PostgreSQL
  role-level privilege isolation.
- Uses `DATABASE_URL` env var → `@neondatabase/serverless`
- Returns: `{ rows: any[], rowCount: number }`
- **Cold-start retry (client-side):** the `queryDB` wrapper in
  `src/global/lib/api.ts` retries 5xx/network failures with exponential backoff
  (4 attempts total) so a waking Neon instance resolves transparently. It never
  retries 4xx (auth/bad-query) or caller-aborted requests.

### GET /api/model
- Returns `{ model: string }` — the active provider's model name for the chat UI. A connected Codex credential takes precedence; returns `503` rather than advertising a display default when neither Codex nor a fallback provider is configured.

### GET/POST /api/codex-auth
- Experimental, single-user ChatGPT/Codex subscription connection. It is separate from the dashboard password identity.
- `GET` returns safe connection/configuration metadata plus the server-owned Sol/Terra/Luna model options; it never returns OAuth tokens. It can return `reset_required: true` when encrypted state exists but the key is unavailable or a refresh outcome became ambiguous.
- `POST { action: "start" }` starts Codex device login and returns a one-time user code plus OpenAI verification URL.
- `POST { action: "poll", login_token }` completes the exchange server-side; `POST { action: "disconnect" }` clears the credential and invalidates pending login/refresh work while preserving a monotonic tombstone revision.
- `POST { action: "set_model", model }` accepts only `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna`. The selection is stored separately from ciphertext and does not advance the OAuth revision or disturb refresh ownership.
- Start, poll, status decryption, and chat require `DASHBOARD_PASSWORD`, `DATABASE_URL`, and `CODEX_OAUTH_ENCRYPTION_KEY`. Authenticated model selection and Disconnect/Reset require only the password and database so preferences remain manageable and a credential encrypted with a lost or malformed key remains removable.
- Access/refresh tokens are AES-256-GCM encrypted in Neon; the browser holds only short-lived encrypted login state while connecting. A durable login nonce prevents stale device flows from overwriting newer state. Refresh-token rotation uses a non-stealable durable marker: ambiguous timeout/crash outcomes remain blocked and require authenticated Reset instead of replaying a potentially consumed refresh token.

### GET /api/rating-image?game=maimai|chunithm
- Streams the stored rating-frame image (BYTEA) from `user_rating_images`.
- `404` when the row/table is absent (pre-first-scrape); `200` with the image bytes otherwise.

### GET /api/cover?img=<16-hex>.png
- Proxies maimai song cover art from `maimai.wonderhoy.me` (public, no auth). Filename is regex-validated; response cached 7 days.

### POST /api/chat
- Body: `{ messages: { role: string, content: string }[], model?: string }`
- Prefers a connected ChatGPT/Codex credential, then falls back to Gemini/OpenAI-compatible env credentials when disconnected
- Streams response via ReadableStream
- Tool definitions:
  - `query_database`: generates and executes read-only SQL against Neon through the same private-data/function-allowlist boundary as `/api/query`
  - `maimai_suggest_songs`: maimai only — finds songs where score improvement most efficiently increases DX rating (see "Song suggestion algorithm" section below). Name is game-prefixed so a future `chunithm_suggest_songs` can coexist without ambiguity.
- System prompt includes full schema DDL, rating formula, and tool examples
- The Codex subscription path uses the Responses protocol while preserving the same browser SSE events and local tool loop as the OpenAI-compatible path.
- **Experimental boundary:** OpenAI documents subscription auth through Codex App Server. The direct Codex backend used here follows Codex-client/Hermes behavior, not a documented general OpenAI API contract; do not present it as production-supported OAuth for `/v1/responses`.

### POST /api/refresh
- Uses `GITHUB_PAT` + `GITHUB_REPO` env vars
- Triggers `workflow_dispatch` on `scrape-user-data.yml` (passes configured `games`)
- Returns: `{ run_id: string, run_url: string }`

### GET /api/refresh?run_id=<id>
- Polls the dispatched run's status. Returns `{ status, conclusion?, run_url? }`.
- The frontend (`pollRefreshStatus`) polls this until `status === "completed"`, then reloads score data.

## GitHub Actions workflows

### scrape-daily.yml
- Cron: `0 15 * * *` (22:00 Asia/Bangkok)
- Also: `workflow_dispatch` for manual trigger
- Reads `config.json` to determine which games to scrape
- Steps: `uv sync` → `uv run python main.py` → (scraper writes to Neon + sends Discord notification)
- On first run: executes `init.sql` to create tables if they don't exist (idempotent)
- Uses `astral-sh/setup-uv@v5` (NOT `actions/setup-python`)
- Secrets needed: `DATABASE_URL`, `SEGA_USERNAME`, `SEGA_PASSWORD`, `DISCORD_WEBHOOK_URL`

### scrape-user-data.yml
- Trigger: `workflow_dispatch` only (from Refresh button or manual)
- Reads `config.json` to determine which chuumai-tools scrapers to run
- Steps:
  1. Run `ghcr.io/leomotors/chunithm-scraper:v6` and/or `ghcr.io/leomotors/maimai-scraper:v1`
  2. Capture JSON output from `outputs/` directory
  3. Run `import_user_data.py` to write JSONB into `user_scores` table
- Data goes directly to Neon — NEVER committed to git (privacy)
- Secrets needed: `DATABASE_URL`, `SEGA_USERNAME`, `SEGA_PASSWORD`

### refresh-songs.yml
- Cron: weekly (or `workflow_dispatch`)
- Only runs if `"maimai"` is in `config.json` games array
- Fetches `maimai.wonderhoy.me/api/musicData` → writes to `public/maimai-songs.json` → commits
- Chart constants change on version updates (~weekly), so this keeps the cache fresh
- No secrets needed (public API)

## Song suggestion algorithm (maimai only)

> CHUNITHM song suggestion is a future feature, not in scope for the deadline.

The `maimai_suggest_songs` tool runs server-side and is dispatched from `executeTool` in `src/api/chat/tools.ts`. The algorithm itself lives in `src/global/lib/maimai-suggest.ts`; rating helpers live in `src/global/lib/maimai-rating.ts`. A future `chunithm_suggest_songs` will be a separate file in the same directory.

### Data inputs
- **player_data**: From `user_scores` table (JSONB). Contains `profile`, `best` (top 35 old), `current` (top 15 new), and `allRecords` (full play history from play_data page)
- **maimai-songs.json**: Cached song catalog with chart constants per difficulty

### Two modes

**best_effort** (default): Walks every chart in `best` + `current` with score < SSS+, builds a "next rank up" move, drops moves with `rating_gain ≤ 0`, sorts by `score_gap` ascending (easiest grind first), and returns the top `maxSuggestions`.

**target** (when user specifies a target rating): **Per-slot threshold** algorithm — NOT a greedy-by-gain accumulator.

1. `threshold = ceil(target_rating / slotCount)` where `slotCount = best.length + current.length` (50 for full data). The rating each top-50 slot must contribute on average.
2. `minConstant` = smallest chart constant where SSS+ (1005000) reaches `threshold`. Searches `c = 1.0 … 16.0` in 0.1 steps via `findMinConstant`.
3. **Classify every top-50 chart**:
   - `constant < minConstant` → **REPLACE** (can't hit threshold even at SSS+; slot recorded with its current rating)
   - `current_rating < threshold` → **IMPROVE** to the lowest rank that reaches threshold (`findMinRankForThreshold`)
   - `current_rating ≥ threshold` → KEEP, no action
4. **Replacements**: scan `allRecords`, skip charts already in top-50, keep `constant ≥ minConstant`. Split into pools by version:
   - `newCandidates` (CiRCLE / PRiSM+) → fill `current` slots
   - `oldCandidates` (everything else) → fill `best` slots
   Both pools sorted by lowest constant first, then highest existing score (least grinding). Slots filled weakest-first (lowest `replacesRating`). Pools that run dry → bump `unfilled` counter, surfaced in the message.
5. Final action list = improvements + replacements with `rating_gain > 0`, sorted by `score_gap` ascending.
6. `projected_rating = current_rating + Σ rating_gain`. Message either confirms the plan reaches the target or reports the shortfall and any unfilled slots.

### Large rating gaps — staging guard (in system prompt)

The uniform per-slot threshold breaks down when `target - current` is large (roughly > 1000). Example: 8000 → 15000 sets threshold = 300, which forces `minConstant ≈ 13.4` and demands SSS+ on every slot — unrealistic, and the candidate pool usually can't fill all the replacement slots, so `unfilled` dominates the response.

The tool itself does not clamp. Instead the staging guard lives in `src/api/chat/system-prompt.ts` ("MAIMAI TARGET-RATING STAGING"): the agent queries the user's current rating from `user_scores` first, and if `target - current > 1000` it calls `maimai_suggest_songs` with `target_rating = current + 500` (rounded to nearest 100) and frames the result as step 1 of N. Smaller gaps pass through unchanged. This avoids the sparse-plan failure without touching the algorithm.

### Version classification for old/new
- **New songs**: `releasedVersion` is `CiRCLE` or `PRiSM+` (current + previous version)
- **Old songs**: everything else
- Drives both the bucket a song competes for (35 old / 15 new) and the replacement pool it can fill.

### Key functions (in `src/global/lib/maimai-rating.ts` and `maimai-suggest.ts`)
- `calculateSongRating(constant, score)`: applies the rating formula
- `calcRating(playerData, allSongs)`: computes total DX rating from top 50
- `getRankInfo(score)`: returns rank name and achievement percentage
- `getNextRank(score)`: returns the next rank threshold above current score (used in best_effort)
- `RANK_FACTORS`: array of `[minScore, multiplier, rankName]` tuples
- `suggestSongs(playerData, allSongs, options)`: main entry point — returns `TargetResult | BestEffortResult`

## Environment variables

### Vercel env vars (server-side, never exposed to browser)
| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `OPENAI_API_KEY` | OpenAI-compatible API key (used if `GEMINI_API_KEY` is not set) |
| `OPENAI_BASE_URL` | OpenAI-compatible base URL (optional, defaults to OpenAI) |
| `GEMINI_API_KEY` | Google Gemini API key (takes priority over `OPENAI_API_KEY`) |
| `AI_MODEL` | Override default model name (default: `gemini-2.5-flash` for Gemini, `gpt-4o-mini` for OpenAI) |
| `CODEX_OAUTH_ENCRYPTION_KEY` | Enables ChatGPT subscription login. Exactly 32 random bytes encoded as 64-character hex or padded Base64; generate with `openssl rand -base64 32`. |
| `CODEX_MODEL` | Initial Codex model until Settings saves a server-side selection; supported values are `gpt-5.6-sol`, `gpt-5.6-terra` (default), and `gpt-5.6-luna` |
| `GITHUB_PAT` | Fine-grained PAT for triggering workflow_dispatch |
| `GITHUB_REPO` | `Phudit-2547/ChuMaiNichi` |
| `DASHBOARD_PASSWORD` | **Required.** Authenticated `/api/*` routes require `Authorization: Bearer <password>`. The `PasswordGate` prompts on first visit; the password is stored via a zustand `persist` store (localStorage key `user-state`) and sent as the Bearer token. Login is verified against `/api/auth` (password only — no DB round-trip). Without this, anyone can use your AI proxy and query your database. |

**AI provider detection:** a connected Codex OAuth credential takes precedence. When disconnected, `api/chat.ts` checks `GEMINI_API_KEY` first, then `OPENAI_API_KEY`. Do not silently fall back to a metered API key after a connected Codex request fails; surface the reconnect/quota error instead. Gemini is accessed via its OpenAI-compatible endpoint using the same `openai` SDK.

### GitHub repo secrets (for Actions)
| Secret | Description |
|---|---|
| `DATABASE_URL` | Same Neon connection string |
| `SEGA_USERNAME` | SEGA ID for game portal login |
| `SEGA_PASSWORD` | SEGA password |
| `DISCORD_WEBHOOK_URL` | Discord webhook for notifications |

## User deployment flow (fork → 3 accounts → done)

1. Fork `Phudit-2547/ChuMaiNichi` on GitHub
2. Edit `config.json`: set `games` to `["maimai"]`, `["chunithm"]`, or `["maimai", "chunithm"]`
3. Create Neon account (free, no credit card) → create project → copy `DATABASE_URL`
4. Add GitHub repo secrets: `DATABASE_URL`, `SEGA_USERNAME`, `SEGA_PASSWORD`, `DISCORD_WEBHOOK_URL`
5. Trigger first scrape manually (workflow runs `init.sql` automatically on first run)
6. Import forked repo in Vercel (free Hobby plan) → add `DATABASE_URL`, `DASHBOARD_PASSWORD`, `GITHUB_PAT`, `GITHUB_REPO`, plus either `CODEX_OAUTH_ENCRYPTION_KEY` for ChatGPT login or an API provider key (provider keys may remain as a disconnected fallback)
7. Visit `<username>.vercel.app`; for ChatGPT usage, connect under Settings and complete the device-code verification
8. Infrastructure can remain 0 THB on the listed free tiers; any ChatGPT plan or metered API usage is separate

## Constraints and gotchas

- **Neon free tier**: 100 CU-hours/project/month, 0.5 GB storage. Keep `user_scores` to latest 5 snapshots per game. Scale-to-zero means idle time costs nothing.
- **Vercel Hobby tier**: Functions currently default to a 300-second execution limit. Stream AI responses so users see progress; verify current quotas before relying on them.
- **uv, not pip**: Always use `uv sync` to install, `uv run` to execute. In GitHub Actions, use `astral-sh/setup-uv@v5`.
- **One row per date**: The `daily_play` table combines both games in a single row. Never insert two rows for the same date.
- **No secrets in browser**: API keys and connection strings stay in Vercel env vars or GitHub secrets; Codex access/refresh tokens stay AES-256-GCM-encrypted in Neon. The React app receives only opaque short-lived login state and calls `/api/*` routes.
- **chuumai-tools Docker images**: chunithm uses `ghcr.io/leomotors/chunithm-scraper:v6`, maimai uses `ghcr.io/leomotors/maimai-scraper:v1`. Version env vars: `VERSION=XVRSX` (chunithm), `VERSION=CiRCLE` (maimai).
- **Timezone**: All scraping and date logic uses `Asia/Bangkok` (UTC+7).
- **Currency**: Default cost per play is 40 THB, configurable in settings.

## Code style and preferences

- Respond concisely. No filler, no enthusiasm.
- Verify claims before stating them — accuracy over speed.
- Use metric units and THB for currency.
- TypeScript for all frontend and API code.
- Python for scraper only.
- Prefer simplest solution that works. Do not over-engineer.
- When in doubt about platform pricing or limits, search and verify — do not guess.
