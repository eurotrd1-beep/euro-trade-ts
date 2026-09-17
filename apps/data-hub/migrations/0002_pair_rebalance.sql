-- ════════════════════════════════════════════════════════════════════════════
-- The twenty-five, reweighted to OTC — and one pair removed for being shut.
--
-- The first shortlist kept twelve real-market pairs and thirteen OTC. This
-- flips that: eighteen OTC against seven real-market majors. The count does not
-- change, so the write budget the number was chosen for does not change either
-- (25 × 1,611 candle upserts ≈ 49% of D1's 100,000 daily row writes).
--
-- ── WHY OTC IS THE MAJORITY ────────────────────────────────────────────────
--
-- The real market closes Friday night and opens Sunday night. The OTC book does
-- not. A catalogue weighted to the real market is therefore a product that
-- shrinks to a third of itself every weekend, and the weekend is not a quiet
-- period for this app — it is when people have time to trade. Weighting the
-- other way makes Saturday the same product as Tuesday.
--
-- Seven real-market pairs remain because the real market is the honest one when
-- it is open: OTC instruments are synthetic prices published by the broker, and
-- keeping the largest USD pairs plus GBP/JPY means the strategy is never
-- measured only against prices the counterparty invents.
--
-- ── WHY EUR/JPY OTC IS GONE ────────────────────────────────────────────────
--
-- It was in the first twenty-five and it should not have been. Pocket Option
-- reports it N/V — its own flag for an asset that cannot be traded — while
-- still streaming a moving price for it. The app reads that flag correctly
-- (`po: false` → مغلق) so the pair showed as closed while every other one was
-- open, which is what made it visible.
--
-- The selection is what was wrong, not the closed-market logic. The first list
-- was validated by asking whether candles were still arriving, and a price that
-- keeps moving is not the same fact as an asset that can be traded. Every pair
-- below was re-checked against the broker's own flag instead: all twenty-five
-- reported open, none N/V.
--
-- ── THE PAIRS THAT ARRIVED WITH THIS ───────────────────────────────────────
--
-- AUDCAD, CADJPY, NZDJPY, AUDNZD, CADCHF, GBPAUD and CHFJPY — all OTC, all
-- confirmed open by the same check, all previously unverifiable because they
-- were not enabled and so were not being streamed.
-- ════════════════════════════════════════════════════════════════════════════

-- ── The list, stated once ──────────────────────────────────────────────────
--
-- A scratch table rather than the symbols repeated in each statement below.
-- The first shortlist wrote its list into a `pair_kept()` function for exactly
-- this reason; SQLite has no user-defined functions from SQL, so this is the
-- nearest equivalent that still states the list a single time.
--
-- Not TEMP: D1 answers `CREATE TEMP TABLE` with SQLITE_AUTH. A real table is
-- what is left, and it is dropped at the end. Wrangler rolls the whole file
-- back on any failure, so it cannot survive a half-run.
DROP TABLE IF EXISTS _kept;
CREATE TABLE _kept (symbol TEXT PRIMARY KEY);
INSERT INTO _kept (symbol) VALUES
  -- OTC currency pairs — eighteen with gold, and the reason there is a weekend
  ('EURUSD_otc'), ('USDJPY_otc'), ('GBPUSD_otc'), ('USDCHF_otc'),
  ('USDCAD_otc'), ('AUDUSD_otc'), ('NZDUSD_otc'), ('GBPJPY_otc'),
  ('EURCHF_otc'), ('AUDJPY_otc'), ('CHFJPY_otc'), ('AUDCAD_otc'),
  ('CADJPY_otc'), ('NZDJPY_otc'), ('AUDNZD_otc'), ('CADCHF_otc'),
  ('GBPAUD_otc'),
  -- Gold, OTC only: the real XAUUSD feed stopped ~28 days before the rest
  ('XAUUSD_otc'),
  -- The real market, majors only
  ('EURUSD'), ('USDJPY'), ('GBPUSD'), ('USDCHF'),
  ('USDCAD'), ('AUDUSD'), ('GBPJPY');

-- ── The catalogue: disable, never delete ───────────────────────────────────
--
-- `otc_pairs` is refilled from Pocket Option's own asset scan, which upserts
-- every symbol the platform advertises. A deleted row comes back on the next
-- scan; a disabled one does not re-enable, because `enabled` is deliberately
-- absent from that upsert's payload.
UPDATE otc_pairs SET enabled = 0, updated_ms = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE enabled = 1 AND symbol NOT IN (SELECT symbol FROM _kept);

UPDATE otc_pairs SET enabled = 1, updated_ms = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE symbol IN (SELECT symbol FROM _kept) AND enabled IS NOT 1;

-- ── The list the app renders ───────────────────────────────────────────────
--
-- Deleted rather than disabled, unlike the catalogue above. `pairs` is not
-- rebuilt by the asset scan, so a delete sticks — and every row here is sent to
-- every phone on every app load, where the client filters `enabled`. Sixty-four
-- rows that are filtered out on arrival are sixty-four rows of bandwidth spent
-- to display nothing. The catalogue in `otc_pairs` is how any of them come back.
DELETE FROM pairs WHERE chart_symbol NOT IN (SELECT symbol FROM _kept);

-- ── Candles for symbols nobody can trade ───────────────────────────────────
DELETE FROM candles
 WHERE CASE
         WHEN key LIKE '%\_1m'  ESCAPE '\' THEN substr(key, 1, length(key) - 3)
         WHEN key LIKE '%\_5m'  ESCAPE '\' THEN substr(key, 1, length(key) - 3)
         WHEN key LIKE '%\_15m' ESCAPE '\' THEN substr(key, 1, length(key) - 4)
         WHEN key LIKE '%\_30m' ESCAPE '\' THEN substr(key, 1, length(key) - 4)
         WHEN key LIKE '%\_1h'  ESCAPE '\' THEN substr(key, 1, length(key) - 3)
         WHEN key LIKE '%\_1D'  ESCAPE '\' THEN substr(key, 1, length(key) - 3)
         ELSE key
       END NOT IN (SELECT symbol FROM _kept);

DROP TABLE _kept;
