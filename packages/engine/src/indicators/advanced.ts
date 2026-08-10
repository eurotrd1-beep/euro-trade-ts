/**
 * Advanced moving averages, oscillators, volatility and volume — batch 4.
 *
 * Ported literally from signal_engine.dart. Dart's `~/` (truncating integer
 * division) becomes `Math.trunc(a / b)`; `pow(x, 2)` becomes `x ** 2`.
 *
 * Several of these are documented in the Dart source as approximations
 * ("Approximate SMA of AO…", "simplified"). The approximations are the shipped
 * behaviour and are reproduced unchanged.
 */

import { register } from '../registry.js';
import type { Candle } from '../types.js';
import * as m from './math.js';

const idiv = (a: number, b: number): number => Math.trunc(a / b);

// ── Moving averages ─────────────────────────────────────────────────────────

/** signal_engine.dart:4696 — linearly weighted, newest candle heaviest. */
export function wma(candles: readonly Candle[], period: number, currentPrice: number): number {
  const n = Math.min(period, candles.length);
  let sum = 0, wt = 0;
  for (let i = 0; i < n; i++) {
    const w = n - i;
    sum += candles[candles.length - 1 - i]!.close * w;
    wt += w;
  }
  return wt > 0 ? sum / wt : currentPrice;
}

/** signal_engine.dart:4707 — note: no final WMA(sqrt(n)) smoothing pass. */
export function hma(candles: readonly Candle[], period: number, currentPrice: number): number {
  return 2 * wma(candles, Math.max(1, idiv(period, 2)), currentPrice) - wma(candles, period, currentPrice);
}

/** signal_engine.dart:4711 — uses EMA(p/2) rather than an EMA of the EMA. */
export function dema(candles: readonly Candle[], p: number, currentPrice: number): number {
  return 2 * m.ema(candles, p, currentPrice) - m.ema(candles, Math.max(1, idiv(p, 2)), currentPrice);
}

/** signal_engine.dart:4713 */
export function tema(candles: readonly Candle[], p: number, currentPrice: number): number {
  return (
    3 * m.ema(candles, p, currentPrice) -
    3 * m.ema(candles, Math.max(1, idiv(p, 2)), currentPrice) +
    m.ema(candles, Math.max(1, idiv(p, 3)), currentPrice)
  );
}

/** signal_engine.dart:4718 — Arnaud Legoux, sigma 6, offset 0.85. */
export function alma(candles: readonly Candle[], period: number, currentPrice: number): number {
  if (candles.length < period) return currentPrice;
  const sigma = 6.0, offset = 0.85;
  const mu = offset * (period - 1);
  const s = period / sigma;
  let sum = 0, wt = 0;
  for (let i = 0; i < period; i++) {
    const w = Math.exp(-((i - mu) ** 2) / (2 * s * s));
    sum += candles[candles.length - period + i]!.close * w;
    wt += w;
  }
  return wt > 0 ? sum / wt : currentPrice;
}

/** signal_engine.dart:4554 — Kaufman adaptive, fast 2/3, slow 2/31. */
export function kama(candles: readonly Candle[], period: number, currentPrice: number): number {
  if (candles.length < period + 1) return currentPrice;
  const fastSc = 2.0 / 3, slowSc = 2.0 / 31;
  const closes = candles.map((c) => c.close);
  const n = Math.min(period, closes.length - 1);
  let value = closes[closes.length - 1 - n]!;

  for (let i = closes.length - n; i < closes.length; i++) {
    let noise = 0;
    for (let j = i - Math.min(n, i); j < i; j++) noise += Math.abs(closes[j + 1]! - closes[j]!);
    const er = noise > 0 ? Math.abs(closes[i]! - closes[i - Math.min(n, i)]!) / noise : 0.0;
    const sc = (er * (fastSc - slowSc) + slowSc) ** 2;
    value += sc * (closes[i]! - value);
  }
  return value;
}

/** signal_engine.dart:4576 — T3 with vFactor 0.7, built from EMA(p), EMA(p/2), EMA(p/3), EMA(p/4). */
export function t3(candles: readonly Candle[], period: number, currentPrice: number): number {
  const vf = 0.7;
  const c1 = -(vf * vf * vf);
  const c2 = 3 * vf * vf + 3 * vf * vf * vf;
  const c3 = -6 * vf * vf - 3 * vf - 3 * vf * vf * vf;
  const c4 = 1 + 3 * vf + vf * vf * vf + 3 * vf * vf;
  const e1 = m.ema(candles, period, currentPrice);
  const e2 = m.ema(candles, Math.max(1, idiv(period, 2)), currentPrice);
  const e3 = m.ema(candles, Math.max(1, idiv(period, 3)), currentPrice);
  const e4 = m.ema(candles, Math.max(1, idiv(period, 4)), currentPrice);
  return c4 * e1 + c3 * e2 + c2 * e3 + c1 * e4;
}

/** signal_engine.dart:4733 — value of the fitted line at the newest bar. */
export function linearRegression(
  candles: readonly Candle[],
  period: number,
  currentPrice: number,
): number {
  const n = Math.min(period, candles.length);
  if (n < 2) return currentPrice;
  const cl = candles.slice(candles.length - n).map((c) => c.close);
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += cl[i]!; sxy += i * cl[i]!; sx2 += i * i;
  }
  const d = n * sx2 - sx * sx;
  if (d === 0) return currentPrice;
  const slope = (n * sxy - sx * sy) / d;
  return (sy - slope * sx) / n + slope * (n - 1);
}

// ── Oscillators ─────────────────────────────────────────────────────────────

/** signal_engine.dart:4789 — Awesome Oscillator, SMA5 − SMA34 of median price. */
export function ao(candles: readonly Candle[]): number {
  if (candles.length < 34) return 0;
  let s5 = 0, s34 = 0;
  for (let i = candles.length - 5; i < candles.length; i++) s5 += (candles[i]!.high + candles[i]!.low) / 2;
  for (let i = candles.length - 34; i < candles.length; i++) s34 += (candles[i]!.high + candles[i]!.low) / 2;
  return s5 / 5 - s34 / 34;
}

/** signal_engine.dart:4610 — AO minus a 5-bar mean of AO, recomputed per bar. */
export function ac(candles: readonly Candle[]): number {
  if (candles.length < 39) return 0;
  const aoNow = ao(candles);
  let aoSum = 0;
  for (let i = 0; i < 5; i++) {
    const sub = candles.slice(0, candles.length - i);
    let s5 = 0, s34 = 0;
    for (let j = sub.length - 5; j < sub.length; j++) s5 += (sub[j]!.high + sub[j]!.low) / 2;
    for (let j = sub.length - 34; j < sub.length; j++) s34 += (sub[j]!.high + sub[j]!.low) / 2;
    aoSum += s5 / 5 - s34 / 34;
  }
  return aoNow - aoSum / 5;
}

/** signal_engine.dart:4856 — Chande Momentum Oscillator. */
export function cmo(candles: readonly Candle[], period: number): number {
  const n = Math.min(period, candles.length - 1);
  let su = 0, sd = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    if (d > 0) su += d; else sd += Math.abs(d);
  }
  return su + sd > 0 ? (100 * (su - sd)) / (su + sd) : 0;
}

/** signal_engine.dart — Relative Vigour Index, 4-bar weighted. */
export function rvi(candles: readonly Candle[], period: number): number {
  if (candles.length < period + 3) return 0;
  let ns = 0, ds = 0;
  for (let i = candles.length - period; i < candles.length - 3; i++) {
    const [a, b, c, d] = [candles[i]!, candles[i + 1]!, candles[i + 2]!, candles[i + 3]!];
    ns += (a.close - a.open) + 2 * (b.close - b.open) + 2 * (c.close - c.open) + (d.close - d.open);
    ds += (a.high - a.low) + 2 * (b.high - b.low) + 2 * (c.high - c.low) + (d.high - d.low);
  }
  return ds > 0.0001 ? ns / ds : 0;
}

/** signal_engine.dart:4933 — a simplified Connors RSI (streak RSI is a 0/100 flag). */
export function connorsRsi(candles: readonly Candle[], currentPrice: number): number {
  const rsi3 = m.rsi(candles, 3);
  const rocVal = m.roc(candles, 1, currentPrice);
  const pr =
    candles.length > 100
      ? m.clamp(
          ((currentPrice - candles[candles.length - 100]!.close) /
            candles[candles.length - 100]!.close) * 100,
          0,
          100,
        )
      : 50;
  return (rsi3 + (rocVal > 0 ? 100 : 0) + pr) / 3;
}

/** signal_engine.dart — Schaff Trend Cycle, reduced to a 3-state value. */
export function stc(candles: readonly Candle[], currentPrice: number): number {
  const macd = m.fullMacd(candles, currentPrice).macd;
  const rsiVal = m.rsi(candles, 14);
  if (macd > 0 && rsiVal > 50) return 75;
  if (macd < 0 && rsiVal < 50) return 25;
  return 50;
}

/** signal_engine.dart:4896 — Balance of Power. */
export function bop(candles: readonly Candle[]): number {
  const c = candles[candles.length - 1]!;
  const r = c.high - c.low;
  return r > 0 ? (c.close - c.open) / r : 0;
}

/** signal_engine.dart:4888 */
export function elderBullPower(candles: readonly Candle[], p: number, currentPrice: number): number {
  return candles[candles.length - 1]!.high - m.ema(candles, Math.min(p, candles.length), currentPrice);
}

/** signal_engine.dart:4890 */
export function elderBearPower(candles: readonly Candle[], p: number, currentPrice: number): number {
  return candles[candles.length - 1]!.low - m.ema(candles, Math.min(p, candles.length), currentPrice);
}

/** signal_engine.dart — Elder Force Index (single bar, not smoothed). */
export function elderForceIndex(candles: readonly Candle[]): number {
  if (candles.length <= 1) return 0;
  const last = candles[candles.length - 1]!;
  return (last.close - candles[candles.length - 2]!.close) * last.volume;
}

/** signal_engine.dart:4753 — Aroon up/down as a percentage of the window. */
export function aroon(candles: readonly Candle[], period: number): { up: number; down: number } {
  const n = Math.min(period, candles.length);
  const sub = candles.slice(candles.length - n);
  let hi = 0, li = 0;
  for (let i = 0; i < sub.length; i++) {
    if (sub[i]!.high >= sub[hi]!.high) hi = i;
    if (sub[i]!.low <= sub[li]!.low) li = i;
  }
  return { up: (hi / (n - 1)) * 100, down: (li / (n - 1)) * 100 };
}

/** signal_engine.dart:4764 */
export function vortex(candles: readonly Candle[], period: number): { plus: number; minus: number } {
  const n = Math.min(period, candles.length - 1);
  if (n < 1) return { plus: 1.0, minus: 1.0 };
  let vp = 0, vm = 0, tr = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    vp += Math.abs(c.high - p.low);
    vm += Math.abs(c.low - p.high);
    tr += Math.max(c.high, p.close) - Math.min(c.low, p.close);
  }
  return tr > 0 ? { plus: vp / tr, minus: vm / tr } : { plus: 1.0, minus: 1.0 };
}

// ── Volatility ──────────────────────────────────────────────────────────────

/** signal_engine.dart:5001 — annualised (√252) log-return stdev, as a percentage. */
export function historicalVolatility(candles: readonly Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  const rets: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    rets.push(Math.log(candles[i]!.close / candles[i - 1]!.close));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, r) => a + (r - mean) ** 2, 0);
  return Math.sqrt(v / rets.length) * Math.sqrt(252) * 100;
}

/** signal_engine.dart — Ulcer Index; the running max is seeded with the LAST close. */
export function ulcerIndex(candles: readonly Candle[], period: number): number {
  const n = Math.min(period, candles.length);
  let maxC = candles[candles.length - 1]!.close;
  let sq = 0;
  for (const c of candles.slice(candles.length - n)) {
    maxC = Math.max(maxC, c.close);
    sq += (((c.close - maxC) / maxC) * 100) ** 2;
  }
  return Math.sqrt(sq / n);
}

/** signal_engine.dart:5520 — % change between two EMAs of the high-low range. */
export function chaikinVolatility(candles: readonly Candle[], period: number): number {
  if (candles.length < period * 2) return 0;
  let ema1 = 0, ema2 = 0;
  const alpha = 2.0 / (period + 1);
  const n = Math.min(period * 2, candles.length);
  for (let i = candles.length - n; i < candles.length - period; i++) {
    ema2 = alpha * (candles[i]!.high - candles[i]!.low) + (1 - alpha) * ema2;
  }
  for (let i = candles.length - period; i < candles.length; i++) {
    ema1 = alpha * (candles[i]!.high - candles[i]!.low) + (1 - alpha) * ema1;
  }
  return ema2 > 0 ? ((ema1 - ema2) / ema2) * 100 : 0;
}

// ── Volume ──────────────────────────────────────────────────────────────────

/** signal_engine.dart:5029 — Ease of Movement; volume is scaled by 1e8. */
export function emv(candles: readonly Candle[], period: number): number {
  const n = Math.min(period, candles.length - 1);
  let s = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    const dist = (c.high + c.low) / 2 - (p.high + p.low) / 2;
    const hl = c.high - c.low;
    const box = hl > 0 ? c.volume / 1e8 / hl : 0;
    s += box > 0 ? dist / box : 0;
  }
  return s / n;
}

/** signal_engine.dart — Price Volume Trend, cumulative over the whole buffer. */
export function pvt(candles: readonly Candle[]): number {
  if (candles.length < 2) return 0;
  let value = 0;
  for (let i = 1; i < candles.length; i++) {
    value += ((candles[i]!.close - candles[i - 1]!.close) / candles[i - 1]!.close) * candles[i]!.volume;
  }
  return value;
}

/** signal_engine.dart:5054 — signed cumulative volume, scaled by two EMA factors. */
export function klinger(candles: readonly Candle[]): number {
  if (candles.length < 15) return 0;
  let kvo = 0;
  for (let i = 1; i < candles.length; i++) {
    kvo += candles[i]!.volume * (candles[i]!.close > candles[i - 1]!.close ? 1.0 : -1.0);
  }
  return (kvo * 2) / (34 + 1) - (kvo * 2) / (55 + 1);
}

/** signal_engine.dart — Negative Volume Index, base 1000. */
export function nvi(candles: readonly Candle[]): number {
  let value = 1000;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.volume < candles[i - 1]!.volume) {
      value += (value * (candles[i]!.close - candles[i - 1]!.close)) / candles[i - 1]!.close;
    }
  }
  return value;
}

// ── Trend / stops ───────────────────────────────────────────────────────────

/** signal_engine.dart — Alligator: EMA 13 / 8 / 5, unshifted. */
export function alligator(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 13) return 'sleeping';
  const jaw = m.ema(candles, Math.min(13, candles.length), currentPrice);
  const teeth = m.ema(candles, Math.min(8, candles.length), currentPrice);
  const lips = m.ema(candles, Math.min(5, candles.length), currentPrice);
  if (lips > teeth && teeth > jaw) return 'bullish';
  if (lips < teeth && teeth < jaw) return 'bearish';
  return 'sleeping';
}

/** signal_engine.dart — Chande Kroll stop, ATR(10) × 1.5 over a 9-bar window. */
export function chandeKrollStop(
  candles: readonly Candle[],
  currentPrice: number,
  atrPeriod = 10,
  mult = 1.5,
  stopPeriod = 9,
): string {
  if (candles.length < atrPeriod + stopPeriod) return 'none';
  const atrVal = m.atr(candles, atrPeriod, currentPrice);
  const sub = candles.slice(candles.length - stopPeriod);
  const hiH = Math.max(...sub.map((c) => c.high));
  const loL = Math.min(...sub.map((c) => c.low));
  const stopLong = hiH - mult * atrVal;
  const stopShort = loL + mult * atrVal;
  if (currentPrice > stopShort) return 'bullish';
  if (currentPrice < stopLong) return 'bearish';
  return 'none';
}

// ── Extended candlestick patterns ───────────────────────────────────────────

/**
 * signal_engine.dart — `_detectAdvancedCandlePattern`.
 * Thirteen indicator names share this one detector, so they all return the SAME
 * label: asking for `harami` does not filter to harami, it returns whatever
 * pattern the detector found. That is existing behaviour, preserved as-is.
 * As with the basic detector, the order of checks decides the winner.
 */
export function advancedCandlePattern(candles: readonly Candle[]): string {
  if (candles.length < 5) return 'none';
  const c0 = candles[candles.length - 1]!;
  const c1 = candles[candles.length - 2]!;
  const c2 = candles.length > 2 ? candles[candles.length - 3]! : c1;

  const range0 = c0.high - c0.low;
  const body0 = Math.abs(c0.close - c0.open);
  const upWick0 = c0.high - Math.max(c0.open, c0.close);
  const dnWick0 = Math.min(c0.open, c0.close) - c0.low;

  if (body0 < range0 * 0.1) {
    if (dnWick0 > range0 * 0.6 && upWick0 < range0 * 0.1) return 'dragonfly_doji';
    if (upWick0 > range0 * 0.6 && dnWick0 < range0 * 0.1) return 'gravestone_doji';
    if (upWick0 > range0 * 0.3 && dnWick0 > range0 * 0.3) return 'long_legged_doji';
    return 'doji';
  }

  if (body0 > range0 * 0.95) return c0.close > c0.open ? 'bullish_marubozu' : 'bearish_marubozu';
  if (body0 < range0 * 0.3 && upWick0 > body0 && dnWick0 > body0) return 'spinning_top';
  if (dnWick0 > body0 * 2 && upWick0 < body0 * 0.5 && range0 > 0.0001) {
    return c0.close > c0.open ? 'hammer' : 'hanging_man';
  }
  if (upWick0 > body0 * 2 && dnWick0 < body0 * 0.5 && range0 > 0.0001) {
    return c0.close > c0.open ? 'inverted_hammer' : 'shooting_star';
  }

  const body1 = Math.abs(c1.close - c1.open);

  if (c1.close < c1.open && c0.close > c0.open && c0.open <= c1.close && c0.close >= c1.open) {
    return 'bullish_engulfing';
  }
  if (c1.close > c1.open && c0.close < c0.open && c0.open >= c1.close && c0.close <= c1.open) {
    return 'bearish_engulfing';
  }
  if (c1.close < c1.open && c0.close > c0.open && c0.open > c1.close && c0.close < c1.open) {
    return 'bullish_harami';
  }
  if (c1.close > c1.open && c0.close < c0.open && c0.open < c1.close && c0.close > c1.open) {
    return 'bearish_harami';
  }
  if (c1.close < c1.open && body0 < body1 * 0.25 && c0.open > c1.close && c0.close < c1.open) {
    return 'bullish_harami_cross';
  }
  if (c1.close > c1.open && body0 < body1 * 0.25 && c0.open < c1.close && c0.close > c1.open) {
    return 'bearish_harami_cross';
  }
  if (
    c1.close < c1.open && c0.close > c0.open &&
    c0.open < c1.close && c0.close > (c1.open + c1.close) / 2
  ) return 'piercing_line';
  if (
    c1.close > c1.open && c0.close < c0.open &&
    c0.open > c1.close && c0.close < (c1.open + c1.close) / 2
  ) return 'dark_cloud_cover';

  if (Math.abs(c1.high - c0.high) < 0.0005 && c1.close > c1.open && c0.close < c0.open) {
    return 'tweezer_top';
  }
  if (Math.abs(c1.low - c0.low) < 0.0005 && c1.close < c1.open && c0.close > c0.open) {
    return 'tweezer_bottom';
  }

  if (candles.length >= 3) {
    const body2 = Math.abs(c2.close - c2.open);
    if (
      c2.close < c2.open && body1 < body2 * 0.3 &&
      c0.close > c0.open && c0.close > (c2.open + c2.close) / 2
    ) return 'morning_star';
    if (
      c2.close > c2.open && body1 < body2 * 0.3 &&
      c0.close < c0.open && c0.close < (c2.open + c2.close) / 2
    ) return 'evening_star';

    if (
      c2.close > c2.open && c1.close > c1.open && c0.close > c0.open &&
      c1.close > c2.close && c0.close > c1.close
    ) return 'three_white_soldiers';
    if (
      c2.close < c2.open && c1.close < c1.open && c0.close < c0.open &&
      c1.close < c2.close && c0.close < c1.close
    ) return 'three_black_crows';

    if (
      c2.close < c2.open && c1.close > c1.open &&
      c1.open > c2.close && c1.close < c2.open && c0.close > c1.close
    ) return 'three_inside_up';
    if (
      c2.close > c2.open && c1.close < c1.open &&
      c1.open < c2.close && c1.close > c2.open && c0.close < c1.close
    ) return 'three_inside_down';

    if (
      c1.close < c1.open && c0.close > c0.open &&
      c0.open >= c1.open && Math.abs(c0.open - c1.open) < 0.0002
    ) return 'bullish_kicker';
    if (
      c1.close > c1.open && c0.close < c0.open &&
      c0.open <= c1.open && Math.abs(c0.open - c1.open) < 0.0002
    ) return 'bearish_kicker';

    // Note: compares body1 against range0 (the newest candle's range), not body2.
    if (
      c2.close < c2.open && body1 < range0 * 0.1 && c0.close > c0.open &&
      c1.low > c2.low && c1.low > c0.low
    ) return 'abandoned_baby_bullish';
    if (
      c2.close > c2.open && body1 < range0 * 0.1 && c0.close < c0.open &&
      c1.high < c2.high && c1.high < c0.high
    ) return 'abandoned_baby_bearish';
  }

  return 'none';
}

// ── Registrations ───────────────────────────────────────────────────────────

register(
  ['advanced_candle', 'doji', 'dragonfly_doji', 'gravestone_doji', 'spinning_top', 'marubozu',
   'tweezer', 'harami', 'kicker', 'abandoned_baby', 'belt_hold', 'three_inside', 'three_outside'],
  ({ candles }) => advancedCandlePattern(candles),
);

register(['hma', 'hull_ma'], ({ candles, rule, currentPrice }) => hma(candles, rule.period, currentPrice));
register('dema', ({ candles, rule, currentPrice }) => dema(candles, rule.period, currentPrice));
register('tema', ({ candles, rule, currentPrice }) => tema(candles, rule.period, currentPrice));
register('alma', ({ candles, rule, currentPrice }) => alma(candles, rule.period, currentPrice));
register('kama', ({ candles, rule, currentPrice }) => kama(candles, rule.period, currentPrice));
register('t3', ({ candles, rule, currentPrice }) => t3(candles, rule.period, currentPrice));
register(['lsma', 'linear_regression'], ({ candles, rule, currentPrice }) =>
  linearRegression(candles, rule.period, currentPrice),
);

register(['ao', 'awesome_oscillator'], ({ candles }) => ao(candles));
register(['ac', 'accelerator_oscillator'], ({ candles }) => ac(candles));
register('cmo', ({ candles, rule }) => cmo(candles, rule.period));
register('rvi', ({ candles, rule }) => rvi(candles, rule.period));
register('connors_rsi', ({ candles, currentPrice }) => connorsRsi(candles, currentPrice));
register('stc', ({ candles, currentPrice }) => stc(candles, currentPrice));
register('bop', ({ candles }) => bop(candles));
register(['elder_bull_power', 'bull_power'], ({ candles, rule, currentPrice }) =>
  elderBullPower(candles, rule.period, currentPrice),
);
register(['elder_bear_power', 'bear_power'], ({ candles, rule, currentPrice }) =>
  elderBearPower(candles, rule.period, currentPrice),
);
register('elder_force_index', ({ candles }) => elderForceIndex(candles));

register('aroon_up', ({ candles, rule }) => aroon(candles, rule.period).up);
register('aroon_down', ({ candles, rule }) => aroon(candles, rule.period).down);
register(['aroon', 'aroon_oscillator'], ({ candles, rule }) => {
  const a = aroon(candles, rule.period);
  return a.up - a.down;
});
register('vortex_plus', ({ candles, rule }) => vortex(candles, rule.period).plus);
register('vortex_minus', ({ candles, rule }) => vortex(candles, rule.period).minus);
register('vortex', ({ candles, rule }) => {
  const v = vortex(candles, rule.period);
  return v.plus - v.minus;
});

register(['historical_volatility', 'hv'], ({ candles, rule }) =>
  historicalVolatility(candles, rule.period),
);
register('ulcer_index', ({ candles, rule }) => ulcerIndex(candles, rule.period));
register('chaikin_volatility', ({ candles, rule }) => chaikinVolatility(candles, rule.period));

register(['emv', 'ease_of_movement'], ({ candles, rule }) => emv(candles, rule.period));
register('pvt', ({ candles }) => pvt(candles));
register(['klinger', 'klinger_oscillator'], ({ candles }) => klinger(candles));
register('nvi', ({ candles }) => nvi(candles));

register('alligator', ({ candles, currentPrice }) => alligator(candles, currentPrice));
register(['chande_kroll_stop', 'ckstop'], ({ candles, currentPrice }) =>
  chandeKrollStop(candles, currentPrice),
);
