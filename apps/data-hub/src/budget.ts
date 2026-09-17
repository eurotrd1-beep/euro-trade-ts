/**
 * The daily write budget, and what to drop when it runs out.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * D1's free plan allows 100,000 row writes a day. Going over does not slow
 * anything down and does not queue: it REFUSES every query on the database —
 * reads included — until 00:00 UTC. So the failure is not "candles stop
 * saving", it is "the app stops", and it lasts until midnight regardless of
 * what caused it.
 *
 * Measured on a normal Thursday with both markets open, the candle path alone
 * writes about 65,700 rows a day (2,273 per 1-minute key × 25 pairs, plus the
 * higher timeframes). Everything else together — the signal pipeline, the
 * admin, the price snapshot, the app — is about 20,000. That is roughly 87%,
 * which leaves no room for a volatile day.
 *
 * ── WHAT IT SHEDS, AND WHY THAT ONE ────────────────────────────────────────
 *
 * Candles, and only candles.
 *
 * They are the largest writer by a factor of three, and they are the only
 * writer whose data can be rebuilt: the scraper holds every candle in memory
 * and the table is a rolling 100-bar window that exists so a restart does not
 * start blind. Losing a few hours of candle PERSISTENCE costs a colder restart.
 *
 * Everything else cannot be rebuilt. A signal that is not recorded never
 * happened, and the published win rate is computed from those rows — a gap in
 * them is a gap in the record that no later pass can fill. A settlement that is
 * not written leaves a trade `pending` for ever. An account patch that is
 * refused leaves somebody paid-for-VIP without VIP.
 *
 * So when the budget gets tight the choice is not "which write fails" but
 * "which write fails FIRST", and the honest answer is the one that can be
 * reconstructed from a process that is still running.
 *
 * ── THE COUNTER IS APPROXIMATE, AND THAT IS FINE ───────────────────────────
 *
 * It lives in `caches.default`, which is per-colo and not shared between
 * Workers isolates, so it undercounts. It is a smoke alarm, not an accountant:
 * it fires early enough to protect the writes that matter, and if it misses
 * some the only cost is that it fires later than it could have.
 *
 * It never fails closed. A cache that cannot be read returns "plenty left",
 * because a broken counter must not be able to stop the pipeline — that would
 * be the outage it exists to prevent, caused by the guard.
 */

/** Cloudflare's published free-plan limit. */
export const DAILY_WRITE_LIMIT = 100_000;

/**
 * Where candle writes start being refused.
 *
 * 80% rather than 99%: the counter undercounts, and the whole point is to stop
 * before the cliff rather than at it. The 20,000 rows left over are several
 * times what the signal pipeline spends in a day.
 */
export const SHED_CANDLES_AT = 0.8;

/** Tables that may be refused to protect the rest. In priority order. */
export const SHEDDABLE: readonly string[] = ['candles'];

const key = (day: string): string => `https://budget.internal/writes/${day}`;

/** The UTC day, which is the day the limit resets on. */
export const utcDay = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

/**
 * How many writes this colo has seen today.
 *
 * Returns 0 when it cannot tell, so an unreadable cache reads as an empty
 * budget rather than a full one.
 */
export async function writesToday(day = utcDay()): Promise<number> {
  try {
    const hit = await caches.default.match(key(day));
    if (!hit) return 0;
    return Number(await hit.text()) || 0;
  } catch {
    return 0;
  }
}

/** Adds to today's count. Never throws — a lost count is not worth an error. */
export async function countWrites(rows: number, day = utcDay()): Promise<void> {
  if (rows <= 0) return;
  try {
    const current = await writesToday(day);
    await caches.default.put(
      key(day),
      new Response(String(current + rows), {
        // Long enough to cover the day, short enough that a stale entry cannot
        // hold a stale count into tomorrow.
        headers: { 'Cache-Control': 'max-age=86400' },
      }),
    );
  } catch {
    // Unwritable cache: the write still happened, it is just not counted.
  }
}

export interface Verdict {
  /** True when this write should be refused to protect the rest of the day. */
  shed: boolean;
  used: number;
  /** 0–1, against the daily limit. */
  fraction: number;
}

/**
 * Whether a write to this table should be shed right now.
 *
 * Only ever true for a table in SHEDDABLE. Everything else is allowed through
 * at any usage level — if the budget is going to be exhausted, it should be
 * exhausted by the writes that cannot be reconstructed.
 */
export async function shouldShed(table: string, day = utcDay()): Promise<Verdict> {
  const used = await writesToday(day);
  const fraction = used / DAILY_WRITE_LIMIT;
  const shed = SHEDDABLE.includes(table) && fraction >= SHED_CANDLES_AT;
  return { shed, used, fraction };
}
