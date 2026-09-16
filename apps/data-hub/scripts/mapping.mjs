/**
 * Where every D1 column comes from in Postgres, and how the value converts.
 *
 * ── THIS FILE IS THE MOVE ──────────────────────────────────────────────────
 *
 * Everything else in the migration can be rolled back by pointing a config row
 * at Supabase. This is the one step that is permanent, and its failure mode is
 * not an error: a column that is not listed here is simply not copied, and the
 * result is a database that looks populated and is missing a field nobody
 * notices until they need it.
 *
 * So `scripts/introspect.mjs --diff` reads the live schema and reports every
 * column that exists there and is absent here. Run it before a load. A column
 * under NOT COPIED is data the move would leave behind.
 *
 * ── HOW MUCH OF THIS IS VERIFIED ───────────────────────────────────────────
 *
 * Eleven tables were read off the migrations in supabase/migrations — those
 * are exact. The other nine (candles, configs, brokers, pairs, otc_pairs,
 * users, clicks, repair_log, captcha_stats) have no CREATE TABLE anywhere in
 * this repo: they were made by hand before it existed. They are written here
 * from how the app reads them, which is a guess about everything the app does
 * not read, and they stay marked until `--diff` has confirmed them.
 *
 * ── THE CONVERSIONS ────────────────────────────────────────────────────────
 *
 *   ms    timestamptz → integer milliseconds. The ISO string would compare
 *         wrongly as text ('…T9:' > '…T12:') in every pruning query.
 *   json  jsonb, and Postgres ARRAYS, → TEXT. Rejected if not really JSON.
 *   bool  boolean → 1/0. SQLite has no boolean, and `true` stored as the
 *         string 'true' makes `WHERE enabled = 1` match nothing.
 *   num   numeric → number, NaN refused rather than quietly stored as null.
 *   text  everything else, including `date`, which stays 'YYYY-MM-DD'.
 */

export const MS = 'ms', JSON_ = 'json', BOOL = 'bool', NUM = 'num', TEXT = 'text';

/** Tables whose shape is confirmed against a migration in this repo. */
export const VERIFIED = new Set([
  'price_snapshot', 'strategy_versions', 'signals', 'signal_daily',
  'signal_write_budget', 'signal_history', 'push_subscriptions', 'push_alerts',
  'telegram_alerts', 'telegram_queue', 'strategy_version_stats',
]);

export const MAPPING = {
  // ── Confirmed against supabase/migrations ────────────────────────────────
  price_snapshot: { from: 'price_snapshot', columns: {
    id: ['id', TEXT], data: ['data', JSON_], updated_ms: ['updated_at', MS],
  } },
  strategy_versions: { from: 'strategy_versions', columns: {
    id: ['id', TEXT], slot: ['slot', TEXT], version_number: ['version_number', NUM],
    uploaded_ms: ['uploaded_at', MS], uploaded_by: ['uploaded_by', TEXT],
    name: ['name', TEXT], strategy_json: ['strategy_json', JSON_],
    json_hash: ['json_hash', TEXT], is_active: ['is_active', BOOL],
  } },
  strategy_version_stats: { from: 'strategy_version_stats', columns: {
    version_id: ['version_id', TEXT], data: ['data', JSON_], updated_ms: ['updated_at', MS],
  } },
  signals: { from: 'signals', columns: {
    id: ['id', NUM], created_ms: ['created_at', MS], symbol: ['symbol', TEXT],
    timeframe: ['timeframe', TEXT], direction: ['direction', TEXT],
    bar_ms: ['bar_time', MS], strategy_version_id: ['strategy_version_id', TEXT],
    slot: ['slot', TEXT], confidence: ['confidence', NUM], score: ['score', NUM],
    rules_matched: ['rules_matched', JSON_],
    // `double precision[]` — a Postgres array, not jsonb. PostgREST hands it
    // over as a JS array, and it becomes a JSON array of the same numbers.
    candle_snapshot: ['candle_snapshot', JSON_],
    entry_price: ['entry_price', NUM], expiry_seconds: ['expiry_seconds', NUM],
    outcome: ['outcome', TEXT], outcome_price: ['outcome_price', NUM],
    outcome_ms: ['outcome_at', MS], forced: ['forced', BOOL],
  } },
  signal_daily: { from: 'signal_daily', columns: {
    day: ['day', TEXT], strategy_version_id: ['strategy_version_id', TEXT],
    symbol: ['symbol', TEXT], timeframe: ['timeframe', TEXT], slot: ['slot', TEXT],
    signals: ['signals', NUM], wins: ['wins', NUM], losses: ['losses', NUM],
    ties: ['ties', NUM], unresolved: ['unresolved', NUM], pending: ['pending', NUM],
    forced: ['forced', NUM],
  } },
  signal_write_budget: { from: 'signal_write_budget', columns: {
    day: ['day', TEXT], written: ['written', NUM], capped: ['capped', BOOL],
    max_rows: ['max_rows', NUM],
  } },
  signal_history: { from: 'signal_history', columns: {
    account_id: ['account_id', TEXT], signals: ['signals', JSON_],
    updated_ms: ['updated_at', MS],
  } },
  push_subscriptions: { from: 'push_subscriptions', columns: {
    id: ['id', TEXT], endpoint: ['endpoint', TEXT], user_id: ['user_id', TEXT],
    subscription: ['subscription', JSON_], symbols: ['symbols', JSON_],
    plan: ['plan', TEXT], failures: ['failures', NUM],
    created_ms: ['created_at', MS], updated_ms: ['updated_at', MS],
  } },
  push_alerts: { from: 'push_alerts', columns: {
    symbol: ['symbol', TEXT], setup_key: ['setup_key', TEXT],
    stage: ['stage', NUM], sent_ms: ['sent_at', MS],
  } },
  telegram_alerts: { from: 'telegram_alerts', columns: {
    event_key: ['event_key', TEXT], kind: ['kind', TEXT], sent_ms: ['sent_at', MS],
  } },
  telegram_queue: { from: 'telegram_queue', columns: {
    event_key: ['event_key', TEXT], kind: ['kind', TEXT], symbol: ['symbol', TEXT],
    depth_bps: ['depth_bps', NUM], body: ['body', TEXT], status: ['status', TEXT],
    expires_ms: ['expires_at', MS], created_ms: ['created_at', MS],
    decided_ms: ['decided_at', MS],
  } },

  // ── NOT confirmed: no CREATE TABLE for these anywhere in the repo ────────
  // Written from how the app reads them. `introspect.mjs --diff` is what turns
  // these into facts; until it has been run, a load of these tables is a load
  // of a guess.
  candles: { from: 'candles', columns: {
    key: ['key', TEXT], data: ['data', JSON_], updated_ms: ['updated_at', MS],
  } },
  configs: { from: 'configs', columns: {
    id: ['id', TEXT], data: ['data', JSON_], updated_ms: ['updated_at', MS],
  } },
  brokers: { from: 'brokers', columns: {
    id: ['id', TEXT], data: ['data', JSON_], updated_ms: ['updated_at', MS],
  } },
  pairs: { from: 'pairs', columns: {
    id: ['id', TEXT], symbol: ['symbol', TEXT], chart_symbol: ['chart_symbol', TEXT],
    category: ['category', TEXT], type: ['type', TEXT], source: ['source', TEXT],
    is_otc: ['is_otc', BOOL], enabled: ['enabled', BOOL], order: ['order', NUM],
    created_ms: ['created_at', MS],
  } },
  otc_pairs: { from: 'otc_pairs', columns: {
    id: ['id', TEXT], platform: ['platform', TEXT], symbol: ['symbol', TEXT],
    name: ['name', TEXT], asset_type: ['asset_type', TEXT], subcategory: ['subcategory', TEXT],
    is_otc: ['is_otc', BOOL], enabled: ['enabled', BOOL], order: ['order', NUM],
    updated_ms: ['updated_at', MS],
  } },
  users: { from: 'users', columns: {
    id: ['id', TEXT], broker: ['broker', TEXT], role: ['role', TEXT],
    is_banned: ['is_banned', BOOL], ban_reason: ['ban_reason', TEXT],
    device_id: ['device_id', TEXT], fcm_token: ['fcm_token', TEXT],
    login_count: ['login_count', NUM], vip_expiry_ms: ['vip_expiry', MS],
    guaranteed_win: ['guaranteed_win', BOOL], clicked_broker: ['clicked_broker', TEXT],
    created_ms: ['created_at', MS],
  } },
  clicks: { from: 'clicks', columns: { id: ['id', TEXT], data: ['data', JSON_] } },
  repair_log: { from: 'repair_log', columns: {
    id: ['id', TEXT], stage: ['stage', TEXT], detail: ['detail', TEXT],
    created_ms: ['created_at', MS],
  } },
  captcha_stats: { from: 'captcha_stats', columns: {
    id: ['id', TEXT], data: ['data', JSON_], updated_ms: ['updated_at', MS],
  } },
};
