/**
 * ‹A11› — the touch candle has to close a real distance past the level, and
 * what the card is allowed to say on the way there.
 *
 * Three rules now stand between a swing and a trade, and they are checked in
 * this order at the close of the touch candle:
 *
 *   ‹A7›  the leg is at least 10 × tieEpsilon wide
 *   ‹A10› the candle closes at or past the level
 *   ‹A11› and at least 3 basis points BEYOND it
 *
 * The card's ladder mirrors them: 50–90 approaching the level, 90–95 touched
 * and back off it, 95–98 beyond but short of the depth, 98–99.99 depth met and
 * only the close outstanding, 100 the candle closed and all three held.
 *
 * The unit is basis points, not pips — the same relative standard for a pair
 * quoted at 0.00001 and one quoted at 4402.
 */

import { describe, expect, it } from 'vitest';
import { fib236Touch, setupProgress, type Candle } from '../src/index.js';
import type { ProgramEvent, ProgramState } from '../src/programs/types.js';

const MIN = 60_000;
const T0 = Date.parse('2026-01-05T09:00:00.000Z');
const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({
  open: o, high: h, low: l, close: cl, volume: 1000, time: T0 + i * MIN,
});

/** A down-swing: high 1.10000 @2, low 1.09000 @9 → PUT, level 1.09236. */
function downSwing(touch: Candle): Candle[] {
  return [
    c(0, 1.0985, 1.0989, 1.0981, 1.0985),
    c(1, 1.0992, 1.0996, 1.0988, 1.0993),
    c(2, 1.0996, 1.1, 1.0994, 1.0997),
    c(3, 1.0985, 1.0989, 1.0981, 1.0983),
    c(4, 1.097, 1.0974, 1.0966, 1.0968),
    c(5, 1.0955, 1.0959, 1.0951, 1.0953),
    c(6, 1.094, 1.0944, 1.0936, 1.0938),
    c(7, 1.0925, 1.0929, 1.0921, 1.0923),
    c(8, 1.091, 1.0914, 1.0906, 1.0908),
    c(9, 1.0904, 1.0908, 1.09, 1.0902),
    c(10, 1.0906, 1.091, 1.0904, 1.0908),
    c(11, 1.0909, 1.0913, 1.0907, 1.0911),
    c(12, 1.0912, 1.0916, 1.091, 1.0914),
    c(13, 1.0915, 1.0918, 1.0913, 1.0916),
    c(14, 1.0917, 1.092, 1.0915, 1.0918),
    c(15, 1.0919, 1.0921, 1.0917, 1.092),
    touch,
    c(17, 1.0925, 1.0929, 1.0921, 1.0923),
    c(18, 1.0925, 1.0929, 1.0921, 1.0923),
  ];
}
const LEVEL = 1.09 + 0.236 * (1.1 - 1.09); // 1.09236

/** The close that sits exactly `bps` beyond the level, for a PUT. */
const closeAt = (bps: number): number => LEVEL / (1 - bps / 10_000);

function drive(candles: Candle[]): { events: ProgramEvent[]; state: ProgramState } {
  const state = fib236Touch.init();
  const events: ProgramEvent[] = [];
  for (let i = 0; i < candles.length; i++) {
    events.push(
      fib236Touch.onCandleClose(
        { candles: candles.slice(0, i + 1), timeframeMs: MIN, now: candles[i]!.time + MIN + 1 },
        state,
      ),
    );
  }
  return { events, state };
}
const fired = (touch: Candle): boolean =>
  drive(downSwing(touch)).events.some((e) => e.signal !== null);

describe('‹A11› the depth the close has to reach', () => {
  // J — exactly at the threshold counts.
  it('takes a close at exactly 3 bps beyond', () => {
    const bar = c(16, 1.0921, closeAt(4), 1.0919, closeAt(3));
    expect(fired(bar)).toBe(true);
  });

  // K — a hair under does not.
  it('refuses a close at 2.99 bps beyond', () => {
    const bar = c(16, 1.0921, closeAt(4), 1.0919, closeAt(2.99));
    expect(fired(bar)).toBe(false);
  });

  it('refuses a close that met ‹A10› but stopped well short of the depth', () => {
    // Past the level — ‹A10› holds — and only 1 bp beyond.
    const bar = c(16, 1.0921, closeAt(4), 1.0919, closeAt(1));
    expect(bar.close).toBeGreaterThan(LEVEL);
    expect(fired(bar)).toBe(false);
  });

  it('takes a close far beyond', () => {
    expect(fired(c(16, 1.0921, closeAt(12), 1.0919, closeAt(10)))).toBe(true);
  });

  // H — reached mid-candle, gave it back.
  it('refuses a candle that reached 3 bps in its range and closed back short', () => {
    // The high goes 10 bps past; the close comes back to 1 bp past.
    const bar = c(16, 1.0921, closeAt(10), 1.0919, closeAt(1));
    expect(bar.high).toBeGreaterThan(closeAt(3));
    expect(fired(bar)).toBe(false);
  });

  it('spends the setup when it refuses — no second attempt later', () => {
    const candles = downSwing(c(16, 1.0921, closeAt(10), 1.0919, closeAt(1)));
    candles[17] = c(17, 1.0925, closeAt(12), 1.0921, closeAt(11));
    candles[18] = c(18, 1.0928, closeAt(13), 1.0924, closeAt(12));
    const { events, state } = drive(candles);
    expect(events.some((e) => e.signal !== null)).toBe(false);
    expect(state.armed).toBeNull();
  });

  // I — met, so the signal exists and the entry is unchanged.
  it('opens on the next candle, timing untouched', () => {
    const f = drive(downSwing(c(16, 1.0921, closeAt(6), 1.0919, closeAt(5)))).events.find(
      (e) => e.signal !== null,
    )!;
    expect(f.signal!.direction).toBe('PUT');
    expect(f.signal!.entryTime).toBe(T0 + 17 * MIN);
  });
});

// ── the card ───────────────────────────────────────────────────────────────

const armed = {
  direction: 'PUT' as const, level: LEVEL, endPrice: 1.09, endTime: T0 + 9 * MIN, key: 'a:b',
};
const at = (price: number, left: number, touched: boolean) =>
  setupProgress({ cycle: null, armed }, null, price, left, touched);

describe('the ladder the card climbs', () => {
  // A / B — far, then closer, before any touch.
  it('sits between 50 and 90 while price is still approaching', () => {
    const far = at(1.0905, 0.5, false).percent;
    const near = at(1.0922, 0.5, false).percent;
    expect(far).toBeGreaterThanOrEqual(50);
    expect(near).toBeLessThan(90);
    expect(far).toBeLessThan(near);
  });

  // C — touched, but price came back off the level.
  it('sits between 90 and 95 once touched and back off the level', () => {
    const p = at(LEVEL - 0.0002, 0.5, true);
    expect(p.percent).toBeGreaterThanOrEqual(90);
    expect(p.percent).toBeLessThan(95);
  });

  // D — beyond the level, short of the depth.
  it('sits between 95 and 98 while the depth is still owed', () => {
    for (const bps of [0.2, 1, 2, 2.9]) {
      const p = at(closeAt(bps), 0.5, true);
      expect(p.percent, `${bps} bps`).toBeGreaterThanOrEqual(95);
      expect(p.percent, `${bps} bps`).toBeLessThan(98);
      expect(p.needBps).toBeCloseTo(3 - bps, 5);
    }
  });

  it('sits between 98 and 99.99 once the depth is met', () => {
    for (const left of [1, 0.5, 0]) {
      const p = at(closeAt(4), left, true);
      expect(p.percent).toBeGreaterThanOrEqual(98);
      expect(p.percent).toBeLessThan(100);
      expect(p.needBps).toBe(0);
    }
  });

  // E — distance falls, time held.
  it('rises as the depth is closed, at a fixed moment in the candle', () => {
    const a = at(closeAt(0.5), 0.5, true).percent;
    const b = at(closeAt(1.5), 0.5, true).percent;
    const d = at(closeAt(2.8), 0.5, true).percent;
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(d);
  });

  // F — time falls, distance held. The two branches move opposite ways.
  it('falls as the candle drains while depth is still owed', () => {
    const early = at(closeAt(1.5), 0.9, true).percent;
    const late = at(closeAt(1.5), 0.1, true).percent;
    expect(late).toBeLessThan(early);
  });

  it('rises as the candle drains once the depth is already met', () => {
    const early = at(closeAt(4), 0.9, true).percent;
    const late = at(closeAt(4), 0.1, true).percent;
    expect(early).toBeLessThan(late);
    expect(late).toBeLessThan(100);
  });

  // G — both move.
  it('moves on both inputs together', () => {
    const a = at(closeAt(1), 0.8, true).percent;
    const b = at(closeAt(2.5), 0.3, true).percent;
    expect(a).not.toBe(b);
  });

  it('keeps the rungs in order, so a better state never reads lower', () => {
    const approach = [1.0905, 1.0915, 1.0922].map((p) => at(p, 0.5, false).percent);
    const back = [LEVEL - 0.0004, LEVEL - 0.0001].map((p) => at(p, 0.5, true).percent);
    const owed = [0.2, 1.5, 2.9].map((b) => at(closeAt(b), 0.5, true).percent);
    const met = [0, 0.5, 1].map((l) => at(closeAt(5), l, true).percent);
    expect(Math.max(...approach)).toBeLessThan(Math.min(...back));
    expect(Math.max(...back)).toBeLessThanOrEqual(Math.min(...owed));
    expect(Math.max(...owed)).toBeLessThanOrEqual(Math.min(...met));
  });

  // The rule everything else defers to.
  it('never reaches 100 while the candle is open', () => {
    for (const left of [1, 0.5, 0.001, 0]) {
      for (const bps of [0, 1, 3, 20, 500]) {
        expect(at(closeAt(bps), left, true).percent, `${bps} bps, ${left} left`).toBeLessThan(100);
      }
    }
  });

  it('reaches 100 only once the trade exists', () => {
    const p = setupProgress(
      { cycle: { direction: 'PUT', stage: 'primary', entryTime: T0 }, armed: null },
      null,
      LEVEL,
    );
    expect(p.stage).toBe('fired');
    expect(p.percent).toBe(100);
  });

  // L — the jump the spec asks for explicitly.
  it('allows 96 to become 100 at the close with nothing in between', () => {
    // Mid-candle the reading is in the nineties and the depth is still owed…
    const midCandle = at(closeAt(2), 0.4, true);
    expect(midCandle.percent).toBeGreaterThanOrEqual(95);
    expect(midCandle.percent).toBeLessThan(98);
    // …and the candle then closes 5 bps beyond, which is a signal at once.
    expect(fired(c(16, 1.0921, closeAt(6), 1.0919, closeAt(5)))).toBe(true);
  });

  // K — nothing here can see the future.
  it('is a function of the present only', () => {
    expect(at(closeAt(1.7), 0.35, true)).toEqual(at(closeAt(1.7), 0.35, true));
  });
});
