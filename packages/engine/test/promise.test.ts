/**
 * 100% is a promise: the trade opens on the next candle. This holds it.
 *
 * The app decides that live, from the range price has covered during a candle,
 * and the strategy decides it afterwards from the candle itself. Those are two
 * pieces of code answering one question, and every time they have drifted apart
 * the user has seen the same thing: a card promising a trade, a candle passing,
 * and nothing happening.
 *
 * So this replays recorded candles, runs the app's live check EXACTLY as the app
 * runs it — same tests, same order — and gives it the widest range it could ever
 * observe: the candle's own high and low. If a false promise is possible at all,
 * it is possible under those conditions. Then it asks the strategy for the same
 * candle and requires it to agree, every time.
 *
 * Measured against the live feed when this was written: 93 promises, 93 kept.
 */

import { describe, expect, it } from 'vitest';
import golden from '../golden/engine-golden.json' with { type: 'json' };
import { fib236Touch } from '../src/index.js';
import type { Candle } from '../src/types.js';

const candles: Candle[] = golden.candles.map((c) => ({
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: 1000,
  time: Date.parse(c.time),
}));

/**
 * The app's live decision, reproduced.
 *
 * Broken first and containment second, because that is the order the strategy
 * retires a setup in — a level inside the range of a candle that also broke the
 * leg produces nothing, and checking containment first would promise it.
 */
function wouldPromise(
  armed: { direction: 'CALL' | 'PUT'; level: number; endPrice: number } | null,
  bar: Candle,
): boolean {
  if (armed === null) return false;
  const broken = armed.direction === 'CALL' ? bar.high > armed.endPrice : bar.low < armed.endPrice;
  if (broken) return false;
  return bar.low <= armed.level && armed.level <= bar.high;
}

describe('every 100% becomes a trade', () => {
  const state = fib236Touch.init();
  let promised = 0;
  let kept = 0;
  const failures: string[] = [];

  for (let i = 14; i < candles.length; i++) {
    const bar = candles[i]!;
    const armed = state.armed;
    const promise = wouldPromise(armed, bar);

    const event = fib236Touch.onCandleClose(
      { candles: candles.slice(0, i + 1), timeframeMs: 60_000, now: bar.time + 60_001 },
      state,
    );

    if (!promise) continue;
    promised++;
    if (event.signal !== null) kept++;
    else failures.push(new Date(bar.time).toISOString());
  }

  it('the fixture actually contains promises to check', () => {
    // Without this the suite would pass by having nothing to test, which is the
    // quietest way for a guarantee to stop being one.
    expect(promised).toBeGreaterThan(0);
  });

  it('never promises a trade the strategy does not take', () => {
    expect(failures, `broken promises at: ${failures.join(', ')}`).toEqual([]);
    expect(kept).toBe(promised);
  });
});

describe('and the promise is not made on the way past', () => {
  it('refuses a candle that broke the leg, even with the level inside it', () => {
    // The case that made the claim wrong one time in eight: price runs through
    // the swing's own high, which retires the setup before the touch is ever
    // considered — so the level being inside that candle means nothing.
    const armed = { direction: 'CALL' as const, level: 1.09764, endPrice: 1.1 };
    const bar: Candle = {
      open: 1.098, high: 1.1005, low: 1.0975, close: 1.1002, volume: 1000, time: 0,
    };
    expect(bar.low <= armed.level && armed.level <= bar.high, 'fixture must contain the level').toBe(true);
    expect(wouldPromise(armed, bar)).toBe(false);
  });

  it('refuses a candle that never reached the level', () => {
    const armed = { direction: 'CALL' as const, level: 1.09764, endPrice: 1.1 };
    const bar: Candle = {
      open: 1.0990, high: 1.0995, low: 1.0985, close: 1.0988, volume: 1000, time: 0,
    };
    expect(wouldPromise(armed, bar)).toBe(false);
  });

  it('promises a candle that contains the level and left the leg alone', () => {
    const armed = { direction: 'CALL' as const, level: 1.09764, endPrice: 1.1 };
    const bar: Candle = {
      open: 1.0985, high: 1.0990, low: 1.0970, close: 1.0980, volume: 1000, time: 0,
    };
    expect(wouldPromise(armed, bar)).toBe(true);
  });
});
