/**
 * Retention for D1 — the job Postgres was doing that nothing else took over.
 *
 * ── HOW THIS WAS FOUND ─────────────────────────────────────────────────────
 *
 * By the comparison alarming. `signals` showed 12,744 rows in Supabase against
 * 14,262 in D1, and D1 having MORE is the one direction that should be
 * impossible before the switch. Nothing had written to D1: Supabase had
 * SHRUNK, because `prune_signals` ran there on schedule. D1 has no schedule,
 * so nothing was ever going to shrink it.
 *
 * Left alone, the tables that grow forever grow forever. The free plan gives
 * 5 GB of storage and five million row reads a day, and both are reached by
 * the same table getting longer — slowly, with no error, until a query that
 * used to be cheap is not.
 *
 * ── THE NUMBERS ARE NOT NEW ONES ───────────────────────────────────────────
 *
 * Every retention below was read out of the corresponding Postgres function in
 * the pg_dump, not chosen here. Inventing a retention during a migration means
 * the two databases disagree about what exists, and the first person to notice
 * is whoever goes looking for a record that was quietly deleted early.
 *
 *   push_alerts      1 day    prune_push_alerts
 *   telegram_alerts  7 days   prune_telegram_alerts
 *   telegram_queue   7 days   prune_telegram_queue
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
 *
 * `signals` and `signal_daily` are absent on purpose. They belong to the
 * signal pipeline, which stays on Supabase, and `prune_signals` there is still
 * their retention. Pruning them here would delete rows from a copy that is not
 * the one being read — and, worse, would be this code deciding when a trade
 * record stops existing.
 */

/** One table, one age limit, one column that holds the time. */
interface Retention {
  table: string;
  column: string;
  days: number;
  /** The Postgres function this mirrors, so the two can be compared. */
  origin: string;
}

export const RETENTION: readonly Retention[] = [
  // A dedup ledger for push notifications. A day is enough to stop the same
  // alert going twice; older rows answer no question.
  { table: 'push_alerts', column: 'sent_ms', days: 1, origin: 'prune_push_alerts' },
  { table: 'telegram_alerts', column: 'sent_ms', days: 7, origin: 'prune_telegram_alerts' },
  { table: 'telegram_queue', column: 'created_ms', days: 7, origin: 'prune_telegram_queue' },
];

export interface PruneResult {
  table: string;
  deleted: number;
  error?: string;
}

/**
 * Deletes what is past its retention, one table at a time.
 *
 * ── WHY A LIMIT PER RUN ────────────────────────────────────────────────────
 *
 * D1's free plan allows 100,000 row writes a day and a DELETE counts as a
 * write. A first run against a table that has never been pruned could exceed
 * that by itself, and going over does not slow anything down — it blocks every
 * query on the database until 00:00 UTC. So each table gives up a bounded
 * number per run and catches up over the following runs instead.
 */
export const MAX_DELETES_PER_TABLE = 2_000;

export async function prune(
  db: D1Database,
  now: number = Date.now(),
): Promise<PruneResult[]> {
  const out: PruneResult[] = [];

  for (const r of RETENTION) {
    const cutoff = now - r.days * 86_400_000;
    try {
      // The table and column are literals from this file. The cutoff and the
      // limit are bound. Nothing here comes from a request — this runs on a
      // timer, with no caller.
      const result = await db
        .prepare(
          `DELETE FROM "${r.table}" WHERE "${r.column}" < ?` +
          ` AND rowid IN (SELECT rowid FROM "${r.table}" WHERE "${r.column}" < ? LIMIT ?)`,
        )
        .bind(cutoff, cutoff, MAX_DELETES_PER_TABLE)
        .run();
      out.push({ table: r.table, deleted: result.meta?.changes ?? 0 });
    } catch (e) {
      // One table failing must not stop the others. A prune that stops at the
      // first error leaves every later table unpruned and reports one problem.
      out.push({
        table: r.table,
        deleted: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return out;
}
