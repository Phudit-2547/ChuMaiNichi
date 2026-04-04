-- Initialize the daily_play table in the local Postgres
CREATE TABLE IF NOT EXISTS public.daily_play (
    play_date       DATE PRIMARY KEY,
    maimai_play_count    INTEGER DEFAULT 0,
    chunithm_play_count  INTEGER DEFAULT 0,
    maimai_cumulative    INTEGER DEFAULT 0,
    chunithm_cumulative  INTEGER DEFAULT 0,
    maimai_rating        NUMERIC,
    chunithm_rating      NUMERIC,
    scrape_failed        BOOLEAN DEFAULT FALSE,
    failure_reason       TEXT
);

-- Per-song score snapshots (JSONB from chuumai-tools)
CREATE TABLE IF NOT EXISTS public.user_scores (
    id         SERIAL PRIMARY KEY,
    game       TEXT NOT NULL,
    scraped_at TIMESTAMPTZ DEFAULT NOW(),
    data       JSONB NOT NULL
);
