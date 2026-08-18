/**
 * How much history a backtest actually saw.
 *
 * The screen used to describe the window as "N days", where N was a count of
 * distinct calendar dates. On the live feed that reads: 800 candles, coverage
 * 3/24 hours, "on 1 day" — while the real window is an hour and forty minutes,
 * because the proxy keeps 100 one-minute candles per pair and every pair is
 * recorded in the same minutes. Eight pairs do not widen the window, they
 * deepen it.
 *
 * A date count and a duration are not the same measurement, and the gap
 * between them grows exactly where it does the most damage: a hundred minutes
 * straddling midnight touches two dates and would have been reported as two
 * days. So the span is measured now, and these pin both the arithmetic and the
 * wording.
 */

import { describe, expect, it } from 'vitest';
import { formatSpan } from '@/lib/backtest';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatSpan', () => {
  it('says minutes below an hour', () => {
    expect(formatSpan(40 * MIN)).toBe('40 دقيقة');
    expect(formatSpan(59 * MIN)).toBe('59 دقيقة');
  });

  it('says hours with the minutes that are left', () => {
    // The live case at the time of writing: 100 candles per pair.
    expect(formatSpan(100 * MIN)).toBe('1 ساعة و40 دقيقة');
    expect(formatSpan(3 * HOUR)).toBe('3 ساعة');
  });

  it('says days with the hours that are left', () => {
    expect(formatSpan(DAY)).toBe('1 يوم');
    expect(formatSpan(DAY + 5 * HOUR)).toBe('1 يوم و5 ساعة');
    // 47 hours is not "1 day". That rounding is the bug this replaced.
    expect(formatSpan(47 * HOUR)).toBe('1 يوم و23 ساعة');
  });

  it('never dresses a short window as a long one', () => {
    // The exact failure: a hundred minutes across midnight touches two dates.
    // Whatever it says, it must not contain the word for days.
    expect(formatSpan(100 * MIN)).not.toContain('يوم');
  });

  it('does not invent a duration it does not have', () => {
    expect(formatSpan(0)).toBe('صفر');
    expect(formatSpan(-5)).toBe('صفر');
    expect(formatSpan(Number.NaN)).toBe('صفر');
  });
});
