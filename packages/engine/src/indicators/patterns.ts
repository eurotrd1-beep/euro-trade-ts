/**
 * Candlestick and chart patterns — batch 3.
 *
 * Ported literally from signal_engine.dart. The ordering inside
 * `candlePatterns` is significant: the Dart version returns the FIRST pattern
 * that matches, so doji shadows engulfing, engulfing shadows hammer, and so on.
 * Reordering these checks would silently change which pattern the app reports.
 */

import { register } from '../registry.js';
import type { Candle } from '../types.js';

/**
 * signal_engine.dart — `_swingPoints`.
 * A swing high needs `str` candles on BOTH sides that are strictly lower;
 * a swing low needs `str` strictly higher. Returned oldest-first.
 */
export function swingPoints(
  candles: readonly Candle[],
  lookback = 50,
  str = 2,
): { h: number[]; l: number[] } {
  const h: number[] = [];
  const l: number[] = [];
  const start = Math.max(str, candles.length - lookback);

  for (let i = start; i < candles.length - str; i++) {
    const ch = candles[i]!.high;
    const cl = candles[i]!.low;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= str; k++) {
      if (ch <= candles[i - k]!.high || ch <= candles[i + k]!.high) isHigh = false;
      if (cl >= candles[i - k]!.low || cl >= candles[i + k]!.low) isLow = false;
    }
    if (isHigh) h.push(ch);
    if (isLow) l.push(cl);
  }
  return { h, l };
}

/** signal_engine.dart:3356 */
export function avgBodySize(candles: readonly Candle[]): number {
  if (candles.length === 0) return 0.0001;
  return candles.reduce((a, c) => a + Math.abs(c.close - c.open), 0) / candles.length;
}

// ── Candlestick patterns ────────────────────────────────────────────────────

/** signal_engine.dart:5995 — first match wins; order is load-bearing. */
export function candlePatterns(candles: readonly Candle[]): string {
  if (candles.length < 3) return 'none';

  const last = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;
  const prev2 = candles[candles.length - 3]!;

  const lastBody = Math.abs(last.close - last.open);
  const lastRange = last.high - last.low;
  const prevBody = Math.abs(prev.close - prev.open);

  if (lastRange === 0) return 'none';

  if (lastBody / lastRange < 0.1) return 'doji';

  if (
    prev.close < prev.open && last.close > last.open &&
    last.open <= prev.close && last.close >= prev.open
  ) return 'bullish_engulfing';

  if (
    prev.close > prev.open && last.close < last.open &&
    last.open >= prev.close && last.close <= prev.open
  ) return 'bearish_engulfing';

  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);

  if (
    lowerWick / lastRange > 0.6 && upperWick / lastRange < 0.15 &&
    lastBody / lastRange > 0.1
  ) return 'hammer';

  if (
    upperWick / lastRange > 0.6 && lowerWick / lastRange < 0.15 &&
    lastBody / lastRange > 0.1
  ) return 'shooting_star';

  if (
    prev2.close < prev2.open && prevBody < lastBody * 0.4 &&
    last.close > last.open && last.close > (prev2.open + prev2.close) / 2
  ) return 'morning_star';

  if (
    prev2.close > prev2.open && prevBody < lastBody * 0.4 &&
    last.close < last.open && last.close < (prev2.open + prev2.close) / 2
  ) return 'evening_star';

  if (
    prev2.close > prev2.open && prev.close > prev.open && last.close > last.open &&
    prev.close > prev2.close && last.close > prev.close
  ) return 'three_white_soldiers';

  if (
    prev2.close < prev2.open && prev.close < prev.open && last.close < last.open &&
    prev.close < prev2.close && last.close < prev.close
  ) return 'three_black_crows';

  if (lowerWick / lastRange > 0.65) return 'pin_bar_bullish';
  if (upperWick / lastRange > 0.65) return 'pin_bar_bearish';

  return 'none';
}

// ── Chart patterns ──────────────────────────────────────────────────────────
// Note the tolerances are ABSOLUTE price distances (0.0015 / 0.0020), not
// percentages — they are tuned for forex-scale quotes and are copied verbatim.

const last2 = (xs: number[]): [number, number] => [xs[xs.length - 1]!, xs[xs.length - 2]!];

/** signal_engine.dart:3782 */
export function doubleTop(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { h } = swingPoints(candles, 40, 2);
  if (h.length < 2) return 'none';
  const tol = 0.0015;
  const [a, b] = last2(h);
  return Math.abs(a - b) < tol && currentPrice < a - tol ? 'bearish' : 'none';
}

/** signal_engine.dart:3794 */
export function doubleBottom(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { l } = swingPoints(candles, 40, 2);
  if (l.length < 2) return 'none';
  const tol = 0.0015;
  const [a, b] = last2(l);
  return Math.abs(a - b) < tol && currentPrice > a + tol ? 'bullish' : 'none';
}

/** signal_engine.dart:3806 */
export function headAndShoulders(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 30) return 'none';
  const { h } = swingPoints(candles, 60, 2);
  if (h.length < 3) return 'none';
  const left = h[h.length - 3]!, head = h[h.length - 2]!, right = h[h.length - 1]!;
  const shoulderAvg = (left + right) / 2;
  if (
    head > left * 1.002 && head > right * 1.002 &&
    Math.abs(left - right) < shoulderAvg * 0.003 &&
    currentPrice < shoulderAvg
  ) return 'bearish';
  return 'none';
}

/** signal_engine.dart:3820 */
export function inverseHeadAndShoulders(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 30) return 'none';
  const { l } = swingPoints(candles, 60, 2);
  if (l.length < 3) return 'none';
  const left = l[l.length - 3]!, head = l[l.length - 2]!, right = l[l.length - 1]!;
  const shoulderAvg = (left + right) / 2;
  if (
    head < left * 0.998 && head < right * 0.998 &&
    Math.abs(left - right) < shoulderAvg * 0.003 &&
    currentPrice > shoulderAvg
  ) return 'bullish';
  return 'none';
}

/** signal_engine.dart:3834 */
export function ascendingTriangle(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, 30, 2);
  if (h.length < 2 || l.length < 2) return 'none';
  const [h1, h2] = last2(h);
  const [l1, l2] = last2(l);
  return Math.abs(h1 - h2) < 0.0015 && l1 > l2 && currentPrice > h1 ? 'bullish' : 'none';
}

/** signal_engine.dart:3846 */
export function descendingTriangle(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, 30, 2);
  if (h.length < 2 || l.length < 2) return 'none';
  const [h1, h2] = last2(h);
  const [l1, l2] = last2(l);
  return Math.abs(l1 - l2) < 0.0015 && h1 < h2 && currentPrice < l1 ? 'bearish' : 'none';
}

/** signal_engine.dart:3858 */
export function symmetricalTriangle(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, 30, 2);
  if (h.length < 2 || l.length < 2) return 'none';
  const [h1, h2] = last2(h);
  const [l1, l2] = last2(l);
  if (!(h1 < h2) || !(l1 > l2)) return 'none';
  if (currentPrice > h1) return 'bullish';
  if (currentPrice < l1) return 'bearish';
  return 'none';
}

/** signal_engine.dart:3872 — a rising wedge resolves BEARISH, and vice versa. */
export function wedge(candles: readonly Candle[], currentPrice: number, rising: boolean): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, 30, 2);
  if (h.length < 2 || l.length < 2) return 'none';
  const [h1, h2] = last2(h);
  const [l1, l2] = last2(l);
  if (rising) {
    if (h1 > h2 && l1 > l2 && currentPrice < l1) return 'bearish';
  } else {
    if (h1 < h2 && l1 < l2 && currentPrice > h1) return 'bullish';
  }
  return 'none';
}

/** signal_engine.dart:3894 — impulse window is candles [-15, -5), consolidation is the last 5. */
export function flag(candles: readonly Candle[], currentPrice: number, bull: boolean): string {
  if (candles.length < 15) return 'none';
  const avg = avgBodySize(candles);
  const first5 = candles.slice(Math.max(0, candles.length - 15), candles.length - 5);
  const last5 = candles.slice(candles.length - 5);

  const impulse = bull
    ? first5[first5.length - 1]!.close - first5[0]!.close
    : first5[0]!.close - first5[first5.length - 1]!.close;
  const hi = Math.max(...last5.map((c) => c.high));
  const lo = Math.min(...last5.map((c) => c.low));
  const consol = hi - lo;

  if (impulse > avg * 5 && consol < impulse * 0.4) {
    if (bull && currentPrice > hi) return 'bullish';
    if (!bull && currentPrice < lo) return 'bearish';
  }
  return 'none';
}

/** signal_engine.dart:3920 */
export function channel(candles: readonly Candle[], up: boolean): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, 30, 2);
  if (h.length < 2 || l.length < 2) return 'none';
  const [h1, h2] = last2(h);
  const [l1, l2] = last2(l);
  if (up) { if (h1 > h2 && l1 > l2) return 'bullish'; }
  else { if (h1 < h2 && l1 < l2) return 'bearish'; }
  return 'none';
}

/** signal_engine.dart — `_detectRectangle` (wider 0.0020 tolerance than the triangles). */
export function rectangle(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, 30, 2);
  if (h.length < 2 || l.length < 2) return 'none';
  const tol = 0.0020;
  const [h1, h2] = last2(h);
  const [l1, l2] = last2(l);
  if (!(Math.abs(h1 - h2) < tol) || !(Math.abs(l1 - l2) < tol)) return 'none';
  if (currentPrice > h1) return 'bullish';
  if (currentPrice < l1) return 'bearish';
  return 'none';
}

// ── Registrations ───────────────────────────────────────────────────────────

register('candle_pattern', ({ candles }) => candlePatterns(candles));
register('double_top', ({ candles, currentPrice }) => doubleTop(candles, currentPrice));
register('double_bottom', ({ candles, currentPrice }) => doubleBottom(candles, currentPrice));
register('head_and_shoulders', ({ candles, currentPrice }) =>
  headAndShoulders(candles, currentPrice),
);
register('inverse_head_and_shoulders', ({ candles, currentPrice }) =>
  inverseHeadAndShoulders(candles, currentPrice),
);
register('ascending_triangle', ({ candles, currentPrice }) => ascendingTriangle(candles, currentPrice));
register('descending_triangle', ({ candles, currentPrice }) =>
  descendingTriangle(candles, currentPrice),
);
register('symmetrical_triangle', ({ candles, currentPrice }) =>
  symmetricalTriangle(candles, currentPrice),
);
register('rising_wedge', ({ candles, currentPrice }) => wedge(candles, currentPrice, true));
register('falling_wedge', ({ candles, currentPrice }) => wedge(candles, currentPrice, false));
register('channel_up', ({ candles }) => channel(candles, true));
register('channel_down', ({ candles }) => channel(candles, false));

// Dart reuses two detectors under a second name each: `pennant` is the
// symmetrical triangle, `horizontal_channel` is the rectangle.
register(['rectangle', 'horizontal_channel'], ({ candles, currentPrice }) =>
  rectangle(candles, currentPrice),
);
register('pennant', ({ candles, currentPrice }) => symmetricalTriangle(candles, currentPrice));
