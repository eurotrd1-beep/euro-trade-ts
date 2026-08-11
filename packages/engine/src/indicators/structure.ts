/**
 * Market-structure, liquidity, volume and clock indicators — batch 2.
 *
 * Ported literally from the `_detect*` / `_calculate*` helpers in
 * signal_engine.dart. Line references point at the Dart source.
 */

import { register, type EngineClock } from '../registry.js';
import type { Candle } from '../types.js';
import * as m from './math.js';

// ── Liquidity zones ─────────────────────────────────────────────────────────

/** signal_engine.dart:2920 */
export function liquidityZones(
  candles: readonly Candle[],
  currentPrice: number,
): { score: number; zone: string; nearestLevel: number } {
  if (candles.length < 10) {
    return { score: 50.0, zone: 'Neutral', nearestLevel: currentPrice };
  }

  const avgVolume = candles.reduce((a, c) => a + c.volume, 0) / candles.length;

  const levels: number[] = [];
  for (const c of candles) {
    if (c.volume > avgVolume * 1.5) levels.push((c.high + c.low) / 2.0);
  }

  const sr = m.supportResistance(candles, currentPrice);
  levels.push(sr.support, sr.resistance, m.vwap(candles, currentPrice));

  let minDist = Infinity;
  let nearestLevel = currentPrice;
  for (const level of levels) {
    const dist = Math.abs(currentPrice - level);
    if (dist < minDist) {
      minDist = dist;
      nearestLevel = level;
    }
  }

  const atrVal = m.atr(candles, 14, currentPrice);
  const score =
    atrVal === 0 ? 50.0 : (1.0 - m.clamp(minDist / (atrVal * 3.0), 0.0, 1.0)) * 100.0;

  let zone: string;
  if (score > 75) zone = currentPrice <= nearestLevel ? 'Demand Zone (Buy)' : 'Supply Zone (Sell)';
  else if (score > 40) zone = 'Transition Zone';
  else zone = 'Low Liquidity';

  return { score, zone, nearestLevel };
}

/** signal_engine.dart:3092 — the average EXCLUDES the last candle. */
export function volumeProfileStats(
  candles: readonly Candle[],
): { spike: boolean; ratio: number; trend: string; avgVolume: number } {
  if (candles.length < 10) {
    return { spike: false, ratio: 1.0, trend: 'flat', avgVolume: 1000.0 };
  }

  let totalVol = 0;
  let count = 0;
  for (let i = Math.max(0, candles.length - 11); i < candles.length - 1; i++) {
    totalVol += candles[i]!.volume;
    count++;
  }
  const avgVolume = count > 0 ? totalVol / count : 1000.0;
  const currentVol = candles[candles.length - 1]!.volume;
  const ratio = avgVolume > 0 ? currentVol / avgVolume : 1.0;

  let obvRecent = 0;
  for (let i = Math.max(1, candles.length - 5); i < candles.length; i++) {
    if (candles[i]!.close > candles[i - 1]!.close) obvRecent += candles[i]!.volume;
    else obvRecent -= candles[i]!.volume;
  }

  return {
    spike: ratio > 1.8,
    ratio,
    trend: obvRecent > 0 ? 'bullish' : obvRecent < 0 ? 'bearish' : 'flat',
    avgVolume,
  };
}

// ── Smart money concepts ────────────────────────────────────────────────────

/** signal_engine.dart:3137 — 5-candle fractal swings. */
export function marketStructure(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';

  const sh: number[] = [];
  const sl: number[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const h = candles[i]!.high;
    if (
      h > candles[i - 1]!.high && h > candles[i - 2]!.high &&
      h > candles[i + 1]!.high && h > candles[i + 2]!.high
    ) sh.push(h);
    const l = candles[i]!.low;
    if (
      l < candles[i - 1]!.low && l < candles[i - 2]!.low &&
      l < candles[i + 1]!.low && l < candles[i + 2]!.low
    ) sl.push(l);
  }

  if (sh.length < 2 || sl.length < 2) return 'none';

  const sh1 = sh[sh.length - 1]!, sh2 = sh[sh.length - 2]!;
  const sl1 = sl[sl.length - 1]!, sl2 = sl[sl.length - 2]!;
  const nowBullish = sh1 > sh2 && sl1 > sl2;
  const nowBearish = sh1 < sh2 && sl1 < sl2;

  if (sh.length >= 3 && sl.length >= 3) {
    const sh3 = sh[sh.length - 3]!, sl3 = sl[sl.length - 3]!;
    const wasBullish = sh2 > sh3 && sl2 > sl3;
    const wasBearish = sh2 < sh3 && sl2 < sl3;
    if (wasBearish && nowBullish) return 'change_of_character_bullish';
    if (wasBullish && nowBearish) return 'change_of_character_bearish';
    if (nowBullish && currentPrice > sh2) return 'break_of_structure_bullish';
    if (nowBearish && currentPrice < sl2) return 'break_of_structure_bearish';
  }

  if (nowBullish) return 'higher_high_higher_low';
  if (nowBearish) return 'lower_low_lower_high';
  return 'none';
}

/** signal_engine.dart:3191 */
export function orderBlock(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 10) return 'none';

  const totalBody = candles.reduce((a, c) => a + Math.abs(c.close - c.open), 0);
  const impulseThreshold = (totalBody / candles.length) * 1.5;

  for (let i = candles.length - 2; i >= 5; i--) {
    const c = candles[i]!;
    if (Math.abs(c.close - c.open) < impulseThreshold) continue;

    const bullishImpulse = c.close > c.open;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const ob = candles[j]!;
      // Look back for the last opposite-coloured candle before the impulse.
      if (bullishImpulse ? ob.close < ob.open : ob.close > ob.open) {
        if (currentPrice >= ob.low && currentPrice <= ob.high) {
          return bullishImpulse ? 'bullish' : 'bearish';
        }
        break;
      }
    }
  }
  return 'none';
}

/** signal_engine.dart:3230 */
export function fairValueGap(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 5) return 'none';
  for (let i = candles.length - 1; i >= 2; i--) {
    const c1 = candles[i - 2]!, c3 = candles[i]!;
    if (c3.low > c1.high && currentPrice >= c1.high && currentPrice <= c3.low) return 'bullish';
    if (c3.high < c1.low && currentPrice >= c3.high && currentPrice <= c1.low) return 'bearish';
  }
  return 'none';
}

/** signal_engine.dart:3251 */
export function liquiditySweep(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 15) return 'none';

  const refEnd = candles.length - 3;
  const refStart = Math.max(0, candles.length - 18);
  let refHigh = 0, refLow = Infinity;
  for (let i = refStart; i < refEnd; i++) {
    refHigh = Math.max(refHigh, candles[i]!.high);
    refLow = Math.min(refLow, candles[i]!.low);
  }

  const last3 = candles.slice(candles.length - 3);
  if (last3.some((c) => c.low < refLow) && currentPrice > refLow) return 'sell_side';
  if (last3.some((c) => c.high > refHigh) && currentPrice < refHigh) return 'buy_side';
  return 'none';
}

/** signal_engine.dart:3664 */
export function wyckoffSpring(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  let support = Infinity;
  const refEnd = candles.length - 3;
  for (let i = Math.max(0, candles.length - 18); i < refEnd; i++) {
    support = Math.min(support, candles[i]!.low);
  }
  const last3 = candles.slice(candles.length - 3);
  if (last3.some((c) => c.low < support) && currentPrice > support) {
    const deepest = Math.min(...last3.map((c) => c.low));
    if (support - deepest < support * 0.003) return 'bullish';
  }
  return 'none';
}

/** signal_engine.dart:3679 */
export function wyckoffUpthrust(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  let resist = 0;
  const refEnd = candles.length - 3;
  for (let i = Math.max(0, candles.length - 18); i < refEnd; i++) {
    resist = Math.max(resist, candles[i]!.high);
  }
  const last3 = candles.slice(candles.length - 3);
  if (last3.some((c) => c.high > resist) && currentPrice < resist) {
    const highest = Math.max(...last3.map((c) => c.high));
    if (highest - resist < resist * 0.003) return 'bearish';
  }
  return 'none';
}

/** signal_engine.dart:3646 */
export function sessionOpen(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 3) return 'none';
  const open = candles[0]!.open;
  if (currentPrice > open * 1.0002) return 'above';
  if (currentPrice < open * 0.9998) return 'below';
  return 'at';
}

/** signal_engine.dart:3654 — the opening range is the FIRST 10 candles. */
export function openingRange(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 10) return 'none';
  const n = Math.min(10, candles.length);
  const head = candles.slice(0, n);
  const orH = Math.max(...head.map((c) => c.high));
  const orL = Math.min(...head.map((c) => c.low));
  if (currentPrice > orH) return 'breakout_up';
  if (currentPrice < orL) return 'breakout_down';
  return 'inside';
}

/** signal_engine.dart:5939 — half-window averages, not true swing pivots. */
export function rsiDivergence(candles: readonly Candle[]): string {
  if (candles.length < 20) return 'none';

  const lookback = Math.min(15, candles.length - 5);
  const prices: number[] = [];
  const rsiValues: number[] = [];

  for (let i = candles.length - lookback; i < candles.length; i++) {
    prices.push(candles[i]!.close);
  }
  for (let i = candles.length - lookback; i < candles.length; i++) {
    if (i < 15) { rsiValues.push(50.0); continue; }
    let totalGain = 0.0, totalLoss = 0.0;
    for (let j = i - 13; j <= i; j++) {
      const change = candles[j]!.close - candles[j - 1]!.close;
      if (change > 0) totalGain += change;
      else totalLoss -= change;
    }
    const rs = totalLoss === 0 ? 100.0 : totalGain / 14.0 / (totalLoss / 14.0);
    rsiValues.push(100.0 - 100.0 / (1.0 + rs));
  }

  if (prices.length < 5 || rsiValues.length < 5) return 'none';

  const mid = Math.trunc(prices.length / 2);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const priceFirst = avg(prices.slice(0, mid));
  const priceLast = avg(prices.slice(mid));
  const rsiFirst = avg(rsiValues.slice(0, mid));
  const rsiLast = avg(rsiValues.slice(mid));

  if (priceLast < priceFirst && rsiLast > rsiFirst + 3) return 'bullish';
  if (priceLast > priceFirst && rsiLast < rsiFirst - 3) return 'bearish';
  return 'none';
}

// ── Clock-driven ────────────────────────────────────────────────────────────

/** signal_engine.dart:3747 */
export function killZone(clock: EngineClock): string {
  const h = clock.utcHour;
  if (h >= 2 && h < 5) return 'asian_killzone';
  if (h >= 8 && h < 11) return 'london_killzone';
  if (h >= 13 && h < 16) return 'newyork_killzone';
  return 'none';
}

/** signal_engine.dart:3754 — reads LOCAL weekday, unlike the UTC-based rest. */
export function dayOfWeek(clock: EngineClock): string {
  switch (clock.weekday) {
    case 1: return 'monday';
    case 2: return 'tuesday';
    case 3: return 'wednesday';
    case 4: return 'thursday';
    case 5: return 'friday';
    default: return 'weekend';
  }
}

/** signal_engine.dart:3771 */
export function sessionOverlap(clock: EngineClock): string {
  const h = clock.utcHour;
  if (h >= 8 && h < 9) return 'asian_london';
  if (h >= 13 && h < 17) return 'london_newyork';
  return 'none';
}

/** signal_engine.dart:5923 */
export function timeSession(session: string, clock: EngineClock): string {
  const h = clock.utcHour;
  switch (session) {
    case 'london_newyork_overlap': return h >= 13 && h < 17 ? 'active' : 'inactive';
    case 'london': return h >= 8 && h < 16 ? 'active' : 'inactive';
    case 'new_york': return h >= 13 && h < 22 ? 'active' : 'inactive';
    case 'tokyo': return h >= 0 && h < 9 ? 'active' : 'inactive';
    default: return 'inactive';
  }
}

/** signal_engine.dart:3626 */
export function judasSwing(
  candles: readonly Candle[],
  currentPrice: number,
  clock: EngineClock,
): string {
  if (candles.length < 8) return 'none';
  const hour = clock.utcHour;
  const inKZ = (hour >= 8 && hour <= 9) || (hour >= 13 && hour <= 14) || (hour >= 2 && hour <= 3);
  if (!inKZ) return 'none';

  const atrVal = m.atr(candles, 5, currentPrice);
  const rec = candles.slice(Math.max(0, candles.length - 6));
  const mxH = Math.max(...rec.map((c) => c.high));
  const mnL = Math.min(...rec.map((c) => c.low));
  const midC = rec[Math.trunc(rec.length / 2)]!.close;

  if (mnL < rec[0]!.close - atrVal * 1.5 && currentPrice > midC) return 'bullish';
  if (mxH > rec[0]!.close + atrVal * 1.5 && currentPrice < midC) return 'bearish';
  return 'none';
}

// ── Registrations ───────────────────────────────────────────────────────────

register('market_structure', ({ candles, currentPrice }) => marketStructure(candles, currentPrice));
register('break_of_structure', ({ candles, currentPrice }) => {
  const ms = marketStructure(candles, currentPrice);
  return ms === 'break_of_structure_bullish' ? 'bullish'
    : ms === 'break_of_structure_bearish' ? 'bearish' : 'none';
});
register('change_of_character', ({ candles, currentPrice }) => {
  const ms = marketStructure(candles, currentPrice);
  return ms === 'change_of_character_bullish' ? 'bullish'
    : ms === 'change_of_character_bearish' ? 'bearish' : 'none';
});

register('order_block', ({ candles, currentPrice }) => orderBlock(candles, currentPrice));
register('fair_value_gap', ({ candles, currentPrice }) => fairValueGap(candles, currentPrice));
register('liquidity_sweep', ({ candles, currentPrice }) => liquiditySweep(candles, currentPrice));
register('wyckoff_spring', ({ candles, currentPrice }) => wyckoffSpring(candles, currentPrice));
register('wyckoff_upthrust', ({ candles, currentPrice }) => wyckoffUpthrust(candles, currentPrice));
register('session_open', ({ candles, currentPrice }) => sessionOpen(candles, currentPrice));
register('opening_range', ({ candles, currentPrice }) => openingRange(candles, currentPrice));

register('divergence', ({ candles }) => {
  const d = rsiDivergence(candles);
  return d === 'bullish' ? 1.0 : d === 'bearish' ? -1.0 : 0.0;
});



// Both cases read the same ratio in Dart.

// Clock-driven. Note the two differing defaults for the session name.
register('kill_zone', ({ clock }) => killZone(clock));
register('day_of_week', ({ clock }) => dayOfWeek(clock));
register('session_overlap', ({ clock }) => sessionOverlap(clock));
register('session', ({ rule, clock }) => timeSession(rule.pattern ?? 'london', clock));
register('time_analysis', ({ rule, clock }) =>
  timeSession(rule.pattern ?? 'london_newyork_overlap', clock),
);
register('judas_swing', ({ candles, currentPrice, clock }) =>
  judasSwing(candles, currentPrice, clock),
);
