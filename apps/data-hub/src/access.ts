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
  candles: { read: 'public', write: 'service' },
  pairs: { read: 'public', write: 'admin' },
  otc_pairs: { read: 'public', write: 'service' },
  brokers: { read: 'public', write: 'admin' },
  configs: { read: 'public', write: 'admin' },

  // Postgres: `CREATE POLICY "read" … USING (true)`. The published record the
  // statistics are computed from; readable so the app can show a win rate.
  signals: { read: 'public', write: 'service' },
  signal_daily: { read: 'public', write: 'service' },
  signal_write_budget: { read: 'public', write: 'service' },
  strategy_versions: { read: 'public', write: 'admin' },
  strategy_version_stats: { read: 'public', write: 'service' },

  // ── Tightened on the way across ──────────────────────────────────────────
  // Postgres has `CREATE POLICY "allow all" ON signal_history`, which lets any
  // holder of the anon key read AND OVERWRITE any account's trade history.
  // That is a carried-over default, not a decision, and the move is the moment
  // to end it: an account reaches its own row and no other.
  signal_history: { read: 'owner', write: 'owner', ownerColumn: 'account_id' },

  // Same story. The anon key can currently read every account row — role, VIP
  // expiry, device binding — for every user.
  users: { read: 'owner', write: 'owner', ownerColumn: 'id' },

  // ── Admin ────────────────────────────────────────────────────────────────
  telegram_queue: { read: 'admin', write: 'admin' },
  repair_log: { read: 'admin', write: 'service' },
  captcha_stats: { read: 'admin', write: 'service' },
  clicks: { read: 'admin', write: 'public' }, // a click is an anonymous write

  // ── Never over HTTP ──────────────────────────────────────────────────────
  // Postgres: RLS on with NO policy at all — refused to anon and authenticated,
  // reachable only by the service key. `push_subscriptions` is the one that was
  // exposed before; it holds per-device encryption keys and there is no caller
  // on the internet who has any business with it.
  push_subscriptions: { read: 'never', write: 'service' },
  push_alerts: { read: 'never', write: 'service' },
  telegram_alerts: { read: 'never', write: 'service' },
  price_snapshot: { read: 'never', write: 'service' },
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
