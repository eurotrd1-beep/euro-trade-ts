/**
 * The signal pipeline, ported from PL/pgSQL.
 *
 * ── READ THIS BEFORE CHANGING ANYTHING HERE ────────────────────────────────
 *
 * These four functions decide what a trade's outcome is and what the published
 * numbers say. A mistake in them does not throw: it changes results, and the
 * only person who finds out is a user comparing a win rate against what they
 * remember. Every rule below was read out of the pg_dump, and the reason each
 * one exists is written next to it, because several of them look arbitrary and
 * none of them are.
 *
 * Each function is compared row-by-row against the live Postgres one in
 * `test/pipeline.test.ts` before any of this is used.
 *
 * ── THE ONE DELIBERATE DIFFERENCE ──────────────────────────────────────────
 *
 * `refreshSignalDaily` skips rows whose counters have not changed. Postgres
 * rewrites all of them, which is free there and is 51% of D1's entire daily
 * write budget here — 178 rows rewritten every ten minutes, 144 times a day,
 * almost none of which differ. The DATA is identical either way; what changes
 * is the returned count, which becomes "rows changed" rather than "rows
 * touched". The proxy only logs it.
 */

export interface Statement {
  sql: string;
  binds: unknown[];
}

// ── record_signals ──────────────────────────────────────────────────────────

export interface IncomingSignal {
  symbol: string;
  timeframe: string;
  direction: string;
  bar_ms: number;
  strategy_version_id: string | null;
  slot: string;
  confidence: number | null;
  score: number | null;
  rules_matched: unknown;
  candle_snapshot: unknown;
  entry_price: number;
  expiry_seconds: number;
  forced?: boolean;
}

export interface BudgetRow {
  written: number;
  max_rows: number;
}

export type RecordPlan =
  | { kind: 'empty' }
  /**
   * The WHOLE batch is refused when it would cross the cap.
   *
   * Postgres does this deliberately, and the comment says why: "نص دفعة مكتوب
   * أسوأ من دفعة مرفوضة، لأنه بيسيب فجوة محدش يعرف حجمها" — half a batch
   * written is worse than a batch refused, because it leaves a gap nobody
   * knows the size of. Writing as many as fit would look kinder and would make
   * the record silently incomplete.
   */
  | { kind: 'capped'; skipped: number; remaining: number }
  | { kind: 'insert'; statements: Statement[] };

/** The UTC date `record_signals` bills the write budget against. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function planRecord(
  rows: readonly IncomingSignal[],
  budget: BudgetRow,
): RecordPlan {
  const n = rows.length;
  if (n === 0) return { kind: 'empty' };

  if (budget.written + n > budget.max_rows) {
    return {
      kind: 'capped',
      skipped: n,
      // GREATEST(0, …) in the original: a budget already over its own cap
      // would otherwise report a negative allowance.
      remaining: Math.max(0, budget.max_rows - budget.written),
    };
  }

  const columns = [
    'symbol', 'timeframe', 'direction', 'bar_ms', 'strategy_version_id', 'slot',
    'confidence', 'score', 'rules_matched', 'candle_snapshot', 'entry_price',
    'expiry_seconds', 'forced', 'created_ms',
  ];

  const statements = rows.map((r): Statement => ({
    sql:
      `INSERT INTO "signals" (${columns.map((c) => `"${c}"`).join(', ')})` +
      ` VALUES (${columns.map(() => '?').join(', ')})` +
      // Identical to the Postgres index, including what it leaves out. NULLs
      // are distinct in a unique index in BOTH engines, so a row with no
      // version never conflicts — which is every row the running strategy
      // writes. The guard is therefore inactive today in Postgres too, and
      // reproducing that exactly is the point of a port.
      ` ON CONFLICT ("strategy_version_id", "symbol", "timeframe", "bar_ms") DO NOTHING`,
    binds: [
      r.symbol, r.timeframe, r.direction, r.bar_ms, r.strategy_version_id, r.slot,
      r.confidence, r.score,
      r.rules_matched === null || r.rules_matched === undefined
        ? null : JSON.stringify(r.rules_matched),
      r.candle_snapshot === null || r.candle_snapshot === undefined
        ? null : JSON.stringify(r.candle_snapshot),
      r.entry_price, r.expiry_seconds,
      // COALESCE(forced, false) — an absent flag is not forced. A signal
      // recorded without it is counted in the published rate, so the default
      // has to be the one that cannot inflate it.
      r.forced === true ? 1 : 0,
      Date.now(),
    ],
  }));

  return { kind: 'insert', statements };
}

/** `expires_at` = created + expiry_seconds, as the original returns it. */
export const expiresAt = (createdMs: number, expirySeconds: number): number =>
  createdMs + expirySeconds * 1000;

// ── resolve_signals ─────────────────────────────────────────────────────────

export interface Resolution {
  id: number;
  price: number | null;
  outcome: string | null;
}

/**
 * Settles one signal.
 *
 * ── THE RULE, VERBATIM ─────────────────────────────────────────────────────
 *
 *     WHEN i.price IS NULL             THEN 'unresolved'
 *     WHEN i.outcome IN (win,loss,tie) THEN i.outcome
 *     ELSE 'unresolved'
 *
 * The `ELSE` carries a comment in the original: an outcome nobody recognises
 * is NOT stored as a tie. It stays "no result" and shows in the statistics as
 * what it is. Mapping it to `tie` would inflate the ties and nobody would be
 * able to say why.
 *
 * `WHERE outcome = 'pending'` matters as much: a signal is settled ONCE. A
 * second resolution for the same id changes nothing, which is what makes the
 * settlement pass safe to retry.
 */
export function outcomeFor(r: Resolution): string {
  if (r.price === null || r.price === undefined) return 'unresolved';
  if (r.outcome === 'win' || r.outcome === 'loss' || r.outcome === 'tie') return r.outcome;
  return 'unresolved';
}

export function planResolve(rows: readonly Resolution[], nowMs: number): Statement[] {
  return rows.map((r) => ({
    sql:
      `UPDATE "signals" SET "outcome_price" = ?, "outcome_ms" = ?, "outcome" = ?` +
      ` WHERE "id" = ? AND "outcome" = 'pending'`,
    binds: [r.price ?? null, nowMs, outcomeFor(r), r.id],
  }));
}

// ── refresh_signal_daily ────────────────────────────────────────────────────

/**
 * Rebuilds the daily aggregate for a date range.
 *
 * ── TWO RULES THAT LOOK LIKE TYPOS AND ARE NOT ─────────────────────────────
 *
 * `wins`, `losses` and `ties` count only rows where `forced` is false. A
 * guaranteed-win signal is excluded from the published rate — recorded without
 * that exclusion, the whole figure is a fabrication.
 *
 * `unresolved` and `pending` have NO such filter. They are not part of the
 * rate, so excluding forced rows from them would make the columns disagree
 * about how many signals the day had.
 *
 * And the WHERE has no `strategy_version_id IS NOT NULL`. It used to. The
 * original's comment on removing it: that clause was what kept the running
 * strategy out of every number on the screen.
 */
export function planRefreshDaily(fromDay: string, toDay: string): Statement {
  return {
    sql:
      `INSERT INTO "signal_daily"` +
      ` ("day", "strategy_version_id", "symbol", "timeframe", "slot",` +
      `  "signals", "wins", "losses", "ties", "unresolved", "pending", "forced")` +
      ` SELECT` +
      `   date("created_ms" / 1000, 'unixepoch') AS d,` +
      `   "strategy_version_id", "symbol", "timeframe", "slot",` +
      `   COUNT(*),` +
      `   COUNT(CASE WHEN "outcome" = 'win'  AND "forced" = 0 THEN 1 END),` +
      `   COUNT(CASE WHEN "outcome" = 'loss' AND "forced" = 0 THEN 1 END),` +
      `   COUNT(CASE WHEN "outcome" = 'tie'  AND "forced" = 0 THEN 1 END),` +
      `   COUNT(CASE WHEN "outcome" = 'unresolved' THEN 1 END),` +
      `   COUNT(CASE WHEN "outcome" = 'pending' THEN 1 END),` +
      `   COUNT(CASE WHEN "forced" = 1 THEN 1 END)` +
      ` FROM "signals"` +
      ` WHERE date("created_ms" / 1000, 'unixepoch') BETWEEN ? AND ?` +
      ` GROUP BY d, "strategy_version_id", "symbol", "timeframe", "slot"` +
      ` ON CONFLICT ("day",` +
      `   COALESCE("strategy_version_id", '00000000-0000-0000-0000-000000000000'),` +
      `   "symbol", "timeframe", "slot")` +
      ` DO UPDATE SET` +
      `   "signals" = excluded."signals", "wins" = excluded."wins",` +
      `   "losses" = excluded."losses", "ties" = excluded."ties",` +
      `   "unresolved" = excluded."unresolved", "pending" = excluded."pending",` +
      `   "forced" = excluded."forced"` +
      // ── The one deliberate difference from Postgres ──────────────────────
      //
      // Skip rows whose counters are unchanged. Postgres rewrites all of them,
      // which costs nothing there and is 51% of D1's entire daily write budget
      // here — the same 178 rows, 144 times a day, almost none of them
      // different. The resulting DATA is identical; only the row count this
      // returns changes meaning, from "touched" to "changed".
      ` WHERE "signal_daily"."signals" IS NOT excluded."signals"` +
      `    OR "signal_daily"."wins" IS NOT excluded."wins"` +
      `    OR "signal_daily"."losses" IS NOT excluded."losses"` +
      `    OR "signal_daily"."ties" IS NOT excluded."ties"` +
      `    OR "signal_daily"."unresolved" IS NOT excluded."unresolved"` +
      `    OR "signal_daily"."pending" IS NOT excluded."pending"` +
      `    OR "signal_daily"."forced" IS NOT excluded."forced"`,
    binds: [fromDay, toDay],
  };
}

// ── prune_signals ───────────────────────────────────────────────────────────

/**
 * Drops raw signals past the retention window.
 *
 * The original refreshes the aggregate for the week before the cut BEFORE
 * deleting, so the summary of what is about to be removed is final first.
 * Deleting and then aggregating would leave those days permanently short, and
 * the numbers would look like a quiet week rather than a missing one.
 */
export function planPrune(keepDays: number, nowMs: number): {
  refresh: Statement;
  del: Statement;
  cutDay: string;
} {
  const cut = new Date(nowMs - keepDays * 86_400_000);
  const cutDay = cut.toISOString().slice(0, 10);
  const weekBefore = new Date(cut.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);

  return {
    cutDay,
    refresh: planRefreshDaily(weekBefore, cutDay),
    del: {
      sql: `DELETE FROM "signals" WHERE date("created_ms" / 1000, 'unixepoch') <= ?`,
      binds: [cutDay],
    },
  };
}
