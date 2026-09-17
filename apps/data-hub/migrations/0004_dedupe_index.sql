-- ════════════════════════════════════════════════════════════════════════════
-- A duplicate guard that actually guards.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--
-- `signals_identity` is UNIQUE on (strategy_version_id, symbol, timeframe,
-- bar_ms), and `record_signals` names those four columns in its
-- `ON CONFLICT … DO NOTHING`. Every signal the running strategy writes has
-- `strategy_version_id = NULL` — 12,778 rows of 12,778 — and NULLs are distinct
-- in a unique index. So the conflict never fires and the guard has never once
-- rejected a row.
--
-- Postgres had exactly the same constraint, and it was equally inert there.
-- This is not a porting defect; it is a rule that never worked in either
-- engine, and it went unnoticed because for a long time only one process was
-- writing. When two were, it cost 94 duplicate rows in a day — including two
-- pairs where the copies disagreed about whether the trade won or lost.
--
-- ── WHY BOTH CHANGES, AND WHY THAT IS THE DANGEROUS PART ──────────────────
--
-- Two things are wrong with the old key, and fixing either one alone is worse
-- than fixing neither:
--
--   COALESCE without `slot`   One bar legitimately carries four rows, one per
--                             slot — instant_free, instant_paid,
--                             monitoring_free, monitoring_paid. Make NULLs
--                             compare equal and those four collapse into one:
--                             6,445 rows of the current table, three of every
--                             four signals, silently dropped by DO NOTHING.
--
--   `slot` without COALESCE   Still NULL against NULL. Still inert.
--
-- Together they say the thing the data actually means: one row per version,
-- symbol, timeframe, bar and slot. Verified against the live table before
-- writing this — zero groups under that key hold more than one direction, so
-- `direction` is not part of the identity and adding it would be guessing.
--
-- ── WHY A NEW NAME, AND WHY THE OLD INDEX STAYS FOR NOW ───────────────────
--
-- SQLite matches an `ON CONFLICT` target against an existing index. Drop the
-- old index before the new code ships and every insert fails with "no matching
-- index"; ship the new code before the index exists and the same. Either order
-- has a window where the signal pipeline records nothing.
--
-- So the new index is built ALONGSIDE the old one under a different name. Both
-- exist for as long as it takes to deploy the Worker, during which an insert
-- writes one extra index entry and nothing breaks. `0005` drops the old one
-- afterwards.
--
-- ── COST ──────────────────────────────────────────────────────────────────
--
-- One entry per row, once: about 12,800 row writes, ~13% of the free plan's
-- daily allowance. It does not recur — the table is bounded at roughly thirty
-- days by prune_signals, and this REPLACES an index rather than adding one, so
-- an insert still writes four rows once 0005 has run.
--
-- The sentinel is the one `signal_daily` already uses for the same reason, so
-- there is one answer in this schema to "what stands in for a missing
-- version". Zero rows carry it as a real value.
-- ════════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS signals_identity_slot ON signals (
  COALESCE("strategy_version_id", '00000000-0000-0000-0000-000000000000'),
  "symbol",
  "timeframe",
  "bar_ms",
  "slot"
);
