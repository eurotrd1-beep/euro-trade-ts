/**
 * ICT / Smart-Money concepts and harmonic patterns — batch 5.
 *
 * Ported literally from signal_engine.dart.
 */

import { register } from '../registry.js';
import type { Candle } from '../types.js';
import * as m from './math.js';
import { avgBodySize, swingPoints } from './patterns.js';
import { fairValueGap, liquiditySweep, marketStructure } from './structure.js';

const inRange = (v: number, lo: number, hi: number): boolean => v >= lo && v <= hi;

// ── Range position ──────────────────────────────────────────────────────────

/** signal_engine.dart:3383 — where price sits in the last 50 candles, 0-100. */
export function premiumDiscountPos(candles: readonly Candle[], currentPrice: number): number {
  if (candles.length < 5) return 50;
  let rH = 0, rL = Infinity;
  const lb = Math.min(50, candles.length);
  for (let i = candles.length - lb; i < candles.length; i++) {
    rH = Math.max(rH, candles[i]!.high);
    rL = Math.min(rL, candles[i]!.low);
  }
  const range = rH - rL;
  return range > 0 ? ((currentPrice - rL) / range) * 100 : 50;
}

/** signal_engine.dart:3733 — volatility expansion, ATR(5) vs ATR(14) × 1.3. */
export function expansion(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 10) return 'none';
  if (m.atr(candles, 5, currentPrice) < m.atr(candles, 14, currentPrice) * 1.3) return 'none';
  const start = candles[candles.length - 5]!.close;
  if (currentPrice > start) return 'bullish';
  if (currentPrice < start) return 'bearish';
  return 'none';
}

// ── Break of structure variants ─────────────────────────────────────────────

/** signal_engine.dart:3399 — short lookback, weak swing strength. */
export function internalBos(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 8) return 'none';
  const { h, l } = swingPoints(candles, 12, 1);
  if (h.length && currentPrice > h[h.length - 1]!) return 'bullish';
  if (l.length && currentPrice < l[l.length - 1]!) return 'bearish';
  return 'none';
}

/** signal_engine.dart:3409 — whole buffer, strength 3, compared to the PRIOR swing. */
export function externalBos(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, candles.length, 3);
  if (h.length >= 2 && currentPrice > h[h.length - 2]!) return 'bullish';
  if (l.length >= 2 && currentPrice < l[l.length - 2]!) return 'bearish';
  return 'none';
}

// ── Blocks ──────────────────────────────────────────────────────────────────

/** signal_engine.dart:3419 */
export function breakerBlock(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 15) return 'none';
  for (let i = candles.length - 8; i >= 3; i--) {
    const obH = candles[i]!.high, obL = candles[i]!.low;
    let brokeAbove = false, brokeBelow = false;
    for (let j = i + 1; j < Math.min(i + 7, candles.length); j++) {
      if (candles[j]!.close > obH) brokeAbove = true;
      if (candles[j]!.close < obL) brokeBelow = true;
    }
    if (brokeAbove && currentPrice >= obL && currentPrice <= obH) return 'bullish';
    if (brokeBelow && currentPrice >= obL && currentPrice <= obH) return 'bearish';
  }
  return 'none';
}

/** signal_engine.dart:3434 */
export function rejectionBlock(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 3) return 'none';
  for (let i = candles.length - 1; i >= Math.max(0, candles.length - 5); i--) {
    const c = candles[i]!;
    const range = c.high - c.low;
    if (range < 0.0001) continue;
    const body = Math.abs(c.close - c.open);
    const upW = c.high - Math.max(c.open, c.close);
    const dnW = Math.min(c.open, c.close) - c.low;
    if (dnW > range * 0.6 && dnW > body * 2 && Math.abs(currentPrice - c.low) < range * 0.4) {
      return 'bullish';
    }
    if (upW > range * 0.6 && upW > body * 2 && Math.abs(currentPrice - c.high) < range * 0.4) {
      return 'bearish';
    }
  }
  return 'none';
}

/** signal_engine.dart:3457 */
export function mitigationBlock(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 15) return 'none';
  const avg = avgBodySize(candles);
  for (let i = candles.length - 10; i >= 5; i--) {
    const c = candles[i]!;
    if (Math.abs(c.close - c.open) < avg * 2) continue;
    const zH = Math.max(c.open, c.close), zL = Math.min(c.open, c.close);
    let moved = false;
    for (let j = i + 1; j < Math.min(i + 5, candles.length - 1); j++) {
      if (Math.abs(candles[j]!.close - c.close) > avg * 3) { moved = true; break; }
    }
    if (moved && currentPrice >= zL && currentPrice <= zH) {
      return c.close > c.open ? 'bullish' : 'bearish';
    }
  }
  return 'none';
}

/** signal_engine.dart:3478 — an FVG that has since been filled inverts its bias. */
export function inverseFvg(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 10) return 'none';
  for (let i = Math.min(candles.length - 4, candles.length - 1); i >= 4; i--) {
    const c1 = candles[i - 2]!, c3 = candles[i]!;
    if (c3.low > c1.high) {
      let filled = false;
      for (let j = i + 1; j < candles.length - 1; j++) {
        if (candles[j]!.low <= c1.high) { filled = true; break; }
      }
      if (filled && currentPrice >= c1.high && currentPrice <= c3.low) return 'bearish';
    }
    if (c3.high < c1.low) {
      let filled = false;
      for (let j = i + 1; j < candles.length - 1; j++) {
        if (candles[j]!.high >= c1.low) { filled = true; break; }
      }
      if (filled && currentPrice >= c3.high && currentPrice <= c1.low) return 'bullish';
    }
  }
  return 'none';
}

/** signal_engine.dart:3510 — overlap of an up-gap and a down-gap. */
export function balancedPriceRange(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 10) return 'none';
  const bL: number[] = [], bH: number[] = [], sL: number[] = [], sH: number[] = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2]!, c3 = candles[i]!;
    if (c3.low > c1.high) { bL.push(c1.high); bH.push(c3.low); }
    if (c3.high < c1.low) { sL.push(c3.high); sH.push(c1.low); }
  }
  for (let b = 0; b < bL.length; b++) {
    for (let s = 0; s < sL.length; s++) {
      const oL = Math.max(bL[b]!, sL[s]!), oH = Math.min(bH[b]!, sH[s]!);
      if (oH > oL && currentPrice >= oL && currentPrice <= oH) return 'active';
    }
  }
  return 'none';
}

/** signal_engine.dart:3535 */
export function equalHighs(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { h } = swingPoints(candles, 40, 2);
  if (h.length < 2) return 'none';
  const tol = 0.001;
  for (let i = h.length - 1; i >= 1; i--) {
    if (Math.abs(h[i]! - h[i - 1]!) < tol && currentPrice >= h[i]! - tol) return 'active';
  }
  return 'none';
}

/** signal_engine.dart:3548 */
export function equalLows(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { l } = swingPoints(candles, 40, 2);
  if (l.length < 2) return 'none';
  const tol = 0.001;
  for (let i = l.length - 1; i >= 1; i--) {
    if (Math.abs(l[i]! - l[i - 1]!) < tol && currentPrice <= l[i]! + tol) return 'active';
  }
  return 'none';
}

/** signal_engine.dart:3573 — optimal trade entry, the 62-79% retracement band. */
export function ote(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  let sH = 0, sL = Infinity, hIdx = 0, lIdx = 0;
  const lb = Math.min(30, candles.length - 3);
  for (let i = candles.length - lb; i < candles.length - 3; i++) {
    if (candles[i]!.high > sH) { sH = candles[i]!.high; hIdx = i; }
    if (candles[i]!.low < sL) { sL = candles[i]!.low; lIdx = i; }
  }
  const range = sH - sL;
  if (range < 0.0001) return 'none';
  if (lIdx < hIdx) {
    if (currentPrice >= sH - range * 0.79 && currentPrice <= sH - range * 0.62) return 'bullish';
  } else {
    if (currentPrice >= sL + range * 0.62 && currentPrice <= sL + range * 0.79) return 'bearish';
  }
  return 'none';
}

/** signal_engine.dart:3600 — bearish context followed by a bullish expansion. */
export function marketMakerBuyModel(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const ms = marketStructure(candles, currentPrice);
  const sweep = liquiditySweep(candles, currentPrice);
  const bearCtx =
    ms.includes('lower') || ms === 'change_of_character_bullish' || sweep === 'sell_side';
  return bearCtx && expansion(candles, currentPrice) === 'bullish' ? 'bullish' : 'none';
}

/** signal_engine.dart:3612 */
export function marketMakerSellModel(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const ms = marketStructure(candles, currentPrice);
  const sweep = liquiditySweep(candles, currentPrice);
  const bullCtx =
    ms.includes('higher') || ms === 'change_of_character_bearish' || sweep === 'buy_side';
  return bullCtx && expansion(candles, currentPrice) === 'bearish' ? 'bearish' : 'none';
}

// ── Harmonics ───────────────────────────────────────────────────────────────

/**
 * signal_engine.dart:3957 — `_detectHarmonic`.
 * A simplified XABCD: ratios are taken from the last few swing points rather
 * than a validated alternating sequence, and direction is decided purely by
 * whether price sits below the X-A midpoint. Copied verbatim.
 */
export function harmonic(
  candles: readonly Candle[],
  currentPrice: number,
  type: string,
): string {
  if (candles.length < 40) return 'none';
  const { h, l } = swingPoints(candles, 60, 2);
  if (h.length < 3 || l.length < 3) return 'none';

  const xL = l.length >= 3 ? l[l.length - 3]! : l[0]!;
  const aH = h.length >= 2 ? h[h.length - 2]! : h[h.length - 1]!;
  const bL = l.length >= 2 ? l[l.length - 2]! : l[l.length - 1]!;
  const cH = h[h.length - 1]!;

  const xa = aH - xL;
  const ab = aH - bL;
  const bc = cH - bL;
  if (xa < 0.0001) return 'none';

  const abXa = ab / xa;
  const bcAb = bc / m.clamp(ab, 0.0001, Infinity);

  let matches = false;
  switch (type) {
    case 'gartley':   matches = inRange(abXa, 0.58, 0.65) && inRange(bcAb, 0.36, 0.90); break;
    case 'bat':       matches = inRange(abXa, 0.38, 0.52) && inRange(bcAb, 0.36, 0.90); break;
    case 'butterfly': matches = inRange(abXa, 0.74, 0.82) && inRange(bcAb, 0.36, 0.90); break;
    case 'crab':      matches = inRange(abXa, 0.36, 0.62) && inRange(bcAb, 0.36, 0.90); break;
    case 'shark':     matches = inRange(abXa, 0.44, 0.55) && bcAb > 1.13; break;
    case 'cypher':    matches = inRange(abXa, 0.38, 0.62) && inRange(bcAb, 1.13, 1.41); break;
    case 'ab_cd':     matches = inRange(bcAb, 0.62, 0.79); break;
    default:          matches = false;
  }
  if (!matches) return 'none';

  return currentPrice < (xL + aH) / 2 ? 'bullish' : 'bearish';
}

// ── Registrations ───────────────────────────────────────────────────────────

register('internal_bos', ({ candles, currentPrice }) => internalBos(candles, currentPrice));
register('external_bos', ({ candles, currentPrice }) => externalBos(candles, currentPrice));
register('breaker_block', ({ candles, currentPrice }) => breakerBlock(candles, currentPrice));
register('rejection_block', ({ candles, currentPrice }) => rejectionBlock(candles, currentPrice));
register('mitigation_block', ({ candles, currentPrice }) => mitigationBlock(candles, currentPrice));
register('inverse_fvg', ({ candles, currentPrice }) => inverseFvg(candles, currentPrice));
register('bpr', ({ candles, currentPrice }) => balancedPriceRange(candles, currentPrice));
register(['eqh', 'equal_highs'], ({ candles, currentPrice }) => equalHighs(candles, currentPrice));
register(['eql', 'equal_lows'], ({ candles, currentPrice }) => equalLows(candles, currentPrice));
register('ote', ({ candles, currentPrice }) => ote(candles, currentPrice));
register('expansion', ({ candles, currentPrice }) => expansion(candles, currentPrice));
register('market_maker_buy_model', ({ candles, currentPrice }) =>
  marketMakerBuyModel(candles, currentPrice),
);
register('market_maker_sell_model', ({ candles, currentPrice }) =>
  marketMakerSellModel(candles, currentPrice),
);
register('premium_zone', ({ candles, currentPrice }) =>
  premiumDiscountPos(candles, currentPrice) > 62 ? 'premium' : 'none',
);
register('discount_zone', ({ candles, currentPrice }) =>
  premiumDiscountPos(candles, currentPrice) < 38 ? 'discount' : 'none',
);
register('dealing_range', ({ candles, currentPrice }) => {
  const p = premiumDiscountPos(candles, currentPrice);
  if (p > 62) return 'premium';
  if (p < 38) return 'discount';
  return 'equilibrium';
});

// `imbalance` is a second name for the fair-value-gap detector in Dart.
register('imbalance', ({ candles, currentPrice }) => fairValueGap(candles, currentPrice));

register(['5_0', 'ab_cd'], ({ candles, currentPrice }) => harmonic(candles, currentPrice, 'ab_cd'));
register(['bat', 'alternate_bat'], ({ candles, currentPrice }) => harmonic(candles, currentPrice, 'bat'));
register(['crab', 'deep_crab'], ({ candles, currentPrice }) => harmonic(candles, currentPrice, 'crab'));
register('butterfly', ({ candles, currentPrice }) => harmonic(candles, currentPrice, 'butterfly'));
register('cypher', ({ candles, currentPrice }) => harmonic(candles, currentPrice, 'cypher'));
register('gartley', ({ candles, currentPrice }) => harmonic(candles, currentPrice, 'gartley'));
register('shark', ({ candles, currentPrice }) => harmonic(candles, currentPrice, 'shark'));
