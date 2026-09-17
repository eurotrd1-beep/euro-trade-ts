/**
 * The guard that decides what to drop when the day runs out of writes.
 *
 * Going over D1's daily write limit does not slow anything down and does not
 * queue — it refuses every query, reads included, until 00:00 UTC. So the
 * question this file answers is not "how do we stay under" but "if we are
 * going over anyway, which write should fail FIRST".
 *
 * The answer has to be the one that can be reconstructed. Candles live in the
 * scraper's memory and the table is a rolling window that exists so a restart
 * is not blind — losing a few hours of persistence costs a colder restart. A
 * signal that is never recorded never happened, and the published win rate is
 * computed from those rows.
 *
 * The tests below are mostly about the ways a guard like this goes wrong:
 * shedding the wrong table, shedding too late to help, or — worst — failing
 * closed and causing the outage it exists to prevent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for `caches.default`, which does not exist outside a Worker. */
const store = new Map<string, string>();
let broken = false;

vi.stubGlobal('caches', {
  default: {
    async match(key: string) {
      if (broken) throw new Error('cache unavailable');
      const hit = store.get(String(key));
      return hit === undefined ? undefined : { text: async () => hit };
    },
    async put(key: string, res: { text: () => Promise<string> }) {
      if (broken) throw new Error('cache unavailable');
      store.set(String(key), await res.text());
    },
  },
});

const {
  DAILY_WRITE_LIMIT, SHED_CANDLES_AT, SHEDDABLE,
  countWrites, shouldShed, utcDay, writesToday,
} = await import('../src/budget.js');

const DAY = '2026-09-17';

beforeEach(() => {
  store.clear();
  broken = false;
});

describe('counting', () => {
  it('starts at nothing', async () => {
    expect(await writesToday(DAY)).toBe(0);
  });

  it('accumulates', async () => {
    await countWrites(10, DAY);
    await countWrites(5, DAY);
    expect(await writesToday(DAY)).toBe(15);
  });

  it('ignores a write that changed no rows', async () => {
    // An UPDATE whose WHERE matched nothing costs nothing, and charging for it
    // would shed candles early on the strength of writes that never happened.
    await countWrites(0, DAY);
    await countWrites(-3, DAY);
    expect(await writesToday(DAY)).toBe(0);
  });

  it('keeps each UTC day separate', async () => {
    // The limit resets at 00:00 UTC, so yesterday's spend must not be carried
    // into a fresh budget.
    await countWrites(90_000, '2026-09-16');
    expect(await writesToday('2026-09-17')).toBe(0);
  });

  it('names the day the way the limit resets', () => {
    expect(utcDay(Date.UTC(2026, 8, 17, 23, 59, 59))).toBe('2026-09-17');
    expect(utcDay(Date.UTC(2026, 8, 18, 0, 0, 1))).toBe('2026-09-18');
  });
});

describe('what gets shed', () => {
  it('lets candles through while there is room', async () => {
    await countWrites(1000, DAY);
    expect((await shouldShed('candles', DAY)).shed).toBe(false);
  });

  it('refuses candles once the day is 80% spent', async () => {
    await countWrites(DAILY_WRITE_LIMIT * SHED_CANDLES_AT, DAY);
    const v = await shouldShed('candles', DAY);
    expect(v.shed).toBe(true);
    expect(v.fraction).toBeCloseTo(SHED_CANDLES_AT);
  });

  it('never refuses anything that cannot be rebuilt', async () => {
    // At 99% of the budget, with the database about to refuse everything, these
    // still go through. A signal that is not recorded never happened, and no
    // later pass can fill the gap — so if the budget is going to be spent, it
    // is spent on these.
    await countWrites(99_000, DAY);
    for (const table of ['signals', 'signal_daily', 'users', 'configs',
                         'signal_history', 'telegram_alerts', 'clicks']) {
      expect((await shouldShed(table, DAY)).shed, table).toBe(false);
    }
  });

  it('sheds candles and nothing else', async () => {
    await countWrites(99_000, DAY);
    expect(SHEDDABLE).toEqual(['candles']);
    expect((await shouldShed('candles', DAY)).shed).toBe(true);
  });

  it('sheds early enough to leave the pipeline a whole day of room', async () => {
    // The pipeline spends about 15,600 rows a day, measured. The reserve left
    // by shedding at 80% is 20,000 — more than a full day of it, so a candle
    // flood cannot starve the signals even if it starts at midnight.
    const reserve = DAILY_WRITE_LIMIT * (1 - SHED_CANDLES_AT);
    expect(reserve).toBeGreaterThan(15_600);
  });
});

describe('a broken counter must not become the outage', () => {
  it('reads as an empty budget rather than a full one', async () => {
    await countWrites(99_000, DAY);
    broken = true;
    // It cannot read the count, so it must not conclude the budget is spent.
    // Failing closed here would stop candle writes permanently on a cache
    // fault — the guard causing the failure it exists to prevent.
    expect((await shouldShed('candles', DAY)).shed).toBe(false);
  });

  it('does not throw when it cannot count', async () => {
    broken = true;
    await expect(countWrites(5, DAY)).resolves.toBeUndefined();
    await expect(writesToday(DAY)).resolves.toBe(0);
  });
});
