/**
 * ‹A10› — the touch has to survive the close, and what the card may claim.
 *
 * Two rules land here and they are separate on purpose:
 *
 *   the STRATEGY  a candle whose range contains the level only trades if it
 *                 also CLOSES at or past it; otherwise the setup is spent and
 *                 nothing opens
 *   the CARD      100 belongs to a closed candle that met that rule. While the
 *                 candle is open the reading says how close it is, and can get
 *                 arbitrarily near 100 without ever arriving
 *
 * The minimum swing size ‹A7› is a third rule that runs earlier, on the setup,
 * and the last test here holds it apart from the other two: it decides whether
 * a setup exists at all, and contributes nothing to the percentage.
 */

import { describe, expect, it } from 'vitest';
import { fib236Touch, setupProgress, tieEpsilon, type Candle } from '../src/index.js';
import type { ProgramEvent, ProgramState } from '../src/programs/types.js';

const MIN = 60_000;
const T0 = Date.parse('2026-01-05T09:00:00.000Z');
const c = (i: number, o: number, h: number, l: number, cl: number): Candle => ({
  open: o,
  high: h,
  low: l,
  close: cl,
  volume: 1000,
  time: T0 + i * MIN,
});

/**
 * A down-swing: high 1.10000 at index 2, low 1.09000 at index 9.
 *
 * PUT, and 23.6% of the drop back up from the low puts the level at 1.09236.
 * Price then drifts up underneath it, so the touch candle at index 16 is the
 * first one that can reach it — and what that candle does at its close is the
 * only thing the tests below change.
 */
function downSwing(touch: Candle): Candle[] {
  return [
    c(0, 1.0985, 1.0989, 1.0981, 1.0985),
    c(1, 1.0992, 1.0996, 1.0988, 1.0993),
    c(2, 1.0996, 1.1, 1.0994, 1.0997), //   ← swing high 1.10000
    c(3, 1.0985, 1.0989, 1.0981, 1.0983),
    c(4, 1.097, 1.0974, 1.0966, 1.0968),
    c(5, 1.0955, 1.0959, 1.0951, 1.0953),
    c(6, 1.094, 1.0944, 1.0936, 1.0938),
    c(7, 1.0925, 1.0929, 1.0921, 1.0923),
    c(8, 1.091, 1.0914, 1.0906, 1.0908),
    c(9, 1.0904, 1.0908, 1.09, 1.0902), // ← swing low 1.09000
    c(10, 1.0906, 1.091, 1.0904, 1.0908),
    c(11, 1.0909, 1.0913, 1.0907, 1.0911),
    c(12, 1.0912, 1.0916, 1.091, 1.0914),
    c(13, 1.0915, 1.0918, 1.0913, 1.0916),
    c(14, 1.0917, 1.092, 1.0915, 1.0918),
    c(15, 1.0919, 1.0921, 1.0917, 1.092),
    touch, //                                ← index 16
    c(17, 1.0925, 1.0929, 1.0921, 1.0923),
    c(18, 1.0925, 1.0929, 1.0921, 1.0923),
  ];
}

const LEVEL = 1.09 + 0.236 * (1.1 - 1.09); // 1.09236

/** Drives the program candle by candle, the way the live loop does. */
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

describe('the level, and what the candle does with it', () => {
  it('has the level where the arithmetic puts it', () => {
    expect(LEVEL).toBeCloseTo(1.09236, 10);
  });

  // C / E — reached it, and gave it back.
  it('refuses a PUT whose touch candle closes back BELOW the level', () => {
    // Range contains 1.09236, so the touch itself is not in doubt.
    const { events } = drive(downSwing(c(16, 1.0921, 1.0928, 1.0919, 1.0922)));
    const touchBar = downSwing(c(16, 1.0921, 1.0928, 1.0919, 1.0922))[16]!;
    expect(touchBar.low <= LEVEL && LEVEL <= touchBar.high, 'the candle did touch').toBe(true);
    expect(touchBar.close < LEVEL, 'and closed short of it').toBe(true);

    expect(events.some((e) => e.signal !== null)).toBe(false);
  });

  // F — reached it and stayed.
  it('takes a PUT whose touch candle closes AT or ABOVE the level', () => {
    // Both closes clear the ‹A11› depth as well; ‹A10› alone is no longer
    // enough to produce a signal.
    for (const close of [LEVEL * (1 + 3.2e-4), 1.0928]) {
      const bar = c(16, 1.0921, 1.0928, 1.0919, close);
      const { events } = drive(downSwing(bar));
      const fired = events.find((e) => e.signal !== null);
      expect(fired, `close ${close}`).toBeDefined();
      expect(fired!.signal!.direction).toBe('PUT');
      expect(fired!.signal!.stage).toBe('primary');
      // Entry timing is untouched: the candle after the touch.
      expect(fired!.signal!.entryTime).toBe(T0 + 17 * MIN);
    }
  });

  // The refusal is final for that swing.
  it('spends the setup when it refuses — no second attempt on a later candle', () => {
    const candles = downSwing(c(16, 1.0921, 1.0928, 1.0919, 1.0922));
    // A later candle that closes well past the level would fire on its own if
    // the setup were still armed.
    candles[17] = c(17, 1.0925, 1.0929, 1.0921, 1.0928);
    candles[18] = c(18, 1.0928, 1.0932, 1.0924, 1.0931);
    const { events, state } = drive(candles);
    expect(events.some((e) => e.signal !== null)).toBe(false);
    expect(state.cycle).toBeNull();
    expect(state.armed, 'the swing was consumed, not left waiting').toBeNull();
  });
});

/**
 * The mirror image, so the rule is not being read off one direction.
 *
 * An up-swing: low 1.09000 at index 2, high 1.10000 at index 9 → CALL, and the
 * level sits BELOW the high at 1.09764. Price drifts down onto it.
 */
function upSwing(touch: Candle): Candle[] {
  return [
    c(0, 1.0915, 1.0919, 1.0911, 1.0915),
    c(1, 1.0908, 1.0912, 1.0904, 1.0908),
    c(2, 1.0904, 1.0908, 1.09, 1.0903), //  ← swing low 1.09000
    c(3, 1.0915, 1.0919, 1.0911, 1.0917),
    c(4, 1.093, 1.0934, 1.0926, 1.0932),
    c(5, 1.0945, 1.0949, 1.0941, 1.0947),
    c(6, 1.096, 1.0964, 1.0956, 1.0962),
    c(7, 1.0975, 1.0979, 1.0971, 1.0977),
    c(8, 1.099, 1.0994, 1.0986, 1.0992),
    c(9, 1.0996, 1.1, 1.0992, 1.0998), //   ← swing high 1.10000
    c(10, 1.0994, 1.0996, 1.099, 1.0992),
    c(11, 1.0991, 1.0993, 1.0987, 1.0989),
    c(12, 1.0988, 1.099, 1.0984, 1.0986),
    c(13, 1.0985, 1.0987, 1.0982, 1.0984),
    c(14, 1.0983, 1.0985, 1.098, 1.0982),
    c(15, 1.0981, 1.0983, 1.0979, 1.098),
    touch, //                                ← index 16
    c(17, 1.0975, 1.0979, 1.0971, 1.0973),
    c(18, 1.0975, 1.0979, 1.0971, 1.0973),
  ];
}
const UP_LEVEL = 1.1 + 0.236 * (1.09 - 1.1); // 1.09764

describe('the same rule the other way up', () => {
  // C — a CALL that gave the level back.
  it('refuses a CALL whose touch candle closes back ABOVE the level', () => {
    const bar = c(16, 1.098, 1.0982, 1.0974, 1.0979);
    expect(bar.low <= UP_LEVEL && UP_LEVEL <= bar.high).toBe(true);
    expect(bar.close > UP_LEVEL).toBe(true);
    expect(drive(upSwing(bar)).events.some((e) => e.signal !== null)).toBe(false);
  });

  // D — a CALL that held it.
  it('takes a CALL whose touch candle closes AT or BELOW the level', () => {
    for (const close of [UP_LEVEL * (1 - 3.2e-4), 1.0972]) {
      const fired = drive(upSwing(c(16, 1.098, 1.0982, 1.0974, close))).events.find(
        (e) => e.signal !== null,
      );
      expect(fired, `close ${close}`).toBeDefined();
      expect(fired!.signal!.direction).toBe('CALL');
      expect(fired!.signal!.entryTime).toBe(T0 + 17 * MIN);
    }
  });
});

// ── the card ───────────────────────────────────────────────────────────────

const armed = {
  direction: 'PUT' as const,
  level: LEVEL,
  endPrice: 1.09,
  endTime: T0 + 9 * MIN,
  key: 'a:b',
};
const progress = (price: number, candleLeft: number, touched: boolean) =>
  setupProgress({ cycle: null, armed }, null, price, candleLeft, touched);

describe('what the card is allowed to claim', () => {
  // G — the candle is still open.
  it('never reaches 100 while the candle is open, however good it looks', () => {
    for (const left of [1, 0.5, 0.01, 0.0001, 0]) {
      for (const price of [LEVEL, LEVEL + 0.001, LEVEL + 0.01]) {
        const p = progress(price, left, true);
        expect(p.percent, `price ${price}, ${left} of the candle left`).toBeLessThan(100);
      }
    }
  });

  it('reaches 100 only once the trade exists — a closed candle that met the rule', () => {
    const fired = setupProgress(
      { cycle: { direction: 'PUT', stage: 'primary', entryTime: T0 }, armed: null },
      null,
      LEVEL,
    );
    expect(fired.stage).toBe('fired');
    expect(fired.percent).toBe(100);
  });

  // H — distance.
  it('rises as price closes on the level, at a fixed moment in the candle', () => {
    const far = progress(LEVEL - 0.005, 0.5, false).percent;
    const near = progress(LEVEL - 0.0005, 0.5, false).percent;
    const closer = progress(LEVEL - 0.00005, 0.5, false).percent;
    expect(far).toBeLessThan(near);
    expect(near).toBeLessThan(closer);
    // ‹A11› moved the floor: an armed setup that has not touched yet lives in
    // 50–90 now, and 90 belongs to a candle that has actually touched.
    expect(far).toBeGreaterThanOrEqual(50);
    expect(closer).toBeLessThan(90);
  });

  // I — time, and it cuts both ways.
  it('falls as the candle drains while price is still short', () => {
    const early = progress(LEVEL - 0.002, 0.9, false).percent;
    const late = progress(LEVEL - 0.002, 0.1, false).percent;
    expect(late, 'less time for the same distance is worse, not better').toBeLessThan(early);
  });

  it('rises as the candle drains once the rule already holds', () => {
    // Past the level with the touch recorded: the only thing left is price
    // leaving again, and there is less and less room for it to.
    const early = progress(LEVEL + 0.0005, 0.9, true).percent;
    const late = progress(LEVEL + 0.0005, 0.1, true).percent;
    expect(early).toBeLessThan(late);
    expect(late).toBeLessThan(100);
  });

  it('puts every satisfied reading above every unsatisfied one', () => {
    // The ordering that makes the two bands mean something: a candle that would
    // fire on this instant's close outranks any candle still travelling.
    const satisfied = [0, 0.25, 0.5, 0.75, 1].map((t) => progress(LEVEL + 0.0002, t, true).percent);
    const short = [0, 0.25, 0.5, 0.75, 1].flatMap((t) =>
      [0.00001, 0.0005, 0.005].map((d) => progress(LEVEL - d, t, false).percent),
    );
    expect(Math.min(...satisfied)).toBeGreaterThanOrEqual(Math.max(...short));
  });

  it('refuses to let time alone carry a distant price up the band', () => {
    // The explicit rule: far away must not read 95 just because the candle is
    // nearly over.
    for (const left of [0.5, 0.1, 0.01, 0]) {
      expect(progress(LEVEL - 0.008, left, false).percent).toBeLessThan(95);
    }
  });

  it('will not call it done just because price is at the level with time to spare', () => {
    expect(progress(LEVEL + 0.0002, 1, true).percent).toBeLessThan(96);
  });

  it('stays inside the band it advertises', () => {
    for (const left of [0, 0.3, 0.7, 1]) {
      for (const d of [-0.01, -0.001, 0, 0.001, 0.01]) {
        for (const touched of [true, false]) {
          const p = progress(LEVEL + d, left, touched).percent;
          expect(p).toBeGreaterThanOrEqual(50);
          expect(p).toBeLessThanOrEqual(99.99);
          // Touching is what unlocks the bands above 90. The approach band
          // saturates AT 90 — reaching the level is the touch, so an untouched
          // reading of exactly 90 is the boundary the two bands share, not an
          // untouched setup claiming a touched one's ground.
          if (!touched) expect(p).toBeLessThanOrEqual(90);
        }
      }
    }
  });

  // K — nothing here can see the future.
  it('is a function of the present only', () => {
    // Same inputs, same answer, whatever happens next: there is no candle, no
    // close and no outcome in the signature to read.
    const a = progress(LEVEL - 0.0003, 0.4, false);
    const b = progress(LEVEL - 0.0003, 0.4, false);
    expect(a).toEqual(b);
  });
});

// ── A and B: the minimum swing size is a separate rule ─────────────────────

describe('the minimum swing size, held apart from the rest', () => {
  /**
   * The same down-swing, shrunk about its low until the leg is under the
   * minimum.
   *
   * Scaled rather than hand-built: the fractal structure is what makes the
   * pivots confirm at all, and a fixture drawn freehand at this size stopped
   * producing a pivot pair — which would have made the test pass for the wrong
   * reason. Scaling keeps every high/low relationship exactly as it is in the
   * fixture above and changes only the size.
   */
  function tinySwing(): Candle[] {
    const K = 0.002; // leg 0.01 → 0.00002, against a minimum of 0.000055
    const f = (p: number): number => 1.1 + (p - 1.09) * K;
    return downSwing(c(16, 1.0921, 1.0928, 1.0919, 1.0926)).map((x, i) =>
      c(i, f(x.open), f(x.high), f(x.low), f(x.close)),
    );
  }

  // A — the minimum fails, so there is nothing for the rest of the rules to do.
  it('produces no setup and no signal when the leg is under the minimum', () => {
    const { events, state } = drive(tinySwing());
    expect(state.armed).toBeNull();
    expect(state.cycle).toBeNull();
    expect(events.some((e) => e.signal !== null)).toBe(false);
    expect(events.some((e) => (e.diagnostics?.rejectedTooSmall ?? 0) > 0)).toBe(true);
  });

  // B — it passes, and everything downstream runs untouched.
  it('lets the ordinary rules run when the leg clears the minimum', () => {
    const leg = Math.abs(1.1 - 1.09);
    expect(leg, 'the fixture leg is well over the minimum').toBeGreaterThan(10 * tieEpsilon(1.09));
    const fired = drive(downSwing(c(16, 1.0921, 1.0932, 1.0919, 1.093))).events.find(
      (e) => e.signal !== null,
    );
    expect(fired).toBeDefined();
  });

  // L — and it is not in the percentage.
  it('contributes nothing to the reading', () => {
    // Two setups whose legs differ by a factor of ten, priced the same distance
    // from their levels with the same clock: the minimum decided whether each
    // EXISTS, and after that it is not a term in the arithmetic. The readings
    // differ only through the leg, which is `setupCompletion`'s own scale and
    // predates this rule.
    const wide = { ...armed, level: 1.1, endPrice: 1.05 };
    const narrow = { ...armed, level: 1.1, endPrice: 1.095 };
    const at = (a: typeof armed) =>
      setupProgress({ cycle: null, armed: a }, null, 1.1 + 0.0002, 0.5, true).percent;
    // Both satisfy ‹A10› right now, so both sit in the satisfied band at the
    // same point — the leg cannot reach this branch at all.
    expect(at(wide)).toBe(at(narrow));
  });
});
