/**
 * Statistical / quantitative indicators and the remaining detectors — batch 9.
 * Ported literally from signal_engine.dart.
 *
 * Two entries here cannot be value-matched against the Dart golden fixture and
 * are handled explicitly rather than quietly:
 *   • monte_carlo_risk_simulation — draws 200 pseudo-random samples per call.
 *   • kelly_criterion             — reads the user's signal history, which is
 *                                   engine state, not candle data.
 * Both are still ported faithfully; see the notes on each.
 */

import { register } from '../registry.js';
import type { Candle } from '../types.js';
import * as m from './math.js';
import { avgBodySize, swingPoints } from './patterns.js';
import { volumeProfileStats, wyckoffSpring } from './structure.js';
import { harmonic } from './ict.js';
import { insideBar } from './extended.js';

const idiv = (a: number, b: number): number => Math.trunc(a / b);

// ── Wyckoff-adjacent ────────────────────────────────────────────────────────

/** signal_engine.dart:3694 — quiet volatility plus rising lows. */
export function accumulation(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  if (m.atr(candles, 5, currentPrice) >= m.atr(candles, 20, currentPrice) * 0.7) return 'none';
  const rL = Math.min(...candles.slice(Math.max(0, candles.length - 5)).map((c) => c.low));
  const pL = Math.min(
    ...candles.slice(Math.max(0, candles.length - 20), candles.length - 5).map((c) => c.low),
  );
  return rL > pL ? 'bullish' : 'none';
}

/** signal_engine.dart:3708 */
export function distribution(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  if (m.atr(candles, 5, currentPrice) >= m.atr(candles, 20, currentPrice) * 0.7) return 'none';
  const rH = Math.max(...candles.slice(Math.max(0, candles.length - 5)).map((c) => c.high));
  const pH = Math.max(
    ...candles.slice(Math.max(0, candles.length - 20), candles.length - 5).map((c) => c.high),
  );
  return rH < pH ? 'bearish' : 'none';
}

/** signal_engine.dart:3722 — note the INVERTED reading: a big down bar is bullish. */
export function manipulation(candles: readonly Candle[]): string {
  if (candles.length < 8) return 'none';
  const avg = avgBodySize(candles);
  const tail = candles.slice(Math.max(0, candles.length - 5));
  for (let i = tail.length - 1; i >= 0; i--) {
    const c = tail[i]!;
    if (Math.abs(c.close - c.open) > avg * 3) return c.close < c.open ? 'bullish' : 'bearish';
  }
  return 'none';
}

/** signal_engine.dart:4384 — Dow theory: higher highs and higher lows. */
export function dowTrend(candles: readonly Candle[]): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, 40, 2);
  if (h.length < 2 || l.length < 2) return 'none';
  const up = h[h.length - 1]! > h[h.length - 2]! && l[l.length - 1]! > l[l.length - 2]!;
  const down = h[h.length - 1]! < h[h.length - 2]! && l[l.length - 1]! < l[l.length - 2]!;
  if (up) return 'uptrend';
  if (down) return 'downtrend';
  return 'sideways';
}

// ── Elliott ─────────────────────────────────────────────────────────────────

/**
 * signal_engine.dart:3274 — labels the wave, then filters by `rule.pattern`.
 * Returns a DIRECTION ('bullish'/'bearish'), not the wave label; the label is
 * only used to decide whether the requested wave matched.
 */
export function elliottWave(
  candles: readonly Candle[],
  targetWave: string | null,
): string {
  if (candles.length < 30) return 'none';

  const highPrices: number[] = [], highIdxs: number[] = [];
  const lowPrices: number[] = [], lowIdxs: number[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const h = candles[i]!.high, l = candles[i]!.low;
    if (
      h > candles[i - 1]!.high && h > candles[i - 2]!.high &&
      h > candles[i + 1]!.high && h > candles[i + 2]!.high
    ) { highPrices.push(h); highIdxs.push(i); }
    if (
      l < candles[i - 1]!.low && l < candles[i - 2]!.low &&
      l < candles[i + 1]!.low && l < candles[i + 2]!.low
    ) { lowPrices.push(l); lowIdxs.push(i); }
  }
  if (highPrices.length < 2 || lowPrices.length < 2) return 'none';

  const lhPrice = highPrices[highPrices.length - 1]!;
  const phPrice = highPrices[highPrices.length - 2]!;
  const llPrice = lowPrices[lowPrices.length - 1]!;
  const plPrice = lowPrices[lowPrices.length - 2]!;
  const lhIdx = highIdxs[highIdxs.length - 1]!;
  const llIdx = lowIdxs[lowIdxs.length - 1]!;

  let detectedWave: string, direction: string;

  if (lhIdx > llIdx) {
    const impulse = lhPrice - plPrice;
    const prevDown = phPrice - llPrice;
    if (impulse > prevDown * 1.3 && lhPrice > phPrice && llPrice > plPrice) {
      detectedWave = '3'; direction = 'bullish';
    } else if (lhPrice > phPrice) {
      detectedWave = impulse < prevDown ? '5' : '1'; direction = 'bullish';
    } else {
      detectedWave = 'B'; direction = 'bearish';
    }
  } else {
    const downSize = lhPrice - llPrice;
    const prevUp = lhPrice - plPrice;
    const retrace = prevUp > 0 ? downSize / prevUp : 0.5;
    if (llPrice < plPrice && lhPrice < phPrice) {
      detectedWave = downSize > prevUp * 1.3 ? '3' : 'C'; direction = 'bearish';
    } else if (retrace >= 0.382 && retrace <= 0.786) {
      detectedWave = '2'; direction = 'bearish';
    } else {
      detectedWave = 'C'; direction = 'bearish';
    }
  }

  if (targetWave != null && targetWave.length > 0 && detectedWave !== targetWave) return 'none';
  return direction;
}

/** signal_engine.dart:5873 — rejection at a Fibonacci level, confirmed by the last candle. */
export function fibonacci(candles: readonly Candle[], currentPrice: number, level: number): string {
  if (candles.length < 20) return 'none';
  const recent = candles.slice(Math.max(0, candles.length - 30));
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const swingLow = Math.min(...recent.map((c) => c.low));
  const range = swingHigh - swingLow;
  if (range < 0.0001) return 'none';

  const fibUp = swingLow + range * level;
  const fibDown = swingHigh - range * level;
  const tol = range * 0.05;
  const last = candles[candles.length - 1]!;
  const prev = candles.length > 1 ? candles[candles.length - 2]! : last;

  if (Math.abs(currentPrice - fibUp) < tol && last.close > last.open && last.close > prev.close) {
    return 'bullish_rejection';
  }
  if (Math.abs(currentPrice - fibDown) < tol && last.close < last.open && last.close < prev.close) {
    return 'bearish_rejection';
  }
  return 'none';
}

// ── DeMark / statistical ────────────────────────────────────────────────────

/** signal_engine.dart:5466 — TD combo; counters are read after the full pass. */
export function tdCombo(candles: readonly Candle[]): string {
  if (candles.length < 14) return 'none';
  let up = 0, dn = 0;
  for (let i = 2; i < candles.length; i++) {
    const c = candles[i]!;
    up = c.close > candles[i - 2]!.close && c.close > candles[i - 1]!.close ? up + 1 : 0;
    dn = c.close < candles[i - 2]!.close && c.close < candles[i - 1]!.close ? dn + 1 : 0;
  }
  if (up >= 13) return 'sell_signal';
  if (dn >= 13) return 'buy_signal';
  return 'none';
}

/** signal_engine.dart:5645 — DeMark pivot, X varies with the candle's direction. */
export function demarkPivot(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 2) return 'none';
  const c = candles[candles.length - 2]!;
  let x: number;
  if (c.close < c.open) x = c.high + 2 * c.low + c.close;
  else if (c.close > c.open) x = 2 * c.high + c.low + c.close;
  else x = c.high + c.low + 2 * c.close;

  const p = x / 4, r1 = x / 2 - c.low, s1 = x / 2 - c.high;
  if (currentPrice > r1) return 'above_r1';
  if (currentPrice < s1) return 'below_s1';
  return currentPrice > p ? 'above_p' : 'below_p';
}

/** signal_engine.dart:5492 — population stdev, measured against currentPrice. */
export function zScore(candles: readonly Candle[], period: number, currentPrice: number): number {
  const n = Math.min(period, candles.length);
  const cl = candles.slice(candles.length - n).map((c) => c.close);
  const mean = cl.reduce((a, b) => a + b, 0) / cl.length;
  const v = cl.reduce((a, c) => a + (c - mean) ** 2, 0);
  const sd = Math.sqrt(v / cl.length);
  return sd > 0 ? (currentPrice - mean) / sd : 0;
}

/** signal_engine.dart:5511 — SMA(5) ± 1.5 × ATR(15). */
export function starcBands(candles: readonly Candle[], currentPrice: number): string {
  const mid = m.sma(candles, Math.min(5, candles.length), currentPrice);
  const a = m.atr(candles, Math.min(15, candles.length), currentPrice);
  if (currentPrice > mid + 1.5 * a) return 'above_upper';
  if (currentPrice < mid - 1.5 * a) return 'below_lower';
  return currentPrice > mid ? 'upper_half' : 'lower_half';
}

/** signal_engine.dart — NR4: the newest bar has the narrowest range of the last 4. */
export function nr4(candles: readonly Candle[]): string {
  if (candles.length < 4) return 'none';
  const r = (i: number): number =>
    candles[candles.length - 1 - i]!.high - candles[candles.length - 1 - i]!.low;
  return r(0) <= r(1) && r(0) <= r(2) && r(0) <= r(3) ? 'nr4' : 'none';
}

/** signal_engine.dart:5551 — inside bar AND NR4. */
export function idnr4(candles: readonly Candle[]): string {
  if (insideBar(candles) === 'none') return 'none';
  return nr4(candles) === 'nr4' ? 'idnr4' : 'none';
}

/** signal_engine.dart:5557 — the "session" is just the first two candles. */
export function initialBalance(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 3) return 'none';
  const ibH = Math.max(candles[0]!.high, candles[1]!.high);
  const ibL = Math.min(candles[0]!.low, candles[1]!.low);
  if (currentPrice > ibH) return 'above_ibh';
  if (currentPrice < ibL) return 'below_ibl';
  return 'inside_ib';
}

/**
 * signal_engine.dart:5567 — ICT Silver Bullet.
 *
 * DEAD CODE IN THE ORIGINAL: it guards on
 *   `_detectTimeSession('new_york') != 'new_york'`
 * but that helper only ever returns 'active' or 'inactive', so the guard is
 * always true and the function always returns 'none'. Any rule using
 * `silver_bullet` therefore contributes nothing today.
 *
 * Reproduced exactly — fixing it would change live signal scoring.
 */
export function silverBullet(): string {
  return 'none';
}

/** signal_engine.dart:5582 — body ≥ 2.5× the average. */
export function institutionalCandle(candles: readonly Candle[]): string {
  const c = candles[candles.length - 1]!;
  if (Math.abs(c.close - c.open) < avgBodySize(candles) * 2.5) return 'none';
  return c.close > c.open ? 'bullish_institutional' : 'bearish_institutional';
}

/** signal_engine.dart:5589 */
export function reaccumulation(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, 20, 2);
  if (h.length < 2 || l.length < 2) return 'none';
  const isUp = h[h.length - 1]! > h[h.length - 2]! && l[l.length - 1]! > l[l.length - 2]!;
  const vr = volumeProfileStats(candles).ratio;
  const atrR = m.atr(candles, 5, currentPrice) / m.atr(candles, 14, currentPrice);
  return isUp && vr < 0.8 && atrR < 0.7 ? 'reaccumulation' : 'none';
}

/** signal_engine.dart:5601 */
export function redistribution(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const { h, l } = swingPoints(candles, 20, 2);
  if (h.length < 2 || l.length < 2) return 'none';
  const isDown = h[h.length - 1]! < h[h.length - 2]! && l[l.length - 1]! < l[l.length - 2]!;
  const vr = volumeProfileStats(candles).ratio;
  const atrR = m.atr(candles, 5, currentPrice) / m.atr(candles, 14, currentPrice);
  return isDown && vr < 0.8 && atrR < 0.7 ? 'redistribution' : 'none';
}

/** signal_engine.dart:5613 — two adjacent bars with near-equal high (or low). */
export function pipePattern(candles: readonly Candle[], currentPrice: number, top: boolean): string {
  if (candles.length < 2) return 'none';
  const c = candles[candles.length - 1]!, p = candles[candles.length - 2]!;
  const thresh = m.atr(candles, 14, currentPrice) * 0.15;
  if (top && Math.abs(c.high - p.high) < thresh) return 'pipe_top';
  if (!top && Math.abs(c.low - p.low) < thresh) return 'pipe_bottom';
  return 'none';
}

/** signal_engine.dart:5623 */
export function bumpAndRun(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 25) return 'none';
  const lead = candles.slice(candles.length - 25, candles.length - 10);
  const bump = candles.slice(candles.length - 10, candles.length - 2);
  const avgRange = (xs: readonly Candle[]): number =>
    xs.reduce((a, c) => a + (c.high - c.low), 0) / xs.length;
  if (avgRange(bump) < avgRange(lead) * 2) return 'none';

  const leadAvg = lead.reduce((a, c) => a + c.close, 0) / lead.length;
  const bumpFirst = bump[0]!.close, bumpLast = bump[bump.length - 1]!.close;
  if (currentPrice < leadAvg && bumpLast < bumpFirst) return 'bearish_run';
  if (currentPrice > leadAvg && bumpLast > bumpFirst) return 'bullish_run';
  return 'none';
}

// ── Quantitative ────────────────────────────────────────────────────────────

/** signal_engine.dart:5665 — rescaled-range Hurst exponent, clamped to [0,1]. */
export function hurstExponent(candles: readonly Candle[]): number {
  if (candles.length < 20) return 0.5;
  const n = Math.min(40, candles.length);
  const prices = candles.slice(candles.length - n).map((c) => c.close);
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) rets.push(prices[i]! - prices[i - 1]!);
  if (!rets.length) return 0.5;

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  let cum = 0;
  const cumDev: number[] = [];
  for (const r of rets) { cum += r - mean; cumDev.push(cum); }

  const R = Math.max(...cumDev) - Math.min(...cumDev);
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0);
  const S = Math.sqrt(variance / rets.length);
  if (S < 1e-10 || R <= 0) return 0.5;
  return m.clamp(Math.log(R / S) / Math.log(rets.length), 0.0, 1.0);
}

/** signal_engine.dart:5694 — Shannon entropy over up/down/flat, normalised by ln 3. */
export function entropyAnalysis(candles: readonly Candle[]): string {
  if (candles.length < 10) return 'none';
  const n = Math.min(30, candles.length - 1);
  let up = 0, dn = 0, flat = 0;
  for (let i = candles.length - n; i < candles.length - 1; i++) {
    const d = candles[i + 1]!.close - candles[i]!.close;
    if (d > 0.00005) up++;
    else if (d < -0.00005) dn++;
    else flat++;
  }
  const total = up + dn + flat;
  if (total === 0) return 'none';
  let entropy = 0;
  for (const cnt of [up, dn, flat]) {
    if (cnt > 0) { const p = cnt / total; entropy -= p * Math.log(p); }
  }
  const norm = entropy / Math.log(3);
  if (norm > 0.95) return 'high_entropy';
  if (norm < 0.60) return 'low_entropy';
  return 'medium_entropy';
}

/** signal_engine.dart:5722 */
export function marketRegime(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const adx = m.adxFull(candles, 14).adx;
  const rAtr = m.atr(candles, 5, currentPrice);
  const lAtr = m.atr(candles, 20, currentPrice);
  if (adx > 30 && rAtr > lAtr * 1.2) return 'trending_volatile';
  if (adx > 25) return 'trending';
  if (rAtr < lAtr * 0.7) return 'quiet_ranging';
  return 'ranging';
}

/** signal_engine.dart:5733 */
export function volatilityRegime(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const rAtr = m.atr(candles, 5, currentPrice);
  const lAtr = m.atr(candles, 20, currentPrice);
  if (rAtr > lAtr * 1.5) return 'high';
  if (rAtr < lAtr * 0.6) return 'low';
  return 'normal';
}

/** signal_engine.dart:5742 — a ±2.5 sigma move against the last 20 closes. */
export function anomaly(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 20) return 'none';
  const n = Math.min(20, candles.length);
  const closes = candles.slice(candles.length - n).map((c) => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const variance = closes.reduce((a, c) => a + (c - mean) ** 2, 0);
  const sd = Math.sqrt(variance / closes.length);
  if (sd < 1e-10) return 'none';
  const z = (currentPrice - mean) / sd;
  if (z > 2.5) return 'anomaly_up';
  if (z < -2.5) return 'anomaly_down';
  return 'normal';
}

/** signal_engine.dart:5762 — a gap wider than 3 × ATR that price now sits inside. */
export function liquidityVoid(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 5) return 'none';
  const a = m.atr(candles, 14, currentPrice);
  for (let i = candles.length - 2; i >= 1; i--) {
    const gapUp = candles[i]!.low - candles[i - 1]!.high;
    const gapDown = candles[i - 1]!.low - candles[i]!.high;
    if (gapUp > a * 3 && currentPrice >= candles[i - 1]!.high && currentPrice <= candles[i]!.low) {
      return 'bullish';
    }
    if (gapDown > a * 3 && currentPrice >= candles[i]!.high && currentPrice <= candles[i - 1]!.low) {
      return 'bearish';
    }
  }
  return 'none';
}

/** signal_engine.dart:5782 — dominant autocorrelation lag over the last 30 closes. */
export function spectralCycle(candles: readonly Candle[]): string {
  if (candles.length < 20) return 'none';
  const n = Math.min(30, candles.length);
  const series = candles.slice(candles.length - n).map((c) => c.close);
  const mean = series.reduce((a, b) => a + b, 0) / series.length;

  let maxCorr = 0, domPeriod = 0;
  for (let lag = 2; lag <= Math.min(15, idiv(n, 2)); lag++) {
    let corr = 0, denom = 0;
    for (let i = lag; i < series.length; i++) {
      corr += (series[i]! - mean) * (series[i - lag]! - mean);
      denom += (series[i]! - mean) ** 2;
    }
    if (denom > 0 && Math.abs(corr / denom) > maxCorr) {
      maxCorr = Math.abs(corr / denom);
      domPeriod = lag;
    }
  }
  if (domPeriod <= 0) return 'none';
  if (domPeriod <= 5) return 'short_cycle';
  if (domPeriod <= 10) return 'medium_cycle';
  return 'long_cycle';
}

/** signal_engine.dart:5832 — EMA 5/13/34 agreement. */
export function waveletTrend(candles: readonly Candle[], currentPrice: number): string {
  if (candles.length < 34) return 'none';
  const f = m.ema(candles, Math.min(5, candles.length), currentPrice);
  const mid = m.ema(candles, Math.min(13, candles.length), currentPrice);
  const s = m.ema(candles, Math.min(34, candles.length), currentPrice);
  const bull = (f > mid ? 1 : 0) + (mid > s ? 1 : 0) + (f > s ? 1 : 0);
  if (bull === 3) return 'bullish';
  if (bull === 0) return 'bearish';
  return 'mixed';
}

/**
 * signal_engine.dart:5809 — Monte Carlo risk simulation.
 *
 * NOT DETERMINISTIC: 200 Box-Muller samples from the engine's `Random`. Two runs
 * on identical candles can disagree, so this is the one indicator whose value
 * cannot be diffed against the Dart golden fixture. `rng` is injectable so the
 * behaviour can still be tested with a seeded source.
 */
export function monteCarlo(
  candles: readonly Candle[],
  currentPrice: number,
  rng: () => number = Math.random,
): string {
  if (candles.length < 20) return 'none';
  const vol = m.atr(candles, 14, currentPrice) / currentPrice;
  const lb = Math.min(14, candles.length - 1);
  const base = candles[candles.length - 1 - lb]!.close;
  const drift = (candles[candles.length - 1]!.close - base) / base / lb;

  let upCount = 0;
  for (let s = 0; s < 200; s++) {
    const u1 = m.clamp(rng(), 1e-10, 1.0);
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const fp = currentPrice * Math.exp((drift - 0.5 * vol * vol) * 5 + vol * Math.sqrt(5.0) * z);
    if (fp > currentPrice) upCount++;
  }
  if (upCount > 130) return 'bullish';
  if (upCount < 70) return 'bearish';
  return 'neutral';
}

/**
 * signal_engine.dart:5843 — simplified Kelly from the user's own signal history.
 * Depends on engine state, not candles; with fewer than 10 past signals it is 0.
 */
export function kellyValue(history: ReadonlyArray<{ status: string }>): number {
  if (history.length < 10) return 0.0;
  const wins = history.filter((s) => s.status === 'WIN').length;
  const w = wins / history.length;
  if (w <= 0 || w >= 1) return 0.0;
  return m.clamp(w - (1 - w), -1.0, 1.0);
}

// ── Registrations ───────────────────────────────────────────────────────────

register('accumulation', ({ candles, currentPrice }) => accumulation(candles, currentPrice));
register('distribution', ({ candles, currentPrice }) => distribution(candles, currentPrice));
register('manipulation', ({ candles }) => manipulation(candles));
register(['dow_theory', 'trend_following'], ({ candles }) => dowTrend(candles));
register('elliott_wave', ({ candles, rule }) => elliottWave(candles, rule.pattern));
register('fibonacci', ({ candles, currentPrice, rule }) =>
  fibonacci(candles, currentPrice, rule.value ?? 0.618),
);

register('td_combo', ({ candles }) => tdCombo(candles));
register(['demark_p', 'demark_pivot'], ({ candles, currentPrice }) =>
  demarkPivot(candles, currentPrice),
);
register('z_score', ({ candles, rule, currentPrice }) => zScore(candles, rule.period, currentPrice));
register(['starc', 'starc_bands'], ({ candles, currentPrice }) => starcBands(candles, currentPrice));
register('idnr4', ({ candles }) => idnr4(candles));
register(['ib', 'initial_balance'], ({ candles, currentPrice }) =>
  initialBalance(candles, currentPrice),
);
register('institutional_candle', ({ candles }) => institutionalCandle(candles));
register('pipe_top', ({ candles, currentPrice }) => pipePattern(candles, currentPrice, true));
register('pipe_bottom', ({ candles, currentPrice }) => pipePattern(candles, currentPrice, false));
register('bump_and_run', ({ candles, currentPrice }) => bumpAndRun(candles, currentPrice));

register('hurst_exponent', ({ candles }) => hurstExponent(candles));
register('fractal_dimension', ({ candles }) => 2.0 - hurstExponent(candles));
register('entropy_analysis', ({ candles }) => entropyAnalysis(candles));
register(['market_regime_classification', 'regime_detection'], ({ candles, currentPrice }) =>
  marketRegime(candles, currentPrice),
);
register('volatility_regime_analysis', ({ candles, currentPrice }) => volatilityRegime(candles, currentPrice));
register('anomaly_detection', ({ candles, currentPrice }) => anomaly(candles, currentPrice));
register('liquidity_voids', ({ candles, currentPrice }) => liquidityVoid(candles, currentPrice));
register('spectral_analysis', ({ candles }) => spectralCycle(candles));
register('wavelet_decomposition', ({ candles, currentPrice }) => waveletTrend(candles, currentPrice));
register('monte_carlo_risk_simulation', ({ candles, currentPrice }) =>
  monteCarlo(candles, currentPrice),
);
// History is not part of the indicator context; with none supplied this matches
// the engine's own "fewer than 10 signals" path, which returns 0.

// `three_drives` routes to the harmonic detector with an unrecognised type, so
// the switch inside it falls to `default: matches = false` → always 'none'.
// `wyckoff` is a second name for the spring detector.
register('wyckoff', ({ candles, currentPrice }) => wyckoffSpring(candles, currentPrice));
