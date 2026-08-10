/**
 * Regression: the indicator cache must not confuse two rules that differ only
 * in a parameter the indicator READS.
 *
 * The cache key was `indicator_period_fast_slow_smooth_stddev` — copied from
 * the Dart engine, `value` and `tolerance` absent from both. That is fine for
 * the ~180 indicators where `value` is only the comparison threshold applied
 * after the fact, and wrong for the ones that read it as an INPUT:
 *
 *   supertrend                   `rule.value` is the ATR multiplier
 *   fibonacci                    `rule.value` is the retracement level
 *   monte_carlo_risk_simulation  `rule.value` is the risk threshold
 *
 * For those, two rules in one strategy — say supertrend at 1.5 and at 3.0 —
 * shared a cache entry, and whichever ran first silently answered for both.
 *
 * It survived unnoticed because it only shows when the two parameters actually
 * disagree on the data at hand. The window below is real recorded candles where
 * they do: multiplier 2.0 reads bearish, 3.0 reads bullish.
 *
 * Both engines had the bug, so this is not a divergence from Dart — it is a
 * fix that Dart still needs. See PENDING_DART_PORT in parity.test.ts.
 */

import { describe, expect, it } from 'vitest';
import golden from '../golden/engine-golden.json' with { type: 'json' };
import { cacheKey, computeIndicator } from '../src/registry.js';
import { makeRule, type Candle } from '../src/types.js';
import '../src/indicators/index.js';

// The fixture stores `time` as an ISO string; the engine wants epoch seconds.
// Same conversion parity.test.ts does.
const candles: Candle[] = golden.candles.map((c) => ({
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: c.volume,
  time: Date.parse(c.time),
}));

/** Real candles where the supertrend multiplier changes the verdict. */
const WINDOW = candles.slice(0, 70);
const PRICE = WINDOW[WINDOW.length - 1]!.close;
const CLOCK = { utcHour: 10, weekday: 4 };

const superTrendRule = (multiplier: number) =>
  makeRule({ indicator: 'supertrend', condition: 'eq', signal: 'CALL', score: 1, value: multiplier });

describe('indicator cache key', () => {
  it('separates rules that differ only in `value`', () => {
    expect(cacheKey(superTrendRule(2)), 'value must take part in the key').not.toBe(
      cacheKey(superTrendRule(3)),
    );
  });

  it('the chosen window really does distinguish the two multipliers', () => {
    // Guards the test itself: if the fixture ever changes and both multipliers
    // agree here, the test below would pass for the wrong reason.
    const a = computeIndicator(WINDOW, superTrendRule(2), PRICE, CLOCK, new Map());
    const b = computeIndicator(WINDOW, superTrendRule(3), PRICE, CLOCK, new Map());
    expect(a).toBe('bearish');
    expect(b).toBe('bullish');
  });

  it('does not let one supertrend answer for another through a shared cache', () => {
    // One cache, as `evaluateStrategyPro` uses for a whole strategy.
    const shared = new Map<string, unknown>();
    const first = computeIndicator(WINDOW, superTrendRule(2), PRICE, CLOCK, shared);
    const second = computeIndicator(WINDOW, superTrendRule(3), PRICE, CLOCK, shared);

    expect(first).toBe('bearish');
    expect(second, 'the 3.0 rule read the 2.0 rule’s cached answer').toBe('bullish');
  });

  it('is unaffected by the order the rules are evaluated in', () => {
    const shared = new Map<string, unknown>();
    const three = computeIndicator(WINDOW, superTrendRule(3), PRICE, CLOCK, shared);
    const two = computeIndicator(WINDOW, superTrendRule(2), PRICE, CLOCK, shared);

    expect(three).toBe('bullish');
    expect(two).toBe('bearish');
  });
});
