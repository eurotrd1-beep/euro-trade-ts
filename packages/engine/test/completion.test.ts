/**
 * How close a setup is to firing.
 *
 * There is no score in this strategy. The pyramid that produced one was
 * removed, `buildRow` writes `score: 0`, and a touch either happened or it did
 * not. But "which pair is closest right now" is a real question, and this is
 * the number two separate callers rank by — the app choosing which chart to
 * show, and the generator choosing which pair to notify about. If they each
 * computed their own, the notification and the chart would eventually disagree
 * about which pair is the one to watch, which is worse than either being wrong
 * on its own.
 *
 * So the arithmetic is pinned here, including the two edges that would rank a
 * pair FIRST if they were mishandled: a zero-width leg (a divide by zero
 * yielding NaN, which sorts unpredictably) and price past the level (which
 * would otherwise read as more than 100% ready).
 */

import { describe, expect, it } from 'vitest';
import { setupCompletion } from '../src/index.js';

/**
 * An up-swing from 1.0900 to 1.1000. The level sits 23.6% back from the high:
 * 1.1000 − 0.00236 = 1.09764.
 */
const up = { direction: 'CALL' as const, level: 1.09764, endPrice: 1.1 };

/** And a down-swing, where the level is approached from below. */
const down = { direction: 'PUT' as const, level: 1.09236, endPrice: 1.09 };

describe('setupCompletion', () => {
  it('is 1 when price is at the level', () => {
    expect(setupCompletion(up, up.level)).toBeCloseTo(1, 10);
    expect(setupCompletion(down, down.level)).toBeCloseTo(1, 10);
  });

  it('is 0 a full leg away from the level', () => {
    // The leg is 0.0100, so a full leg above the level is 1.10764.
    expect(setupCompletion(up, up.level + 0.01)).toBeCloseTo(0, 10);
  });

  it('is a half at half a leg out', () => {
    expect(setupCompletion(up, up.level + 0.005)).toBeCloseTo(0.5, 10);
  });

  it('does not exceed 1 when price runs past the level', () => {
    // Price is free to carry on through. A setup is not 130% ready — it is
    // touched, and a number above 1 would put it ahead of a genuine touch in
    // any ranking.
    expect(setupCompletion(up, up.level - 0.003)).toBe(1);
    expect(setupCompletion(down, down.level + 0.003)).toBe(1);
  });

  it('does not go below 0 far away from the level', () => {
    expect(setupCompletion(up, up.level + 0.05)).toBe(0);
  });

  it('is not a bare distance — the side matters', () => {
    // 0.002 short of the level is 80% of the way there. 0.002 PAST it is a
    // touch, which is the whole event. A symmetric distance would call the
    // second one 80% too, and rank a setup that has already fired below one
    // that has not.
    expect(setupCompletion(up, up.level + 0.002)).toBeCloseTo(0.8, 10);
    expect(setupCompletion(up, up.level - 0.002)).toBe(1);
  });

  it('returns 0 rather than NaN for a leg with no width', () => {
    // A degenerate setup would divide by zero. NaN compares false against
    // everything, so a sort would put it wherever it happened to land — and it
    // would sometimes land first, pointing every user at a pair with no swing.
    // Priced just above the level so the reached-shortcut does not fire and
    // the divide is actually reached.
    const flat = { direction: 'CALL' as const, level: 1.1, endPrice: 1.1 };
    expect(setupCompletion(flat, 1.10001)).toBe(0);
    expect(Number.isNaN(setupCompletion(flat, 1.10001))).toBe(false);
  });

  it('ranks a nearer pair above a further one', () => {
    // The property everything downstream actually relies on.
    const near = setupCompletion(up, up.level + 0.001);
    const far = setupCompletion(up, up.level + 0.008);
    expect(near).toBeGreaterThan(far);
  });

  it('compares fairly across pairs with different-sized legs', () => {
    // Two pairs, one with a leg ten times the other, each 20% of its own leg
    // away. Neither is "closer" — the measure is a fraction of the leg, which
    // is what makes a JPY pair and a EUR pair rankable against each other at
    // all.
    const small = { direction: 'CALL' as const, level: 1.09764, endPrice: 1.1 }; // leg 0.0100
    const large = { direction: 'CALL' as const, level: 107.64, endPrice: 110 }; // leg 10.00
    expect(setupCompletion(small, small.level + 0.002)).toBeCloseTo(
      setupCompletion(large, large.level + 2),
      10,
    );
  });
});
