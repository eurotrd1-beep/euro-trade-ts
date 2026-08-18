/**
 * 100 on screen must mean a touch has happened. Nothing else may print it.
 *
 * The bars showed 100% beside text correctly reading "35 pips left to the
 * level" — two claims about one pair, one of them false. The reason was
 * `Math.round`: the approach caps at 99.9 by design, and rounding turned that
 * into a displayed 100.
 *
 * The scale's top is a promise, and a promise that can be reached by rounding
 * is not one. This pins the display rule the way `progress.test.ts` pins the
 * arithmetic behind it.
 */

import { describe, expect, it } from 'vitest';

/** Exactly what both the card and the strip do to turn a reading into a label. */
const shown = (percent: number): number => (percent >= 100 ? 100 : Math.floor(percent));

describe('the number on screen', () => {
  it('never prints 100 for the top of the approach', () => {
    // 99.9 is the cap for a setup that has NOT been touched.
    expect(shown(99.9)).toBe(99);
  });

  it('never prints 100 for anything below a touch, at any value', () => {
    // Swept, because the failure was one function call and a single spot check
    // would have missed it just as easily as the review did.
    for (let p = 90; p < 100; p += 0.01) {
      expect(shown(p), `${p.toFixed(2)} printed 100 without a touch`).toBeLessThan(100);
    }
  });

  it('prints 100 for a touch', () => {
    expect(shown(100)).toBe(100);
  });

  it('does not flatter anything else either', () => {
    // Rounding up anywhere would overstate progress; the whole scale reads low.
    expect(shown(49.7)).toBe(49);
    expect(shown(29.99)).toBe(29);
    expect(shown(0)).toBe(0);
  });
});
