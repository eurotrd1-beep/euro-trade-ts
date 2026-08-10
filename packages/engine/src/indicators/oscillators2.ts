/**
 * Extended trend, oscillator and volatility indicators — batch 7.
 * Ported literally from signal_engine.dart.
 */

import { register } from '../registry.js';
import type { Candle } from '../types.js';
import * as m from './math.js';

const idiv = (a: number, b: number): number => Math.trunc(a / b);

/** signal_engine.dart:4634 — bands seeded at 0, so early bars compare against 0. */
export function superTrend(
  candles: readonly Candle[],
  currentPrice: number,
  period = 10,
  mult = 3.0,
): string {
  if (candles.length < period + 1) return 'none';
  const atrVal = m.atr(candles, period, currentPrice);
  let upB = 0, dnB = 0, bull = true;
  for (let i = Math.max(1, candles.length - period * 2); i < candles.length; i++) {
    const hl2 = (candles[i]!.high + candles[i]!.low) / 2;
    const up = hl2 + mult * atrVal, dn = hl2 - mult * atrVal;
    upB = up < upB || candles[i - 1]!.close > upB ? up : upB;
    dnB = dn > dnB || candles[i - 1]!.close < dnB ? dn : dnB;
    bull = candles[i]!.close > upB ? true : candles[i]!.close < dnB ? false : bull;
  }
  return bull ? 'bullish' : 'bearish';
}

/** signal_engine.dart:4657 — Tenkan/Kijun/Senkou with no forward displacement. */
export function ichimoku(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 52) return 'none';
  const midOf = (n: number): number => {
    const sub = candles.slice(Math.max(0, candles.length - n));
    return (Math.max(...sub.map((c) => c.high)) + Math.min(...sub.map((c) => c.low))) / 2;
  };
  const tenkan = midOf(9);
  const kijun = midOf(26);
  const senkouB = midOf(52);
  const senkouA = (tenkan + kijun) / 2;
  const cloudH = Math.max(senkouA, senkouB), cloudL = Math.min(senkouA, senkouB);

  if (currentPrice > cloudH && tenkan > kijun) return 'strong_bullish';
  if (currentPrice < cloudL && tenkan < kijun) return 'strong_bearish';
  if (currentPrice > cloudH) return 'bullish';
  if (currentPrice < cloudL) return 'bearish';
  return 'in_cloud';
}

/** signal_engine.dart:4805 — 7/14/28 weighted 4:2:1. */
export function ultimateOscillator(candles: readonly Candle[]): number {
  if (candles.length < 29) return 50;
  let bp7 = 0, tr7 = 0, bp14 = 0, tr14 = 0, bp28 = 0, tr28 = 0;
  const n = Math.min(28, candles.length - 1);
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    const bp = c.close - Math.min(c.low, p.close);
    const tr = Math.max(c.high, p.close) - Math.min(c.low, p.close);
    const pos = candles.length - i;
    if (pos <= 7) { bp7 += bp; tr7 += tr; }
    if (pos <= 14) { bp14 += bp; tr14 += tr; }
    bp28 += bp; tr28 += tr;
  }
  return (
    (100 *
      (4 * (tr7 > 0 ? bp7 / tr7 : 0.5) +
        2 * (tr14 > 0 ? bp14 / tr14 : 0.5) +
        (tr28 > 0 ? bp28 / tr28 : 0.5))) /
    7
  );
}

/** signal_engine.dart:4832 — single-pass EMA smoothing, alpha 2/14. */
export function tsi(candles: readonly Candle[]): number {
  if (candles.length < 26) return 0;
  const n = Math.min(25, candles.length - 1);
  let ema1 = 0, aem1 = 0;
  const alpha = 2.0 / 14;
  for (let i = candles.length - n; i < candles.length; i++) {
    const mom = candles[i]!.close - candles[i - 1]!.close;
    ema1 = alpha * mom + (1 - alpha) * ema1;
    aem1 = alpha * Math.abs(mom) + (1 - alpha) * aem1;
  }
  return aem1 > 0 ? (100 * ema1) / aem1 : 0;
}

/** signal_engine.dart:4845 */
export function fisherTransform(
  candles: readonly Candle[],
  period: number,
  currentPrice: number,
): number {
  const n = Math.min(period, candles.length);
  const sub = candles.slice(candles.length - n);
  const hi = Math.max(...sub.map((c) => c.high));
  const lo = Math.min(...sub.map((c) => c.low));
  const range = hi - lo;
  if (range < 0.0001) return 0;
  const v = m.clamp(2 * ((currentPrice - lo) / range) - 1, -0.999, 0.999);
  return 0.5 * Math.log((1 + v) / (1 - v));
}

/** signal_engine.dart:4901 */
export function ppo(candles: readonly Candle[], currentPrice: number): number {
  const e26 = m.ema(candles, Math.min(26, candles.length), currentPrice);
  return e26 > 0
    ? ((m.ema(candles, Math.min(12, candles.length), currentPrice) - e26) / e26) * 100
    : 0;
}

/** signal_engine.dart:4908 — EMA(p) vs EMA(p/2), not a triple-smoothed ROC. */
export function trix(candles: readonly Candle[], p: number, currentPrice: number): number {
  const e = m.ema(candles, p, currentPrice);
  const e2 = m.ema(candles, Math.max(1, idiv(p, 2)), currentPrice);
  return e2 > 0 ? ((e - e2) / e2) * 100 : 0;
}

/** signal_engine.dart:4913 — weighted sum of four ROCs, unsmoothed. */
export function kst(candles: readonly Candle[], currentPrice: number): number {
  return (
    m.roc(candles, 10, currentPrice) +
    m.roc(candles, 15, currentPrice) * 2 +
    m.roc(candles, 20, currentPrice) * 3 +
    m.roc(candles, 30, currentPrice) * 4
  );
}

/** signal_engine.dart:4919 — detrended price oscillator. */
export function dpo(candles: readonly Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  const shift = idiv(period, 2) + 1;
  const refIdx = candles.length - 1 - shift;
  if (refIdx < 0) return 0;
  const n = Math.min(period, refIdx + 1);
  let sum = 0;
  for (let i = refIdx - n + 1; i <= refIdx; i++) sum += candles[i]!.close;
  return candles[refIdx]!.close - sum / n;
}

/** signal_engine.dart:4961 — EMA(20) ± 2 × ATR(10). */
export function keltnerChannel(candles: readonly Candle[], currentPrice: number): string {
  const mid = m.ema(candles, Math.min(20, candles.length), currentPrice);
  const a = m.atr(candles, 10, currentPrice);
  if (currentPrice > mid + 2 * a) return 'above_upper';
  if (currentPrice < mid - 2 * a) return 'below_lower';
  if (currentPrice > mid) return 'upper_half';
  return 'lower_half';
}

/** signal_engine.dart:4970 */
export function donchianChannel(
  candles: readonly Candle[],
  period: number,
  currentPrice: number,
): string {
  const n = Math.min(period, candles.length);
  const sub = candles.slice(candles.length - n);
  const hi = Math.max(...sub.map((c) => c.high));
  const lo = Math.min(...sub.map((c) => c.low));
  if (currentPrice >= hi) return 'at_upper';
  if (currentPrice <= lo) return 'at_lower';
  return 'inside';
}

/** signal_engine.dart:4985 — double-smoothed range ratio, alpha 2/10. */
export function massIndex(candles: readonly Candle[], period: number): number {
  if (candles.length < period + 9) return 25;
  const seed = candles[candles.length - period - 9]!;
  let e1 = seed.high - seed.low;
  let e2 = e1;
  let mi = 0;
  const alpha = 2.0 / 10;
  for (let i = candles.length - period; i < candles.length; i++) {
    e1 = alpha * (candles[i]!.high - candles[i]!.low) + (1 - alpha) * e1;
    e2 = alpha * e1 + (1 - alpha) * e2;
    if (e2 > 0) mi += e1 / e2;
  }
  return mi;
}

// ── Registrations ───────────────────────────────────────────────────────────

// Dart: _detectSuperTrend(period: r.period, mult: r.value ?? 3.0) — the rule
// drives both, so the 10/3.0 defaults in the function signature are never used
// by the dispatch path.
register('supertrend', ({ candles, currentPrice, rule }) =>
  superTrend(candles, currentPrice, rule.period, rule.value ?? 3.0),
);
register('ichimoku', ({ candles, currentPrice }) => ichimoku(candles, currentPrice));
register('ultimate_oscillator', ({ candles }) => ultimateOscillator(candles));
register('tsi', ({ candles }) => tsi(candles));
register('fisher_transform', ({ candles, rule, currentPrice }) =>
  fisherTransform(candles, rule.period, currentPrice),
);
register('ppo', ({ candles, currentPrice }) => ppo(candles, currentPrice));
register('trix', ({ candles, rule, currentPrice }) => trix(candles, rule.period, currentPrice));
register('kst', ({ candles, currentPrice }) => kst(candles, currentPrice));
register('dpo', ({ candles, rule }) => dpo(candles, rule.period));
register('keltner_channel', ({ candles, currentPrice }) => keltnerChannel(candles, currentPrice));
register('donchian_channel', ({ candles, rule, currentPrice }) =>
  donchianChannel(candles, rule.period, currentPrice),
);
register('mass_index', ({ candles, rule }) => massIndex(candles, rule.period));
