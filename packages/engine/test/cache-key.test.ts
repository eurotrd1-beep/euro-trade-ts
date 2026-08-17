/**
 * Regression: the indicator cache must not confuse two rules that differ only
 * in a parameter the indicator READS.
 *
 * The cache key was `indicator_period_fast_slow_smooth_stddev` — copied from
 * the Dart engine, `value` and `tolerance` absent from both. That is harmless
 * where `value` is only the threshold compared after the fact, and wrong where
 * the indicator reads it as an INPUT. Two such rules in one strategy shared a
 * cache entry, and whichever ran first silently answered for both.
 *
 * This used to be demonstrated with `supertrend` at two ATR multipliers. That
 * indicator no longer exists, and the bug it guarded very much still can: of
 * the eight indicators left, `fib_bounce` reads `value` as the retracement
 * level it watches, and four of them read `tolerance` as the width of the band
 * that counts as "at" a level. So the case is rebuilt on those.
 *
 * It only shows when the two parameters actually disagree on the data at hand.
 * The window below is real recorded candles where they do: at the 38.2% level
 * the last candle is a bearish rejection, at 78.6% nothing is happening.
 *
 * Both engines had the bug, so this is not a divergence from Dart — it is a fix
 * Dart still needs.
 */

import { describe, expect, it } from 'vitest';
import golden from '../golden/engine-golden.json' with { type: 'json' };
import { cacheKey, computeIndicator } from '../src/registry.js';
import { makeRule, type Candle } from '../src/types.js';
import '../src/indicators/index.js';

// The fixture stores `time` as an ISO string; the engine wants epoch millis.
const candles: Candle[] = golden.candles.map((c) => ({
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: c.volume,
  time: Date.parse(c.time),
}));

/** Real candles where the watched Fibonacci level changes the verdict. */
const WINDOW = candles.slice(0, 146);
const PRICE = WINDOW[WINDOW.length - 1]!.close;
const CLOCK = { utcHour: 10, weekday: 4 };

const bounceAt = (level: number) =>
  makeRule({
    indicator: 'fib_bounce', condition: 'eq', signal: 'CALL', score: 1,
    value: level, tolerance: 10,
  });

const levelWithin = (tolerance: number) =>
  makeRule({ indicator: 'fib_level', condition: 'eq', signal: 'CALL', score: 1, tolerance });

describe('indicator cache key', () => {
  it('separates rules that differ only in `value`', () => {
    expect(cacheKey(bounceAt(0.382)), 'value must take part in the key').not.toBe(
      cacheKey(bounceAt(0.786)),
    );
  });

  it('separates rules that differ only in `tolerance`', () => {
    expect(cacheKey(levelWithin(1)), 'tolerance must take part in the key').not.toBe(
      cacheKey(levelWithin(12)),
    );
  });

  it('the chosen window really does distinguish the two levels', () => {
    // Guards the test itself: if the fixture ever changes and both levels agree
    // here, the test below would pass for the wrong reason.
    const a = computeIndicator(WINDOW, bounceAt(0.382), PRICE, CLOCK, new Map());
    const b = computeIndicator(WINDOW, bounceAt(0.786), PRICE, CLOCK, new Map());
    expect(a).toBe('bearish');
    expect(b).toBe('none');
  });

  it('does not let one fib_bounce answer for another through a shared cache', () => {
    // One cache, as `evaluateRules` uses for a whole strategy.
    const shared = new Map<string, unknown>();
    const first = computeIndicator(WINDOW, bounceAt(0.382), PRICE, CLOCK, shared);
    const second = computeIndicator(WINDOW, bounceAt(0.786), PRICE, CLOCK, shared);

    expect(first).toBe('bearish');
    expect(second, 'the 0.786 rule read the 0.382 rule’s cached answer').toBe('none');
  });

  it('is unaffected by the order the rules are evaluated in', () => {
    const shared = new Map<string, unknown>();
    const wide = computeIndicator(WINDOW, levelWithin(12), PRICE, CLOCK, shared);
    const tight = computeIndicator(WINDOW, levelWithin(1), PRICE, CLOCK, shared);

    expect(wide).toBe('at_500');
    expect(tight, 'the tight band read the wide band’s cached answer').toBe('none');
  });
});
