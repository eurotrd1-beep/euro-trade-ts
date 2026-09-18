/**
 * The daily rollup, and the range it scans.
 *
 * ── WHAT WENT WRONG ────────────────────────────────────────────────────────
 *
 * The rollup selected its rows with `date("created_ms" / 1000, 'unixepoch')
 * BETWEEN ? AND ?`. That is a function of the column, so no index can answer
 * it and SQLite reads every row in the table — the whole 30-day retention
 * window, to rebuild three days of counters. At 218 runs a day that was 3.1
 * million row reads, 88% of everything the database read, against a daily
 * ceiling that blocks reads as well as writes when it is hit.
 *
 * The fix adds a range on the raw column, which `signals_created` can seek on,
 * and keeps the `date()` clause, which is the one that defines the result.
 *
 * ── SO THIS FILE ASKS ONE QUESTION ─────────────────────────────────────────
 *
 * Does the narrowed scan return exactly what the unnarrowed one did? An
 * off-by-one at either edge silently drops a day's signals out of the
 * published statistics and nothing else would notice: the numbers would still
 * add up, they would just be the wrong numbers.
 *
 * So every test here compares the two against a real SQLite engine, with rows
 * placed on the boundaries themselves.
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dayStartMs, planPrune, planRefreshDaily } from '../src/pipeline.js';

interface Stmt {
  run(...a: unknown[]): unknown;
  all(...a: unknown[]): Array<Record<string, unknown>>;
}
type DatabaseSync = { exec(sql: string): void; prepare(sql: string): Stmt };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

const MIGRATIONS = readdirSync(fileURLToPath(new URL('../migrations', import.meta.url)))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(fileURLToPath(new URL(`../migrations/${f}`, import.meta.url)), 'utf8'));

const fresh = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
};

const DAY = 86_400_000;
const FROM = '2026-09-16';
const TO = '2026-09-18';

/** The rollup's SELECT half, with whichever WHERE is being tested. */
const aggregate = (where: string): string =>
  'SELECT date("created_ms" / 1000, \'unixepoch\') AS d,' +
  ' "strategy_version_id" AS v, "symbol" AS s, "timeframe" AS t, "slot" AS sl,' +
  ' COUNT(*) AS n,' +
  ' COUNT(CASE WHEN "outcome" = \'win\'  AND "forced" = 0 THEN 1 END) AS w,' +
  ' COUNT(CASE WHEN "outcome" = \'loss\' AND "forced" = 0 THEN 1 END) AS l,' +
  ' COUNT(CASE WHEN "outcome" = \'unresolved\' THEN 1 END) AS u,' +
  ' COUNT(CASE WHEN "forced" = 1 THEN 1 END) AS f' +
  ` FROM "signals" WHERE ${where}` +
  ' GROUP BY d, v, s, t, sl ORDER BY d, s, t, sl';

const LEGACY_WHERE = 'date("created_ms" / 1000, \'unixepoch\') BETWEEN ? AND ?';
const NARROWED_WHERE = `${LEGACY_WHERE} AND "created_ms" >= ? AND "created_ms" < ?`;

let seq = 0;
function insert(db: DatabaseSync, createdMs: number, outcome = 'win', forced = 0): void {
  seq += 1;
  db.prepare(
    'INSERT INTO "signals" ("id", "symbol", "timeframe", "slot", "bar_ms", "direction",' +
      ' "entry_price", "expiry_seconds", "created_ms", "outcome", "forced")' +
      " VALUES (?, 'EURUSD_otc', '1m', 'instant_free', ?, 'CALL', 1.1, 60, ?, ?, ?)",
  ).run(seq, createdMs, createdMs, outcome, forced);
}

/** Rows on every edge of the window, and one well outside each end. */
function boundaryRows(db: DatabaseSync): void {
  const from = dayStartMs(FROM);
  const to = dayStartMs(TO);
  insert(db, from - 1, 'loss'); // the last millisecond of the day before
  insert(db, from); // midnight exactly, the first row that counts
  insert(db, from + 1);
  insert(db, from + DAY / 2, 'loss');
  insert(db, to + DAY - 1, 'unresolved'); // 23:59:59.999 of the last day
  insert(db, to + DAY, 'win'); // midnight of the day after, excluded
  insert(db, from - 9 * DAY);
  insert(db, to + 9 * DAY);
  insert(db, from + DAY, 'win', 1); // a forced row, mid-window
}

describe('the narrowed scan returns what the full scan did', () => {
  it('agrees row for row, including on both boundaries', () => {
    const db = fresh();
    boundaryRows(db);

    const legacy = db.prepare(aggregate(LEGACY_WHERE)).all(FROM, TO);
    const narrowed = db
      .prepare(aggregate(NARROWED_WHERE))
      .all(FROM, TO, dayStartMs(FROM), dayStartMs(TO) + DAY);

    expect(narrowed).toEqual(legacy);
    // Not vacuously equal: the window really does hold rows, and really does
    // exclude the ones on the far side of each edge.
    expect(legacy.length).toBeGreaterThan(0);
    // Five of the nine rows are inside the window: both boundary rows, the two
    // mid-window ones and the forced one.
    const counted = legacy.reduce((sum, r) => sum + Number(r['n']), 0);
    expect(counted).toBe(5);
  });

  it('counts a row landing exactly on midnight, not the one before it', () => {
    const db = fresh();
    insert(db, dayStartMs(FROM) - 1, 'loss');
    insert(db, dayStartMs(FROM), 'win');

    const rows = db
      .prepare(aggregate(NARROWED_WHERE))
      .all(FROM, TO, dayStartMs(FROM), dayStartMs(TO) + DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['d']).toBe(FROM);
    expect(rows[0]?.['w']).toBe(1);
  });

  it('includes the final millisecond of the last day', () => {
    const db = fresh();
    insert(db, dayStartMs(TO) + DAY - 1, 'win');
    insert(db, dayStartMs(TO) + DAY, 'win');

    const rows = db
      .prepare(aggregate(NARROWED_WHERE))
      .all(FROM, TO, dayStartMs(FROM), dayStartMs(TO) + DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['d']).toBe(TO);
  });
});

describe('the statement the pipeline builds', () => {
  it('binds the day strings and the matching millisecond range', () => {
    const st = planRefreshDaily(FROM, TO);
    expect(st.binds).toEqual([FROM, TO, dayStartMs(FROM), dayStartMs(TO) + DAY]);
    // The date() clause is what defines the result; losing it while keeping
    // the range would change which rows a day contains.
    expect(st.sql).toContain('date("created_ms" / 1000, \'unixepoch\') BETWEEN ? AND ?');
    expect(st.sql).toContain('"created_ms" >= ? AND "created_ms" < ?');
  });

  it('runs end to end and fills the aggregate', () => {
    const db = fresh();
    boundaryRows(db);
    const st = planRefreshDaily(FROM, TO);
    db.prepare(st.sql).run(...(st.binds as unknown[]));

    const rows = db
      .prepare('SELECT "day", SUM("signals") AS n, SUM("forced") AS f FROM "signal_daily" GROUP BY "day" ORDER BY "day"')
      .all();
    expect(rows.map((r) => r['day'])).toEqual([FROM, '2026-09-17', TO]);
    expect(rows.reduce((s, r) => s + Number(r['n']), 0)).toBe(5);
    expect(rows.reduce((s, r) => s + Number(r['f']), 0)).toBe(1);
  });

  it('seeks the index rather than scanning the table', () => {
    // The whole point of the change. A plan that says SCAN here means the
    // rollup is reading the entire retention window again.
    const db = fresh();
    const st = planRefreshDaily(FROM, TO);
    const select = st.sql.slice(st.sql.indexOf(' SELECT'), st.sql.indexOf(' ON CONFLICT'));
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${select}`)
      .all(FROM, TO, dayStartMs(FROM), dayStartMs(TO) + DAY);
    const detail = plan.map((r) => String(r['detail'])).join(' | ');
    expect(detail).toContain('signals_created');
    expect(detail).toContain('SEARCH');
    expect(detail).not.toContain('SCAN signals');
  });
});

describe('the prune delete', () => {
  it('removes exactly the days the date() cut names', () => {
    const db = fresh();
    const now = Date.parse('2026-09-18T12:00:00.000Z');
    const plan = planPrune(30, now);
    const cut = dayStartMs(plan.cutDay);

    insert(db, cut - DAY); // the day before the cut, goes
    insert(db, cut); // the cut day itself, goes — the condition is <=
    insert(db, cut + DAY - 1); // still the cut day, goes
    insert(db, cut + DAY); // the day after, stays
    insert(db, now); // today, stays

    db.prepare(plan.del.sql).run(...(plan.del.binds as unknown[]));
    const left = db.prepare('SELECT "created_ms" AS c FROM "signals" ORDER BY c').all();
    expect(left.map((r) => Number(r['c']))).toEqual([cut + DAY, now]);
  });
});
