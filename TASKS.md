# ChuMaiNichi — Task Delegation

> Deadline: April 28, 2026 (Digital & AI demo)
> MVP target: April 16 (gives 12 days buffer)
> Repo: https://github.com/Phudit-2547/ChuMaiNichi

---

## Day 1–2: You (Big) scaffold — unblocks everyone

Do this BEFORE assigning anyone else:

1. `pnpm create vite@latest . -- --template react-ts`
2. `pnpm install`
3. Create `vercel.json`:
   ```json
   { "rewrites": [{ "source": "/((?!api/).*)", "destination": "/index.html" }] }
   ```
4. Create `config.json`:
   ```json
   { "games": ["maimai", "chunithm"], "currency_per_play": 40 }
   ```
5. Create 3 API stubs with mock data:
   - `api/query.ts` — returns hardcoded `daily_play` rows
   - `api/chat.ts` — returns a canned chat response
   - `api/refresh.ts` — returns `{ "status": "ok" }`
6. Copy `play_counter/` from Chunimai-tracker → `scraper/play_counter/`
7. Copy `main.py`, `pyproject.toml`, `uv.lock` → `scraper/`
8. Copy `init.sql` → `scraper/init.sql` (add `user_scores` table)
9. Copy `.github/workflows/schedule.yml` → `.github/workflows/scrape-daily.yml`
   - Update `working-directory: scraper`
10. Deploy to Vercel, verify stubs work at `<your>.vercel.app`
11. Add `CLAUDE.md` to repo root

After this: tell teammates "pull main, read CLAUDE.md, start on your section."

---

## Person B — Frontend

**Read first:** CLAUDE.md (UI layout section, config.json section)
**Depends on:** Big's scaffold (API stubs return mock data)

### Deliverables

1. **App.tsx** — Single-page layout
   - Header bar with refresh button + gear icon + chat toggle
   - Main content area (heatmap + rating chart stacked vertically)
   - Collapsible right sidebar for chat
   - Settings modal (triggered by gear icon)

2. **src/lib/api.ts** — Fetch wrappers
   - `queryDB(sql, params?)` → `POST /api/query`
   - `sendChat(messages)` → `POST /api/chat` (handle streaming)
   - `triggerRefresh()` → `POST /api/refresh`
   - `getConfig()` → `fetch('/config.json')`

3. **src/components/Heatmap.tsx**
   - `pnpm add cal-heatmap` (or similar React heatmap lib)
   - Fetch data: `SELECT * FROM daily_play ORDER BY play_date`
   - Show maimai (orange) and/or chunithm (green) based on `config.json`
   - Year selector, tooltip on hover showing play count + rating
   - Both games in one row per date (NOT separate rows)

4. **src/components/RatingChart.tsx**
   - `pnpm add recharts`
   - Line chart: `maimai_rating` and/or `chunithm_rating` over time
   - Conditionally show lines based on `config.json` games array

5. **src/components/ChatPanel.tsx**
   - Right sidebar, toggleable via header button
   - Text input + message history display
   - Call `sendChat()`, display streamed response
   - Keep it simple — no `deep-chat-react` needed, raw fetch + ReadableStream

6. **src/components/SettingsModal.tsx**
   - Modal overlay
   - Theme toggle (dark/light)
   - Any display preferences (stored in localStorage)
   - Game selection is NOT here (it's in config.json)

### Notes
- Build against the mock API stubs first. When real routes land, everything just works.
- Use pnpm, not npm or bun.
- No react-router-dom. No client-side routing. Single page.
- Test with `pnpm dev` locally and `npx vercel dev` for API routes.

---

## Person C — AI Agent

**Read first:** CLAUDE.md (rating system section, song suggestion algorithm section)
**Depends on:** Nothing — pure functions, testable standalone

### Deliverables

1. **src/lib/maimai-rating.ts** — Port from Python `rating.py`
   - `RANK_FACTORS`: array of `{ minScore, multiplier, rankName }`
     ```
     SSS+ = 1005000, 22.4
     SSS  = 1000000, 21.6
     SS+  = 995000,  21.1
     SS   = 990000,  20.8
     S+   = 980000,  20.3
     ```
   - `calculateSongRating(constant, score)`: `Math.floor(constant * multiplier * Math.min(score/10000, 100.5) / 100)`
   - `calcRating(playerData, version)`: compute total DX rating from top 50 (35 old + 15 new)
   - `getRankInfo(score)`: returns `{ rank, achievementPct }`
   - `getNextRank(score)`: returns next rank threshold above current score
   - New version songs: `releasedVersion` is `CiRCLE` or `PRiSM+`
   - Write unit tests with known values to validate against the formula

2. **src/lib/maimai-suggest.ts** — Port from Python `suggest_songs.py`
   - Two modes: `best_effort` and `target`
   - `best_effort`: return top N improvements + new songs sorted by rating gain
   - `target`: greedy algorithm picking songs until remaining_rating ≤ 0
     - Improvements: replace song's own rating in top-50 (no push-out)
     - New songs: enter top-50, push out lowest
   - Reads `maimai-songs.json` for chart constants
   - maimai only (CHUNITHM song suggestion is out of scope)
   - The full Python code is in the repo's CLAUDE.md project context — ask Big if needed

3. **api/chat.ts** — Replace Big's stub with real implementation
   - Read `OPENAI_API_KEY` and `OPENAI_BASE_URL` from `process.env`
   - System prompt includes:
     - `daily_play` schema DDL
     - `user_scores` schema DDL
     - Rating formula with multiplier table
     - Instructions for when to use each tool
   - Two tool definitions:
     - `query_database`: LLM generates SQL → execute via Neon → return results
       - Read-only guard: reject non-SELECT statements
       - `pnpm add @neondatabase/serverless`
     - `maimai_suggest_songs`: call maimai-suggest.ts with parameters from LLM
   - Stream response back using ReadableStream
   - 60-second Vercel Hobby timeout — keep streaming to stay alive

### Notes
- `maimai-rating.ts` and `maimai-suggest.ts` are pure functions. Test them with `vitest` without Vercel or Neon.
- For `api/chat.ts`, test locally with `npx vercel dev`.
- The system prompt is critical for demo quality — invest time in good examples.
- Read the suggest_songs.py code Big will provide. Don't reinvent the algorithm.

---

## Person D — Data Pipeline + Presentation

**Read first:** CLAUDE.md (GitHub Actions workflows section, user deployment flow)
**Depends on:** Big's scaffold (for workflow file locations)

### Deliverables (code)

1. **scraper/import_user_data.py**
   - Parse JSON output from chuumai-tools Docker containers
   - Upsert into `user_scores` table (JSONB)
   - Keep only latest 5 snapshots per game (DELETE older to stay under Neon's 0.5 GB)
   - Use asyncpg (same as existing `db.py`)

2. **.github/workflows/scrape-user-data.yml**
   - Trigger: `workflow_dispatch`
   - Read `config.json` to determine which games to scrape
   - Run Docker containers:
     - maimai: `ghcr.io/leomotors/maimai-scraper:v1` with `VERSION=CiRCLE`
     - chunithm: `ghcr.io/leomotors/chunithm-scraper:v6` with `VERSION=XVRS`
   - Mount `outputs/` to capture JSON
   - Run `import_user_data.py` to write to Neon
   - NEVER commit output to git (privacy)
   - Secrets: `DATABASE_URL`, `SEGA_USERNAME`, `SEGA_PASSWORD`

3. **.github/workflows/refresh-songs.yml**
   - Trigger: weekly cron + `workflow_dispatch`
   - Fetch `maimai.wonderhoy.me/api/musicData`
   - Write to `public/maimai-songs.json`
   - Commit and push (this is public data, OK to commit)

4. **api/refresh.ts** — Replace Big's stub
   - Read `GITHUB_PAT` and `GITHUB_REPO` from `process.env`
   - `POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/scrape-user-data.yml/dispatches`
   - Return `{ run_url }`

5. **Update scraper/init.sql** — Add `user_scores` table
   ```sql
   CREATE TABLE IF NOT EXISTS user_scores (
       id         SERIAL PRIMARY KEY,
       game       TEXT NOT NULL,
       scraped_at TIMESTAMPTZ DEFAULT NOW(),
       data       JSONB NOT NULL
   );
   ```

### Deliverables (presentation)

6. **Presentation deck** (12-min + 3-min Q&A)
   - Problem: expertise gap in rhythm games, casual players waste credits
   - Solution: ChuMaiNichi — free, fork-and-deploy dashboard with AI agent
   - Tech: Generative AI (tool-use), Playwright automation, Neon, Vercel
   - Demo: live walkthrough (heatmap → chat → song suggestion → rating improvement)
   - Feasibility: 0 THB cost, 3 free-tier accounts, ~15 min setup

7. **Demo script** — Exact steps to show in 3 minutes
   - Show heatmap with real data
   - Ask AI: "how many times did I play this week?"
   - Ask AI: "suggest songs to reach rating 15000"
   - Show the suggestion output with target scores

### Notes
- Use `uv` for Python, not pip. In GitHub Actions use `astral-sh/setup-uv@v5`.
- Docker images use env vars: `USERNAME`, `PASSWORD`, `VERSION`, `TZ=Asia/Bangkok`.
- The scrape-daily.yml already exists from Big's scaffold — don't recreate it.
- Coordinate with Big on the presentation — Big knows the architecture best.

---

## Integration checklist (week 2)

Work lands directly on `main` via PR (no long-lived feature branches). Suggested order to minimise conflicts:

1. Pipeline first (init.sql + workflows, no frontend conflicts)
2. AI agent second (api/chat.ts + lib/, no frontend conflicts)
3. Frontend last (consumes the APIs above)
4. Big: end-to-end test on Vercel, fix integration bugs

---

## What is NOT in MVP

- Friend onboarding documentation (README with screenshots)
- Docker self-hosting support
- Settings modal game selection (it's in config.json)
- CHUNITHM song suggestion
- Polish, animations, mobile responsiveness
- User study protocol (HCI group handles this separately)
