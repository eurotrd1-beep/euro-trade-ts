/**
 * The order of the cards, and the number printed on them.
 *
 * ‹A10› moved where 100 comes from — a closed candle rather than a touch — and
 * added a band above the approach for "this would fire if the minute ended
 * now". Both of those are only visible to a user through the ordering and the
 * rounding, so both are pinned here.
 */

import { describe, expect, it } from 'vitest';
import { byNearest } from '../lib/stageWords';
import type { SetupProgress } from '@euro/engine';

const p = (percent: number, stage: SetupProgress['stage'] = 'armed'): SetupProgress => ({
  stage,
  percent,
});

/** What the card prints: floor, with 100 reserved for a real 100. */
const shown = (percent: number): number => (percent >= 100 ? 100 : Math.floor(percent));

describe('cards are ordered by the number they show', () => {
  it('sorts descending, across every band', () => {
    const rows = [
      p(42.5, 'rejected'),
      p(100, 'fired'),
      p(90.02),
      p(99.99),
      p(12, 'pivots'),
      p(95.0),
      p(98.4),
      p(0, 'idle'),
    ];
    expect([...rows].sort(byNearest).map((x) => x.percent)).toEqual([
      100, 99.99, 98.4, 95.0, 90.02, 42.5, 12, 0,
    ]);
  });

  it('puts a satisfied candle above every approaching one', () => {
    // The band split, seen from outside: 95 is the floor of "would fire now"
    // and the ceiling of "still travelling", so the two never interleave.
    const satisfied = [95.0, 96.3, 99.99].map((x) => p(x));
    const approaching = [90.0, 92.7, 94.999].map((x) => p(x));
    const sorted = [...approaching, ...satisfied].sort(byNearest);
    expect(sorted.slice(0, 3).every((x) => x.percent >= 95)).toBe(true);
    expect(sorted.slice(3).every((x) => x.percent < 95)).toBe(true);
  });

  it('leaves the other stages where they were', () => {
    // The bands below the armed one are untouched by ‹A10›; only their order
    // relative to each other matters and it is still by percentage.
    const rows = [p(29.9, 'pivots'), p(49.9, 'rejected'), p(14.9, 'idle')];
    expect([...rows].sort(byNearest).map((x) => x.stage)).toEqual(['rejected', 'pivots', 'idle']);
  });
});

describe('the printed number', () => {
  it('never prints 100 for the top of the approach', () => {
    // 99.99 is the ceiling while the candle is open. Rounding would print 100
    // and promise a trade that has not been given.
    expect(shown(99.99)).toBe(99);
    expect(shown(99.999)).toBe(99);
    expect(shown(95)).toBe(95);
    expect(shown(90.0)).toBe(90);
  });

  it('prints 100 only for a real 100', () => {
    expect(shown(100)).toBe(100);
  });
});
