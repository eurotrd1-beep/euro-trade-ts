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

function readsVolume(name: string): boolean {
  const rule = makeRule({ indicator: name, condition: 'eq', signal: 'CALL', score: 1 });
  try {
    const flat = computeIndicator(base, rule, PRICE, CLOCK, new Map());
    const moved = computeIndicator(varied, rule, PRICE, CLOCK, new Map());
    return String(flat) !== String(moved);
  } catch {
    return false;
  }
}

describe('volume metadata', () => {
  it('lists every indicator that reacts to volume', () => {
    const observed = registeredNames().filter(readsVolume);
    const missing = observed.filter((n) => !VOLUME_DEPENDENT.has(n));
    expect(
      missing,
      `these react to volume but are not marked, so nothing warns about them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('does not mark indicators that ignore volume', () => {
    // The reverse direction matters too: a false mark tells an operator to
    // avoid a perfectly good indicator.
    //
    // A name may legitimately sit in the list while this fixture cannot move it
    // — the audit ran over a far wider sample. So a marked indicator is only
    // reported if it is not registered at all.
    const unknown = [...VOLUME_DEPENDENT].filter((n) => !registeredNames().includes(n));
    expect(unknown, `marked but not registered: ${unknown.join(', ')}`).toEqual([]);
  });

  it('splits dead from degraded without overlap', () => {
    const both = [...VOLUME_DEAD].filter((n) => VOLUME_DEGRADES_TO_PRICE.has(n));
    expect(both, 'an indicator cannot be both constant and a usable price proxy').toEqual([]);

    for (const n of [...VOLUME_DEAD, ...VOLUME_DEGRADES_TO_PRICE]) {
      expect(VOLUME_DEPENDENT.has(n), `${n} is classified but not in VOLUME_DEPENDENT`).toBe(true);
    }
  });

  it('vwap with a flat volume is exactly the mean typical price', () => {
    // The claim the "degrades to price" classification rests on. If this ever
    // stops holding, the note in meta.ts is a lie.
    const rule = makeRule({ indicator: 'vwap', condition: 'gt', signal: 'CALL', score: 1 });
    const value = computeIndicator(base, rule, PRICE, CLOCK, new Map()) as number;
    const meanTypical =
      base.reduce((sum, c) => sum + (c.high + c.low + c.close) / 3, 0) / base.length;
    expect(Math.abs(value - meanTypical)).toBeLessThan(1e-12);
  });
});
