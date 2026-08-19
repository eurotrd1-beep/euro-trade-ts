/**
 * The 0.236 touch strategy, rule by rule.
 *
 * Every candle here is placed by hand. That is deliberate: this strategy is a
 * sequence of decisions about WHICH candle is allowed to do what, and a sampled
 * fixture would let a passing test hide a wrong reason. Each case below is built
 * so exactly one rule can fail it.
 *
 * The series helper produces a clean V or Λ with a controllable retracement, and
 * the tests bend it — a long swing candle, a break past the high, a touch that
 * arrives one candle too late.
 */

import { describe, expect, it } from 'vitest';
import { fib236Touch, _internals } from '../src/programs/fib236.js';
import type { ProgramState } from '../src/programs/types.js';
import type { Candle } from '../src/types.js';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** One candle. `t` is an index; the clock is derived so gaps are impossible by accident. */
function c(t: number, open: number, high: number, low: number, close: number): Candle {
  return { open, high, low, close, volume: 1000, time: T0 + t * MIN };
}

/** A flat run of `n` candles around `price`, wide enough to never be a pivot. */
function flat(from: number, n: number, price: number, halfRange = 0.0004): Candle[] {
  return Array.from({ length: n }, (_, i) =>
    c(from + i, price, price + halfRange, price - halfRange, price),
  );
}

/**
 * A completed up-swing: a confirmed low, a rally, a confirmed high, then bars
 * drifting down towards the retracement without reaching it.
 *
 * Layout (index → what it is):
 *   0-1   filler so the low has two neighbours
 *   2     the LOW  — strictly under everything within two bars
 *   3-6   the rally
 *   7     the HIGH — strictly over everything within two bars
 *   8-11  the drift down, staying above the 0.236 level
 *
 * With low 1.0800 and high 1.1000 the level is 1.10000 − 0.236 × 0.02 = 1.09528.
 */
function upSwing(): Candle[] {
  return [
    c(0, 1.0850, 1.0854, 1.0846, 1.0850),
    c(1, 1.0845, 1.0849, 1.0841, 1.0845),
    c(2, 1.0810, 1.0814, 1.0800, 1.0812), //  ← the low
    c(3, 1.0830, 1.0834, 1.0826, 1.0830),
    c(4, 1.0870, 1.0874, 1.0866, 1.0870),
    c(5, 1.0920, 1.0924, 1.0916, 1.0920),
    c(6, 1.0960, 1.0964, 1.0956, 1.0960),
    c(7, 1.0980, 1.1000, 1.0976, 1.0985), // ← the high
    c(8, 1.0975, 1.0979, 1.0971, 1.0975),
    c(9, 1.0970, 1.0974, 1.0966, 1.0970),
    c(10, 1.0968, 1.0972, 1.0964, 1.0968),
    c(11, 1.0966, 1.0970, 1.0962, 1.0966),
  ];
}

/** The mirror image: a confirmed high, a fall, a confirmed low, then a drift up. */
function downSwing(): Candle[] {
  return [
    c(0, 1.0950, 1.0954, 1.0946, 1.0950),
    c(1, 1.0955, 1.0959, 1.0951, 1.0955),
    c(2, 1.0990, 1.1000, 1.0986, 1.0988), // ← the high
    c(3, 1.0970, 1.0974, 1.0966, 1.0970),
    c(4, 1.0930, 1.0934, 1.0926, 1.0930),
    c(5, 1.0880, 1.0884, 1.0876, 1.0880),
    c(6, 1.0840, 1.0844, 1.0836, 1.0840),
    c(7, 1.0820, 1.0824, 1.0800, 1.0815), // ← the low
    c(8, 1.0825, 1.0829, 1.0821, 1.0825),
    c(9, 1.0830, 1.0834, 1.0826, 1.0830),
    c(10, 1.0832, 1.0836, 1.0828, 1.0832),
    c(11, 1.0834, 1.0838, 1.0830, 1.0834),
  ];
}

const UP_LEVEL = 1.1 - 0.236 * 0.02; //  1.09528
const DOWN_LEVEL = 1.08 + 0.236 * 0.02; // 1.08472

/** Runs the program over every candle in order, as the live loop does. */
function replay(candles: Candle[], state = fib236Touch.init()) {
  const events = [];
  for (let i = 0; i < candles.length; i++) {
    const now = candles[i]!.time + MIN; // the candle has just closed
    const e = fib236Touch.onCandleClose(
      { candles: candles.slice(0, i + 1), timeframeMs: MIN, now },
      state,
    );
    if (e.signal || e.settled || e.cycleEnd) events.push({ at: i, ...e });
  }
  return { events, state };
}

/**
 * A candle whose range contains `level`, at index `t`.
 *
 * The default close sits about 4.5 basis points BEYOND the level, on the side
 * the trade needs: ‹A10› requires the candle to close past the level and ‹A11›
 * requires at least 3 bps of it. The old default closed exactly ON the level,
 * which satisfies neither, so every fixture built on it stopped producing a
 * signal the day those rules arrived.
 */
function touchAt(
  t: number,
  level: number,
  close?: number,
  dir: 'CALL' | 'PUT' = 'CALL',
): Candle {
  const beyond = dir === 'CALL' ? level - 0.0005 : level + 0.0005;
  return c(t, level + 0.0006, level + 0.0008, level - 0.0008, close ?? beyond);
}

describe('the level', () => {
  it('is 23.6% back from the end of the leg, both ways', () => {
    // One formula for both directions: end + 0.236 × (origin − end).
    expect(UP_LEVEL).toBeCloseTo(1.09528, 6);
    expect(DOWN_LEVEL).toBeCloseTo(1.08472, 6);
  });

  it('counts a wick that reaches it exactly as a touch', () => {
    const level = 1.09528;
    expect(_internals.touches(c(0, 1.096, 1.0965, level, 1.0962), level)).toBe(true);
    expect(_internals.touches(c(0, 1.096, 1.0965, level + 0.00001, 1.0962), level)).toBe(false);
  });
});

describe('direction comes from the swing, not the touch', () => {
  it('fires CALL when an up-swing retraces down into the level', () => {
    const candles = [...upSwing(), touchAt(12, UP_LEVEL)];
    const { events } = replay(candles);

    expect(events).toHaveLength(1);
    expect(events[0]!.at, 'the touch candle').toBe(12);
    expect(events[0]!.signal).toEqual({
      direction: 'CALL',
      stage: 'primary',
      entryTime: candles[12]!.time + MIN,
      // Reported alongside, from ‹A11›. Above the minimum by construction:
      // the signal exists, so the depth cleared it.
      depthBps: expect.any(Number),
    });
    expect(events[0]!.signal!.depthBps).toBeGreaterThanOrEqual(3);
  });

  it('fires PUT when a down-swing retraces up into the level', () => {
    const candles = [...downSwing(), touchAt(12, DOWN_LEVEL, undefined, 'PUT')];
    const { events } = replay(candles);

    expect(events).toHaveLength(1);
    expect(events[0]!.signal?.direction).toBe('PUT');
  });
});

describe('the signal lands on the candle after the touch', () => {
  it('never trades the touch candle itself', () => {
    const candles = [...upSwing(), touchAt(12, UP_LEVEL)];
    const { events } = replay(candles);

    const signal = events[0]!.signal!;
    // The touch candle opened at T0+12m and closed at T0+13m. The trade opens
    // where that candle ended, which is the start of the next one.
    expect(signal.entryTime).toBe(candles[12]!.time + MIN);
    expect(signal.entryTime).toBeGreaterThan(candles[12]!.time);
  });

  it('settles on the entry candle: its open in, its close out', () => {
    const entry = c(13, 1.0950, 1.0962, 1.0948, 1.0958); // closes above its open
    const { events } = replay([...upSwing(), touchAt(12, UP_LEVEL), entry]);

    const settled = events[1]!.settled!;
    expect(settled.entryPrice).toBe(1.095);
    expect(settled.exitPrice).toBe(1.0958);
    expect(settled.result, 'CALL, closed higher').toBe('WIN');
    expect(events[1]!.cycleEnd).toBe('WIN');
  });
});

describe('the swing candle must not have touched the level already', () => {
  it('refuses a setup whose high candle reached down to it', () => {
    const candles = upSwing();
    // The candle that makes the high gets a long lower wick reaching the level.
    // Nothing else about the swing changes.
    candles[7] = c(7, 1.0980, 1.1000, UP_LEVEL - 0.0001, 1.0985);
    const { events } = replay([...candles, touchAt(12, UP_LEVEL)]);

    expect(events, 'the whole move is disqualified').toHaveLength(0);
  });

  it('still accepts it when the wick stops just short', () => {
    const candles = upSwing();
    candles[7] = c(7, 1.098, 1.1, UP_LEVEL + 0.0001, 1.0985);
    const { events } = replay([...candles, touchAt(12, UP_LEVEL)]);

    expect(events).toHaveLength(1);
    expect(events[0]!.signal?.direction).toBe('CALL');
  });
});

describe('a setup that the market has moved past', () => {
  it('dies once price trades beyond the swing high', () => {
    // The break has to sit in the last two candles to be interesting: any
    // earlier and it becomes a confirmed pivot of its own, the swing is
    // rebuilt around it ‹A8›, and nothing is stale to begin with. Here the
    // market takes out 1.1000 at index 11, which cannot be confirmed as a
    // pivot yet — the window where a level would otherwise still be armed on
    // a high the market has already left behind.
    const candles = upSwing();
    candles[11] = c(11, 1.0996, 1.1012, 1.0992, 1.1008);
    const { events } = replay([...candles, touchAt(12, UP_LEVEL)]);

    expect(events, 'the level belongs to a leg that no longer ends there').toHaveLength(0);
  });

  it('rebuilds the swing when the break does confirm a new pivot', () => {
    // Same break, four candles earlier. Now index 9 is a confirmed high of
    // 1.1010, the old high at 7 stops being a pivot at all, and the level is
    // recomputed from the leg that actually ends the move ‹A8›.
    const candles = upSwing();
    candles[9] = c(9, 1.0995, 1.101, 1.0991, 1.0995);
    const newLevel = 1.101 - 0.236 * (1.101 - 1.08);
    const { events } = replay([...candles, touchAt(12, newLevel)]);

    expect(events).toHaveLength(1);
    expect(events[0]!.signal?.direction).toBe('CALL');
  });
});

/**
 * A series that turns at each price given, three bars per leg.
 *
 * Each turn is a single bar whose wick reaches the price exactly while its body
 * stops short, which is what makes it a clean 5-candle fractal. Three bars a leg
 * gives every turn its two clear neighbours on each side.
 */
function swings(turns: readonly number[], endAt: number): Candle[] {
  const out: Candle[] = [];
  const reach = 0.0002;
  let i = 0;
  const step = (from: number, to: number) => {
    for (let k = 1; k <= 3; k++) {
      const o = from + ((to - from) * (k - 1)) / 3;
      const cl = from + ((to - from) * k) / 3;
      out.push(c(i++, o, Math.max(o, cl) + 0.00002, Math.min(o, cl) - 0.00002, cl));
    }
  };

  let at = turns[0]! > turns[1]! ? turns[0]! - reach * 6 : turns[0]! + reach * 6;
  for (let t = 0; t < turns.length; t++) {
    const price = turns[t]!;
    const next = turns[t + 1];
    const isHigh = next === undefined ? price > turns[t - 1]! : price > next;

    step(at, isHigh ? price - reach * 2 : price + reach * 2);
    out.push(
      isHigh
        ? c(i++, price - reach * 2, price, price - reach * 2 - 0.00002, price - reach)
        : c(i++, price + reach * 2, price + reach * 2 + 0.00002, price, price + reach),
    );
    at = isHigh ? price - reach : price + reach;
  }
  step(at, endAt);
  return out;
}

/**
 * A rise from `low` to 1.1000 whose PEAK candle is an outside bar: it swallows
 * its four neighbours upward and downward at once, so it satisfies both the
 * swing-high and the swing-low test.
 */
function outsideBarAtPeak(low: number, wick: number): Candle[] {
  const out: Candle[] = [
    c(0, low + 0.003, low + 0.0034, low + 0.0026, low + 0.003),
    c(1, low + 0.002, low + 0.0024, low + 0.0016, low + 0.002),
    c(2, low + 0.0006, low + 0.001, low, low + 0.0004), //           ← the swing low
  ];
  // A smooth climb to the tight consolidation under the peak.
  for (let k = 1; k <= 2; k++) {
    const o = low + 0.001 + ((1.0965 - low - 0.001) * (k - 1)) / 2;
    const cl = low + 0.001 + ((1.0965 - low - 0.001) * k) / 2;
    out.push(c(2 + k, o, cl + 0.00002, o - 0.00002, cl));
  }
  out.push(c(5, 1.0966, 1.097, 1.0965, 1.0968));
  out.push(c(6, 1.0968, 1.0972, 1.0966, 1.097));
  out.push(c(7, 1.098, 1.1, wick, 1.0985)); //                        ← the outside bar
  out.push(c(8, 1.0975, 1.0979, 1.0966, 1.0975));
  out.push(c(9, 1.0972, 1.0976, 1.0967, 1.0972));
  out.push(c(10, 1.097, 1.0974, 1.0965, 1.097));
  out.push(c(11, 1.0968, 1.0972, 1.0963, 1.0968));
  return out;
}

describe('choosing the swing — A1 / A2', () => {
  /** The 23.6% of a leg, as the engine computes it. */
  const level = (origin: number, end: number) => end + 0.236 * (origin - end);

  it('takes the newest adjacent pair when the window holds several swings', () => {
    // Three complete moves behind it; the newest pair is 1.0930 → 1.0975.
    const candles = swings([1.085, 1.098, 1.091, 1.102, 1.093, 1.0975], 1.0968);
    const setup = _internals.findSetup(candles, 0, candles.length - 1, [])!;

    expect(setup).not.toBeNull();
    expect(setup.direction).toBe('CALL');
    expect(setup.level).toBeCloseTo(level(1.093, 1.0975), 5);
  });

  it('prefers the recent small move over an older larger one', () => {
    // The old leg runs 200 pips (1.0800 → 1.1000); the recent one runs 50
    // (1.0900 → 1.0950). Size is not the criterion — recency is.
    const candles = swings([1.08, 1.1, 1.09, 1.095], 1.0942);
    const setup = _internals.findSetup(candles, 0, candles.length - 1, [])!;

    expect(setup.level, 'drawn on the recent leg, not the big one').toBeCloseTo(
      level(1.09, 1.095),
      5,
    );
  });

  it('never reaches past an intermediate swing to pair two older points', () => {
    // 1.0800 → 1.1000 is the tidier move to a human eye, and it is NOT
    // available: the low at 1.0850 sits between them, so the only pair the
    // engine may take is 1.0850 → 1.1000.
    const candles = swings([1.08, 1.09, 1.085, 1.1], 1.0985);
    const setup = _internals.findSetup(candles, 0, candles.length - 1, [])!;

    expect(setup.level).toBeCloseTo(level(1.085, 1.1), 5);
    expect(setup.level, 'not the leg that skips the intermediate low').not.toBeCloseTo(
      level(1.08, 1.1),
      5,
    );
  });

  it('confirms a swing only after two more candles close  ‹A1›', () => {
    const candles = swings([1.085, 1.098, 1.091, 1.1], 1.0985);
    const peak = candles.reduce((best, x, i) => (x.high > candles[best]!.high ? i : best), 0);

    // One candle after the peak: the test needs `peak + 2`, which has not
    // closed, so the pivot does not exist yet.
    expect(
      _internals.confirmedPivots(candles, 0, peak - 1).some((pv) => pv.index === peak),
      'not a pivot while the window still ends before peak + 2',
    ).toBe(false);

    // Two candles later it is confirmed, and from then on it never changes.
    expect(
      _internals.confirmedPivots(candles, 0, peak).some((pv) => pv.index === peak && pv.kind === 'high'),
    ).toBe(true);
  });
});

describe('a candle that is both a high and a low — A3', () => {
  it('is not discarded — it stands as both, and the Setup rules judge it', () => {
    // Wick to 1.0950, under the four neighbouring lows: the bar satisfies the
    // swing-high test AND the swing-low test at the same time.
    const candles = outsideBarAtPeak(1.06, 1.095);
    const atPeak = _internals.confirmedPivots(candles, 0, 9).filter((pv) => pv.index === 7);

    // The old rule dropped it outright, so this list was empty and the swing
    // vanished for a reason nobody had written down.
    expect(atPeak.map((pv) => pv.kind).sort()).toEqual(['high', 'low']);
  });

  it('is usable as a swing when its own wick stays off the level', () => {
    // Leg 1.0600 → 1.1000, so 23.6% sits at 1.09056 — below the 1.0950 wick.
    // The bar is an outside bar and the setup is still perfectly good.
    const candles = outsideBarAtPeak(1.06, 1.095);
    const setup = _internals.findSetup(candles, 0, candles.length - 1, [])!;

    expect(setup).not.toBeNull();
    expect(setup.endIndex, 'the outside bar is the end of the leg').toBe(7);
    expect(setup.level).toBeCloseTo(1.1 + 0.236 * (1.06 - 1.1), 5);
  });

  it('is refused by the 0.236 rule when its wick does reach the level', () => {
    // Same bar, shorter leg: 1.0900 → 1.1000 puts 23.6% at 1.09764, inside the
    // candle's own range. The author's exclusion rule is what rejects it —
    // not a separate rule about outside bars.
    const candles = outsideBarAtPeak(1.09, 1.095);
    const levelOf = 1.1 + 0.236 * (1.09 - 1.1);

    expect(_internals.touches(candles[7]!, levelOf), 'the peak candle contains its own level').toBe(true);

    const setup = _internals.findSetup(candles, 0, candles.length - 1, []);
    expect(setup?.endIndex, 'so that swing is not used').not.toBe(7);
  });

  it('never pairs the candle with itself', () => {
    // The list now holds `high@7` then `low@7`, so the engine does try them as
    // a pair. Its 23.6% lands inside the candle by construction, so the 0.236
    // rule throws it out — no special case needed.
    const candles = outsideBarAtPeak(1.06, 1.095);
    const setup = _internals.findSetup(candles, 0, candles.length - 1, []);

    expect(
      setup === null || setup.originIndex !== setup.endIndex,
      'a candle is never both ends of its own move',
    ).toBe(true);
  });
});

describe('the adopted setup is held still', () => {
  it('keeps its level when a newer swing forms underneath it', () => {
    // The retracement carves a small leg of its own — a minor low then a minor
    // high, both well inside the original move. That pair is newer and would
    // win a "most recent swing" search, and its 23.6% sits somewhere else
    // entirely. The armed setup must not move to it.
    const candles = [
      ...upSwing(),
      c(12, 1.0966, 1.097, 1.0958, 1.096),
      c(13, 1.096, 1.0964, 1.0954, 1.0956), // a minor low, stopping just above
      c(14, 1.0958, 1.0966, 1.0957, 1.0964), //  the level at 1.09528
      c(15, 1.0966, 1.0974, 1.0962, 1.0972), // a minor high forms here
      c(16, 1.097, 1.0974, 1.0966, 1.0968),
      c(17, 1.0966, 1.097, 1.0963, 1.0964),
    ];

    const state = fib236Touch.init();
    replay(candles, state);

    expect(state.armed, 'still watching something').not.toBeNull();
    expect(state.armed!.level, 'and it is still the original 23.6%').toBeCloseTo(UP_LEVEL, 6);
    expect(state.armed!.endTime, 'anchored to the original high').toBe(candles[7]!.time);
  });

  it('lets go once price takes out the end of the leg', () => {
    const candles = [
      ...upSwing(),
      c(12, 1.0985, 1.1004, 1.098, 1.1002), // through the 1.1000 high
      c(13, 1.1, 1.1004, 1.0996, 1.1),
    ];

    const state = fib236Touch.init();
    replay(candles, state);

    // It may well have adopted something else by now — retiring a setup and
    // arming the next one happen on the same candle. What matters is that the
    // dead leg is not what it is watching.
    expect(state.armed?.endTime, 'not anchored to the broken high any more').not.toBe(
      candles[7]!.time,
    );
    expect(state.armed?.level ?? 0, 'and not still quoting its level').not.toBeCloseTo(UP_LEVEL, 6);
  });

  it('adopts and fires on different candles, never the same one', () => {
    // A touch on the very candle that first revealed the swing is not traded:
    // the setup did not exist when the price passed through the level.
    const candles = [...upSwing().slice(0, 11), touchAt(11, UP_LEVEL)];
    const { events, state } = replay(candles);

    expect(events).toHaveLength(0);
    expect(state.armed).not.toBeNull();
  });
});

describe('one signal per setup', () => {
  it('refuses a swing it has already traded, and only that swing', () => {
    // Tested here rather than through a replay for a reason worth writing down:
    // after a touch the market keeps making structure, and the retracement low
    // that produced the touch becomes a pivot of its own within a couple of
    // candles. So a replay DOES produce more signals afterwards — from new
    // swings, which is correct. What A4 forbids is narrower: the same pair of
    // pivots firing twice.
    const candles = [...upSwing(), touchAt(12, UP_LEVEL)];

    const setup = _internals.findSetup(candles, 0, 12, []);
    expect(setup, 'the swing is there to begin with').not.toBeNull();

    const again = _internals.findSetup(candles, 0, 12, [setup!.key]);
    expect(again, 'and it is not offered a second time').toBeNull();
  });

  it('keys the setup by time, so a sliding buffer does not resurrect it', () => {
    // The buffer drops its oldest candle every minute, so every index shifts.
    // A key built from indices would name a different swing an hour later and
    // the same setup would quietly become eligible again.
    const candles = [...upSwing(), touchAt(12, UP_LEVEL)];
    const setup = _internals.findSetup(candles, 0, 12, [])!;

    expect(setup.key).toBe(`${candles[2]!.time}:${candles[7]!.time}`);
    expect(setup.key).not.toContain('undefined');
  });
});

describe('the martingale', () => {
  const upToLoss = () => [
    ...upSwing(),
    touchAt(12, UP_LEVEL),
    c(13, 1.0952, 1.0956, 1.0948, 1.0950), // CALL entry, closes lower → LOSS
  ];

  it('follows a loss immediately, in the same direction', () => {
    const { events } = replay(upToLoss());
    const last = events.at(-1)!;

    expect(last.settled?.result).toBe('LOSS');
    expect(last.signal).toEqual({
      direction: 'CALL',
      stage: 'martingale',
      entryTime: T0 + 14 * MIN,
    });
    expect(last.cycleEnd, 'the cycle is still open').toBeNull();
  });

  it('ends the cycle as RECOVERED when it wins', () => {
    const { events } = replay([
      ...upToLoss(),
      c(14, 1.0950, 1.0968, 1.0949, 1.0965), // martingale candle, closes higher → WIN
    ]);

    expect(events.at(-1)!.cycleEnd).toBe('RECOVERED');
  });

  it('stops at FINAL_LOSS and never doubles twice', () => {
    const { events, state } = replay([
      ...upToLoss(),
      c(14, 1.0950, 1.0954, 1.0930, 1.0935), // martingale loses too
      touchAt(15, UP_LEVEL),
      touchAt(16, UP_LEVEL),
    ]);

    expect(events.at(-1)!.cycleEnd).toBe('FINAL_LOSS');
    expect(events.filter((e) => e.signal?.stage === 'martingale')).toHaveLength(1);
    expect(state.cycle, 'the cycle is closed for good').toBeNull();
  });

  it('does not follow a tie — there is nothing to recover', () => {
    const { events } = replay([
      ...upSwing(),
      touchAt(12, UP_LEVEL),
      c(13, 1.0952, 1.0956, 1.0948, 1.0952), // opens and closes at the same price
    ]);

    expect(events.at(-1)!.settled?.result).toBe('TIE');
    expect(events.at(-1)!.signal).toBeNull();
    expect(events.at(-1)!.cycleEnd).toBe('TIE');
  });
});

describe('no overlapping cycles', () => {
  it('ignores a fresh touch while a trade is open', () => {
    const candles = [
      ...upSwing(),
      touchAt(12, UP_LEVEL),
      touchAt(13, UP_LEVEL, 1.0944), // the entry candle touches again, and loses
    ];
    const { events } = replay(candles);

    // Two signals, and the second is the martingale the loss earned — not a
    // second setup taken from the touch that happened while the trade was on.
    const stages = events.filter((e) => e.signal !== null).map((e) => e.signal!.stage);
    expect(stages).toEqual(['primary', 'martingale']);
  });
});

describe('no repainting, and no future data', () => {
  it('ignores a candle that is still forming', () => {
    const candles = [...upSwing(), touchAt(12, UP_LEVEL)];
    const state = fib236Touch.init();

    // The touch candle opened one second ago — its high and low are still moving.
    const early = fib236Touch.onCandleClose(
      { candles, timeframeMs: MIN, now: candles[12]!.time + 1000 },
      state,
    );
    expect(early.signal).toBeNull();

    // The same call once it has closed produces the signal.
    const closed = fib236Touch.onCandleClose(
      { candles, timeframeMs: MIN, now: candles[12]!.time + MIN },
      state,
    );
    expect(closed.signal?.direction).toBe('CALL');
  });

  it('reads the same candle only once, however often it is asked', () => {
    const candles = [...upSwing(), touchAt(12, UP_LEVEL)];
    const state = fib236Touch.init();

    // Arm it first: adopting a setup and firing on it are two different
    // candles now, so the touch has to arrive at a program that is already
    // watching something.
    replay(candles.slice(0, 12), state);
    expect(state.armed, 'the swing is adopted and being watched').not.toBeNull();

    // The live loop ticks four times a second against an unchanged buffer.
    const ctx = { candles, timeframeMs: MIN, now: candles[12]!.time + MIN };
    expect(fib236Touch.onCandleClose(ctx, state).signal).not.toBeNull();
    expect(fib236Touch.onCandleClose(ctx, state).signal).toBeNull();
    expect(fib236Touch.onCandleClose(ctx, state).signal).toBeNull();
  });

  it('will not use a pivot that the next two candles could still disprove', () => {
    // The high at index 7 is only confirmed at index 9. Asked at index 8, the
    // program must not know about it yet — so the touch at 8 cannot trade.
    const candles = upSwing().slice(0, 9);
    candles[8] = touchAt(8, UP_LEVEL);

    const { events } = replay(candles);
    expect(events).toHaveLength(0);
  });

  it('replays to the identical result, which is what no-repainting means', () => {
    const candles = [
      ...upSwing(),
      touchAt(12, UP_LEVEL),
      c(13, 1.0952, 1.0956, 1.0948, 1.095),
      c(14, 1.095, 1.0968, 1.0949, 1.0965),
    ];

    const first = replay(candles).events;
    const second = replay(candles).events;
    expect(second).toEqual(first);
  });
});

describe('a touch discovered late is not traded late', () => {
  it('skips a touch that happened before the swing was confirmed', () => {
    // The touch sits at index 8 — after the high at 7, but before that high is
    // confirmable at 9. By the time the program can see the swing, the moment
    // to enter "on the next candle" has gone, so nothing is traded.
    const candles = upSwing();
    candles[8] = touchAt(8, UP_LEVEL);
    candles[9] = c(9, 1.097, 1.0974, 1.0966, 1.097);

    const { events } = replay(candles);
    expect(events).toHaveLength(0);
  });
});

describe('gaps and short history', () => {
  it('says nothing when there is not enough history', () => {
    const { events } = replay(flat(0, 8, 1.09));
    expect(events).toHaveLength(0);
  });

  it('will not build a swing across a hole in the feed', () => {
    const candles = upSwing();
    // Drop three candles out of the middle of the rally: the timestamps jump.
    const gapped = [...candles.slice(0, 4), ...candles.slice(7)];
    const { events } = replay([...gapped, touchAt(20, UP_LEVEL)]);

    expect(events).toHaveLength(0);
  });

  it('abandons a cycle whose entry candle never arrived', () => {
    const candles = [...upSwing(), touchAt(12, UP_LEVEL)];
    const state = fib236Touch.init();
    replay(candles, state);
    expect(state.cycle).not.toBeNull();

    // The feed resumes two minutes later; the candle the trade was to open on
    // does not exist, so nothing was traded and nothing is owed.
    const after = c(15, 1.096, 1.0964, 1.0956, 1.096);
    const event = fib236Touch.onCandleClose(
      { candles: [...candles, after], timeframeMs: MIN, now: after.time + MIN },
      state,
    );

    expect(event.cycleEnd).toBe('ABORTED');
    expect(event.settled, 'nothing opened, so nothing settled').toBeNull();
    expect(state.cycle).toBeNull();
  });
});

describe('state survives a reload', () => {
  it('carries an open cycle through JSON', () => {
    const candles = [...upSwing(), touchAt(12, UP_LEVEL)];
    const state = fib236Touch.init();
    replay(candles, state);

    const restored = JSON.parse(JSON.stringify(state)) as ProgramState;
    const entry = c(13, 1.0952, 1.0956, 1.0948, 1.095);

    const event = fib236Touch.onCandleClose(
      { candles: [...candles, entry], timeframeMs: MIN, now: entry.time + MIN },
      restored,
    );

    expect(event.settled?.result, 'the losing trade is still known about').toBe('LOSS');
    expect(event.signal?.stage, 'and it still earns its martingale').toBe('martingale');
  });
});
