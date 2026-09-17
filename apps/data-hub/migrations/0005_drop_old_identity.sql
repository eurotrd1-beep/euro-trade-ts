-- ════════════════════════════════════════════════════════════════════════════
-- The old duplicate guard, now that nothing points at it.
--
-- `signals_identity` was UNIQUE on (strategy_version_id, symbol, timeframe,
-- bar_ms) and never rejected a row, because every version is NULL and NULLs do
-- not compare equal. `0004` built its replacement; the Worker deploy between
-- the two moved `ON CONFLICT` onto it.
--
-- Run this only AFTER that deploy. Between the two, both indexes exist and an
-- insert writes one extra entry — which is the price of having no window where
-- the pipeline cannot record a signal.
--
-- Dropping it puts the per-insert cost back where it was: four rows written,
-- the row itself plus three indexes.
-- ════════════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS signals_identity;
