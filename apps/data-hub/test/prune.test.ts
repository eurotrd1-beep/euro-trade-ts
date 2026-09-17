/**
 * Retention, on a real engine.
 *
 * ── THE FAILURE THAT STARTED THIS ──────────────────────────────────────────
 *
 * The comparison alarmed: 12,744 rows in Supabase against 14,262 in D1, and
 * D1 having MORE was supposed to be impossible before the switch. Nothing had
 * written to D1 — Supabase had SHRUNK, because its prune ran on schedule and
 * D1 had no schedule at all.
 *
 * That is the shape of every problem in this migration: not an error, a job
 * that silently was not being done. The tables that grow would have grown
 * until a storage or row-read limit was reached weeks later, with nothing to
 * point at.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_DELETES_PER_TABLE, RETENTION, prune } from '../src/prune.js';

interface Row { [k: string]: unknown }
interface Db {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...a: unknown[]): { changes: number | bigint };
    all(...a: unknown[]): Row[];
    bind(...a: unknown[]): { run(): Promise<{ meta: { changes: number } }> };
  };
}
let raw: Db;

/** The smallest D1Database this code actually uses, over node:sqlite. */
const asD1 = (db: Db) => ({
  prepare(sql: string) {
    return {
      bind(...binds: unknown[]) {
        return {
          async run() {
            const r = db.prepare(sql).run(...binds);
            return { meta: { changes: Number(r.changes) } };
          },
        };
      },
    };
  },
}) as unknown as D1Database;

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const daysAgo = (n: number): number => NOW - n * 86_400_000;

const count = (table: string): number =>
  Number((raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).all()[0] as { n: number }).n);

beforeEach(() => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  raw = new DatabaseSync(':memory:') as Db;
  raw.exec(readFileSync(
    fileURLToPath(new URL('../migrations/0001_schema.sql', import.meta.url)), 'utf8',
  ));
});

describe('the retentions are the ones Postgres used', () => {
  it('keeps push_alerts for one day', () => {
    const r = RETENTION.find((x) => x.table === 'push_alerts')!;
    expect(r.days).toBe(1);
    expect(r.origin).toBe('prune_push_alerts');
  });

  it('keeps both telegram tables for seven days', () => {
    expect(RETENTION.find((x) => x.table === 'telegram_alerts')!.days).toBe(7);
    expect(RETENTION.find((x) => x.table === 'telegram_queue')!.days).toBe(7);
  });

  it('does not touch the signal pipeline', () => {
    // signals and signal_daily stay on Supabase, and prune_signals there is
    // still their retention. Deleting them here would be this code deciding
    // when a trade record stops existing, in a copy nothing reads.
    const tables = RETENTION.map((r) => r.table);
    expect(tables).not.toContain('signals');
    expect(tables).not.toContain('signal_daily');
  });

  it('names a real column on a real table', () => {
    // A wrong column name makes the DELETE throw; a wrong table makes it throw
    // too. Both would show up as "deleted 0", which is indistinguishable from
    // "nothing to delete" unless somebody checks.
    for (const r of RETENTION) {
      const cols = raw.prepare(`PRAGMA table_info("${r.table}")`).all()
        .map((c) => String(c['name']));
      expect(cols, `${r.table}.${r.column}`).toContain(r.column);
    }
  });
});

describe('what it deletes', () => {
  const insertAlert = (key: string, sentMs: number) =>
    raw.prepare('INSERT INTO push_alerts (symbol, setup_key, stage, sent_ms) VALUES (?, ?, 96, ?)')
      .run('EURUSD_otc', key, sentMs);

  it('removes what is past the limit and keeps what is not', async () => {
    insertAlert('old', daysAgo(3));
    insertAlert('edge', daysAgo(2));
    insertAlert('fresh', daysAgo(0.5));

    const [result] = await prune(asD1(raw), NOW);
    expect(result!.table).toBe('push_alerts');
    expect(result!.deleted).toBe(2);
    expect(count('push_alerts')).toBe(1);
  });

  it('keeps a row exactly at the boundary', async () => {
    // `<` not `<=`, matching the Postgres original. One second of difference
    // in a retention is not worth an argument, but silently disagreeing with
    // the database being replaced is.
    insertAlert('exactly', daysAgo(1));
    await prune(asD1(raw), NOW);
    expect(count('push_alerts')).toBe(1);
  });

  it('deletes nothing when there is nothing old', async () => {
    insertAlert('fresh', NOW - 1000);
    const results = await prune(asD1(raw), NOW);
    expect(results.every((r) => r.deleted === 0)).toBe(true);
    expect(count('push_alerts')).toBe(1);
  });

  it('caps a single run so a first pass cannot blow the daily write limit', async () => {
    // A DELETE is a write, the free plan allows 100,000 a day, and going over
    // blocks every query until 00:00 UTC. A table that has never been pruned
    // could exceed that on its own.
    for (let i = 0; i < MAX_DELETES_PER_TABLE + 250; i++) insertAlert(`k${i}`, daysAgo(5));

    const [first] = await prune(asD1(raw), NOW);
    expect(first!.deleted).toBe(MAX_DELETES_PER_TABLE);
    expect(count('push_alerts')).toBe(250);

    // And it catches up on the next run rather than leaving them for ever.
    const [second] = await prune(asD1(raw), NOW);
    expect(second!.deleted).toBe(250);
    expect(count('push_alerts')).toBe(0);
  });

  it('prunes each table by its own clock', async () => {
    insertAlert('push-2d', daysAgo(2));
    raw.prepare('INSERT INTO telegram_alerts (event_key, kind, sent_ms) VALUES (?, ?, ?)')
      .run('tg-2d', 'signal', daysAgo(2));

    await prune(asD1(raw), NOW);
    // Two days is past the one-day limit and inside the seven-day one.
    expect(count('push_alerts')).toBe(0);
    expect(count('telegram_alerts')).toBe(1);
  });
});

describe('when one table fails', () => {
  it('still prunes the others and names the one that broke', async () => {
    // A prune that stops at the first error leaves every later table unpruned
    // and reports a single problem, which reads as a small one.
    raw.prepare('INSERT INTO telegram_alerts (event_key, kind, sent_ms) VALUES (?, ?, ?)')
      .run('old', 'signal', daysAgo(30));
    raw.exec('DROP TABLE push_alerts');

    const results = await prune(asD1(raw), NOW);
    const failed = results.find((r) => r.table === 'push_alerts')!;
    const worked = results.find((r) => r.table === 'telegram_alerts')!;

    expect(failed.error).toBeTruthy();
    expect(failed.deleted).toBe(0);
    expect(worked.deleted).toBe(1);
  });
});
