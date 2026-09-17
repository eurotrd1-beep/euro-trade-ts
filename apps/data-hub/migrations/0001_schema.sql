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
-- NO INDEX ON updated_ms, deliberately.
--
-- There was one, and it cost more than everything it saved. D1 bills index
-- writes as row writes, so every candle upsert cost two instead of one — and
-- candle upserts are the single largest write source in the system, measured
-- at 1,611 per pair per day. The index doubled the cost of the busiest table
-- in the database.
--
-- Nothing read it. Every query against `candles` is by `key`, which is the
-- primary key; the table is bounded at one row per symbol+timeframe and is
-- never pruned by age, so there is no range scan over time to serve.
--
-- Halving that write cost is the difference between 22 pairs and 28 at the
-- same fraction of the daily limit.

CREATE TABLE IF NOT EXISTS price_snapshot (
  id          TEXT PRIMARY KEY,               -- always 'otc_prices'
  data        TEXT NOT NULL CHECK (json_valid(data)),
  updated_ms  INTEGER NOT NULL
);

-- ── Catalogue and settings ─────────────────────────────────────────────────

-- Two columns. The live table has no `updated_at` — a third column here would
-- be one nothing ever fills, which reads as a timestamp that is always missing
-- rather than as a column that should not exist.
CREATE TABLE IF NOT EXISTS configs (
  id    TEXT PRIMARY KEY,
  data  TEXT NOT NULL CHECK (json_valid(data))
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
  created_ms   INTEGER,
  updated_ms   INTEGER NOT NULL,
  UNIQUE (platform, symbol)
);

-- The broker list on the login screen. Sixteen columns, not the `data` blob an
-- earlier draft of this file had: `BrokerRow` in packages/shared has always
-- said so, and the live table agrees.
CREATE TABLE IF NOT EXISTS brokers (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  logo_url           TEXT,
  chart_url          TEXT,
  registration_link  TEXT,
  desc               TEXT,
  click_key          TEXT,
  promo_code         TEXT,
  bonus_percent      REAL,
  min_deposit        REAL,
  is_active          INTEGER NOT NULL DEFAULT 0,
  is_recommended     INTEGER NOT NULL DEFAULT 0,
  "order"            INTEGER NOT NULL DEFAULT 0,
  -- camelCase in the database, deliberately. It is spelled that way in
  -- Postgres and the admin writes it by that name; "correcting" it here would
  -- rename a column during a copy, which is the same as dropping it.
  themeColor         TEXT,
  created_ms         INTEGER,
  updated_ms         INTEGER
);

-- ── Accounts ───────────────────────────────────────────────────────────────

-- Column-for-column with the live Postgres table, checked against `UserRow` in
-- packages/shared/src/database.ts and against every read in the app and the
-- admin. An earlier draft of this file invented names — `banned` for
-- `is_banned`, a `seen_ms` nothing writes — and dropped four columns that are
-- read today. A rename here is not a rename: it is a column that arrives empty
-- after the copy, and `is_banned` arriving empty unbans everyone.
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,           -- the id typed into the box
  broker          TEXT,
  role            TEXT NOT NULL DEFAULT 'standard',
  is_banned       INTEGER NOT NULL DEFAULT 0, -- SQLite has no boolean
  ban_reason      TEXT,                       -- shown on the splash, boot.ts
  device_id       TEXT,                       -- VIP is bound to one device
  fcm_token       TEXT,
  login_count     INTEGER NOT NULL DEFAULT 0,
  vip_expiry_ms   INTEGER,                    -- was timestamptz `vip_expiry`
  guaranteed_win  INTEGER NOT NULL DEFAULT 0,
  clicked_broker  TEXT,                       -- set once, at first login
  created_ms      INTEGER NOT NULL            -- was timestamptz `created_at`
);
-- The admin lists users newest first and filters by role.
CREATE INDEX IF NOT EXISTS users_created ON users (created_ms);
CREATE INDEX IF NOT EXISTS users_role ON users (role);

-- One row per account, holding its trades as JSON. Postgres had `allow all` on
-- this — any holder of the anon key could read or overwrite anyone's history.
-- The move is the moment that ends: see `signal_history` in access.ts.
CREATE TABLE IF NOT EXISTS signal_history (
  account_id  TEXT PRIMARY KEY,
  signals     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(signals)),
  updated_ms  INTEGER NOT NULL,
  -- Carried over from Postgres, and it is a safety cap, not the product's cap:
  -- the app trims to fifty, and this stops a hostile client turning one row
  -- into megabytes. If the app's limit ever rises, this has to rise first.
  CHECK (json_array_length(signals) <= 200)
);

-- ── The published record ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signals (
  -- `bigint GENERATED ALWAYS AS IDENTITY` in Postgres. INTEGER PRIMARY KEY is
  -- SQLite's rowid alias, the only form that auto-assigns, and the copied ids
  -- keep the values they already have.
  id                   INTEGER PRIMARY KEY,
  created_ms           INTEGER NOT NULL,
  symbol               TEXT NOT NULL,
  timeframe            TEXT NOT NULL,
  direction            TEXT NOT NULL CHECK (direction IN ('CALL', 'PUT')),
  -- The close of the candle the signal was generated on. Not decoration: it is
  -- what stops a proxy restart re-evaluating the same candle into a second row.
  bar_ms               INTEGER NOT NULL,
  strategy_version_id  TEXT,
  slot                 TEXT NOT NULL,
  confidence           REAL,
  score                REAL,
  rules_matched        TEXT CHECK (rules_matched IS NULL OR json_valid(rules_matched)),
  -- `double precision[]` in Postgres — the last five candles as raw numbers.
  -- SQLite has no array type, so it becomes a JSON array of the same numbers.
  candle_snapshot      TEXT CHECK (candle_snapshot IS NULL OR json_valid(candle_snapshot)),
  entry_price          REAL NOT NULL,
  expiry_seconds       INTEGER NOT NULL,
  -- `unresolved` is not `tie`. "No price available" recorded as a tie inflates
  -- the ties and nobody can tell why. Both are excluded from the win rate.
  outcome              TEXT NOT NULL DEFAULT 'pending'
                       CHECK (outcome IN ('pending', 'win', 'loss', 'tie', 'unresolved')),
  outcome_price        REAL,
  outcome_ms           INTEGER,
  -- An admin-forced guaranteed_win signal. Excluded from every calculation and
  -- shown in a column of its own — recorded without this flag, the published
  -- rate is a fabrication.
  forced               INTEGER NOT NULL DEFAULT 0
);
-- The uniqueness `record_signals` depends on. Its `ON CONFLICT DO NOTHING` is
-- the whole race guard: the insert either takes the row or lands on the one
-- already there, and landing means "already recorded". Without this index the
-- conflict never fires and the same signal is written twice under load.
CREATE UNIQUE INDEX IF NOT EXISTS signals_identity
  ON signals (strategy_version_id, symbol, timeframe, bar_ms);
CREATE INDEX IF NOT EXISTS signals_created ON signals (created_ms);
-- An open signal is `outcome = 'pending'`, never NULL: the column is NOT NULL
-- with a default, so an `IS NULL` index here would match nothing, for ever,
-- and in silence.
CREATE INDEX IF NOT EXISTS signals_open ON signals (outcome) WHERE outcome = 'pending';

-- One row per day, version, symbol, timeframe and slot.
--
-- The key is five columns and every one of them earns its place. This table was
-- built once with a key that left the slot out, and the Postgres migration that
-- fixed it had to DELETE every row, because three out of every four had
-- overwritten each other. A key that is too short does not collide loudly — it
-- merges rows that are not the same row, and the numbers stay plausible.
CREATE TABLE IF NOT EXISTS signal_daily (
  day                  TEXT NOT NULL,              -- 'YYYY-MM-DD', UTC
  strategy_version_id  TEXT,                       -- nullable: versionless stats
  symbol               TEXT NOT NULL,
  timeframe            TEXT NOT NULL,
  slot                 TEXT NOT NULL,
  signals              INTEGER NOT NULL DEFAULT 0,
  wins                 INTEGER NOT NULL DEFAULT 0,
  losses               INTEGER NOT NULL DEFAULT 0,
  ties                 INTEGER NOT NULL DEFAULT 0,
  unresolved           INTEGER NOT NULL DEFAULT 0,
  pending              INTEGER NOT NULL DEFAULT 0,
  forced               INTEGER NOT NULL DEFAULT 0
);
-- A UNIQUE INDEX rather than a PRIMARY KEY, and COALESCE for the same reason
-- Postgres needed both: a primary key cannot hold NULL, and the version is
-- legitimately NULL for versionless statistics. Without the COALESCE every
-- versionless row is distinct from every other one and they stop merging at all.
CREATE UNIQUE INDEX IF NOT EXISTS signal_daily_key ON signal_daily (
  day,
  COALESCE(strategy_version_id, '00000000-0000-0000-0000-000000000000'),
  symbol, timeframe, slot
);

CREATE TABLE IF NOT EXISTS signal_write_budget (
  day        TEXT PRIMARY KEY,
  written    INTEGER NOT NULL DEFAULT 0,
  capped     INTEGER NOT NULL DEFAULT 0,
  max_rows   INTEGER NOT NULL DEFAULT 20000
);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id              TEXT PRIMARY KEY,              -- uuid
  slot            TEXT NOT NULL CHECK (slot IN
                    ('instant_free', 'instant_paid', 'monitoring_free', 'monitoring_paid')),
  version_number  INTEGER NOT NULL,
  uploaded_ms     INTEGER NOT NULL,
  uploaded_by     TEXT,
  name            TEXT NOT NULL,
  strategy_json   TEXT NOT NULL CHECK (json_valid(strategy_json)),
  json_hash       TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (slot, version_number)
);

-- NOT A TABLE. In Postgres this is a view over strategy_versions and
-- signal_daily, and copying it would copy an aggregate that is correct for one
-- instant and wrong from the next write onwards.
--
-- One row per version instead of the ~21,000 raw rows a month: the difference
-- between a query measured in kilobytes and one measured in megabytes.
CREATE VIEW IF NOT EXISTS strategy_version_stats AS
SELECT v.id, v.slot, v.version_number, v.name, v.uploaded_ms, v.uploaded_by,
       v.is_active, v.json_hash,
       COALESCE(SUM(d.signals), 0)    AS signals,
       COALESCE(SUM(d.wins), 0)       AS wins,
       COALESCE(SUM(d.losses), 0)     AS losses,
       COALESCE(SUM(d.ties), 0)       AS ties,
       COALESCE(SUM(d.unresolved), 0) AS unresolved,
       COALESCE(SUM(d.pending), 0)    AS pending,
       COALESCE(SUM(d.forced), 0)     AS forced,
       -- NULL under thirty settled trades. Not computed and then hidden in the
       -- interface: a number that gets calculated leaks out somewhere, and a
       -- win rate from nine trades is a number nobody should ever see.
       CASE WHEN COALESCE(SUM(d.wins + d.losses), 0) >= 30
            THEN ROUND(100.0 * SUM(d.wins) / NULLIF(SUM(d.wins + d.losses), 0), 2)
       END AS win_rate
  FROM strategy_versions v
  LEFT JOIN signal_daily d ON d.strategy_version_id = v.id
 GROUP BY v.id;

-- ── Notifications ──────────────────────────────────────────────────────────

-- Device push credentials. This is the table that was world-readable in
-- Postgres for months, handing out p256dh and auth keys with the account they
-- belong to. It is `never` readable over HTTP in access.ts, and that is not a
-- precaution — it is the fix for something that actually happened.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            TEXT PRIMARY KEY,             -- uuid
  endpoint      TEXT NOT NULL,                -- the endpoint IS the device
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
  symbol     TEXT NOT NULL,
  setup_key  TEXT NOT NULL,
  stage      INTEGER NOT NULL CHECK (stage IN (96, 98, 100)),
  sent_ms    INTEGER NOT NULL,
  PRIMARY KEY (symbol, setup_key, stage)
);
CREATE INDEX IF NOT EXISTS push_alerts_sent ON push_alerts (sent_ms);

CREATE TABLE IF NOT EXISTS telegram_alerts (
  event_key  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('eligible', 'signal', 'result', 'daily')),
  sent_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS telegram_alerts_sent ON telegram_alerts (sent_ms);

CREATE TABLE IF NOT EXISTS telegram_queue (
  event_key   TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('signal', 'result', 'daily')),
  symbol      TEXT,
  depth_bps   REAL,
  -- The finished message, not a template. A queued message is held for a person
  -- to approve, and approving something still to be rendered later approves
  -- something nobody has read.
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'sent', 'rejected')),
  expires_ms  INTEGER,
  created_ms  INTEGER NOT NULL,
  decided_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS telegram_queue_state ON telegram_queue (status, created_ms);

-- ── Housekeeping ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clicks (
  id     TEXT PRIMARY KEY,
  data   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data))
);

CREATE TABLE IF NOT EXISTS repair_log (
  id          TEXT PRIMARY KEY,
  at_ms       INTEGER,
  action      TEXT,
  result      TEXT,
  created_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS repair_log_created ON repair_log (created_ms);

-- 2captcha solve counters. `packages/shared` describes this as `{id, data}`
-- and the live table disagrees — it has four real columns. Where the two
-- disagree the live table wins, because it is the one holding the rows.
CREATE TABLE IF NOT EXISTS captcha_stats (
  id       TEXT PRIMARY KEY,
  ts_ms    INTEGER,
  success  INTEGER,
  cost     REAL
);
