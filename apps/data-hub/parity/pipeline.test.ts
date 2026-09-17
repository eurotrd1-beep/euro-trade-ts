/**
 * The ported pipeline against the live Postgres one, on the real signals.
 *
 * ── WHAT THIS CATCHES THAT A UNIT TEST CANNOT ──────────────────────────────
 *
 * A unit test checks the rules I understood. This checks the rules I did not.
 * It loads every signal Postgres holds — 12,764 rows across 169 symbols, five
 * timeframes, four slots and every outcome the settlement produces — runs the
 * ported SQL over a copy of them in SQLite, and compares the aggregate against
 * the one Postgres built from the same rows.
 *
 * If the port is wrong about which columns exclude `forced`, about the UTC day
 * boundary, about NULL versions grouping together, or about any combination
 * nobody would think to write down, it appears here as a row that differs.
 *
 * ── NO TOLERANCE ───────────────────────────────────────────────────────────
 *
 * Every column of every bucket is compared exactly. There is no "close
 * enough": the whole point of settling a trade is that the number is the
 * number. One differing row fails the run.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { planRefreshDaily, outcomeFor, planRecord, utcDay } from '../src/pipeline.js';

const SUPABASE_URL = 'https://dlzqdmqkvlvwnjhqxqym.supabase.co';
const KEY = process.env['SUPABASE_SERVICE_KEY'] ?? '';

interface Db {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): Record<string, unknown>[] };
}

interface PgSignal {
  id: number; created_at: string; symbol: string; timeframe: string;
  direction: string; bar_time: string; strategy_version_id: string | null;
  slot: string; confidence: number | null; score: number | null;
  entry_price: number; expiry_seconds: number; outcome: string;
  outcome_price: number | null; outcome_at: string | null; forced: boolean;
}

let db: Db;
let signals: PgSignal[] = [];
let pgDaily: Record<string, unknown>[] = [];

async function page<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}&offset=${off}&limit=1000`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status} on ${path}`);
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

beforeAll(async () => {
  // Deliberately NOT skipped when the key is absent. A parity run that quietly
  // does not run is the worst outcome here: the summary says green and nothing
  // was compared.
  if (!KEY) {
    throw new Error('SUPABASE_SERVICE_KEY is required — this compares against the live database');
  }

  signals = await page<PgSignal>(
    'signals?select=id,created_at,symbol,timeframe,direction,bar_time,' +
    'strategy_version_id,slot,confidence,score,entry_price,expiry_seconds,' +
    'outcome,outcome_price,outcome_at,forced&order=id',
  );
  pgDaily = await page<Record<string, unknown>>('signal_daily?select=*&order=day');

  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  db = new DatabaseSync(':memory:') as Db;
  db.exec(readFileSync(
    fileURLToPath(new URL('../migrations/0001_schema.sql', import.meta.url)), 'utf8',
  ));

  const insert = db.prepare(
    `INSERT INTO signals (id, created_ms, symbol, timeframe, direction, bar_ms,
       strategy_version_id, slot, confidence, score, entry_price, expiry_seconds,
       outcome, outcome_price, outcome_ms, forced)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const s of signals) {
    insert.run(
      s.id, Date.parse(s.created_at), s.symbol, s.timeframe, s.direction,
      Date.parse(s.bar_time), s.strategy_version_id, s.slot,
      s.confidence, s.score, s.entry_price, s.expiry_seconds,
      s.outcome, s.outcome_price,
      s.outcome_at === null ? null : Date.parse(s.outcome_at),
      s.forced ? 1 : 0,
    );
  }
});

describe('there is something to compare', () => {
  it('read the live signals', () => {
    expect(signals.length).toBeGreaterThan(1000);
  });

  it('read the aggregate Postgres built from them', () => {
    expect(pgDaily.length).toBeGreaterThan(0);
  });
});

describe('refresh_signal_daily, row by row against Postgres', () => {
  const COUNTERS = ['signals', 'wins', 'losses', 'ties', 'unresolved', 'pending', 'forced'];
  const keyOf = (r: Record<string, unknown>): string => [
    String(r['day']).slice(0, 10),
    r['strategy_version_id'] ?? 'NULL',
    r['symbol'], r['timeframe'], r['slot'],
  ].join('|');

  let ported: Record<string, unknown>[] = [];
  let inRange: Record<string, unknown>[] = [];

  beforeAll(() => {
    // ── The comparison window is where RAW SIGNALS still exist ────────────
    //
    // `signal_daily` outlives `signals` by design: prune_signals deletes the
    // raw rows and leaves the summary, which is the entire point of having a
    // summary. Postgres therefore holds 900 aggregate rows going back to
    // 2026-08-15 whose sources were deleted, and no rebuild — in either engine
    // — can reproduce them from rows that are gone.
    //
    // Comparing over the full history reports those as differences, which is
    // the test being wrong about its own scope rather than the port being
    // wrong. Production only ever refreshes today-2..today for the same
    // reason.
    // ── And TODAY is excluded, for the opposite reason ────────────────────
    //
    // signal_daily for the current day is always behind its own sources: the
    // rollup runs every ten minutes, so a signal recorded a minute ago is in
    // `signals` and not yet in the aggregate. Comparing today reports that lag
    // as a difference. Seen exactly that way on the first run — USDCHF_otc had
    // three signals and the aggregate said two, because the third was 61
    // seconds old.
    //
    // Every completed day is stable: no new signals arrive for it and the
    // rollup has long since run.
    const today = new Date().toISOString().slice(0, 10);
    const days = [...new Set(signals.map((s) => s.created_at.slice(0, 10)))]
      .filter((d) => d < today)
      .sort();
    const from = days[0]!;
    const to = days[days.length - 1]!;

    const { sql, binds } = planRefreshDaily(from, to);
    db.prepare(sql).run(...binds);
    ported = db.prepare('SELECT * FROM signal_daily').all();
    inRange = pgDaily.filter((r) => {
      const day = String(r['day']).slice(0, 10);
      return day >= from && day <= to;
    });
  });

  it('produces the same set of buckets', () => {
    const a = new Set(inRange.map(keyOf));
    const b = new Set(ported.map(keyOf));
    const onlyPg = [...a].filter((k) => !b.has(k));
    const onlyD1 = [...b].filter((k) => !a.has(k));
    expect({ onlyPg: onlyPg.slice(0, 5), onlyD1: onlyD1.slice(0, 5) })
      .toEqual({ onlyPg: [], onlyD1: [] });
  });

  it('produces the same numbers in every column of every bucket', () => {
    const b = new Map(ported.map((r) => [keyOf(r), r]));
    const differences: string[] = [];
    for (const row of inRange) {
      const mine = b.get(keyOf(row));
      if (mine === undefined) continue; // reported by the test above
      for (const c of COUNTERS) {
        if (Number(row[c]) !== Number(mine[c])) {
          differences.push(`${keyOf(row)} ${c}: postgres=${row[c]} d1=${mine[c]}`);
        }
      }
    }
    // Printed in full rather than counted: "3 differences" is not something
    // anybody can act on.
    expect(differences.slice(0, 20)).toEqual([]);
    expect(differences).toHaveLength(0);
  });

  it('counted a meaningful number of buckets, so a pass means something', () => {
    // A comparison over an empty set passes. Say how much was actually checked.
    expect(ported.length).toBeGreaterThan(50);
  });
});

describe('the settlement rule, against every real outcome', () => {
  it('reproduces the stored outcome for every settled signal', () => {
    // resolve_signals stores the outcome rather than recomputing it, so the
    // stored value IS what the rule produced. Feeding the same inputs back
    // through the port must return the same string for every row.
    const wrong: string[] = [];
    for (const s of signals) {
      if (s.outcome === 'pending') continue;
      const mine = outcomeFor({
        id: s.id,
        price: s.outcome_price,
        // What the generator passed in is not stored, so the stored outcome is
        // replayed: for a settled row it is exactly what was submitted, unless
        // the price was null — the case the rule overrides.
        outcome: s.outcome === 'unresolved' ? null : s.outcome,
      });
      if (mine !== s.outcome) wrong.push(`${s.id}: stored=${s.outcome} port=${mine}`);
    }
    expect(wrong.slice(0, 10)).toEqual([]);
  });

  it('never turns an unrecognised outcome into a tie', () => {
    for (const odd of ['weird', '', 'WIN', 'Win', null, undefined]) {
      expect(outcomeFor({ id: 1, price: 1.5, outcome: odd as string | null })).toBe('unresolved');
    }
  });

  it('calls a missing price unresolved whatever the outcome says', () => {
    expect(outcomeFor({ id: 1, price: null, outcome: 'win' })).toBe('unresolved');
  });
});

describe('record_signals refuses a batch the same way', () => {
  it('refuses the WHOLE batch when it would cross the cap', () => {
    const rows = Array.from({ length: 10 }, () => ({
      symbol: 'EURUSD_otc', timeframe: '1m', direction: 'CALL', bar_ms: 1,
      strategy_version_id: null, slot: 'instant_free', confidence: 1, score: 1,
      rules_matched: null, candle_snapshot: null, entry_price: 1, expiry_seconds: 60,
    }));
    const plan = planRecord(rows, { written: 95, max_rows: 100 });
    expect(plan.kind).toBe('capped');
    if (plan.kind === 'capped') {
      expect(plan.skipped).toBe(10);
      expect(plan.remaining).toBe(5);
    }
  });

  it('bills the budget against the UTC day, not the local one', () => {
    // 23:30 UTC-anything is still the UTC day the original uses.
    expect(utcDay(Date.UTC(2026, 8, 17, 23, 30))).toBe('2026-09-17');
    expect(utcDay(Date.UTC(2026, 8, 18, 0, 30))).toBe('2026-09-18');
  });
});
