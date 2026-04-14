-- NZR Platform: Add trade context columns to journal table
-- Run this in the Supabase SQL Editor (https://app.supabase.com → SQL Editor)
-- These columns capture the full signal context at trade entry and exit.
-- All columns are nullable so existing rows and manual trades are unaffected.

-- Entry context columns
ALTER TABLE journal ADD COLUMN IF NOT EXISTS strategy         text;
ALTER TABLE journal ADD COLUMN IF NOT EXISTS nzr_score        integer;
ALTER TABLE journal ADD COLUMN IF NOT EXISTS rsi_at_entry     real;
ALTER TABLE journal ADD COLUMN IF NOT EXISTS macd_hist_at_entry real;
ALTER TABLE journal ADD COLUMN IF NOT EXISTS ema_trend        text;       -- BULL / BEAR
ALTER TABLE journal ADD COLUMN IF NOT EXISTS ema_cross        text;       -- GOLDEN / DEATH
ALTER TABLE journal ADD COLUMN IF NOT EXISTS volume_vs_avg    text;       -- ABOVE / BELOW
ALTER TABLE journal ADD COLUMN IF NOT EXISTS spy_change_pct   real;
ALTER TABLE journal ADD COLUMN IF NOT EXISTS vix_level        real;
ALTER TABLE journal ADD COLUMN IF NOT EXISTS sector_etf       text;       -- e.g. XLK, XLF
ALTER TABLE journal ADD COLUMN IF NOT EXISTS sector_etf_change_pct real;
ALTER TABLE journal ADD COLUMN IF NOT EXISTS filters_bypassed text;       -- e.g. "LOW_VOL(bypassed), RSI=71.2(penalty -10)"

-- Exit context columns
ALTER TABLE journal ADD COLUMN IF NOT EXISTS exit_reason              text;  -- PROFIT_TARGET, STOP_LOSS, TRAILING_1PCT_HIT, AUTOCLOSE, etc.
ALTER TABLE journal ADD COLUMN IF NOT EXISTS hold_duration_minutes    integer;

-- Ensure created_at exists with a default (may already exist)
ALTER TABLE journal ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Optional: backfill strategy from notes for existing rows
-- UPDATE journal SET strategy = 'COMBINED' WHERE strategy IS NULL AND notes LIKE 'Bot: COMBINED%';
-- UPDATE journal SET strategy = 'SCAN'     WHERE strategy IS NULL AND notes LIKE 'Bot: SCAN%';
