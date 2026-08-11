/**
 * Price-action, Wyckoff, market-profile and pivot extensions — batch 8.
 * Ported literally from signal_engine.dart.
 */

import { register } from '../registry.js';
import type { Candle } from '../types.js';
import * as m from './math.js';
import { avgBodySize, swingPoints } from './patterns.js';
import { liquiditySweep, volumeProfileStats, wyckoffSpring, wyckoffUpthrust } from './structure.js';
import { expansion } from './ict.js';

// ── Volume ──────────────────────────────────────────────────────────────────

/** signal_engine.dart:5078 — Positive Volume Index, base 1000. */
export function pvi(candles: readonly Candle[]): number {
  let value = 1000;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.volume > candles[i - 1]!.volume) {
      value += (value * (candles[i]!.close - candles[i - 1]!.close)) / candles[i - 1]!.close;
    }
  }
  return value;
}

/** signal_engine.dart:5091 */
export function volumeOscillator(candles: readonly Candle[], fast: number, slow: number): number {
  if (candles.length < slow) return 0;
  let sf = 0, ss = 0;
  for (let i = candles.length - fast; i < candles.length; i++) sf += candles[i]!.volume;
  for (let i = candles.length - slow; i < candles.length; i++) ss += candles[i]!.volume;
  const avgFast = sf / fast, avgSlow = ss / slow;
  return avgSlow > 0 ? ((avgFast - avgSlow) / avgSlow) * 100 : 0;
}

// ── Price action ────────────────────────────────────────────────────────────

/** signal_engine.dart:5108 — checks only the bar 3 from the end. */
export function fractals(candles: readonly Candle[]): string {
  if (candles.length < 5) return 'none';
  const i = candles.length - 3;
  const c = candles[i]!;
  if (
    c.high > candles[i - 1]!.high && c.high > candles[i - 2]!.high &&
    c.high > candles[i + 1]!.high && c.high > candles[i + 2]!.high
  ) return 'bearish_fractal';
  if (
    c.low < candles[i - 1]!.low && c.low < candles[i - 2]!.low &&
    c.low < candles[i + 1]!.low && c.low < candles[i + 2]!.low
  ) return 'bullish_fractal';
  return 'none';
}

/** signal_engine.dart:5127 */
export function insideBar(candles: readonly Candle[]): string {
  if (candles.length < 2) return 'none';
  const c = candles[candles.length - 1]!, p = candles[candles.length - 2]!;
  if (c.high < p.high && c.low > p.low) return c.close > c.open ? 'bullish' : 'bearish';
  return 'none';
}

/** signal_engine.dart:5135 */
export function outsideBar(candles: readonly Candle[]): string {
  if (candles.length < 2) return 'none';
  const c = candles[candles.length - 1]!, p = candles[candles.length - 2]!;
  if (c.high > p.high && c.low < p.low) return c.close > c.open ? 'bullish' : 'bearish';
  return 'none';
}

/** signal_engine.dart:5143 — inside bar, then a false break of the mother bar. */
export function fakeyPattern(candles: readonly Candle[]): string {
  if (candles.length < 4) return 'none';
  const c0 = candles[candles.length - 1]!;
  const c1 = candles[candles.length - 2]!;
  const c2 = candles[candles.length - 3]!;
  if (!(c1.high < c2.high && c1.low > c2.low)) return 'none';
  if (c0.high > c2.high && c0.close < c2.high) return 'bearish';
  if (c0.low < c2.low && c0.close > c2.low) return 'bullish';
  return 'none';
}

// ── ICT extended ────────────────────────────────────────────────────────────

/** signal_engine.dart:5158 */
export function powerOfThree(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 15) return 'none';
  const sweep = liquiditySweep(candles, currentPrice);
  const exp = expansion(candles, currentPrice);
  if (sweep === 'sell_side' && exp === 'bullish') return 'distribution_bullish';
  if (sweep === 'buy_side' && exp === 'bearish') return 'distribution_bearish';
  if (m.atr(candles, 5, currentPrice) < m.atr(candles, 14, currentPrice) * 0.7) return 'accumulation';
  return 'none';
}

/** signal_engine.dart:5167 — a 20-bar range broken then reclaimed. */
export function turtleSoup(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 22) return 'none';
  const ref = candles.slice(candles.length - 22, candles.length - 2);
  const rH = Math.max(...ref.map((c) => c.high));
  const rL = Math.min(...ref.map((c) => c.low));
  const l2 = candles.slice(candles.length - 2);
  if (l2.some((c) => c.high > rH) && currentPrice < rH) return 'bearish';
  if (l2.some((c) => c.low < rL) && currentPrice > rL) return 'bullish';
  return 'none';
}

/** signal_engine.dart:5178 — change in state of delivery. */
export function cisd(candles: readonly Candle[]): string {
  if (candles.length < 5) return 'none';
  const c = candles[candles.length - 1]!;
  if (Math.abs(c.close - c.open) < avgBodySize(candles) * 2.5) return 'none';
  const { h, l } = swingPoints(candles, 10, 1);
  if (c.close > c.open && h.length && c.close > h[h.length - 1]!) return 'bullish';
  if (c.close < c.open && l.length && c.close < l[l.length - 1]!) return 'bearish';
  return 'none';
}

/** signal_engine.dart:5192 — price at the midpoint of a fair value gap. */
export function consequentEncroachment(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 5) return 'none';
  for (let i = candles.length - 1; i >= 2; i--) {
    const c1 = candles[i - 2]!, c3 = candles[i]!;
    if (c3.low > c1.high) {
      const ce = (c3.low + c1.high) / 2;
      if (Math.abs(currentPrice - ce) < (c3.low - c1.high) * 0.1) return 'bullish_ce';
    }
    if (c3.high < c1.low) {
      const ce = (c1.low + c3.high) / 2;
      if (Math.abs(currentPrice - ce) < (c1.low - c3.high) * 0.1) return 'bearish_ce';
    }
  }
  return 'none';
}

/** signal_engine.dart:5212 */
export function inducement(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 15) return 'none';
  const { h, l } = swingPoints(candles, 15, 1);
  const atr5 = m.atr(candles, 5, currentPrice);
  if (h.length >= 2 && l.length) {
    if (h[h.length - 1]! < h[h.length - 2]! && Math.abs(currentPrice - h[h.length - 1]!) < atr5) {
      return 'inducement_high';
    }
  }
  if (l.length >= 2 && h.length) {
    if (l[l.length - 1]! > l[l.length - 2]! && Math.abs(currentPrice - l[l.length - 1]!) < atr5) {
      return 'inducement_low';
    }
  }
  return 'none';
}

// ── Wyckoff phases ──────────────────────────────────────────────────────────

/** signal_engine.dart:5237 — first matching phase wins; order is load-bearing. */
export function wyckoffPhase(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 30) return 'none';
  const { h: highs, l: lows } = swingPoints(candles, 40, 2);
  if (highs.length < 2 || lows.length < 2) return 'none';

  const isDown =
    highs[highs.length - 1]! < highs[highs.length - 2]! &&
    lows[lows.length - 1]! < lows[lows.length - 2]!;
  const isUp =
    highs[highs.length - 1]! > highs[highs.length - 2]! &&
    lows[lows.length - 1]! > lows[lows.length - 2]!;

  const vr = volumeProfileStats(candles).ratio;
  const atrR = m.atr(candles, 5, currentPrice) / m.atr(candles, 20, currentPrice);
  const last = candles[candles.length - 1]!;
  const lastClose = last.close;
  const lastHL = (last.high + last.low) / 2;

  if (isDown && vr > 2.0 && atrR > 1.5 && lastClose > lastHL) return 'sc';
  if (isDown && lastClose > candles[candles.length - 3]!.close * 1.005) return 'ar';
  if (wyckoffSpring(candles, currentPrice) === 'bullish') return 'spring_test';
  if (!isDown && isUp && vr > 1.5) return 'sos';
  if (isUp && atrR < 0.7) return 'lps';
  if (isUp && vr > 2.0 && atrR > 1.5 && lastClose < lastHL) return 'bc';
  if (wyckoffUpthrust(candles, currentPrice) === 'bearish') return 'utad';
  if (vr < 0.7) return 'st';
  if (isDown && vr > 1.2) return 'ps';
  return 'none';
}

// ── Market profile ──────────────────────────────────────────────────────────

/** signal_engine.dart:5270 — 10 volume buckets over the last 50 candles. */
export function marketProfile(
  candles: readonly Candle[],
  currentPrice: number,
): { poc: number; vah: number; val: number } {
  const lb = Math.min(50, candles.length);
  const sub = candles.slice(candles.length - lb);
  const hi = Math.max(...sub.map((c) => c.high));
  const lo = Math.min(...sub.map((c) => c.low));
  const range = hi - lo;
  if (range < 0.0001) return { poc: currentPrice, vah: currentPrice, val: currentPrice };

  const buckets = new Array<number>(10).fill(0);
  for (const c of sub) {
    // Dart's `round()` is half-away-from-zero; these values are non-negative
    // after the clamp, so Math.round matches.
    const idx = m.clamp(Math.round(((c.close - lo) / range) * 9), 0, 9);
    buckets[idx] = buckets[idx]! + c.volume;
  }

  let pocB = 0;
  for (let i = 1; i < 10; i++) if (buckets[i]! > buckets[pocB]!) pocB = i;

  const poc = lo + (pocB / 9) * range;
  const tot = buckets.reduce((a, b) => a + b, 0);
  let acc = buckets[pocB]!;
  let lB = pocB, hB = pocB;

  // Grow the value area outward until it holds 70% of volume.
  while (acc < tot * 0.7 && (lB > 0 || hB < 9)) {
    const aH = hB < 9 ? buckets[hB + 1]! : 0;
    const aL = lB > 0 ? buckets[lB - 1]! : 0;
    if (aH >= aL && hB < 9) { hB++; acc += buckets[hB]!; }
    else if (lB > 0) { lB--; acc += buckets[lB]!; }
    else hB++;
  }

  return { poc, vah: lo + (hB / 9) * range, val: lo + (lB / 9) * range };
}

/** signal_engine.dart:5306 */
export function marketProfileZone(candles: readonly Candle[], currentPrice: number): string {
  const mp = marketProfile(candles, currentPrice);
  if (currentPrice > mp.vah) return 'above_vah';
  if (currentPrice < mp.val) return 'below_val';
  if (Math.abs(currentPrice - mp.poc) < m.atr(candles, 5, currentPrice)) return 'at_poc';
  return currentPrice > mp.poc ? 'above_poc' : 'below_poc';
}

// ── Pivot systems ───────────────────────────────────────────────────────────

/** signal_engine.dart:5318 — Camarilla, built off close ± range × 1.1. */
export function camarillaPivot(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 2) return 'none';
  const c = candles[candles.length - 2]!;
  const r = c.high - c.low;
  const h4 = c.close + (r * 1.1) / 2, h3 = c.close + (r * 1.1) / 4;
  const l3 = c.close - (r * 1.1) / 4, l4 = c.close - (r * 1.1) / 2;
  if (currentPrice > h4) return 'above_h4';
  if (currentPrice < l4) return 'below_l4';
  if (currentPrice > h3) return 'above_h3';
  if (currentPrice < l3) return 'below_l3';
  return 'inside';
}

/** signal_engine.dart:5332 — Woodie's pivot weights the close double. */
export function woodiePivot(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 2) return 'none';
  const c = candles[candles.length - 2]!;
  const p = (c.high + c.low + 2 * c.close) / 4;
  const r1 = 2 * p - c.low, s1 = 2 * p - c.high;
  if (currentPrice > r1) return 'above_r1';
  if (currentPrice < s1) return 'below_s1';
  return currentPrice > p ? 'above_p' : 'below_p';
}

/** signal_engine.dart:5343 */
export function fibPivot(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 2) return 'none';
  const c = candles[candles.length - 2]!;
  const p = (c.high + c.low + c.close) / 3;
  const r = c.high - c.low;
  const r2 = p + 0.618 * r, r1 = p + 0.382 * r;
  const s1 = p - 0.382 * r, s2 = p - 0.618 * r;
  if (currentPrice > r2) return 'above_r2';
  if (currentPrice < s2) return 'below_s2';
  if (currentPrice > r1) return 'above_r1';
  if (currentPrice < s1) return 'below_s1';
  return currentPrice > p ? 'above_p' : 'below_p';
}

// ── Chart patterns extended ─────────────────────────────────────────────────

/** signal_engine.dart:5362 — diverging swings; breakouts read as reversals. */
export function broadeningWedge(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, 30, 2);
  if (h.length < 2 || l.length < 2) return 'none';
  if (h[h.length - 1]! > h[h.length - 2]! && l[l.length - 1]! < l[l.length - 2]!) {
    if (currentPrice > h[h.length - 1]!) return 'bearish';
    if (currentPrice < l[l.length - 1]!) return 'bullish';
    return 'active';
  }
  return 'none';
}

/** signal_engine.dart:5375 — gap away then gap back, leaving an island. */
export function islandReversal(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 6) return 'none';
  const a = m.atr(candles, 14, currentPrice);
  for (let i = 2; i < candles.length - 2; i++) {
    if (
      candles[i]!.low > candles[i - 1]!.high + a * 0.5 &&
      candles[i + 1]!.high < candles[i]!.low - a * 0.5
    ) return 'bearish';
    if (
      candles[i]!.high < candles[i - 1]!.low - a * 0.5 &&
      candles[i + 1]!.low > candles[i]!.high + a * 0.5
    ) return 'bullish';
  }
  return 'none';
}

/** signal_engine.dart:5391 — broadening then narrowing swings. */
export function diamondPattern(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 30) return 'none';
  const { h, l } = swingPoints(candles, 30, 2);
  if (h.length < 4 || l.length < 4) return 'none';
  if (
    h[h.length - 3]! > h[h.length - 4]! && l[l.length - 3]! < l[l.length - 4]! &&
    h[h.length - 1]! < h[h.length - 2]! && l[l.length - 1]! > l[l.length - 2]!
  ) {
    if (currentPrice > h[h.length - 1]!) return 'bullish';
    if (currentPrice < l[l.length - 1]!) return 'bearish';
  }
  return 'none';
}

/** signal_engine.dart:5406 */
export function roundingPattern(
  candles: readonly Candle[],
  currentPrice: number,
  bottom: boolean,
): string {
  if (candles.length < 20) return 'none';
  const n = Math.min(20, candles.length);
  const sub = candles.slice(candles.length - n);
  const first = sub[0]!.close, last = sub[sub.length - 1]!.close;
  const extreme = bottom
    ? Math.min(...sub.map((c) => c.low))
    : Math.max(...sub.map((c) => c.high));

  if (bottom && extreme < first * 0.998 && extreme < last * 0.998 && currentPrice > last) {
    return 'bullish';
  }
  if (!bottom && extreme > first * 1.002 && extreme > last * 1.002 && currentPrice < last) {
    return 'bearish';
  }
  return 'none';
}

// ── Time / Gann ─────────────────────────────────────────────────────────────

/** signal_engine.dart:5433 */
export function openingGap(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 2) return 'none';
  const a = m.atr(candles, 14, currentPrice);
  const gap = candles[candles.length - 1]!.open - candles[candles.length - 2]!.close;
  if (gap > a * 0.5) return 'gap_up';
  if (gap < -a * 0.5) return 'gap_down';
  return 'none';
}

/** signal_engine.dart:5442 — candle count modulo 90 landing on a Fibonacci number. */
export function fibTimeZone(candles: readonly Candle[]): string {
  const fibs = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
  return fibs.includes(candles.length % 90) ? 'fib_zone' : 'none';
}

/** signal_engine.dart:5451 — measured from the LOW of the reference bar. */
export function gannFan(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 10) return 'none';
  const n = Math.min(10, candles.length - 1);
  const pips = (currentPrice - candles[candles.length - 1 - n]!.low) / n;
  const a = m.atr(candles, 14, currentPrice);
  if (Math.abs(pips) >= a * 0.8 && Math.abs(pips) <= a * 1.2) return 'on_1x1';
  if (pips > a * 1.2) return 'above_1x1';
  if (pips > 0) return 'below_1x1';
  return 'none';
}

// ── Registrations ───────────────────────────────────────────────────────────

register('fractals', ({ candles }) => fractals(candles));
register('inside_bar', ({ candles }) => insideBar(candles));
register('outside_bar', ({ candles }) => outsideBar(candles));
register(['fakey', 'inside_bar_fakey'], ({ candles }) => fakeyPattern(candles));
register(['po3', 'power_of_three', 'amd_cycle'], ({ candles, currentPrice }) =>
  powerOfThree(candles, currentPrice),
);
register('turtle_soup', ({ candles, currentPrice }) => turtleSoup(candles, currentPrice));
register('cisd', ({ candles }) => cisd(candles));
register(['ce', 'consequent_encroachment'], ({ candles, currentPrice }) =>
  consequentEncroachment(candles, currentPrice),
);
register('inducement', ({ candles, currentPrice }) => inducement(candles, currentPrice));

register('poc', ({ candles, currentPrice }) => marketProfile(candles, currentPrice).poc);
register('vah', ({ candles, currentPrice }) => marketProfile(candles, currentPrice).vah);
register('val', ({ candles, currentPrice }) => marketProfile(candles, currentPrice).val);
register(['market_profile', 'tpo'], ({ candles, currentPrice }) =>
  marketProfileZone(candles, currentPrice),
);

register(['camarilla', 'camarilla_pivot'], ({ candles, currentPrice }) =>
  camarillaPivot(candles, currentPrice),
);
register(['woodie', 'woodie_pivot'], ({ candles, currentPrice }) =>
  woodiePivot(candles, currentPrice),
);
register(['fib_pivot', 'fibonacci_pivot'], ({ candles, currentPrice }) =>
  fibPivot(candles, currentPrice),
);

register(['broadening_wedge', 'megaphone'], ({ candles, currentPrice }) =>
  broadeningWedge(candles, currentPrice),
);
register(['diamond', 'diamond_top'], ({ candles, currentPrice }) =>
  diamondPattern(candles, currentPrice),
);

register('opening_gap', ({ candles, currentPrice }) => openingGap(candles, currentPrice));
register(['fib_time', 'fibonacci_time_zone'], ({ candles }) => fibTimeZone(candles));
register('gann_fan', ({ candles, currentPrice }) => gannFan(candles, currentPrice));
