/**
 * Who may read and write each table — the replacement for row-level security.
 *
 * ── WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE MIGRATION ───────────────
 *
 * Today Postgres refuses. After this, code refuses — and the difference is that
 * a rule nobody wrote is not an error. It is an open table: no exception, no
 * log line, nothing in any dashboard. The table is simply readable by anyone
 * who asks, until somebody notices.
 *
 * That is not hypothetical here. `push_subscriptions` was world-readable with a
 * plain anon key for months, handing out every device's push encryption keys
 * (`p256dh`, `auth`) alongside the account they belong to. The migration that
 * closed it says so in as many words. The hole was not a bug anybody wrote — it
 * was a `CREATE TABLE` that nobody had written a policy for.
 *
 * ── SO THE DEFAULT IS NO ───────────────────────────────────────────────────
 *
 * This is a whitelist and it is exhaustive. A table absent from POLICY is
 * refused, for everyone, for every operation. Forgetting is therefore a closed
 * door rather than an open one — which is the only arrangement where "we forgot
 * one" is survivable.
 *
 * And `test/access.test.ts` reads the table names out of the schema and fails
 * the build if any of them is missing here. A new table with no decision about
 * it is a red build, not a quiet hole.
 */

/** Who is asking. Derived from the request, never from anything it claims. */
export type Caller =
  /** No credential. The browser, before it identifies itself. */
  | { kind: 'public' }
  /** A signed-in account id. Owns its own rows and nothing else. */
  | { kind: 'user'; accountId: string }
  /** The admin secret. */
  | { kind: 'admin' }
  /** Render and the schedulers, holding the service secret. */
  | { kind: 'service' };

export type Access =
  /** Anyone, including an unidentified browser. */
  | 'public'
  /** Only rows whose owner column matches the caller's account id. */
  | 'owner'
  | 'admin'
  | 'service'
  /** Nobody over HTTP, at any level. Internal code paths only. */
  | 'never';

export interface TablePolicy {
  read: Access;
  write: Access;
  /**
   * The column holding the owner's account id. Required by, and only
   * meaningful for, `owner` access — a table that says `owner` without one
   * cannot scope anything, so the check below refuses it outright rather than
   * falling back to letting everything through.
   */
  ownerColumn?: string;
  /**
   * Every column a request may name — to select, to filter on, to order by.
   *
   * Required, and it is a second whitelist rather than a convenience. A table
   * name and a column name cannot be sent to SQLite as bound parameters; they
   * are the one part of a query that has to be written into the statement
   * itself. So neither is ever taken from the request: the request names one,
   * and what goes into the SQL is the matching entry from this file or
   * nothing at all.
   *
   * It also means `*` has a definition. A column added to the schema later is
   * not selected by anything until somebody adds it here — the same shape as
   * the table rule, so a new column is a decision rather than a disclosure.
   *
   * `test/schema.test.ts` checks every name here against the real table.
   */
  columns: readonly string[];
  /**
   * The primary key, as the conflict target for an upsert.
   *
   * Required, and it is not bookkeeping: `ON CONFLICT (…) DO UPDATE` with the
   * wrong target does not fail. It stops matching, so every upsert becomes an
   * insert, and a table meant to hold one row per account quietly fills with
   * duplicates — each write appearing to succeed. The app upserts a user's
   * whole history on every settled trade, so the wrong target here is a table
   * that grows without bound and a history that stops updating.
   *
   * `test/schema.test.ts` compares this against the real key.
   */
  primaryKey: readonly string[];
  /**
   * The `ON CONFLICT (…)` target as raw SQL, for the one table whose identity
   * is an expression rather than a plain key.
   *
   * Set only where `primaryKey` cannot express it. It is not a hook for
   * arbitrary SQL — nothing from a request reaches it, and the schema test
   * checks it against the index the table actually has.
   */
  conflictTarget?: string;
  /**
   * True for a SQLite VIEW rather than a table.
   *
   * Recorded because the checks that hold this file to the schema have to know:
   * a view has no primary key and no conflict target, and demanding one would
   * fail for a reason that has nothing wrong with it.
   */
  view?: boolean;
}

/**
 * Every table, and the decision for it.
 *
 * The comments say what the rule replaces, because a bare matrix is a thing
 * nobody can review: the question a reader has is always "is this the same as
 * what Postgres was doing", and the answer has to be next to the rule.
 */
export const POLICY: Readonly<Record<string, TablePolicy>> = {
  // ── Read by the browser, written by the feed ─────────────────────────────
  // Postgres: `CREATE POLICY "public read"`. Prices and pairs are public by
  // nature — they are what the app exists to show.
  candles: {
    read: 'public', write: 'service',
    columns: ['key', 'data', 'updated_ms'],
    primaryKey: ['key'],
  },
  pairs: {
    read: 'public', write: 'admin',
    columns: ['id', 'symbol', 'chart_symbol', 'category', 'type', 'source', 'is_otc', 'enabled',
      'order', 'created_ms'],
    primaryKey: ['id'],
  },
  otc_pairs: {
    read: 'public', write: 'service',
    columns: ['id', 'platform', 'symbol', 'name', 'asset_type', 'subcategory', 'is_otc', 'enabled',
      'order', 'created_ms', 'updated_ms'],
    primaryKey: ['id'],
  },
  brokers: {
    read: 'public', write: 'admin',
    columns: ['id', 'name', 'logo_url', 'chart_url', 'registration_link', 'desc', 'click_key',
      'promo_code', 'bonus_percent', 'min_deposit', 'is_active', 'is_recommended', 'order',
      'themeColor', 'created_ms', 'updated_ms'],
    primaryKey: ['id'],
  },
  configs: {
    read: 'public', write: 'admin',
    columns: ['id', 'data'],
    primaryKey: ['id'],
  },

  // Postgres: `CREATE POLICY "read" … USING (true)`. The published record the
  // statistics are computed from; readable so the app can show a win rate.
  signals: {
    read: 'public', write: 'service',
    columns: ['id', 'created_ms', 'symbol', 'timeframe', 'direction', 'bar_ms', 'strategy_version_id',
      'slot', 'confidence', 'score', 'rules_matched', 'candle_snapshot', 'entry_price',
      'expiry_seconds', 'outcome', 'outcome_price', 'outcome_ms', 'forced'],
    primaryKey: ['id'],
  },
  // The one table whose identity is not a primary key. The version is
  // legitimately NULL for versionless statistics, a primary key cannot hold
  // NULL, and NULLs do not compare equal — so without the COALESCE every
  // versionless row is distinct from every other one and they never merge.
  // Postgres hit this first and this mirrors its fix exactly.
  signal_daily: {
    read: 'public', write: 'service',
    conflictTarget:
      `"day", COALESCE("strategy_version_id", '00000000-0000-0000-0000-000000000000'), ` +
      `"symbol", "timeframe", "slot"`,
    columns: ['day', 'strategy_version_id', 'symbol', 'timeframe', 'slot', 'signals', 'wins',
      'losses', 'ties', 'unresolved', 'pending', 'forced'],
    primaryKey: ['day', 'strategy_version_id', 'symbol', 'timeframe', 'slot'],
  },
  signal_write_budget: {
    read: 'public', write: 'service',
    columns: ['day', 'written', 'capped', 'max_rows'],
    primaryKey: ['day'],
  },
  strategy_versions: {
    read: 'public', write: 'admin',
    columns: ['id', 'slot', 'version_number', 'uploaded_ms', 'uploaded_by', 'name', 'strategy_json',
      'json_hash', 'is_active'],
    primaryKey: ['id'],
  },
  // A VIEW, not a table — one row per version, aggregated over signal_daily.
  // Nothing writes it, in Postgres or here: `write: 'never'` is not a policy
  // decision so much as a fact, and saying it out loud stops somebody adding a
  // writer later and wondering why the numbers do not change.
  strategy_version_stats: {
    view: true,
    read: 'public', write: 'never',
    columns: ['id', 'slot', 'version_number', 'name', 'uploaded_ms', 'uploaded_by', 'is_active',
      'json_hash', 'signals', 'wins', 'losses', 'ties', 'unresolved', 'pending', 'forced',
      'win_rate'],
    primaryKey: [],
  },

  // ── Tightened on the way across ──────────────────────────────────────────
  // Postgres has `CREATE POLICY "allow all" ON signal_history`, which lets any
  // holder of the anon key read AND OVERWRITE any account's trade history.
  // That is a carried-over default, not a decision, and the move is the moment
  // to end it: an account reaches its own row and no other.
  signal_history: {
    read: 'owner', write: 'owner', ownerColumn: 'account_id',
    columns: ['account_id', 'signals', 'updated_ms'],
    primaryKey: ['account_id'],
  },

  // Same story. The anon key can currently read every account row — role, VIP
  // expiry, device binding — for every user.
  users: {
    read: 'owner', write: 'owner', ownerColumn: 'id',
    columns: ['id', 'broker', 'role', 'is_banned', 'ban_reason', 'device_id', 'fcm_token',
      'login_count', 'vip_expiry_ms', 'guaranteed_win', 'clicked_broker', 'created_ms'],
    primaryKey: ['id'],
  },

  // ── Admin ────────────────────────────────────────────────────────────────
  telegram_queue: {
    read: 'admin', write: 'admin',
    columns: ['event_key', 'kind', 'symbol', 'depth_bps', 'body', 'status', 'expires_ms', 'created_ms',
      'decided_ms'],
    primaryKey: ['event_key'],
  },
  repair_log: {
    read: 'admin', write: 'service',
    columns: ['id', 'at_ms', 'action', 'result', 'created_ms'],
    primaryKey: ['id'],
  },
  captcha_stats: {
    read: 'admin', write: 'service',
    columns: ['id', 'ts_ms', 'success', 'cost'],
    primaryKey: ['id'],
  },

  // A click IS an anonymous write, but not an anonymous write to this table.
  // Postgres routes it through `increment_click`, a SECURITY DEFINER function
  // that adds one to a named counter and can do nothing else — so the public
  // never holds write access to the row, only the right to make it larger by
  // one. Carrying that over means the generic table write stays closed here,
  // and the increment endpoint (with the write path, not in this stage) is the
  // one narrow, fixed mutation that runs as the service. A `write: 'public'`
  // here would be a widening dressed as a port: it would let anyone overwrite
  // every counter the analytics page reads.
  clicks: {
    read: 'admin', write: 'service',
    columns: ['id', 'data'],
    primaryKey: ['id'],
  },

  // ── Never over HTTP ──────────────────────────────────────────────────────
  // Postgres: RLS on with NO policy at all — refused to anon and authenticated,
  // reachable only by the service key. `push_subscriptions` is the one that was
  // exposed before; it holds per-device encryption keys and there is no caller
  // on the internet who has any business with it.
  push_subscriptions: {
    read: 'never', write: 'service',
    columns: ['id', 'endpoint', 'user_id', 'subscription', 'symbols', 'plan', 'failures', 'created_ms',
      'updated_ms'],
    primaryKey: ['id'],
  },
  push_alerts: {
    read: 'never', write: 'service',
    columns: ['symbol', 'setup_key', 'stage', 'sent_ms'],
    primaryKey: ['symbol', 'setup_key', 'stage'],
  },
  telegram_alerts: {
    read: 'never', write: 'service',
    columns: ['event_key', 'kind', 'sent_ms'],
    primaryKey: ['event_key'],
  },
  price_snapshot: {
    read: 'never', write: 'service',
    columns: ['id', 'data', 'updated_ms'],
    primaryKey: ['id'],
  },
};

/** Ranked, so a service caller satisfies an `admin` rule and so on. */
const RANK: Record<Caller['kind'], number> = { public: 0, user: 1, admin: 2, service: 3 };
const NEEDED: Record<Exclude<Access, 'never' | 'owner'>, number> = {
  public: 0,
  admin: 2,
  service: 3,
};

export interface Decision {
  allowed: boolean;
  /** Set when the rule is `owner`: the caller may only touch these rows. */
  scope?: { column: string; value: string };
  reason: string;
}

/**
 * The single gate. Nothing reaches a table except through this.
 *
 * Returns a decision rather than throwing, so the caller can log a refusal as a
 * refusal — a thrown error in a request handler tends to become a 500, and a
 * 500 reads like a bug in us rather than a request that was not allowed.
 */
export function decide(table: string, op: 'read' | 'write', caller: Caller): Decision {
  const policy = POLICY[table];
  // The whole point. An unknown table is refused, not defaulted.
  if (policy === undefined) {
    return { allowed: false, reason: `no policy for '${table}' — refused by default` };
  }

  const rule = op === 'read' ? policy.read : policy.write;
  if (rule === 'never') {
    return { allowed: false, reason: `'${table}' is not reachable over HTTP` };
  }

  if (rule === 'owner') {
    if (caller.kind === 'admin' || caller.kind === 'service') {
      return { allowed: true, reason: `${caller.kind} may ${op} any row` };
    }
    if (caller.kind !== 'user') {
      return { allowed: false, reason: `'${table}' needs a signed-in account` };
    }
    // A table declaring `owner` without a column cannot scope anything. Letting
    // it through unscoped would hand every row to whoever asked first, so it is
    // refused as a configuration fault instead.
    if (!policy.ownerColumn) {
      return { allowed: false, reason: `'${table}' is owner-scoped but names no owner column` };
    }
    return {
      allowed: true,
      scope: { column: policy.ownerColumn, value: caller.accountId },
      reason: `scoped to ${policy.ownerColumn} = the caller`,
    };
  }

  const ok = RANK[caller.kind] >= NEEDED[rule];
  return ok
    ? { allowed: true, reason: `${caller.kind} satisfies '${rule}'` }
    : { allowed: false, reason: `'${table}' ${op} needs '${rule}', caller is '${caller.kind}'` };
}

/** Every table this file has an opinion about — for the inventory test. */
export const GOVERNED = Object.keys(POLICY).sort();

// ── Identifiers ─────────────────────────────────────────────────────────────
//
// A table name and a column name are the one part of a SQL statement that
// cannot be a bound parameter. Everything below exists so that the string that
// ends up inside a statement comes from THIS FILE and not from a request.

/**
 * What a legal identifier looks like here.
 *
 * Not a defence against the request — the request never reaches the SQL. It is
 * a check on the whitelist itself, so that a typo in POLICY (a space, a quote,
 * a stray comma inside a name) is caught by the tests instead of becoming a
 * broken statement, or worse a working one.
 */
// Uppercase is allowed because one real column has it: `brokers.themeColor`
// is spelled that way in Postgres, the admin writes it by that name, and
// "correcting" it to theme_color during the copy would be renaming a column,
// which is indistinguishable from dropping it.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The canonical table name, or null.
 *
 * Returns the string held in this file rather than the one that was asked for.
 * They compare equal, and only one of them was written by us — which is the
 * whole reason this returns anything at all instead of a boolean.
 */
export function tableNamed(requested: string): string | null {
  return GOVERNED.find((t) => t === requested) ?? null;
}

/**
 * The columns a request may have, resolved against the whitelist.
 *
 * `null` or `'*'` means every declared column — which is not the same as every
 * column in the table. A column added to the schema and not added to POLICY is
 * returned by nothing, so a new column cannot be disclosed by an old query.
 *
 * Returns null if ANY requested column is not declared. Not "the ones that
 * matched": a partial answer to a query naming a column we refuse looks like a
 * table that lost a column, and the caller would carry on with a row that is
 * quietly missing a field.
 */
export function columnsFor(table: string, requested: readonly string[] | null): string[] | null {
  const policy = POLICY[table];
  if (policy === undefined) return null;
  const declared = policy.columns;
  if (requested === null || (requested.length === 1 && requested[0] === '*')) {
    return [...declared];
  }
  const out: string[] = [];
  for (const want of requested) {
    // Pushing the DECLARED string, not the requested one.
    const found = declared.find((c) => c === want);
    if (found === undefined || !IDENTIFIER.test(found)) return null;
    out.push(found);
  }
  return out.length > 0 ? out : null;
}

/** One column name, resolved against the whitelist — for filters and ordering. */
export function columnNamed(table: string, requested: string): string | null {
  const found = POLICY[table]?.columns.find((c) => c === requested);
  return found !== undefined && IDENTIFIER.test(found) ? found : null;
}

/** Exposed so the tests can hold the whitelist itself to the same rule. */
export const isIdentifier = (s: string): boolean => IDENTIFIER.test(s);
