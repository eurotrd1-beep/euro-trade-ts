/**
 * The two ported functions, run on a real engine.
 *
 * ── WHAT A PORT CAN GET WRONG WITHOUT FAILING ──────────────────────────────
 *
 * Both of these carry a decision in their body that the call site cannot show,
 * and both decisions are invisible when broken:
 *
 *   signal_stats LEFT JOINs a table it uses no column from. An INNER join
 *   there dropped every row whose version was NULL — which is every row from
 *   the strategy that is actually running. The query still returned numbers.
 *
 *   The win rate is NULL below thirty settled trades. Computed-and-hidden is
 *   not the same thing: a number that gets calculated leaks out somewhere.
 *
 * So the tests below are mostly about rows that should be counted and numbers
 * that should be absent, not about the arithmetic.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildClick, buildStats, parseStats, type StatsFilter } from '../src/rpc.js';

interface Db {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
}
let db: Db;

const filter = (over: Partial<StatsFilter> = {}): StatsFilter => ({
  from: '2026-01-01', to: '2026-12-31', groupBy: 'total',
  slot: null, version: null, symbol: null, ...over,
});

const stats = (f: StatsFilter): Record<string, unknown>[] => {
  const { sql, binds } = buildStats(f);
  return db.prepare(sql).all(...binds) as Record<string, unknown>[];
};

/** `wins` of a day, with everything else defaulted. */
const day = (
  d: string, symbol: string, version: string | null,
  wins: number, losses: number, extra: Record<string, number> = {},
) => {
  db.prepare(`INSERT INTO signal_daily
    (day, strategy_version_id, symbol, timeframe, slot, signals, wins, losses, ties,
     unresolved, pending, forced)
    VALUES (?, ?, ?, '1m', 'instant_free', ?, ?, ?, ?, ?, ?, ?)`).run(
    d, version, symbol, wins + losses, wins, losses,
    extra['ties'] ?? 0, extra['unresolved'] ?? 0, extra['pending'] ?? 0, extra['forced'] ?? 0,
  );
};

beforeEach(() => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  db = new DatabaseSync(':memory:') as Db;
  db.exec(readFileSync(
    fileURLToPath(new URL('../migrations/0001_schema.sql', import.meta.url)), 'utf8',
  ));
});

describe('signal_stats counts the rows with no version', () => {
  it('includes them in the total', () => {
    // The running strategy stamps no version. An INNER JOIN on
    // strategy_versions dropped exactly these, and the Postgres original
    // carries a comment saying so.
    day('2026-03-01', 'EURUSD_otc', null, 20, 10);
    day('2026-03-02', 'EURUSD_otc', 'v-old', 5, 5);

    const [row] = stats(filter());
    expect(row!['signals']).toBe(40);
    expect(row!['wins']).toBe(25);
  });

  it('gives them a name rather than a null key when grouped by version', () => {
    // The bucket is read back as a key in JSON, where `null` is
    // indistinguishable from "no result".
    day('2026-03-01', 'EURUSD_otc', null, 20, 10);
    day('2026-03-02', 'EURUSD_otc', 'v-old', 5, 5);

    const buckets = stats(filter({ groupBy: 'version' })).map((r) => r['bucket']);
    expect(buckets).toContain('current');
    expect(buckets).toContain('v-old');
    expect(buckets).not.toContain(null);
  });

  it('separates the two eras, which is the point of the version grouping', () => {
    // 10,809 rows came from strategies that were removed; the running one
    // stamps none. Summed together they answer a question nobody asked.
    day('2026-03-01', 'EURUSD_otc', null, 40, 20);      // current: 66.7%
    day('2026-03-02', 'EURUSD_otc', 'v-old', 10, 90);   // old: 10%

    const rows = stats(filter({ groupBy: 'version' }));
    const current = rows.find((r) => r['bucket'] === 'current')!;
    const old = rows.find((r) => r['bucket'] === 'v-old')!;
    expect(current['win_rate']).toBe(66.7);
    expect(old['win_rate']).toBe(10);
  });
});

describe('the thirty-trade floor', () => {
  it('returns no win rate below thirty settled trades', () => {
    day('2026-03-01', 'EURUSD_otc', null, 20, 9); // 29 settled
    expect(stats(filter())[0]!['win_rate']).toBeNull();
  });

  it('returns one at exactly thirty', () => {
    day('2026-03-01', 'EURUSD_otc', null, 20, 10);
    expect(stats(filter())[0]!['win_rate']).toBe(66.7);
  });

  it('counts only wins and losses toward the floor', () => {
    // Ties, unresolved and pending are excluded from the rate, so they must
    // not be allowed to unlock it either — 29 settled plus 50 ties is still
    // 29 settled.
    day('2026-03-01', 'EURUSD_otc', null, 20, 9, { ties: 50, unresolved: 50, pending: 50 });
    expect(stats(filter())[0]!['win_rate']).toBeNull();
  });

  it('is NULL, not zero — zero is a win rate and this is not', () => {
    day('2026-03-01', 'EURUSD_otc', null, 0, 5);
    const row = stats(filter())[0]!;
    expect(row['win_rate']).toBeNull();
    expect(row['win_rate']).not.toBe(0);
  });
});

describe('the filters and the range', () => {
  beforeEach(() => {
    day('2026-03-01', 'EURUSD_otc', null, 10, 0);
    day('2026-04-01', 'GBPUSD_otc', null, 20, 0);
  });

  it('keeps the range inclusive at both ends', () => {
    expect(stats(filter({ from: '2026-03-01', to: '2026-03-01' }))[0]!['wins']).toBe(10);
    expect(stats(filter({ from: '2026-04-01', to: '2026-04-01' }))[0]!['wins']).toBe(20);
  });

  it('excludes what is outside it', () => {
    expect(stats(filter({ from: '2026-05-01', to: '2026-05-31' }))).toEqual([]);
  });

  it('filters by symbol', () => {
    expect(stats(filter({ symbol: 'GBPUSD_otc' }))[0]!['wins']).toBe(20);
  });

  it('groups by day and by symbol', () => {
    expect(stats(filter({ groupBy: 'day' })).map((r) => r['bucket']))
      .toEqual(['2026-03-01', '2026-04-01']);
    expect(stats(filter({ groupBy: 'symbol' })).map((r) => r['bucket']))
      .toEqual(['EURUSD_otc', 'GBPUSD_otc']);
  });

  it('binds every filter value instead of writing it', () => {
    const { sql, binds } = buildStats(filter({ symbol: "'; DROP TABLE signal_daily; --" }));
    expect(sql).not.toContain('DROP');
    expect(binds).toContain("'; DROP TABLE signal_daily; --");
  });
});

describe('parsing the stats request', () => {
  const parse = (q: string) => parseStats(new URLSearchParams(q));

  it('refuses a malformed date', () => {
    // It would compare as text against a real one and return a silently wrong
    // range, which looks like an answer.
    expect(parse('from=yesterday&to=2026-03-01')).toBeNull();
    expect(parse('from=2026-3-1&to=2026-03-01')).toBeNull();
    expect(parse('to=2026-03-01')).toBeNull();
  });

  it('falls back to total for a grouping nobody defined', () => {
    expect(parse('from=2026-01-01&to=2026-12-31&group_by=whatever')?.groupBy).toBe('total');
  });

  it('keeps the five real ones', () => {
    for (const g of ['total', 'day', 'symbol', 'slot', 'version']) {
      expect(parse(`from=2026-01-01&to=2026-12-31&group_by=${g}`)?.groupBy).toBe(g);
    }
  });
});

describe('increment_click adds one and can do nothing else', () => {
  const click = (row: string, field: string): boolean => {
    const s = buildClick(row, field);
    if (s === null) return false;
    db.prepare(s.sql).run(...s.binds);
    return true;
  };
  const read = (row: string): Record<string, number> =>
    JSON.parse(String((db.prepare('SELECT data FROM clicks WHERE id = ?')
      .all(row)[0] as { data: string }).data));

  it('creates the row on the first click', () => {
    expect(click('brokers', 'pocketLogins')).toBe(true);
    expect(read('brokers')).toEqual({ pocketLogins: 1 });
  });

  it('adds one to an existing counter without touching its neighbours', () => {
    click('brokers', 'pocketLogins');
    click('brokers', 'quotexLogins');
    click('brokers', 'pocketLogins');
    click('brokers', 'pocketLogins');
    expect(read('brokers')).toEqual({ pocketLogins: 3, quotexLogins: 1 });
  });

  it('refuses a name that could escape the JSON path', () => {
    // The name goes into a path built by concatenation. Postgres passed it as
    // a bound array element and could afford not to care; here it matters.
    for (const bad of ['a.b', 'a$b', 'a[0]', '', 'x'.repeat(41), '$.', 'a b']) {
      expect(buildClick('brokers', bad), bad).toBeNull();
    }
  });

  it('refuses a row id that is empty or absurd', () => {
    expect(buildClick('', 'x')).toBeNull();
    expect(buildClick('x'.repeat(65), 'x')).toBeNull();
  });

  it('binds the row id rather than writing it', () => {
    const s = buildClick("'; DELETE FROM clicks; --", 'ok')!;
    expect(s.sql).not.toContain('DELETE');
    expect(s.binds).toContain("'; DELETE FROM clicks; --");
  });
});

describe('the win rate matches Postgres, not the float', () => {
  it('rounds 41 of 80 to 51.3, the way exact decimal does', () => {
    // The real case, from BITB_otc. 41/80 is exactly 51.25%, which Postgres
    // rounds up in `numeric`. Computed as a float it is 51.24999999999999 and
    // rounds DOWN — one tenth of a percent on a published number, on one
    // symbol out of 169.
    day('2026-03-01', 'BITB_otc', null, 41, 39);
    expect(stats(filter())[0]!['win_rate']).toBe(51.3);
  });

  it('rounds every exact half upward', () => {
    for (const [wins, losses, expected] of [
      [41, 39, 51.3],   // 51.25
      [1, 7, null],     // below the floor
      [21, 19, 52.5],   // exact, no rounding needed
      [5, 11, null],    // below the floor
    ] as [number, number, number | null][]) {
      db.exec('DELETE FROM signal_daily');
      day('2026-03-01', 'X_otc', null, wins, losses);
      expect(stats(filter())[0]?.['win_rate'] ?? null, `${wins}/${wins + losses}`)
        .toBe(expected);
    }
  });

  it('never returns a float artefact like 66.70000000000001', () => {
    day('2026-03-01', 'X_otc', null, 20, 10);
    const rate = stats(filter())[0]!['win_rate'] as number;
    expect(rate).toBe(66.7);
    expect(String(rate)).toBe('66.7');
  });
});
