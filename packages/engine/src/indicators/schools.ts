/**
 * Additional technical schools — batch 6.
 *
 * Pivots, VSA, Wolfe, DeMark, Darvas, Heikin-Ashi, Gann and friends.
 * Ported literally from signal_engine.dart; several are marked "simplified" in
 * the Dart source and that simplification is the shipped behaviour.
 */

import { register } from '../registry.js';
import type { Candle } from '../types.js';
import * as m from './math.js';
import { avgBodySize, swingPoints } from './patterns.js';
import { openingRange, volumeProfileStats } from './structure.js';
import { premiumDiscountPos } from './ict.js';

const idiv = (a: number, b: number): number => Math.trunc(a / b);

// ── Pivots ──────────────────────────────────────────────────────────────────

/** signal_engine.dart:4020 — classic pivot off the PREVIOUS candle, not a session. */
export function pivotPoint(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 5) return 'none';
  const c = candles[candles.length - 2]!;
  const p = (c.high + c.low + c.close) / 3;
  const r1 = 2 * p - c.low;
  const s1 = 2 * p - c.high;
  if (currentPrice > r1) return 'above_r1';
  if (currentPrice < s1) return 'below_s1';
  if (currentPrice > p) return 'above_pivot';
  if (currentPrice < p) return 'below_pivot';
  return 'at_pivot';
}

/** signal_engine.dart — Central Pivot Range. */
export function cpr(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 3) return 'none';
  const c = candles[candles.length - 2]!;
  const p = (c.high + c.low + c.close) / 3;
  const tc = (c.high + c.low) / 2;
  const bc = 2 * p - tc;
  if (currentPrice > Math.max(tc, bc)) return 'above_cpr';
  if (currentPrice < Math.min(tc, bc)) return 'below_cpr';
  return 'inside_cpr';
}

// ── Zones and breakouts ─────────────────────────────────────────────────────

/** signal_engine.dart:4034 */
export function supplyDemandZone(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 10) return 'none';
  const avg = avgBodySize(candles);
  for (let i = candles.length - 8; i >= 2; i--) {
    const c = candles[i]!;
    if (Math.abs(c.close - c.open) < avg * 2) continue;
    const zH = Math.max(c.open, c.close), zL = Math.min(c.open, c.close);
    if (currentPrice >= zL && currentPrice <= zH) {
      return c.close > c.open ? 'demand' : 'supply';
    }
  }
  return 'none';
}

/** signal_engine.dart:4050 — needs an ATR(14) × 0.3 buffer beyond the swing. */
export function breakoutSignal(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, 20, 2);
  if (!h.length || !l.length) return 'none';
  const res = h[h.length - 1]!, sup = l[l.length - 1]!;
  const atrVal = m.atr(candles, 14, currentPrice);
  if (currentPrice > res + atrVal * 0.3) return 'bullish';
  if (currentPrice < sup - atrVal * 0.3) return 'bearish';
  return 'none';
}

/** signal_engine.dart:4062 */
export function momentumSignal(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 10) return 'none';
  const r = m.roc(candles, 5, currentPrice);
  if (r > 0.3) return 'bullish';
  if (r < -0.3) return 'bearish';
  return 'none';
}

/** signal_engine.dart:4069 */
export function meanReversionSignal(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const rsiVal = m.rsi(candles, 14);
  const pos = premiumDiscountPos(candles, currentPrice);
  if (rsiVal < 25 && pos < 10) return 'bullish';
  if (rsiVal > 75 && pos > 90) return 'bearish';
  return 'none';
}

/** signal_engine.dart:4077 — NR4 / NR7: narrowest range of the last n bars. */
export function nrPattern(candles: readonly Candle[], currentPrice: number, n: number): string {
  if (candles.length < n + 1) return 'none';
  const recent = candles.slice(candles.length - n);
  const ranges = recent.map((c) => c.high - c.low);
  const lastRange = ranges[ranges.length - 1]!;
  if (!ranges.every((r) => r >= lastRange)) return 'none';
  const last = recent[recent.length - 1]!;
  if (currentPrice > last.high) return 'bullish';
  if (currentPrice < last.low) return 'bearish';
  return 'active';
}

/** signal_engine.dart:4104 — volatility contraction, ranges narrowing bar over bar. */
export function vcp(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 10) return 'none';
  const recent = candles.slice(candles.length - 8);
  const ranges = recent.map((c) => c.high - c.low);
  for (let i = 1; i < ranges.length - 1; i++) {
    if (ranges[i]! >= ranges[i - 1]! * 1.1) return 'none';
  }
  const last = recent[recent.length - 1]!;
  if (currentPrice > last.high) return 'bullish';
  if (currentPrice < last.low) return 'bearish';
  return 'none';
}

/** signal_engine.dart:4121 — opening-range breakout, relabelled bullish/bearish. */
export function orbSignal(candles: readonly Candle[], currentPrice: number): string {
  const r = openingRange(candles, currentPrice);
  if (r === 'breakout_up') return 'bullish';
  if (r === 'breakout_down') return 'bearish';
  return 'none';
}

// ── Price transforms ────────────────────────────────────────────────────────

/** signal_engine.dart:4130 — single-bar Heikin-Ashi, not a recursive series. */
export function heikinAshi(candles: readonly Candle[]): string {
  if (candles.length < 3) return 'none';
  const c = candles[candles.length - 1]!;
  const p = candles[candles.length - 2]!;
  const haClose = (c.open + c.high + c.low + c.close) / 4;
  const haOpen = (p.open + p.close) / 2;
  if (haClose > haOpen && c.low === Math.min(c.open, c.close)) return 'strong_bullish';
  if (haClose < haOpen && c.high === Math.max(c.open, c.close)) return 'strong_bearish';
  if (haClose > haOpen) return 'bullish';
  if (haClose < haOpen) return 'bearish';
  return 'none';
}

/** signal_engine.dart:4147 — "anchored" to the whole buffer, i.e. plain VWAP. */
export function anchoredVwap(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 5) return 'none';
  const v = m.vwap(candles, currentPrice);
  if (currentPrice > v * 1.001) return 'above';
  if (currentPrice < v * 0.999) return 'below';
  return 'at';
}

/** signal_engine.dart:4155 — VWAP ± one ATR(14). */
export function vwapBands(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 5) return 'none';
  const v = m.vwap(candles, currentPrice);
  const a = m.atr(candles, 14, currentPrice);
  if (currentPrice > v + a) return 'above_upper';
  if (currentPrice < v - a) return 'below_lower';
  if (currentPrice > v) return 'above';
  if (currentPrice < v) return 'below';
  return 'at';
}

/** signal_engine.dart:4166 — simplified 1×1 Gann angle. */
export function gannAngle(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 10) return 'none';
  const n = Math.min(10, candles.length - 1);
  const startPrice = candles[candles.length - 1 - n]!.close;
  const pipPerBar = (currentPrice - startPrice) / n;
  if (Math.abs(pipPerBar) < 0.00005) return 'equilibrium';
  return pipPerBar > 0 ? 'bullish' : 'bearish';
}

// ── Volume spread analysis ──────────────────────────────────────────────────

/** signal_engine.dart:4400 — narrow/wide spread against ATR(5), with volume. */
export function vsaSignal(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 5) return 'none';
  const c = candles[candles.length - 1]!;
  const spread = c.high - c.low;
  const volRatio = volumeProfileStats(candles).ratio;
  const atr5 = m.atr(candles, 5, currentPrice);
  const mid = (c.high + c.low) / 2;

  if (spread < atr5 * 0.5 && volRatio < 0.7 && c.close < mid) return 'no_demand';
  if (spread < atr5 * 0.5 && volRatio < 0.7 && c.close > mid) return 'no_supply';
  if (spread > atr5 * 1.3 && volRatio > 1.5 && c.close > mid) return 'effort_up';
  if (spread > atr5 * 1.3 && volRatio > 1.5 && c.close < mid) return 'effort_down';
  return 'none';
}

/** signal_engine.dart:4434 — signed volume over the last ~10 bars. */
export function cvd(candles: readonly Candle[]): string {
  const obvNow = m.obv(candles);
  const n = Math.min(10, candles.length - 1);
  if (n < 1) return 'neutral';
  const end = candles.length - n;
  let prevObv = 0.0;
  for (let i = 1; i < end; i++) {
    if (candles[i]!.close > candles[i - 1]!.close) prevObv += candles[i]!.volume;
    else if (candles[i]!.close < candles[i - 1]!.close) prevObv -= candles[i]!.volume;
  }
  const delta = obvNow - prevObv;
  if (delta > 0) return 'positive';
  if (delta < 0) return 'negative';
  return 'neutral';
}

// ── Wave / sequential ───────────────────────────────────────────────────────

/** signal_engine.dart:4459 — simplified Wolfe wave: point 5 near the 1-3 line. */
export function wolfeWave(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 30) return 'none';
  const { h, l } = swingPoints(candles, 40, 2);
  if (h.length < 3 || l.length < 3) return 'none';

  const pt1 = l[l.length - 3]!, pt3 = l[l.length - 2]!, pt5 = l[l.length - 1]!;
  const trend13 = pt3 - pt1;
  if (Math.abs(pt5 - (pt3 + trend13)) < Math.abs(trend13 * 0.15) && currentPrice > pt5) {
    return 'bullish';
  }

  const ph1 = h[h.length - 3]!, ph3 = h[h.length - 2]!, ph5 = h[h.length - 1]!;
  const trendH = ph3 - ph1;
  if (Math.abs(ph5 - (ph3 + trendH)) < Math.abs(trendH * 0.15) && currentPrice < ph5) {
    return 'bearish';
  }
  return 'none';
}

/**
 * signal_engine.dart:4487 — TD setup.
 * The counters run over the WHOLE buffer and are only inspected after the loop,
 * so this reports whether the streak is still alive at the newest candle.
 */
export function demarkSequential(candles: readonly Candle[]): string {
  if (candles.length < 13) return 'none';
  let upCount = 0, dnCount = 0;
  for (let i = 4; i < candles.length; i++) {
    upCount = candles[i]!.close > candles[i - 4]!.close ? upCount + 1 : 0;
    dnCount = candles[i]!.close < candles[i - 4]!.close ? dnCount + 1 : 0;
  }
  if (upCount >= 9) return 'sell_setup';
  if (dnCount >= 9) return 'buy_setup';
  return 'none';
}

// ── Box / cup ───────────────────────────────────────────────────────────────

/** signal_engine.dart:4513 — box built from the last 10 bars minus the newest 3. */
export function darvasBox(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 15) return 'none';
  const recent = candles.slice(Math.max(0, candles.length - 10));
  const box = recent.slice(0, recent.length - 3);
  const boxH = Math.max(...box.map((c) => c.high));
  const boxL = Math.min(...box.map((c) => c.low));
  if (currentPrice > boxH) return 'bullish';
  if (currentPrice < boxL) return 'bearish';
  return 'inside';
}

/** signal_engine.dart:4528 — thirds of the first half form the cup, the rest the handle. */
export function cupAndHandle(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 30) return 'none';
  const mid = idiv(candles.length, 2);
  const leftH = Math.max(...candles.slice(0, idiv(mid, 3)).map((c) => c.high));
  const bottomL = Math.min(...candles.slice(idiv(mid, 3), idiv(mid * 2, 3)).map((c) => c.low));
  const rightH = Math.max(...candles.slice(idiv(mid * 2, 3), mid).map((c) => c.high));
  const handleL = Math.min(...candles.slice(mid).map((c) => c.low));

  const isU = Math.abs(leftH - rightH) < leftH * 0.01 && bottomL < leftH * 0.97;
  const isHandle = handleL > bottomL && handleL < leftH;
  return isU && isHandle && currentPrice > rightH ? 'bullish' : 'none';
}

// ── Registrations ───────────────────────────────────────────────────────────

register(['cpr', 'pivot_point'], ({ candles, currentPrice, rule }) =>
  rule.indicator === 'cpr' ? cpr(candles, currentPrice) : pivotPoint(candles, currentPrice),
);
register('supply_demand', ({ candles, currentPrice }) => supplyDemandZone(candles, currentPrice));
register('breakout', ({ candles, currentPrice }) => breakoutSignal(candles, currentPrice));
register(['momentum', 'momentum_trading'], ({ candles, currentPrice }) =>
  momentumSignal(candles, currentPrice),
);
register('mean_reversion', ({ candles, currentPrice }) => meanReversionSignal(candles, currentPrice));
register('nr4', ({ candles, currentPrice }) => nrPattern(candles, currentPrice, 4));
register('nr7', ({ candles, currentPrice }) => nrPattern(candles, currentPrice, 7));
register(['orb', 'opening_range_breakout'], ({ candles, currentPrice }) =>
  orbSignal(candles, currentPrice),
);
register('heikin_ashi', ({ candles }) => heikinAshi(candles));
register('anchored_vwap', ({ candles, currentPrice }) => anchoredVwap(candles, currentPrice));
register('vwap_bands', ({ candles, currentPrice }) => vwapBands(candles, currentPrice));
register('gann_angle', ({ candles, currentPrice }) => gannAngle(candles, currentPrice));
register('wolfe_waves', ({ candles, currentPrice }) => wolfeWave(candles, currentPrice));
register(['demark', 'td_sequential'], ({ candles }) => demarkSequential(candles));
register('darvas_box', ({ candles, currentPrice }) => darvasBox(candles, currentPrice));
register('cup_and_handle', ({ candles, currentPrice }) => cupAndHandle(candles, currentPrice));
