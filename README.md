# ChuMaiNichi

A personal dashboard for CHUNITHM and maimai DX arcade rhythm-game players. It keeps live International data separate from a historical Japan Journal view, tracks daily activity and ratings, and uses an AI agent to suggest songs for efficient DX rating improvement.

> *ChuMaiNichi* = CHUNITHM + maimai + 毎日 (*mainichi*, "every day") — *playing daily*.

## Screenshots

<img width="3773" height="1618" alt="CleanShot 2569-05-16 at 00 44 40@2x" src="https://github.com/user-attachments/assets/502dbcc9-36c8-4246-be49-749774e7882d" />

*Main dashboard: play-count heatmap for both games.*

<img width="1270" height="1837" alt="CleanShot 2569-05-17 at 11 28 18@2x" src="https://github.com/user-attachments/assets/0b1d5cf3-1a23-4511-a179-5df58afdcb6e" />

*AI agent suggesting songs to grind for rating improvement.*

<img width="1210" height="356" alt="CleanShot 2569-05-16 at 00 32 55@2x" src="https://github.com/user-attachments/assets/3319f714-1af9-4c57-aefe-52d647a594d5" />

*Discord notification : Montly.*

<img width="1014" height="334" alt="CleanShot 2569-05-16 at 00 37 56@2x" src="https://github.com/user-attachments/assets/0e49b734-b97a-4a9e-85bf-62bcfc2680b5" />

*Discord notification : Weekly.*

<img width="812" height="174" alt="CleanShot 2569-05-16 at 00 36 11@2x" src="https://github.com/user-attachments/assets/a16d4737-0d46-40c3-98f2-d92f2890dee7" />

*Discord notification : Daily.*

## Features

- **Daily play tracking** — your play count and rating are recorded in PostgreSQL once per day.
- **International/Japan views** — switch the whole dashboard between live International data and the Japan Journal archive; Japan also includes ONGEKI tracks.
- **Rating history** — DX rating and CHUNITHM rating tracked per day.
- **AI agent with tool use** — chat with an LLM that can query your database and recommend songs; optionally connect a ChatGPT plan through Codex device login.
- **Song suggestion engine (maimai)** — greedy algorithm that finds the minimum-effort path to a target DX rating.
- **Discord notifications** — daily summary of play count, rating changes, and money spent.
- **Password-gated** — frontend prompts for a password on first visit; all `/api/*` routes require it.
- **Free infrastructure tier** — Vercel Hobby, Neon free, and GitHub Actions can host the dashboard without infrastructure charges; ChatGPT plans or API usage are separate.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TypeScript |
| Hosting | Vercel (Hobby plan) |
| API routes | Vercel serverless functions |
| Database | Neon PostgreSQL (serverless) |
| Daily scraper | Python 3.12 + Playwright (Firefox, headless), managed with `uv` |
| Per-song scraper | [leomotors/chuumai-tools](https://github.com/Leomotors/chuumai-tools) Docker images |
| AI | ChatGPT/Codex subscription (experimental) or an OpenAI-compatible API; server-side, streaming, with local tools |
| CI/CD | GitHub Actions |
| Notifications | Discord webhooks |

## Architecture

```
Browser (React SPA on Vercel)
    │
    ├── POST /api/query   → Neon PostgreSQL (read-only SQL)
    ├── POST /api/chat    → Codex subscription or OpenAI-compatible API (tool use, streaming)
    ├── GET/POST /api/codex-auth → ChatGPT login/status/model/disconnect
    └── POST /api/refresh → GitHub API (trigger workflow_dispatch)

GitHub Actions (cron + manual trigger)
    ├── scrape-daily.yml       → Playwright scraper → Neon → Discord
    └── scrape-user-data.yml   → chuumai-tools Docker → Neon

Neon PostgreSQL
    ├── daily_play          — live International data, both games combined
    ├── japan_daily_play    — Journal-derived maimai/CHUNITHM plays + ONGEKI tracks
    ├── user_scores         — International JSONB snapshots from chuumai-tools
    ├── user_rating_images  — latest rendered rating frame per game
    └── codex_oauth_credentials — encrypted OAuth credential + lifecycle state (single user)
```

All secrets stay in Vercel env vars, Neon, and GitHub repo secrets. The browser never receives API keys or ChatGPT access/refresh tokens.

## Setup

Three free accounts (GitHub, Neon, Vercel) plus one SEGA account. Optionally: Discord, an eligible ChatGPT plan, or an OpenAI/Gemini API key.

### 1. Fork this repository

Click **Fork** on [Phudit-2547/ChuMaiNichi](https://github.com/Phudit-2547/ChuMaiNichi).

### 2. Edit `config.json` in your fork

```json
{
  "games": ["maimai", "chunithm"],
  "currency_per_play": 40
}
```

Set `games` to the subset you play. See [Configuration](#configuration) for details.

### 3. Create a Neon database

Sign up at [neon.com](https://neon.com/docs/get-started/signing-up), create a project, and copy the **pooled connection string** from the dashboard. It looks like:

```
postgresql://<user>:<password>@ep-<id>-pooler.<region>.aws.neon.tech/neondb?sslmode=require
```

You'll reuse this string in both GitHub secrets (step 5) and Vercel env vars (step 7).

### 4. Create a Discord webhook (optional)

Follow Discord's [Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks). Create a webhook in the channel where you want daily notifications, then copy its URL. Skip this if you don't want Discord notifications.

### 5. Set GitHub Actions secrets

In your fork: **Settings → Secrets and variables → Actions**. Add:

| Secret | Value |
|---|---|
| `DATABASE_URL` | Neon connection string from step 3 |
| `SEGA_USERNAME` | Your SEGA ID |
| `SEGA_PASSWORD` | Your SEGA password |
| `DISCORD_WEBHOOK_URL` | Discord webhook from step 4 (optional) |

Step-by-step walkthrough (originally for a predecessor repo — *steps are identical, substitute ChuMaiNichi for Chunimai-tracker*): [Fork Chunimai Tracker Repository and Set Up Actions Secrets](https://scribehow.com/viewer/Fork_Chunimai_Tracker_Repository_and_Set_Up_Actions_Secrets__pLeL8YA5S4Kg-7uqWRPD7Q).

### 6. Trigger the first scrape

On your fork: **Actions → Run Scraper → Run workflow** (the workflow file is `scrape-daily.yml`; "Run Scraper" is its display name in the Actions sidebar). The first run:

- Executes `init.sql` to create the tables (idempotent, safe to re-run).
- Logs into your SEGA portal and scrapes today's play count and rating.
- Sends a Discord notification if the webhook is configured.

Wait ~2 minutes for the run to finish.

### 7. Deploy to Vercel

First, create a fine-grained GitHub Personal Access Token (the dashboard's **Refresh scores** button uses it to trigger your fork's GitHub Actions):

1. Open <https://github.com/settings/personal-access-tokens/new>
2. **Token name**: e.g., `ChuMaiNichi Vercel`
3. **Expiration**: pick the longest you're comfortable with (max 1 year for fine-grained tokens)
4. **Repository access**: choose **Only select repositories** and pick your fork (e.g., `yourname/ChuMaiNichi`)
5. **Repository permissions**: scroll down and set **Actions** to **Read and write** (leave everything else untouched)
6. Click **Generate token** at the bottom of the page
7. **Copy the token immediately** — GitHub shows it only once. You'll paste it into Vercel as `GITHUB_PAT` below.

Then import your fork at [vercel.com/new](https://vercel.com/new) and set these env vars during import:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Same Neon connection string |
| `DASHBOARD_PASSWORD` | A strong password — the dashboard will prompt for it |
| `GITHUB_PAT` | Fine-grained PAT with `actions: write` scope on your fork |
| `GITHUB_REPO` | `<your-username>/ChuMaiNichi` |
| `OPENAI_API_KEY` or `GEMINI_API_KEY` | Optional fallback AI provider when ChatGPT is not connected |
| `CODEX_OAUTH_ENCRYPTION_KEY` | Optional: enables ChatGPT subscription login; generate with `openssl rand -base64 32` |

See [Environment variables](#environment-variables) for the full reference including optional vars.

Step-by-step walkthrough: [How To Deploy A Vercel Project With Environment Variables](https://scribehow.com/viewer/How_To_Deploy_A_Vercel_Project_With_Environment_Variables___i1qFMICTWKNabjopvyPQw).

### 8. Visit your dashboard

Open the URL Vercel assigns (`<your-project>.vercel.app`). Enter the `DASHBOARD_PASSWORD` from step 7 when prompted — it's stored in `localStorage`, so you only enter it once per browser.

To use the Codex allowance included with an eligible ChatGPT plan, open **Settings → ChatGPT subscription**, choose **Connect**, then enter the displayed one-time code on the OpenAI verification page. You can choose GPT-5.6 Sol, Terra, or Luna in the same section; the server validates and stores the selection, and the next Assistant message uses it. Only opaque, short-lived login state reaches the browser; the resulting OAuth tokens are encrypted with `CODEX_OAUTH_ENCRYPTION_KEY` and stored in Neon. A server-side login nonce lets Disconnect or a newer login invalidate an in-flight flow. Refresh-token rotation is fail-closed: after an ambiguous timeout or crash the server will not replay the old token, and Settings will ask you to **Reset connection** and connect again.

> **Experimental:** OpenAI officially documents ChatGPT subscription authentication through [Codex App Server](https://learn.chatgpt.com/docs/app-server). This Vercel integration uses the same Codex device-code flow and Responses backend used by Codex clients so it can preserve ChuMaiNichi's existing server-side database tools. That direct backend is not a documented general OpenAI API contract and may need maintenance when Codex changes.

## Configuration

### `config.json`

Single file at repo root, committed to git. Edits require a redeploy to take effect.

```json
{
  "games": ["maimai", "chunithm"],
  "currency_per_play": 40
}
```

| Field | Values | Effect |
|---|---|---|
| `games` | `["maimai"]`, `["chunithm"]`, or both | Which International scrapers run, which International heatmaps render, and whether the maimai song-suggestion AI tool is available |
| `currency_per_play` | Integer (THB) | Used in spending calculations shown on the dashboard and in Discord notifications |

**Do not put secrets here.** This file is public.

### Environment variables

**Vercel (server-side; never exposed to the browser):**

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Neon PostgreSQL connection string |
| `DASHBOARD_PASSWORD` | yes | Bearer-token password for all `/api/*` routes |
| `GITHUB_PAT` | yes | Fine-grained PAT for triggering `workflow_dispatch` |
| `GITHUB_REPO` | yes | `<your-username>/ChuMaiNichi` |
| `OPENAI_API_KEY` | optional fallback | OpenAI-compatible key (used if ChatGPT is disconnected and `GEMINI_API_KEY` is not set) |
| `OPENAI_BASE_URL` | optional | Custom base URL; defaults to OpenAI |
| `GEMINI_API_KEY` | optional fallback | Google Gemini key (takes priority over `OPENAI_API_KEY`) |
| `AI_MODEL` | optional | Model override; default `gemini-2.5-flash` (Gemini) or `gpt-4o-mini` (OpenAI) |
| `CODEX_OAUTH_ENCRYPTION_KEY` | for ChatGPT login | Exactly 32 random bytes encoded as 64-character hex or padded Base64; encrypts OAuth state and credentials |
| `CODEX_MODEL` | optional | Initial Codex model before Settings saves a server-side choice; one of `gpt-5.6-sol`, `gpt-5.6-terra` (default), or `gpt-5.6-luna` |

**GitHub Actions secrets:**

| Secret | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Same Neon connection string |
| `SEGA_USERNAME` | yes | SEGA ID |
| `SEGA_PASSWORD` | yes | SEGA password |
| `DISCORD_WEBHOOK_URL` | optional | Enables daily Discord notifications |

## How it works

**Daily scrape (22:00 Asia/Bangkok).** GitHub Actions runs a Playwright scraper that logs into your SEGA portal, reads today's play count and rating, and upserts one row per date into `daily_play`. A Discord webhook sends the summary.

**Manual refresh.** Clicking **Refresh scores** on the dashboard calls `/api/refresh`, which triggers `scrape-user-data.yml`. That runs the `leomotors/chuumai-tools` Docker scrapers to fetch your full song-score history and stores it as a JSONB snapshot in `user_scores`. Takes ~2 minutes.

**Japan Journal import.** The Japan view is intentionally not scraped. Run `uv run python import_japan_journal.py /path/to/Obsidian/Journal` from `scraper/` for a dry run, then add `--apply` to upsert the audited series into `japan_daily_play`. An explicit dash carries the previous cumulative value forward; an omitted total must have a non-negative audited daily count in `japan_daily_attribution.json` or the importer stops. Cells whose daily count uses a user-estimated ambiguous split display `*`; deterministic differences between audited totals do not. ONGEKI is stored in tracks.

**AI chat.** The right-sidebar chat streams responses from `/api/chat`. A connected ChatGPT/Codex credential takes precedence; otherwise the route uses the configured Gemini/OpenAI-compatible fallback. Both paths keep the same tools and browser SSE protocol:

- `query_database` — generates and runs read-only SQL against your Neon database. A shared application-layer guard excludes the private OAuth table and PostgreSQL system catalogs, and restricts callable SQL functions to a small analytics allowlist.
- `maimai_suggest_songs` (maimai only) — given your current scores, finds songs where extra practice most efficiently raises your DX rating (greedy search over top-35 old + top-15 new).

The SQL guard keeps the dashboard and AI query paths from reading `codex_oauth_credentials`, but it is application-layer defense rather than PostgreSQL role isolation. Keep the guard centralized and its adversarial tests when extending the query vocabulary.

## Project structure

```
ChuMaiNichi/
├── .github/workflows/   # GitHub Actions (daily scrape, user-data refresh, songs cache)
├── scraper/             # Python scrapers + Japan Journal importer
├── api/                 # Vercel serverless functions (query, chat, refresh)
├── src/                 # React frontend
├── public/              # Cached maimai-songs.json (chart constants)
├── config.json          # ← edit this after forking
└── CLAUDE.md            # Implementation spec (deeper technical reference)
```

See `CLAUDE.md` for the full database schema, rating formula, and song-suggestion algorithm.

## Roadmap

- [ ] CHUNITHM song suggestion (maimai done; CHUNITHM deferred)
- [ ] SEGA news ingestion — scrape `info-chunithm.sega.com` and `info-maimai.sega.com`, cache as JSON/Markdown, and expose to the AI agent as tool-accessible knowledge (event schedules, version updates, song additions)
- [ ] Keyboard navigation — shortcuts for toggling the chat panel, opening settings, triggering refresh, and focusing the chat input
- [ ] Update AI system prompt — surface ingested SEGA news, refine tool-use guidance, and tune tone/response length

## Acknowledgements

- [leomotors/chuumai-tools](https://github.com/Leomotors/chuumai-tools) — per-song score scraper Docker images.
- [maimai.wonderhoy.me](https://maimai.wonderhoy.me/) — maimai song catalog and chart constants.
- This repo merges two predecessors: [Chunimai-tracker](https://github.com/Phudit-2547/Chunimai-tracker) (Playwright scraper) and [Chunimai_dashboard](https://github.com/Phudit-2547/Chunimai_dashboard) (old UI, fully rewritten).

## License

[MIT](LICENSE).
