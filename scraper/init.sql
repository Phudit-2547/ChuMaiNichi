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

-- Collapse same-day snapshots (keep newest per game per BKK day) before
-- enforcing the unique index. Safe to re-run: once the index exists no
-- duplicates can be created.
DELETE FROM public.user_scores
WHERE id IN (
    SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY game, (scraped_at AT TIME ZONE 'Asia/Bangkok')::date
                   ORDER BY scraped_at DESC, id DESC
               ) AS rn
        FROM public.user_scores
    ) ranked
    WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS user_scores_game_day_bkk_key
    ON public.user_scores (game, ((scraped_at AT TIME ZONE 'Asia/Bangkok')::date));
