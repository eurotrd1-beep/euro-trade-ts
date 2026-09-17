-- ════════════════════════════════════════════════════════════════════════════
-- The defaults the port dropped.
--
-- Postgres fills five columns in by itself. The SQLite schema kept the columns,
-- kept the NOT NULL, and lost the DEFAULT — so every insert that relied on the
-- database to supply a value now fails instead:
--
--   telegram_alerts.sent_at      DEFAULT now()               → sent_ms, none
--   push_subscriptions.id        DEFAULT gen_random_uuid()   → none
--   push_subscriptions.created_at/updated_at  DEFAULT now()  → none, AND
--                                                              NOT NULL, which
--                                                              Postgres did not
--                                                              have either
--   otc_pairs.id                 DEFAULT gen_random_uuid()   → none
--   candles/price_snapshot.updated_at  DEFAULT now()         → none
--
-- Found by running the proxy's own client against this database before the
-- proxy ran against it: `telegram.js` inserts `{event_key, kind}` and nothing
-- else, and `push.js` inserts a subscription without an id, because in Postgres
-- neither has to know those columns exist. Both came back "write failed".
--
-- This is the `is_banned` class of defect — a column carried across with its
-- name intact and its behaviour changed — and it fails the same way: not at
-- migration time, but the first time the code that depended on it runs.
--
-- ── WHY THE TABLES ARE REBUILT ─────────────────────────────────────────────
--
-- SQLite cannot ALTER a column to add a default. The standard answer is to
-- create the table as it should have been, copy the rows across, drop the old
-- one and rename — which is safe here because these tables are small
-- (125, 1, 89, 0 and 0 rows) and because wrangler rolls the whole file back if
-- any statement in it fails.
--
-- Every CREATE below is the current DDL with defaults added and nothing else
-- changed: same columns, same order, same types, same CHECKs, same keys.
-- ════════════════════════════════════════════════════════════════════════════

-- ── telegram_alerts ─────────────────────────────────────────────────────────
--
-- The whole table is a duplicate guard: the primary key IS the check, and an
-- insert either takes the key or collides. `sent_ms` is bookkeeping, and the
-- caller has never supplied it.
CREATE TABLE telegram_alerts_new (
  event_key  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('eligible', 'signal', 'result', 'daily')),
  sent_ms    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
INSERT INTO telegram_alerts_new (event_key, kind, sent_ms)
  SELECT event_key, kind, sent_ms FROM telegram_alerts;
DROP TABLE telegram_alerts;
ALTER TABLE telegram_alerts_new RENAME TO telegram_alerts;
CREATE INDEX telegram_alerts_sent ON telegram_alerts (sent_ms);

-- ── push_subscriptions ──────────────────────────────────────────────────────
--
-- `id` is a uuid the database generates. SQLite has no gen_random_uuid(), so
-- the expression below builds a v4 out of randomblob — same shape, same
-- collision odds, and generated in the same place: the database, not the
-- caller. A caller-generated id would mean every writer needs a uuid library
-- and they would not all pick the same one.
--
-- `created_ms` and `updated_ms` also drop NOT NULL, because Postgres does not
-- have it on either. Keeping a constraint the source did not have is not a
-- tightening, it is a difference — and a difference is what breaks a rollback.
CREATE TABLE push_subscriptions_new (
  id            TEXT PRIMARY KEY DEFAULT (
                  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
                        substr(hex(randomblob(2)), 2) || '-' ||
                        substr('89ab', abs(random()) % 4 + 1, 1) ||
                        substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))
                ),
  endpoint      TEXT NOT NULL,                -- the endpoint IS the device
  user_id       TEXT,
  subscription  TEXT NOT NULL CHECK (json_valid(subscription)),
  symbols       TEXT CHECK (symbols IS NULL OR json_valid(symbols)),
  plan          TEXT,
  failures      INTEGER NOT NULL DEFAULT 0,
  created_ms    INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_ms    INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
INSERT INTO push_subscriptions_new
  (id, endpoint, user_id, subscription, symbols, plan, failures, created_ms, updated_ms)
  SELECT id, endpoint, user_id, subscription, symbols, plan, failures, created_ms, updated_ms
    FROM push_subscriptions;
DROP TABLE push_subscriptions;
ALTER TABLE push_subscriptions_new RENAME TO push_subscriptions;
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- `endpoint` is the device, and `save()` upserts on it. Without a unique
-- constraint that upsert has nothing to conflict on, so a device
-- re-subscribing would add a row rather than replace one and then receive
-- every notification twice. Postgres has the same guarantee through the
-- ON CONFLICT the caller names.
CREATE UNIQUE INDEX push_subscriptions_endpoint ON push_subscriptions (endpoint);

-- ── otc_pairs ───────────────────────────────────────────────────────────────
--
-- Same uuid default. The asset scan upserts on (platform, symbol) and never
-- sends an id, so without this every scanned row inserted a NULL primary key —
-- which SQLite permits, so nothing collided and nothing complained.
CREATE TABLE otc_pairs_new (
  id           TEXT PRIMARY KEY DEFAULT (
                 lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
                       substr(hex(randomblob(2)), 2) || '-' ||
                       substr('89ab', abs(random()) % 4 + 1, 1) ||
                       substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))
               ),
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
  created_ms   INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_ms   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  UNIQUE (platform, symbol)
);
INSERT INTO otc_pairs_new
  (id, platform, symbol, name, asset_type, subcategory, is_otc, enabled, "order",
   created_ms, updated_ms)
  SELECT id, platform, symbol, name, asset_type, subcategory, is_otc, enabled, "order",
         created_ms, updated_ms
    FROM otc_pairs;
DROP TABLE otc_pairs;
ALTER TABLE otc_pairs_new RENAME TO otc_pairs;

-- ── candles and price_snapshot ──────────────────────────────────────────────
--
-- The scraper always sends `updated_at`, so these defaults are never reached
-- today. They are here because Postgres has them and a schema that differs
-- from the one it was ported from is a schema that will surprise somebody —
-- most likely whoever writes the next inserting caller.
CREATE TABLE candles_new (
  key         TEXT PRIMARY KEY,               -- '<symbol>_<interval>'
  data        TEXT NOT NULL CHECK (json_valid(data)),
  updated_ms  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
INSERT INTO candles_new (key, data, updated_ms) SELECT key, data, updated_ms FROM candles;
DROP TABLE candles;
ALTER TABLE candles_new RENAME TO candles;

CREATE TABLE price_snapshot_new (
  id          TEXT PRIMARY KEY,               -- always 'otc_prices'
  data        TEXT NOT NULL CHECK (json_valid(data)),
  updated_ms  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
INSERT INTO price_snapshot_new (id, data, updated_ms)
  SELECT id, data, updated_ms FROM price_snapshot;
DROP TABLE price_snapshot;
ALTER TABLE price_snapshot_new RENAME TO price_snapshot;
