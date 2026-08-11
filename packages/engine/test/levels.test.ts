/**
 * Unit tests for the level indicators, on candles built by hand.
 *
 * Hand-built rather than sampled, because these answer questions with a known
 * arithmetic answer: a leg from 1.0800 to 1.1000 retraced to 1.0953 is at 23.5%,
 * and no amount of live data proves that as clearly as one series that says so.
 * The liveness audit covers the other half — that they move on real markets.
 */

import { describe, expect, it } from 'vitest';
import { computeIndicator } from '../src/registry.js';
import { makeRule, type Candle } from '../src/types.js';
import { FIB_LEVELS, detectSwing } from '../src/indicators/levels.js';
import '../src/indicators/index.js';

const CLOCK = { utcHour: 10, weekday: 4 };

let clock = 1_700_000_000_000;
function bar(open: number, close: number, highPad = 0.00002, lowPad = 0.00002): Candle {
  clock += 60_000;
  return {
    open,
    close,
    high: Math.max(open, close) + highPad,
    low: Math.min(open, close) - lowPad,
    volume: 1000,
    time: clock,
  };
}

/**
 * A clean upward leg from `low` to `high`, then a pullback to `endAt`.
 *
 * Each extreme is built to be STRICTLY beyond its four neighbours, which is
 * what the 5-candle fractal requires. The climb therefore stops short of the
 * high and lets one bar make the top on its own — the first version of this
 * helper let the last step close exactly at the high, so the peak bar tied with
 * its neighbour and no fractal was ever confirmed.
 */
function upLeg(low: number, high: number, endAt: number): Candle[] {
  const out: Candle[] = [];
  const range = high - low;

  // Four bars well above the low, so the low bar has two clear neighbours.
  for (let i = 0; i < 4; i++) out.push(bar(low + range * 0.06, low + range * 0.06));
  // The low: strictly under everything around it.
  out.push(bar(low + range * 0.02, low + range * 0.01, 0.00002, range * 0.01));
  for (let i = 0; i < 4; i++) out.push(bar(low + range * 0.06, low + range * 0.07));

  // Climb, stopping short so the peak bar is the only one that reaches it.
  for (let i = 1; i <= 6; i++) {
    const from = low + range * (0.07 + 0.13 * (i - 1));
    out.push(bar(from, low + range * (0.07 + 0.13 * i)));
  }
  // The high: strictly over everything around it.
  out.push(bar(high - range * 0.02, high - range * 0.01, range * 0.01, 0.00002));
  for (let i = 0; i < 4; i++) out.push(bar(high - range * 0.06, high - range * 0.07));

  out.push(bar(high - range * 0.07, endAt));
  return out;
}

describe('detectSwing', () => {
  it('finds both ends of a clean upward leg, and its direction', () => {
    const candles = upLeg(1.08, 1.1, 1.0953);
    const swing = detectSwing(candles, 50);

    expect(swing).not.toBeNull();
    expect(swing!.high).toBeCloseTo(1.1, 4);
    expect(swing!.low).toBeCloseTo(1.08, 4);
    expect(swing!.up, 'the low came first, so the leg ran up').toBe(true);
    expect(swing!.range).toBeCloseTo(0.02, 4);
  });

  it('reads a downward leg as downward', () => {
    // Same construction mirrored: the high forms before the low.
    const candles: Candle[] = [];
    const range = 0.02;
    for (let i = 0; i < 4; i++) candles.push(bar(1.1 - range * 0.06, 1.1 - range * 0.06));
    candles.push(bar(1.1 - range * 0.02, 1.1 - range * 0.01, range * 0.01, 0.00002));
    for (let i = 0; i < 4; i++) candles.push(bar(1.1 - range * 0.06, 1.1 - range * 0.07));
    for (let i = 1; i <= 6; i++) {
      candles.push(bar(1.1 - range * (0.07 + 0.13 * (i - 1)), 1.1 - range * (0.07 + 0.13 * i)));
    }
    candles.push(bar(1.08 + range * 0.02, 1.08 + range * 0.01, 0.00002, range * 0.01));
    for (let i = 0; i < 4; i++) candles.push(bar(1.08 + range * 0.06, 1.08 + range * 0.07));

    const swing = detectSwing(candles, 50);
    expect(swing).not.toBeNull();
    expect(swing!.up, 'the high came first, so the leg ran down').toBe(false);
  });

  it('returns null when nothing is confirmed', () => {
    const flat = Array.from({ length: 30 }, () => bar(1.08, 1.08));
    expect(detectSwing(flat, 50)).toBeNull();
  });
});

describe('fib_retracement', () => {
  it('matches the arithmetic', () => {
    // 1.0800 → 1.1000 is a range of 0.0200. A pullback to 1.0953 sits 0.0047
    // below the high, which is 23.5% of the range.
    const candles = upLeg(1.08, 1.1, 1.0953);
    const value = computeIndicator(
      candles,
      makeRule({ indicator: 'fib_retracement', condition: 'gt', signal: 'CALL', score: 1, period: 50 }),
      1.0953,
      CLOCK,
      new Map(),
    ) as number;
    expect(value).toBeCloseTo(23.5, 1);
  });

  it('answers -1, not 0, when there is no swing', () => {
    // 0 is a real answer meaning "at the extreme"; a rule reading `lte 10` must
    // not fire just because the window was too short to measure.
    const flat = Array.from({ length: 30 }, () => bar(1.08, 1.08));
    const value = computeIndicator(
      flat,
      makeRule({ indicator: 'fib_retracement', condition: 'gt', signal: 'CALL', score: 1, period: 50 }),
      1.08,
      CLOCK,
      new Map(),
    );
    expect(value).toBe(-1);
  });
});

describe('fib_level', () => {
  it('names the level the price is sitting on', () => {
    // 61.8% of the way back from 1.1000 is 1.08764.
    const candles = upLeg(1.08, 1.1, 1.08764);
    const value = computeIndicator(
      candles,
      makeRule({ indicator: 'fib_level', condition: 'eq', signal: 'CALL', score: 1, period: 50, tolerance: 2.5 }),
      1.08764,
      CLOCK,
      new Map(),
    );
    expect(value).toBe('at_618');
  });

  it('answers none when the price is between levels', () => {
    // 31% back: past 23.6 and short of 38.2, outside a 1% band of either.
    const candles = upLeg(1.08, 1.1, 1.0938);
    const value = computeIndicator(
      candles,
      makeRule({ indicator: 'fib_level', condition: 'eq', signal: 'CALL', score: 1, period: 50, tolerance: 1 }),
      1.0938,
      CLOCK,
      new Map(),
    );
    expect(value).toBe('none');
  });

  it('only returns labels declared in FIB_LEVELS', () => {
    // The labels are the contract the strategy reference publishes, so they
    // cannot be invented at the call site.
    const labels = new Set(FIB_LEVELS.map((l) => l.label));
    const candles = upLeg(1.08, 1.1, 1.0953);
    for (const tolerance of [0.5, 2.5, 10, 40]) {
      const value = computeIndicator(
        candles,
        makeRule({ indicator: 'fib_level', condition: 'eq', signal: 'CALL', score: 1, period: 50, tolerance }),
        1.0953,
        CLOCK,
        new Map(),
      ) as string;
      expect(value === 'none' || labels.has(value), `unexpected label: ${value}`).toBe(true);
    }
  });
});

describe('fib_zone', () => {
  const candles = upLeg(1.08, 1.1, 1.09);

  const zoneAt = (price: number) =>
    computeIndicator(
      candles,
      makeRule({ indicator: 'fib_zone', condition: 'eq', signal: 'CALL', score: 1, period: 50 }),
      price,
      CLOCK,
      new Map(),
    );

  it('calls the 38.2-61.8 band golden', () => {
    expect(zoneAt(1.09)).toBe('golden');
  });

  it('separates shallow from deep', () => {
    expect(zoneAt(1.0960), 'a 20% pullback').toBe('shallow');
    expect(zoneAt(1.0840), 'an 80% pullback').toBe('deep');
  });

  it('reads a break past the high of an upward leg as an extension', () => {
    expect(zoneAt(1.105)).toBe('extension');
  });
});

describe('fib_bounce', () => {
  it('reports bullish when the candle reached the level and closed back above', () => {
    const candles = upLeg(1.08, 1.1, 1.0895);
    // Reach down to 61.8% (1.08764) and close well above it.
    candles.push({
      open: 1.0885, close: 1.0895, high: 1.0896, low: 1.0876, volume: 1000, time: (clock += 60_000),
    });

    const value = computeIndicator(
      candles,
      makeRule({
        indicator: 'fib_bounce', condition: 'bullish', signal: 'CALL', score: 1,
        period: 50, value: 0.618, tolerance: 2.5,
      }),
      1.0895,
      CLOCK,
      new Map(),
    );
    expect(value).toBe('bullish');
  });

  it('does not call a close below the level a bounce', () => {
    // Through the level and closing beyond it is a break, and reading it as a
    // bounce is how a reversal rule ends up buying a breakdown.
    const candles = upLeg(1.08, 1.1, 1.0860);
    candles.push({
      open: 1.0880, close: 1.0860, high: 1.0882, low: 1.0858, volume: 1000, time: (clock += 60_000),
    });

    const value = computeIndicator(
      candles,
      makeRule({
        indicator: 'fib_bounce', condition: 'bullish', signal: 'CALL', score: 1,
        period: 50, value: 0.618, tolerance: 2.5,
      }),
      1.086,
      CLOCK,
      new Map(),
    );
    expect(value).not.toBe('bullish');
  });
});

describe('fib_distance', () => {
  it('is near zero at a level and signed away from it', () => {
    const candles = upLeg(1.08, 1.1, 1.08764);
    const at = computeIndicator(
      candles,
      makeRule({ indicator: 'fib_distance', condition: 'between', signal: 'CALL', score: 1, period: 50 }),
      1.08764,
      CLOCK,
      new Map(),
    ) as number;
    expect(Math.abs(at), 'sitting on 61.8%').toBeLessThan(0.5);

    // 1.0910 is above the 50% level (1.0900), so the distance reads positive;
    // 1.0890 is below the same level and reads negative. That sign is the whole
    // point of the indicator — it is what makes `between -0.2 0.2` mean
    // "touching any level".
    const above = computeIndicator(
      candles,
      makeRule({ indicator: 'fib_distance', condition: 'between', signal: 'CALL', score: 1, period: 50 }),
      1.0910,
      CLOCK,
      new Map(),
    ) as number;
    expect(above, 'above the nearest level reads positive').toBeGreaterThan(0);

    const below = computeIndicator(
      candles,
      makeRule({ indicator: 'fib_distance', condition: 'between', signal: 'CALL', score: 1, period: 50 }),
      1.0890,
      CLOCK,
      new Map(),
    ) as number;
    expect(below, 'below the nearest level reads negative').toBeLessThan(0);
  });
});

describe('sr_position', () => {
  const candles = upLeg(1.08, 1.1, 1.09);

  const posAt = (price: number, tolerance = 0.15) =>
    computeIndicator(
      candles,
      makeRule({ indicator: 'sr_position', condition: 'eq', signal: 'CALL', score: 1, period: 50, tolerance }),
      price,
      CLOCK,
      new Map(),
    );

  it('recognises the two ends and the space between', () => {
    expect(posAt(1.0801), 'within 0.15% of the low').toBe('at_support');
    expect(posAt(1.0999), 'within 0.15% of the high').toBe('at_resistance');
    expect(posAt(1.09), 'mid-range').toBe('between');
  });

  it('separates a break from a touch', () => {
    expect(posAt(1.0750)).toBe('below_support');
    expect(posAt(1.1050)).toBe('above_resistance');
  });

  it('widens with tolerance', () => {
    // 1.0850 is 0.46% above the low: outside a 0.15% band, inside a 1% one.
    expect(posAt(1.085, 0.15)).toBe('between');
    expect(posAt(1.085, 1)).toBe('at_support');
  });
});

describe('sr_bounce', () => {
  it('reports bullish when support held and the candle closed up', () => {
    const candles = upLeg(1.08, 1.1, 1.0815);
    candles.push({
      open: 1.0805, close: 1.0815, high: 1.0816, low: 1.0799, volume: 1000, time: (clock += 60_000),
    });

    const value = computeIndicator(
      candles,
      makeRule({ indicator: 'sr_bounce', condition: 'bullish', signal: 'CALL', score: 1, period: 50, tolerance: 0.15 }),
      1.0815,
      CLOCK,
      new Map(),
    );
    expect(value).toBe('bullish');
  });
});

describe('the family shares one structure', () => {
  it('fib and sr read the same swing, so a mixed strategy means one thing', () => {
    // At the low of the leg: 100% retraced, and at support. If these disagreed,
    // a strategy combining them would be describing two different structures.
    const candles = upLeg(1.08, 1.1, 1.0801);

    const retracement = computeIndicator(
      candles,
      makeRule({ indicator: 'fib_retracement', condition: 'gt', signal: 'CALL', score: 1, period: 50 }),
      1.0801, CLOCK, new Map(),
    ) as number;
    const position = computeIndicator(
      candles,
      makeRule({ indicator: 'sr_position', condition: 'eq', signal: 'CALL', score: 1, period: 50, tolerance: 0.15 }),
      1.0801, CLOCK, new Map(),
    );

    expect(retracement).toBeGreaterThan(95);
    expect(position).toBe('at_support');
  });
});
