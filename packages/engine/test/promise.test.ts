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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fib236Touch } from '../src/index.js';
import type { Candle } from '../src/types.js';

/**
 * 89 pairs of real one-minute candles, not the 400-candle single-symbol
 * fixture this used to run on.
 *
 * That one contained exactly ONE touch across its whole length, and after ‹A10›
 * that touch no longer qualifies — so the replay had nothing left to check and
 * the guarantee would have gone on passing while testing nothing. The
 * gate-parity fixture is the same market the strategy is pinned against
 * elsewhere, and it carries enough touches to be worth replaying.
 */
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../golden/gate-parity.json', import.meta.url)), 'utf8'),
) as { candles: Record<string, number[]> };

function decode(flat: number[]): Candle[] {
  const t0 = flat[0]!;
  const out: Candle[] = [];
  for (let i = 1; i < flat.length; i += 5) {
    out.push({
      open: flat[i]!, high: flat[i + 1]!, low: flat[i + 2]!, close: flat[i + 3]!,
      volume: 1000, time: (t0 + flat[i + 4]! * 60) * 1000,
    });
  }
  return out;
}

/**
 * The app's live decision, reproduced.
 *
 * Broken first and containment second, because that is the order the strategy
 * retires a setup in — a level inside the range of a candle that also broke the
 * leg produces nothing, and checking containment first would promise it.
 *
 * ‹A10› added the third test, and it is the one that moved WHEN a promise can
 * be made at all. Containment is knowable while the candle is still forming;
 * where it closes is not. So the card no longer reaches 100 mid-candle — it
 * tops out at 99.99 and only the closed candle earns the rest.
 */
function wouldPromise(
  armed: { direction: 'CALL' | 'PUT'; level: number; endPrice: number } | null,
  bar: Candle,
): boolean {
  if (armed === null) return false;
  const broken = armed.direction === 'CALL' ? bar.high > armed.endPrice : bar.low < armed.endPrice;
  if (broken) return false;
  if (!(bar.low <= armed.level && armed.level <= bar.high)) return false;
  if (!(armed.direction === 'CALL' ? bar.close <= armed.level : bar.close >= armed.level)) {
    return false;
  }
  // ‹A11› And a real distance beyond, not a hair past. Without this the app
  // would promise 39 trades on this fixture that the strategy does not take.
  const past = armed.direction === 'CALL' ? armed.level - bar.close : bar.close - armed.level;
  return (past / bar.close) * 10_000 >= 3 - 1e-9;
}

describe('every 100% becomes a trade', () => {
  let promised = 0;
  let kept = 0;
  const failures: string[] = [];

  for (const [symbol, flat] of Object.entries(golden.candles)) {
    const candles = decode(flat);
    const state = fib236Touch.init();

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
      else failures.push(`${symbol} ${new Date(bar.time).toISOString()}`);
    }
  }

  it('the fixture actually contains promises to check', () => {
    // Without this the suite would pass by having nothing to test, which is the
    // quietest way for a guarantee to stop being one. It has caught exactly
    // that once: ‹A10› made the old fixture's single touch stop qualifying.
    expect(promised).toBeGreaterThan(10);
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

  it('refuses a candle that reached the level and closed back off it', () => {
    // ‹A10›. The range contains the level, the leg is untouched — and the
    // candle ended on the wrong side, so there is no trade to promise.
    const armed = { direction: 'CALL' as const, level: 1.09764, endPrice: 1.1 };
    const bar: Candle = {
      open: 1.0985, high: 1.099, low: 1.097, close: 1.098, volume: 1000, time: 0,
    };
    expect(bar.low <= armed.level && armed.level <= bar.high, 'fixture must contain the level').toBe(true);
    expect(bar.close > armed.level, 'and must close above it').toBe(true);
    expect(wouldPromise(armed, bar)).toBe(false);
  });

  it('refuses a candle that closed past the level but only by a hair', () => {
    // ‹A11›. 0.4 bps beyond is past it and nowhere near deep enough.
    const armed = { direction: 'CALL' as const, level: 1.09764, endPrice: 1.1 };
    const bar: Candle = {
      open: 1.0985, high: 1.099, low: 1.097, close: 1.09759, volume: 1000, time: 0,
    };
    expect(bar.close).toBeLessThan(armed.level);
    expect(wouldPromise(armed, bar)).toBe(false);
  });

  it('promises a candle that contains the level, closed deep past it and left the leg alone', () => {
    const armed = { direction: 'CALL' as const, level: 1.09764, endPrice: 1.1 };
    const bar: Candle = {
      open: 1.0985, high: 1.099, low: 1.097, close: 1.0972, volume: 1000, time: 0,
    };
    expect(wouldPromise(armed, bar)).toBe(true);
  });
});
