/**
 * What happens on the other pairs while a trade is running — Phase 5.
 *
 * Two requirements that pull against each other, and the shape of the solution
 * is what reconciles them:
 *
 *   • every watched pair keeps being evaluated — nothing stops computing
 *   • no second trade opens, and no notification interrupts
 *
 * A pair is therefore ticked on a COPY of its state. If nothing fires the copy
 * is kept, which is what stops the pair re-reading the same candle for ever and
 * never ageing its setup. If something fires the copy is dropped — including
 * the cycle it just opened, which must not exist — and the event is recorded to
 * be shown once the screen is free.
 *
 * These pin the copying and the ordering. The engine is exercised directly:
 * what matters is the state machine's behaviour under a discarded tick, not how
 * React renders it.
 */

import { describe, expect, it } from 'vitest';
import { fib236Touch, type Candle, type ProgramState } from '@euro/engine';
import golden from '../../../packages/engine/golden/engine-golden.json' with { type: 'json' };

const MIN = 60_000;

const recorded: Candle[] = golden.candles.map((c) => ({
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: 1000,
  time: Date.parse(c.time),
}));

/** The copy `holdOthers` makes: same shape, no shared array. */
const copyOf = (s: ProgramState): ProgramState => ({
  cycle: s.cycle,
  armed: s.armed,
  firedKeys: s.firedKeys.slice(),
  lastCandleTime: s.lastCandleTime,
});

/** Runs the program forward to wherever the first signal appears. */
function runToSignal(): { state: ProgramState; index: number } | null {
  const state = fib236Touch.init();
  for (let i = 14; i < recorded.length; i++) {
    const window = recorded.slice(0, i + 1);
    const before = copyOf(state);
    const event = fib236Touch.onCandleClose(
      { candles: window, timeframeMs: MIN, now: window[i]!.time + MIN + 1 },
      state,
    );
    if (event.signal !== null) return { state: before, index: i };
  }
  return null;
}

describe('ticking a pair without letting it trade', () => {
  it('the fixture does produce a signal to hold back', () => {
    expect(runToSignal(), 'no signal in the fixture — the tests below prove nothing').not.toBeNull();
  });

  it('leaves the real state untouched when the copy fires', () => {
    const found = runToSignal()!;
    const real = found.state;
    const copy = copyOf(real);

    const window = recorded.slice(0, found.index + 1);
    const event = fib236Touch.onCandleClose(
      { candles: window, timeframeMs: MIN, now: window[found.index]!.time + MIN + 1 },
      copy,
    );

    expect(event.signal, 'the copy did not fire, so nothing is being held').not.toBeNull();
    // The copy opened a cycle. The real state must not have one — a second open
    // trade is exactly what the copying exists to prevent.
    expect(copy.cycle, 'the copy should hold the cycle').not.toBeNull();
    expect(real.cycle, 'the real state opened a trade it was not allowed to').toBeNull();
  });

  it('does not consume the setup, so the pair can fire once the screen is free', () => {
    const found = runToSignal()!;
    const real = found.state;
    const copy = copyOf(real);

    const window = recorded.slice(0, found.index + 1);
    fib236Touch.onCandleClose(
      { candles: window, timeframeMs: MIN, now: window[found.index]!.time + MIN + 1 },
      copy,
    );

    // `firedKeys` is how the strategy remembers it has already traded a setup.
    // The discarded copy must not have added to the real one.
    expect(real.firedKeys.length).toBeLessThan(copy.firedKeys.length);
  });

  it('keeps the copy when nothing fired, so the candle is not re-read for ever', () => {
    // The other half. Committing a quiet tick is what advances `lastCandleTime`;
    // without it the pair would re-detect the same candle on every sweep and its
    // setup would never age out.
    const state = fib236Touch.init();
    const window = recorded.slice(0, 40);
    const copy = copyOf(state);
    const event = fib236Touch.onCandleClose(
      { candles: window, timeframeMs: MIN, now: window[39]!.time + MIN + 1 },
      copy,
    );

    expect(event.signal).toBeNull();
    expect(copy.lastCandleTime).toBeGreaterThan(state.lastCandleTime);
  });

  it('copies the fired keys rather than sharing the array', () => {
    // A shared array would let a discarded tick write into the real state
    // through the back door, which is the bug this whole approach avoids.
    const state = fib236Touch.init();
    state.firedKeys.push('a:b');
    const copy = copyOf(state);
    copy.firedKeys.push('c:d');
    expect(state.firedKeys).toEqual(['a:b']);
  });
});

describe('the order events are shown in', () => {
  /** The sort `HeldEvents` applies before trimming to five. */
  const rank = (events: Array<{ symbol: string; percent: number; fired: boolean }>) =>
    [...events].sort(
      (a, b) =>
        Number(b.fired) - Number(a.fired) ||
        b.percent - a.percent ||
        a.symbol.localeCompare(b.symbol),
    );

  it('puts a pair that reached its level above one that was merely close', () => {
    // 100 and "fired" are not the same claim, and a pair that actually traded is
    // the one worth looking at first.
    const out = rank([
      { symbol: 'AAA_otc', percent: 99, fired: false },
      { symbol: 'BBB_otc', percent: 40, fired: true },
    ]);
    expect(out[0]!.symbol).toBe('BBB_otc');
  });

  it('then orders by how close each one came', () => {
    const out = rank([
      { symbol: 'AAA_otc', percent: 30, fired: false },
      { symbol: 'BBB_otc', percent: 80, fired: false },
      { symbol: 'CCC_otc', percent: 55, fired: false },
    ]);
    expect(out.map((e) => e.symbol)).toEqual(['BBB_otc', 'CCC_otc', 'AAA_otc']);
  });

  it('breaks an exact tie the same way every time', () => {
    // Reproducible rather than dependent on which order they arrived in.
    const out = rank([
      { symbol: 'ZZZ_otc', percent: 50, fired: false },
      { symbol: 'AAA_otc', percent: 50, fired: false },
    ]);
    expect(out.map((e) => e.symbol)).toEqual(['AAA_otc', 'ZZZ_otc']);
  });

  it('records one event per pair, not one per tick', () => {
    // A setup that stays touched across several sweeps is one thing that
    // happened. Keyed by pair, newest wins.
    const held = new Map<string, { symbol: string; percent: number }>();
    for (const e of [
      { symbol: 'AAA_otc', percent: 60 },
      { symbol: 'AAA_otc', percent: 75 },
      { symbol: 'BBB_otc', percent: 40 },
    ]) {
      held.set(e.symbol, e);
    }
    expect(held.size).toBe(2);
    expect(held.get('AAA_otc')!.percent).toBe(75);
  });
});
