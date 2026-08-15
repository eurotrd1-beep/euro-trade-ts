/**
 * Keeps `VOLUME_DEPENDENT` honest.
 *
 * The list is a hand-maintained constant, which means it can rot: an indicator
 * that starts reading volume, or stops, would leave it silently wrong — and a
 * wrong list here is worse than none, because the reference and the admin both
 * present it as fact.
 *
 * So it is re-derived the same way it was built: run every registered indicator
 * against a flat volume and a varying one, and see whose answer moves.
 */

import { describe, expect, it } from 'vitest';
import golden from '../golden/engine-golden.json' with { type: 'json' };
import { computeIndicator, registeredNames } from '../src/registry.js';
import { vwap } from '../src/indicators/math.js';
import { makeRule, type Candle } from '../src/types.js';
import { VOLUME_DEAD, VOLUME_DEGRADES_TO_PRICE, VOLUME_DEPENDENT } from '../src/meta.js';
import '../src/indicators/index.js';

const base: Candle[] = golden.candles.map((c) => ({
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  // Flat, exactly as the app supplies it — the feed carries no volume.
  volume: 1000,
  time: Date.parse(c.time),
}));

/** Same candles, volume varied so a dependency has something to react to. */
const varied: Candle[] = base.map((c, i) => ({ ...c, volume: 500 + ((i * 97) % 3000) }));

const PRICE = base[base.length - 1]!.close;
const CLOCK = { utcHour: 10, weekday: 4 };

/**
 * A fixed-seed PRNG (mulberry32) swapped in for `Math.random` while an
 * indicator is probed.
 *
 * `monte_carlo_risk_simulation` draws 200 samples per call and answers with a
 * bucket — bullish above 130 up-paths, bearish below 70, neutral between. On
 * the golden candles it lands near the bullish edge, so the flat run and the
 * varied run picked different sides of it from the DRAWS alone: measured over
 * 300 probes the two disagreed 22 times with volume playing no part. That is a
 * 7% chance of this test failing a deploy for a dependency that does not exist,
 * and it duly did. Replaying the same stream into both runs leaves volume as
 * the only thing that differs between them.
 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Any value; it only has to be the SAME for both halves of the comparison. */
const SEED = 0x5eed;

function readsVolume(name: string): boolean {
  const rule = makeRule({ indicator: name, condition: 'eq', signal: 'CALL', score: 1 });
  const realRandom = Math.random;
  try {
    Math.random = seeded(SEED);
    const flat = computeIndicator(base, rule, PRICE, CLOCK, new Map());
    Math.random = seeded(SEED);
    const moved = computeIndicator(varied, rule, PRICE, CLOCK, new Map());
    return String(flat) !== String(moved);
  } catch {
    return false;
  } finally {
    Math.random = realRandom;
  }
}

describe('volume metadata', () => {
  it('lists every registered indicator that reacts to volume', () => {
    // Most of the marked names are no longer registered — they were moved to
    // indicators/unavailable/volume.ts precisely because of this flag. What
    // matters now is that nothing STILL registered reads volume unmarked.
    const observed = registeredNames().filter(readsVolume);
    const missing = observed.filter((n) => !VOLUME_DEPENDENT.has(n));
    expect(
      missing,
      `these react to volume but are not marked, so nothing warns about them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('leaves none of them registered', () => {
    // vwap and price_vs_vwap were held back at first, on the grounds that a
    // constant volume cancels out of their formula rather than corrupting it —
    // which is true, and pinned by the last test in this file. They went with
    // the rest in the end: a rule applied to some of its cases is not a rule,
    // and "reads an input that does not exist" is the rule.
    const stillRegistered = [...VOLUME_DEPENDENT].filter((n) => registeredNames().includes(n));
    expect(stillRegistered).toEqual([]);
  });

  it('splits dead from degraded without overlap', () => {
    const both = [...VOLUME_DEAD].filter((n) => VOLUME_DEGRADES_TO_PRICE.has(n));
    expect(both, 'an indicator cannot be both constant and a usable price proxy').toEqual([]);

    for (const n of [...VOLUME_DEAD, ...VOLUME_DEGRADES_TO_PRICE]) {
      expect(VOLUME_DEPENDENT.has(n), `${n} is classified but not in VOLUME_DEPENDENT`).toBe(true);
    }
  });

  it('vwap with a flat volume is exactly the mean typical price', () => {
    // Kept although vwap is no longer registered: this is the fact that
    // explains why it was worth arguing over, and the one to re-check the day
    // a real volume source arrives and it comes back.
    // Straight to the function: vwap is no longer registered, so going through
    // the registry would just return undefined and prove nothing.
    const value = vwap(base, PRICE);
    const meanTypical =
      base.reduce((sum, c) => sum + (c.high + c.low + c.close) / 3, 0) / base.length;
    expect(Math.abs(value - meanTypical)).toBeLessThan(1e-12);
  });
});
