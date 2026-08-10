/**
 * Indicator maths — a literal port of the `_calculate*` helpers in
 * euro_trade/lib/services/signal_engine.dart.
 *
 * These are deliberately NOT textbook implementations. Several of them deviate
 * from the standard formulas (the MACD signal line is a rolling SMA of SMA
 * differences, ADX is really a single-period DX, %D lags %K by dropping the
 * newest sample). Those deviations are what the live app trades on today, so
 * they are reproduced exactly. Where a formula is non-standard it is flagged —
 * the note is a warning to future readers, not an invitation to "fix" it.
 *
 * Line references point at the Dart source.
 */

import type { Candle } from '../types.js';

/** Dart's `num.clamp` — identical semantics to a standard clamp. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** signal_engine.dart:2644 */
export function rsi(candles: readonly Candle[], period: number): number {
  if (candles.length <= period) return 50.0;
  let totalGain = 0.0;
  let totalLoss = 0.0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    if (change > 0) totalGain += change;
    else totalLoss -= change;
  }
  if (totalLoss === 0) return 100.0;
  const rs = totalGain / period / (totalLoss / period);
  return 100.0 - 100.0 / (1.0 + rs);
}

/** signal_engine.dart:2662 */
export function sma(candles: readonly Candle[], period: number, currentPrice: number): number {
  if (candles.length < period) return currentPrice;
  let sum = 0.0;
  for (let i = candles.length - period; i < candles.length; i++) sum += candles[i]!.close;
  return sum / period;
}

/** signal_engine.dart:2672 — seeded with an SMA of the FIRST `period` candles. */
export function ema(candles: readonly Candle[], period: number, currentPrice: number): number {
  if (candles.length < period) return currentPrice;
  let sum = 0.0;
  for (let i = 0; i < period; i++) sum += candles[i]!.close;
  let value = sum / period;
  const k = 2.0 / (period + 1);
  for (let i = period; i < candles.length; i++) {
    value = candles[i]!.close * k + value * (1 - k);
  }
  return value;
}

/** signal_engine.dart:2693 */
export function supportResistance(
  candles: readonly Candle[],
  currentPrice: number,
): { support: number; resistance: number } {
  if (candles.length < 10) {
    return { support: currentPrice * 0.995, resistance: currentPrice * 1.005 };
  }
  const peaks: number[] = [];
  const valleys: number[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1]!, curr = candles[i]!, next = candles[i + 1]!;
    if (curr.high > prev.high && curr.high > next.high) peaks.push(curr.high);
    if (curr.low < prev.low && curr.low < next.low) valleys.push(curr.low);
  }
  const support = valleys.length
    ? Math.min(...valleys)
    : Math.min(...candles.map((c) => c.low));
  const resistance = peaks.length
    ? Math.max(...peaks)
    : Math.max(...candles.map((c) => c.high));
  return { support, resistance };
}

/**
 * signal_engine.dart:2736
 * Note: the standard deviation is taken around the SMA of the SAME window,
 * and divides by `period` (population), not `period - 1`.
 */
export function bollingerBands(
  candles: readonly Candle[],
  period: number,
  currentPrice: number,
  stdDevMult = 2.0,
): { upper: number; lower: number; middle: number } {
  const mid = sma(candles, period, currentPrice);
  if (candles.length < period) {
    return { upper: mid * 1.002, lower: mid * 0.998, middle: mid };
  }
  let varianceSum = 0.0;
  for (let i = candles.length - period; i < candles.length; i++) {
    varianceSum += (candles[i]!.close - mid) ** 2;
  }
  const stdDev = Math.sqrt(varianceSum / period);
  return {
    upper: mid + stdDevMult * stdDev,
    lower: mid - stdDevMult * stdDev,
    middle: mid,
  };
}

/**
 * signal_engine.dart:2757
 * NON-STANDARD: the MACD line is a real EMA(12) − EMA(26), but the signal line
 * is the mean of the last 9 *SMA-based* MACD approximations, not an EMA(9) of
 * the MACD line. Reproduced verbatim.
 */
export function fullMacd(
  candles: readonly Candle[],
  currentPrice: number,
): { macd: number; signal: number; histogram: number } {
  const ema12 = ema(candles, 12, currentPrice);
  const ema26 = ema(candles, 26, currentPrice);
  const macdLine = ema12 - ema26;

  if (candles.length < 26) return { macd: macdLine, signal: 0.0, histogram: macdLine };

  const macdValues: number[] = [];
  for (let i = Math.max(0, candles.length - 9); i < candles.length; i++) {
    let sum12 = 0, sum26 = 0, cnt12 = 0, cnt26 = 0;
    for (let j = Math.max(0, i - 11); j <= i; j++) { sum12 += candles[j]!.close; cnt12++; }
    for (let j = Math.max(0, i - 25); j <= i; j++) { sum26 += candles[j]!.close; cnt26++; }
    macdValues.push(sum12 / cnt12 - sum26 / cnt26);
  }

  const signal = macdValues.length
    ? macdValues.reduce((a, b) => a + b, 0) / macdValues.length
    : 0.0;
  return { macd: macdLine, signal, histogram: macdLine - signal };
}

/** signal_engine.dart:2792 */
export function atr(candles: readonly Candle[], period: number, currentPrice: number): number {
  if (candles.length < period + 1) return currentPrice * 0.001;
  let totalTR = 0.0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i]!, prev = candles[i - 1]!;
    const tr1 = curr.high - curr.low;
    const tr2 = Math.abs(curr.high - prev.close);
    const tr3 = Math.abs(curr.low - prev.close);
    totalTR += Math.max(tr1, Math.max(tr2, tr3));
  }
  return totalTR / period;
}

/**
 * signal_engine.dart:2808
 * NON-STANDARD: raw %K uses `currentPrice`, while the smoothing samples use
 * candle closes. %D is the mean of the smoothing samples with the newest one
 * dropped, so that %K and %D actually differ and `stoch_cross` is non-zero.
 */
export function stochastic(
  candles: readonly Candle[],
  period: number,
  smoothK: number,
  currentPrice: number,
): { k: number; d: number } {
  if (candles.length < period) return { k: 50.0, d: 50.0 };

  let highestHigh = -Infinity;
  let lowestLow = Infinity;
  for (let i = candles.length - period; i < candles.length; i++) {
    if (candles[i]!.high > highestHigh) highestHigh = candles[i]!.high;
    if (candles[i]!.low < lowestLow) lowestLow = candles[i]!.low;
  }

  const range = highestHigh - lowestLow;
  let rawK = range === 0 ? 50.0 : ((currentPrice - lowestLow) / range) * 100.0;
  rawK = clamp(rawK, 0.0, 100.0);

  const kValues: number[] = [];
  for (let s = 0; s < smoothK && s < candles.length - period; s++) {
    const offset = candles.length - period - s;
    if (offset < 0) break;
    let hh = -Infinity, ll = Infinity;
    for (let i = offset; i < offset + period && i < candles.length; i++) {
      if (candles[i]!.high > hh) hh = candles[i]!.high;
      if (candles[i]!.low < ll) ll = candles[i]!.low;
    }
    const r = hh - ll;
    const idx = Math.min(offset + period - 1, candles.length - 1);
    kValues.push(r === 0 ? 50.0 : ((candles[idx]!.close - ll) / r) * 100.0);
  }
  kValues.unshift(rawK);

  const smoothedK = kValues.reduce((a, b) => a + b, 0) / kValues.length;
  const smoothedD =
    kValues.length > 1
      ? kValues.slice(1).reduce((a, b) => a + b, 0) / (kValues.length - 1)
      : smoothedK;

  return { k: clamp(smoothedK, 0.0, 100.0), d: clamp(smoothedD, 0.0, 100.0) };
}

/** signal_engine.dart:2859 */
export function obv(candles: readonly Candle[]): number {
  if (candles.length < 2) return 0.0;
  let value = 0.0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.close > candles[i - 1]!.close) value += candles[i]!.volume;
    else if (candles[i]!.close < candles[i - 1]!.close) value -= candles[i]!.volume;
  }
  return value;
}

/** signal_engine.dart:2873 */
export function vwap(candles: readonly Candle[], currentPrice: number): number {
  if (candles.length === 0) return currentPrice;
  let cumVolumePrice = 0.0, cumVolume = 0.0;
  for (const c of candles) {
    cumVolumePrice += ((c.high + c.low + c.close) / 3.0) * c.volume;
    cumVolume += c.volume;
  }
  return cumVolume === 0 ? currentPrice : cumVolumePrice / cumVolume;
}

/** signal_engine.dart:2886 */
export function cmf(candles: readonly Candle[], period: number): number {
  if (candles.length < period) return 0.0;
  let mfvSum = 0.0, volSum = 0.0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]!;
    const hl = c.high - c.low;
    const mult = hl === 0 ? 0.0 : (c.close - c.low - (c.high - c.close)) / hl;
    mfvSum += mult * c.volume;
    volSum += c.volume;
  }
  return volSum === 0 ? 0.0 : clamp(mfvSum / volSum, -1.0, 1.0);
}

/** signal_engine.dart:2903 — fixed 5-candle window, ignores `period`. */
export function volumeDelta(candles: readonly Candle[]): number {
  if (candles.length < 5) return 0.0;
  let buyVolume = 0.0, sellVolume = 0.0;
  for (let i = candles.length - 5; i < candles.length; i++) {
    const c = candles[i]!;
    const bodyRatio = c.high === c.low ? 0.5 : (c.close - c.low) / (c.high - c.low);
    buyVolume += c.volume * bodyRatio;
    sellVolume += c.volume * (1.0 - bodyRatio);
  }
  const total = buyVolume + sellVolume;
  return total === 0 ? 0.0 : ((buyVolume - sellVolume) / total) * 100.0;
}

/** signal_engine.dart:2989 — measured against `currentPrice`, not the last close. */
export function williamsR(
  candles: readonly Candle[],
  period: number,
  currentPrice: number,
): number {
  if (candles.length < period) return -50.0;
  let highestHigh = -Infinity, lowestLow = Infinity;
  for (let i = candles.length - period; i < candles.length; i++) {
    if (candles[i]!.high > highestHigh) highestHigh = candles[i]!.high;
    if (candles[i]!.low < lowestLow) lowestLow = candles[i]!.low;
  }
  const range = highestHigh - lowestLow;
  if (range === 0) return -50.0;
  return ((highestHigh - currentPrice) / range) * -100.0;
}

/** signal_engine.dart:3003 */
export function cci(candles: readonly Candle[], period: number): number {
  if (candles.length < period) return 0.0;
  const typicalPrices: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    typicalPrices.push((candles[i]!.high + candles[i]!.low + candles[i]!.close) / 3.0);
  }
  const mean = typicalPrices.reduce((a, b) => a + b, 0) / typicalPrices.length;
  const meanDeviation =
    typicalPrices.map((tp) => Math.abs(tp - mean)).reduce((a, b) => a + b, 0) /
    typicalPrices.length;
  if (meanDeviation === 0) return 0.0;
  const last = candles[candles.length - 1]!;
  const currentTP = (last.high + last.low + last.close) / 3.0;
  return (currentTP - mean) / (0.015 * meanDeviation);
}

/** signal_engine.dart:3022 */
export function mfi(candles: readonly Candle[], period: number): number {
  if (candles.length < period + 1) return 50.0;
  let posFlow = 0.0, negFlow = 0.0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    const tp = (c.high + c.low + c.close) / 3.0;
    const prevTp = (p.high + p.low + p.close) / 3.0;
    const rawMF = tp * c.volume;
    if (tp > prevTp) posFlow += rawMF;
    else negFlow += rawMF;
  }
  if (negFlow === 0) return 100.0;
  return 100.0 - 100.0 / (1.0 + posFlow / negFlow);
}

/** signal_engine.dart:3045 */
export function roc(candles: readonly Candle[], period: number, currentPrice: number): number {
  if (candles.length < period + 1) return 0.0;
  const pastPrice = candles[candles.length - period - 1]!.close;
  if (pastPrice === 0) return 0.0;
  return ((currentPrice - pastPrice) / pastPrice) * 100.0;
}

/**
 * signal_engine.dart:3053
 * NON-STANDARD: `adx` here is a single-period DX, not a smoothed 14-period ADX,
 * and +DI/-DI are not Wilder-smoothed. Kept as-is.
 */
export function adxFull(
  candles: readonly Candle[],
  period: number,
): { adx: number; plusDi: number; minusDi: number } {
  const fallback = { adx: 25.0, plusDi: 50.0, minusDi: 50.0 };
  if (candles.length < period + 1) return fallback;

  let plusDmSum = 0, minusDmSum = 0, trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i]!, prev = candles[i - 1]!;
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(
      curr.high - curr.low,
      Math.max(Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)),
    );
    plusDmSum += plusDm;
    minusDmSum += minusDm;
    trSum += tr;
  }

  if (trSum === 0) return fallback;

  const plusDi = (plusDmSum / trSum) * 100;
  const minusDi = (minusDmSum / trSum) * 100;
  const diSum = plusDi + minusDi;
  if (diSum === 0) return { adx: 25.0, plusDi, minusDi };

  const dx = (Math.abs(plusDi - minusDi) / diSum) * 100;
  return { adx: clamp(dx, 0.0, 100.0), plusDi, minusDi };
}
