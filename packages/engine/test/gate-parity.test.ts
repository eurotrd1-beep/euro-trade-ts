/**
 * A frozen market, and every trade the strategy takes on it.
 *
 * Three rules were added on top of the original fib236 — a minimum swing size
 * ‹A7›, touch-close ‹A10› and a minimum depth ‹A11› — and none of them can be
 * reasoned about from its own wording. All three refuse things, and refusing
 * changes what happens next: a rejected candidate sends `findSetup` on to an
 * older pair of pivots, and a consumed-but-untraded setup frees the engine a
 * minute earlier than it would otherwise have been free. Trades appear as well
 * as vanish.
 *
 * `golden/gate-parity.json` holds the comparison over 89 pairs of real
 * one-minute candles: `baseline` is the program before any of them, `shipped`
 * is with ‹A7›, ‹A10› and ‹A11› all on. This test drives today's program over
 * those candles and requires it to reproduce `shipped` exactly — touch candle,
 * entry candle, stage, direction, entry price, exit price, outcome.
 *
 * So it is not "the program does what it does". Any change to any rule in the
 * strategy — including one nobody meant to make — moves this file.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fib236Touch, type Candle } from '../src/index.js';

const MIN = 60_000;

interface GoldenTrade {
  symbol: string;
  touch: number;
  entry: number;
  stage: string;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  outcome: string;
}
interface Golden {
  baseline: GoldenTrade[];
  shipped: GoldenTrade[];
  removed: GoldenTrade[];
  /** [firstTimeSeconds, then open, high, low, close, minutesAfterFirst × N] */
  candles: Record<string, number[]>;
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../golden/gate-parity.json', import.meta.url)), 'utf8'),
) as Golden;

/** The stored form back into candles. The gaps in it are real and preserved. */
function decode(flat: number[]): Candle[] {
  const t0 = flat[0]!;
  const out: Candle[] = [];
  for (let i = 1; i < flat.length; i += 5) {
    out.push({
      open: flat[i]!,
      high: flat[i + 1]!,
      low: flat[i + 2]!,
      close: flat[i + 3]!,
      volume: 1000,
      time: (t0 + flat[i + 4]! * 60) * 1000,
    });
  }
  return out;
}

function replayAll(): GoldenTrade[] {
  const out: GoldenTrade[] = [];
  for (const [symbol, flat] of Object.entries(golden.candles)) {
    const cs = decode(flat);
    const state = fib236Touch.init();
    const opened: Array<{ entry: number; touch: number }> = [];

    for (let i = 0; i < cs.length; i++) {
      const bar = cs[i]!;
      const ev = fib236Touch.onCandleClose(
        { candles: cs.slice(0, i + 1), timeframeMs: MIN, now: bar.time + MIN + 1 },
        state,
      );
      if (ev.settled !== null) {
        const o = opened.shift()!;
        out.push({
          symbol,
          touch: o.touch,
          entry: o.entry,
          stage: ev.settled.stage,
          direction: ev.settled.direction,
          entryPrice: ev.settled.entryPrice,
          exitPrice: ev.settled.exitPrice,
          outcome: ev.settled.result,
        });
      }
      if (ev.signal !== null) opened.push({ entry: ev.signal.entryTime, touch: bar.time });
    }
  }
  return out;
}

const key = (t: GoldenTrade): string => `${t.symbol}@${t.entry}#${t.stage}`;
const replayed = replayAll();

describe('the trades the shipped strategy takes on this market', () => {
  it('reproduces all of them, and nothing besides', () => {
    expect(golden.shipped).toHaveLength(14);
    expect(replayed).toHaveLength(golden.shipped.length);
  });

  it('keeps every field identical — touch, entry, exit, direction, stage, outcome', () => {
    // Compared as whole records rather than field by field: a loop that checks
    // six fields is a loop that forgets the seventh when one is added.
    const sort = (a: GoldenTrade, b: GoldenTrade): number =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    expect([...replayed].sort(sort)).toEqual([...golden.shipped].sort(sort));
  });

  it('covers both stages and all three outcomes', () => {
    // Otherwise the equality above could be passing on a list of one kind.
    const count = (f: (t: GoldenTrade) => boolean): number => replayed.filter(f).length;
    expect(count((t) => t.stage === 'primary')).toBe(13);
    expect(count((t) => t.stage === 'martingale')).toBe(1);
    expect(count((t) => t.outcome === 'WIN')).toBe(12);
    expect(count((t) => t.outcome === 'LOSS')).toBe(1);
    expect(count((t) => t.outcome === 'TIE')).toBe(1);
    expect(count((t) => t.direction === 'CALL')).toBeGreaterThan(0);
    expect(count((t) => t.direction === 'PUT')).toBeGreaterThan(0);
  });
});

describe('what the three rules cost and bought, on this market', () => {
  it('takes a small fraction of the trades the original took', () => {
    // The cost of the three rules together, stated rather than buried: on this
    // market they leave one trade in eleven. That is the number to watch if the
    // signal count ever looks too quiet in production.
    expect(golden.baseline).toHaveLength(152);
    expect(golden.shipped).toHaveLength(14);
  });

  it('drops more losses than wins', () => {
    // The number that decides whether a filter is worth its signal count. It is
    // recorded rather than argued: 139 trades left, and the losses outnumbered
    // the wins among them — but only just, which is the honest shape of it.
    const by = (o: string): number => golden.removed.filter((t) => t.outcome === o).length;
    expect(golden.removed).toHaveLength(139);
    expect(by('LOSS')).toBe(64);
    expect(by('WIN')).toBe(59);
    expect(by('TIE')).toBe(16);
    expect(by('LOSS')).toBeGreaterThan(by('WIN'));
  });

  it('leaves a better decided win rate than it started with', () => {
    const rate = (ts: GoldenTrade[]): number => {
      const w = ts.filter((t) => t.outcome === 'WIN').length;
      const l = ts.filter((t) => t.outcome === 'LOSS').length;
      return (100 * w) / (w + l);
    };
    expect(rate(golden.baseline)).toBeCloseTo(51.9, 1);
    expect(rate(golden.shipped)).toBeCloseTo(92.3, 1);
  });

  it('records the one trade that only exists because of the rules', () => {
    // Refusing a candidate is not the same as removing a trade: the search
    // walks on, and a setup consumed without trading frees the engine sooner.
    // One trade on this market exists only in the filtered run, and it is
    // pinned so the effect stays visible rather than being assumed away.
    const baselineKeys = new Set(golden.baseline.map(key));
    const appeared = golden.shipped.filter((t) => !baselineKeys.has(key(t)));
    expect(appeared).toHaveLength(1);
  });
});

describe('no trade appeared where there was none', () => {
  it('produces nothing on the pairs the fixture records as silent', () => {
    const traded = new Set(golden.shipped.map((t) => t.symbol));
    const silent = Object.keys(golden.candles).filter((s) => !traded.has(s));
    expect(silent.length).toBeGreaterThan(0);
    for (const s of silent) expect(replayed.some((t) => t.symbol === s)).toBe(false);
  });
});
