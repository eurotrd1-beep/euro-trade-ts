/**
 * The signal spool, against a real SQLite.
 *
 * What is being defended is one property: every signal the generator produced
 * ends up in `signals` exactly once, however the outage goes. There are two
 * ways to break it and they point in opposite directions — lose the row, or
 * write it twice — and the second one is not hypothetical: the unique index is
 * inert for every row the running strategy writes, because `strategy_version_id`
 * is NULL and NULLs are distinct in a unique index. That is how 38 duplicates
 * got in this morning.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXISTS_SQL, existsBinds } from '../src/spool.js';
import { planRecord, type IncomingSignal } from '../src/pipeline.js';

// `createRequire`, as schema.test.ts does: Vite's resolver strips the `node:`
// prefix from `node:sqlite` and then cannot find a package called `sqlite`.
type Stmt = { run(...a: never[]): unknown; get(...a: never[]): unknown; all(...a: never[]): unknown[] };
type DatabaseSync = { exec(sql: string): void; prepare(sql: string): Stmt };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

const SCHEMA = readFileSync(fileURLToPath(new URL('../migrations/0001_schema.sql', import.meta.url)), 'utf8');

const fresh = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
};

const signal = (over: Partial<IncomingSignal> = {}): IncomingSignal => ({
  symbol: 'EURUSD_otc', timeframe: '1m', direction: 'CALL', bar_ms: 1_000_000,
  strategy_version_id: null, slot: 'instant_free', confidence: 0.7, score: 3,
  rules_matched: null, candle_snapshot: null, entry_price: 1.1, expiry_seconds: 60,
  ...over,
});

const insert = (db: DatabaseSync, rows: IncomingSignal[], now?: number): void => {
  const plan = planRecord(rows, { written: 0, max_rows: 20000 }, now);
  if (plan.kind !== 'insert') throw new Error(plan.kind);
  for (const st of plan.statements) db.prepare(st.sql).run(...(st.binds as never[]));
};

const exists = (db: DatabaseSync, r: IncomingSignal): boolean =>
  db.prepare(EXISTS_SQL).get(...(existsBinds(r) as never[])) !== undefined;

describe('why the spool has to check before it writes', () => {
  it('the unique index does NOT stop a second copy of a NULL-version signal', () => {
    // This is the premise of the whole design, so it is asserted rather than
    // assumed. If this test ever fails, the index started working and the
    // check below became belt-and-braces rather than the only guard.
    const db = fresh();
    insert(db, [signal()]);
    insert(db, [signal()]);
    const n = db.prepare('SELECT count(*) AS n FROM signals').get() as { n: number };
    expect(n.n).toBe(2);
  });
});

describe('the existence check', () => {
  it('finds a signal that is already recorded', () => {
    const db = fresh();
    insert(db, [signal()]);
    expect(exists(db, signal())).toBe(true);
  });

  it('matches a NULL version to a NULL version, which `=` cannot', () => {
    const db = fresh();
    insert(db, [signal({ strategy_version_id: null })]);
    expect(exists(db, signal({ strategy_version_id: null }))).toBe(true);
  });

  it('tells the four slots on one bar apart', () => {
    // The index has no `slot`, which is why four rows per bar coexist. The
    // check does — otherwise a replayed paid signal would be taken for the
    // free one already present, and dropped.
    const db = fresh();
    insert(db, [signal({ slot: 'instant_free' })]);
    expect(exists(db, signal({ slot: 'instant_free' }))).toBe(true);
    expect(exists(db, signal({ slot: 'instant_paid' }))).toBe(false);
    expect(exists(db, signal({ slot: 'monitoring_free' }))).toBe(false);
  });

  it('does not match a different bar, symbol, timeframe or version', () => {
    const db = fresh();
    insert(db, [signal()]);
    expect(exists(db, signal({ bar_ms: 2_000_000 }))).toBe(false);
    expect(exists(db, signal({ symbol: 'GBPUSD_otc' }))).toBe(false);
    expect(exists(db, signal({ timeframe: '5m' }))).toBe(false);
    expect(exists(db, signal({ strategy_version_id: 'v1' }))).toBe(false);
  });

  it('distinguishes a real version from NULL', () => {
    const db = fresh();
    insert(db, [signal({ strategy_version_id: 'v1' })]);
    expect(exists(db, signal({ strategy_version_id: 'v1' }))).toBe(true);
    expect(exists(db, signal({ strategy_version_id: null }))).toBe(false);
  });

  it('uses the identity index rather than scanning the table', () => {
    // During an outage the drain checks every spooled row; a scan per row
    // against a table of thousands would spend the read budget on the way
    // back from the outage.
    const db = fresh();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${EXISTS_SQL}`)
      .all(...(existsBinds(signal()) as never[])) as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(' ');
    expect(detail).toMatch(/signals_identity/);
    expect(detail).not.toMatch(/SCAN signals/);
  });
});

describe('a replay writes what would have been written', () => {
  it('keeps the moment the record call was made', () => {
    // A signal generated at 23:50 and replayed at 02:00 belongs to the day it
    // was generated. Stamping the replay time would move it.
    const db = fresh();
    const original = Date.UTC(2026, 8, 17, 23, 50);
    insert(db, [signal()], original);
    const row = db.prepare('SELECT created_ms FROM signals').get() as { created_ms: number };
    expect(row.created_ms).toBe(original);
  });

  it('leaves the live path on the clock', () => {
    // No `now` passed — every call the generator makes. It must be exactly
    // what it was before the parameter existed.
    const db = fresh();
    const before = Date.now();
    insert(db, [signal()]);
    const after = Date.now();
    const row = db.prepare('SELECT created_ms FROM signals').get() as { created_ms: number };
    expect(row.created_ms).toBeGreaterThanOrEqual(before);
    expect(row.created_ms).toBeLessThanOrEqual(after);
  });
});

describe('a full outage, played out', () => {
  it('ends with every signal recorded exactly once', () => {
    // Four signals spooled. The first drain inserts two and then "loses" the
    // acknowledgement — the rows landed but the spool still holds them. The
    // second drain sees all four again.
    const db = fresh();
    const spooled = [
      signal({ bar_ms: 1, slot: 'instant_free' }),
      signal({ bar_ms: 1, slot: 'instant_paid' }),
      signal({ bar_ms: 2, slot: 'instant_free' }),
      signal({ bar_ms: 2, slot: 'instant_paid' }),
    ];

    const drain = (rows: IncomingSignal[]): number => {
      let moved = 0;
      for (const r of rows) {
        if (exists(db, r)) continue;
        insert(db, [r]);
        moved++;
      }
      return moved;
    };

    // First drain, interrupted after two.
    expect(drain(spooled.slice(0, 2))).toBe(2);
    // Acknowledgement lost — all four come back.
    expect(drain(spooled)).toBe(2);
    // And a third pass, for good measure, writes nothing.
    expect(drain(spooled)).toBe(0);

    const n = db.prepare('SELECT count(*) AS n FROM signals').get() as { n: number };
    expect(n.n).toBe(4);
  });
});
