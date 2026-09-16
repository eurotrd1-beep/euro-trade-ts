-- ════════════════════════════════════════════════════════════════════════════
-- The schema, in SQLite — what Postgres was holding, minus the types it had.
--
-- ── TIME ───────────────────────────────────────────────────────────────────
--
-- SQLite has no date type. `timestamptz` becomes INTEGER holding Unix
-- MILLISECONDS, never a string, and the reason is that the string form fails
-- silently: '2026-09-16T12:00:00Z' < '2026-09-16T9:00:00Z' is TRUE in a text
-- comparison, so a pruning query written that way deletes the wrong rows and
-- reports success. Integers cannot be compared wrongly.
--
-- Every column is suffixed `_ms` so a reader never has to guess the unit, and
-- so a value in seconds assigned to one of them looks wrong on sight — the
-- feed speaks seconds and the database speaks milliseconds, and that boundary
-- is where the two used to get mixed up.
--
-- ── JSON ───────────────────────────────────────────────────────────────────
--
-- `jsonb` becomes TEXT with a `json_valid` CHECK. SQLite's JSON1 can query it
-- (`json_extract`), which is all the Postgres side was doing. The CHECK matters
-- more than it looks: without it a failed serialisation writes the string
-- "[object Object]" and every later read returns it without complaint.
--
-- ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
--
-- No RLS, because SQLite has none. Access lives in `src/access.ts`, as a
-- whitelist with a test that fails the build when a table here has no entry
-- there. A table added to this file and nowhere else is a red build.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Prices and candles ─────────────────────────────────────────────────────

-- One row per symbol+timeframe, holding up to 100 candles as JSON. Shaped like
-- the Postgres table on purpose: the scraper writes the whole array each time,
-- and splitting it into one row per candle would multiply the write count by a
-- hundred against a hard daily limit.
CREATE TABLE IF NOT EXISTS candles (
  key         TEXT PRIMARY KEY,               -- '<symbol>_<interval>'
  data        TEXT NOT NULL CHECK (json_valid(data)),
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS candles_updated ON candles (updated_ms);

CREATE TABLE IF NOT EXISTS price_snapshot (
  id          TEXT PRIMARY KEY,               -- always 'otc_prices'
  data        TEXT NOT NULL CHECK (json_valid(data)),
  updated_ms  INTEGER NOT NULL
);

-- ── Catalogue and settings ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS configs (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL CHECK (json_valid(data)),
  updated_ms  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pairs (
  id            TEXT PRIMARY KEY,
  symbol        TEXT NOT NULL,                -- display name: 'Gold OTC'
  chart_symbol  TEXT NOT NULL,                -- feed symbol: 'XAUUSD_otc'
  category      TEXT,
  type          TEXT,
  source        TEXT,
  is_otc        INTEGER NOT NULL DEFAULT 0,   -- SQLite has no boolean
  enabled       INTEGER NOT NULL DEFAULT 0,   -- closed by default, as in Postgres
  "order"       INTEGER NOT NULL DEFAULT 0,   -- reserved word, hence quoted
  created_ms    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pairs_chart_symbol ON pairs (chart_symbol);

CREATE TABLE IF NOT EXISTS otc_pairs (
  id           TEXT PRIMARY KEY,
  platform     TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  name         TEXT,
  asset_type   TEXT,
  subcategory  TEXT,
  is_otc       INTEGER NOT NULL DEFAULT 0,
  -- Closed by default. A symbol the platform starts advertising tomorrow must
  -- arrive switched off and wait for a decision, not start storing itself.
  enabled      INTEGER NOT NULL DEFAULT 0,
  "order"      INTEGER NOT NULL DEFAULT 0,
  updated_ms   INTEGER NOT NULL,
  UNIQUE (platform, symbol)
);

CREATE TABLE IF NOT EXISTS brokers (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL CHECK (json_valid(data)),
  updated_ms  INTEGER NOT NULL
);

-- ── Accounts ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,           -- the id typed into the box
  role            TEXT NOT NULL DEFAULT 'standard',
  vip_expiry_ms   INTEGER,
  device_id       TEXT,                       -- VIP is bound to one device
  guaranteed_win  INTEGER NOT NULL DEFAULT 0,
  banned          INTEGER NOT NULL DEFAULT 0,
  broker          TEXT,
  created_ms      INTEGER NOT NULL,
  seen_ms         INTEGER
);

-- One row per account, holding its trades as JSON. Postgres had `allow all` on
-- this — any holder of the anon key could read or overwrite anyone's history.
-- The move is the moment that ends: see `signal_history` in access.ts.
CREATE TABLE IF NOT EXISTS signal_history (
  account_id  TEXT PRIMARY KEY,
  signals     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(signals)),
  updated_ms  INTEGER NOT NULL
);

-- ── The published record ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signals (
  id                   TEXT PRIMARY KEY,
  symbol               TEXT NOT NULL,
  timeframe            TEXT NOT NULL,
  direction            TEXT NOT NULL,
  bar_ms               INTEGER NOT NULL,
  strategy_version_id  TEXT,
  slot                 TEXT,
  confidence           REAL,
  score                REAL,
  rules_matched        TEXT CHECK (rules_matched IS NULL OR json_valid(rules_matched)),
  candle_snapshot      TEXT CHECK (candle_snapshot IS NULL OR json_valid(candle_snapshot)),
  entry_price          REAL,
  exit_price           REAL,
  expiry_seconds       INTEGER,
  outcome              TEXT,                  -- win | loss | tie | unresolved
  forced               INTEGER NOT NULL DEFAULT 0,
  created_ms           INTEGER NOT NULL,
  resolved_ms          INTEGER
);
-- The uniqueness `record_signals` depends on. Its `ON CONFLICT DO NOTHING` is
-- the whole race guard: the insert either takes the row or lands on the one
-- already there, and landing means "already recorded". Without this index the
-- conflict never fires and the same signal is written twice under load.
CREATE UNIQUE INDEX IF NOT EXISTS signals_identity
  ON signals (strategy_version_id, symbol, timeframe, bar_ms);
CREATE INDEX IF NOT EXISTS signals_created ON signals (created_ms);
CREATE INDEX IF NOT EXISTS signals_open ON signals (outcome) WHERE outcome IS NULL;

CREATE TABLE IF NOT EXISTS signal_daily (
  day          TEXT NOT NULL,                 -- 'YYYY-MM-DD', UTC
  symbol       TEXT NOT NULL,
  signals      INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  losses       INTEGER NOT NULL DEFAULT 0,
  ties         INTEGER NOT NULL DEFAULT 0,
  unresolved   INTEGER NOT NULL DEFAULT 0,
  pending      INTEGER NOT NULL DEFAULT 0,
  forced       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, symbol)
);

CREATE TABLE IF NOT EXISTS signal_write_budget (
  day        TEXT PRIMARY KEY,
  written    INTEGER NOT NULL DEFAULT 0,
  max_rows   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  strategy_json  TEXT NOT NULL CHECK (json_valid(strategy_json)),
  published      INTEGER NOT NULL DEFAULT 0,
  created_ms     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_version_stats (
  version_id  TEXT PRIMARY KEY,
  data        TEXT NOT NULL CHECK (json_valid(data)),
  updated_ms  INTEGER NOT NULL
);

-- ── Notifications ──────────────────────────────────────────────────────────

-- Device push credentials. This is the table that was world-readable in
-- Postgres for months, handing out p256dh and auth keys with the account they
-- belong to. It is `never` readable over HTTP in access.ts, and that is not a
-- precaution — it is the fix for something that actually happened.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint      TEXT PRIMARY KEY,             -- the endpoint IS the device
  user_id       TEXT,
  subscription  TEXT NOT NULL CHECK (json_valid(subscription)),
  symbols       TEXT CHECK (symbols IS NULL OR json_valid(symbols)),
  plan          TEXT,
  failures      INTEGER NOT NULL DEFAULT 0,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);

-- Both alert tables exist for one reason: the primary key IS the duplicate
-- guard. An insert either takes the key or collides, and a collision means
-- "already sent". No select-then-insert, so no race sends twice.
CREATE TABLE IF NOT EXISTS push_alerts (
  event_key  TEXT PRIMARY KEY,
  sent_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_alerts_sent ON push_alerts (sent_ms);

CREATE TABLE IF NOT EXISTS telegram_alerts (
  event_key  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('eligible', 'signal', 'result', 'daily')),
  sent_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS telegram_alerts_sent ON telegram_alerts (sent_ms);

CREATE TABLE IF NOT EXISTS telegram_queue (
  id          TEXT PRIMARY KEY,
  event_key   TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL CHECK (json_valid(payload)),
  state       TEXT NOT NULL DEFAULT 'pending',
  created_ms  INTEGER NOT NULL,
  decided_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS telegram_queue_state ON telegram_queue (state, created_ms);

-- ── Housekeeping ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clicks (
  id     TEXT PRIMARY KEY,
  data   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data))
);

CREATE TABLE IF NOT EXISTS repair_log (
  id          TEXT PRIMARY KEY,
  stage       TEXT,
  detail      TEXT,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS repair_log_created ON repair_log (created_ms);

CREATE TABLE IF NOT EXISTS captcha_stats (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL CHECK (json_valid(data)),
  updated_ms  INTEGER NOT NULL
);
