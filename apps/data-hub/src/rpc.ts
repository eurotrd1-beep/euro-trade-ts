/**
 * The two Postgres functions, ported.
 *
 * ── WHY THEY GET THEIR OWN FILE ────────────────────────────────────────────
 *
 * `db.ts` builds statements from a request. These two are the opposite: fixed
 * statements that a request only supplies values to. That is what a Postgres
 * function was — a shape the caller cannot change — and keeping them apart is
 * what stops "we need one more query" turning the generic path into a place
 * arbitrary SQL can be expressed.
 *
 * Both were read out of the pg_dump rather than reconstructed from how they
 * are called, because both carry a decision in their body that the call site
 * does not show.
 */

import { POLICY, type Caller } from './access.js';

export interface Statement {
  sql: string;
  binds: unknown[];
}

// ── signal_stats ────────────────────────────────────────────────────────────

export type GroupBy = 'total' | 'day' | 'symbol' | 'slot' | 'version';

export interface StatsFilter {
  from: string;
  to: string;
  groupBy: GroupBy;
  slot: string | null;
  version: string | null;
  symbol: string | null;
}

/**
 * The bucket expression, chosen from five literals.
 *
 * `version` is `COALESCE(strategy_version_id, 'current')` and the original
 * says why in as many words: the column is read back as a key in JSON, and a
 * `null` key is indistinguishable from "no result". The running strategy
 * stamps no version, so its rows are the NULL ones — the bucket that would
 * have been nameless is the one that matters most.
 */
const BUCKET: Record<GroupBy, string> = {
  total: `'total'`,
  day: `"day"`,
  symbol: `"symbol"`,
  slot: `"slot"`,
  version: `COALESCE("strategy_version_id", 'current')`,
};

/**
 * Builds the aggregate.
 *
 * ── THE JOIN THAT IS NOT HERE ──────────────────────────────────────────────
 *
 * Postgres LEFT JOINs strategy_versions and uses nothing from it. The comment
 * on the original records why the LEFT matters: an INNER join dropped every
 * row whose version was NULL — which is every row from the strategy that is
 * actually running. A join that contributes no column and can only remove rows
 * is not a join, so it is gone rather than carried across as decoration. The
 * behaviour is the LEFT JOIN's, exactly.
 *
 * ── AND THE THIRTY ─────────────────────────────────────────────────────────
 *
 * `win_rate` is NULL below thirty settled trades. Not computed and hidden in
 * the interface: a number that gets calculated leaks out somewhere eventually,
 * and a win rate from nine trades is one nobody should ever see.
 */
export function buildStats(f: StatsFilter): Statement {
  const bucket = BUCKET[f.groupBy] ?? BUCKET.total;

  const where: string[] = ['"day" BETWEEN ? AND ?'];
  const binds: unknown[] = [f.from, f.to];

  // Each filter is optional and each value is bound. The columns are literals
  // from this file; nothing from the request reaches the SQL text.
  if (f.slot !== null) { where.push('"slot" = ?'); binds.push(f.slot); }
  if (f.version !== null) { where.push('"strategy_version_id" = ?'); binds.push(f.version); }
  if (f.symbol !== null) { where.push('"symbol" = ?'); binds.push(f.symbol); }

  const sql =
    `SELECT ${bucket} AS bucket,` +
    ` SUM("signals") AS signals,` +
    ` SUM("wins") AS wins,` +
    ` SUM("losses") AS losses,` +
    ` SUM("ties") AS ties,` +
    ` SUM("unresolved") AS unresolved,` +
    ` SUM("pending") AS pending,` +
    ` SUM("forced") AS forced,` +
    // ── Integer arithmetic, and not ROUND() on a division ──────────────────
    //
    // Postgres computes this in `numeric`, which is exact decimal. SQLite has
    // only binary floating point, and the two disagree: 41 wins of 80 settled
    // is 51.25%, which Postgres rounds to 51.3 and SQLite to 51.2 — because
    // 41.0/80*100 is not 51.25 in binary, it is 51.24999999999999, and that
    // rounds down.
    //
    // It is one tenth of one percent on a published win rate, it appeared on
    // exactly one symbol out of 169, and it would have been found by a user
    // noticing the number moved after the migration.
    //
    // So the rate is computed without a float at all. Round-half-up on a
    // quotient is floor((w*1000/total) + 0.5), which in integers with no
    // division-before-rounding is (w*2000 + total) / (2*total). SQLite's
    // integer division truncates, and every value here is positive, so
    // truncation is the floor. Divided by ten at the end to place the decimal.
    ` CASE WHEN SUM("wins") + SUM("losses") >= 30` +
    ` THEN ((SUM("wins") * 2000 + (SUM("wins") + SUM("losses")))` +
    `       / (2 * (SUM("wins") + SUM("losses")))) / 10.0` +
    ` END AS win_rate` +
    ` FROM "signal_daily" WHERE ${where.join(' AND ')}` +
    ` GROUP BY bucket ORDER BY bucket`;

  return { sql, binds };
}

/** Reads the filter off a URL, with every value defaulted rather than assumed. */
export function parseStats(params: URLSearchParams): StatsFilter | null {
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  // 'YYYY-MM-DD', which is how `day` is stored. A malformed date would compare
  // as text against a real one and return a silently wrong range.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;

  const raw = params.get('group_by') ?? 'total';
  const groupBy: GroupBy =
    raw === 'day' || raw === 'symbol' || raw === 'slot' || raw === 'version' ? raw : 'total';

  return {
    from,
    to,
    groupBy,
    slot: params.get('slot'),
    version: params.get('version'),
    symbol: params.get('symbol'),
  };
}

// ── increment_click ─────────────────────────────────────────────────────────

/**
 * What a counter may be called.
 *
 * Postgres passed the name as a bound array element, so it could be anything.
 * Here it goes into a JSON PATH, and two things follow from that. A path is
 * built by concatenation, so it must not be able to carry `$`, `.` or `[`.
 * And a name nobody validates means anybody can add keys to the row for ever,
 * growing one JSON document without limit — which the original allowed too,
 * and which there is no reason to carry across.
 */
const COUNTER_NAME = /^[A-Za-z0-9_]{1,40}$/;

/**
 * One counter, plus one.
 *
 * ── WHY THE PUBLIC MAY RUN THIS AND MAY NOT WRITE `clicks` ─────────────────
 *
 * Postgres routed a click through a SECURITY DEFINER function: it ran as the
 * owner, and it could do exactly one thing — add one to a named counter. The
 * public never held write access to the row, only the right to make a number
 * larger.
 *
 * That is why `clicks` is `write: 'service'` in access.ts and this is the only
 * way in. A `write: 'public'` there would have been a widening dressed as a
 * port: it would let anyone overwrite every counter the analytics page reads.
 */
export function buildClick(row: string, field: string): Statement | null {
  if (!COUNTER_NAME.test(field)) return null;
  if (row.length === 0 || row.length > 64) return null;
  // The row id is bound; only the table name is written, and it is a literal.
  return {
    sql:
      `INSERT INTO "clicks" ("id", "data") VALUES (?, json_object(?, 1))` +
      ` ON CONFLICT ("id") DO UPDATE SET "data" = json_set(` +
      `  "clicks"."data", '$.' || ?,` +
      `  COALESCE(json_extract("clicks"."data", '$.' || ?), 0) + 1)`,
    binds: [row, field, field, field],
  };
}

/**
 * Who may read the aggregate.
 *
 * It reads `signal_daily`, so it answers to that table's rule and not to one
 * of its own — the published record is public, which is what lets the app show
 * a win rate. Written as a lookup rather than a constant so that changing the
 * table's rule changes this too, instead of leaving an endpoint behind that
 * still says public.
 */
export function statsReadableBy(caller: Caller): boolean {
  return POLICY['signal_daily']?.read === 'public' || caller.kind !== 'public';
}
