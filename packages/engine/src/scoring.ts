/**
 * The V2 parametric scorer — `_scoreV2Engine` in signal_engine.dart.
 *
 * Used only when no rule-based strategy is loaded; when one is, the Dart code
 * delegates straight to `_evaluateRules` and none of this runs.
 *
 * Five weighted tiers, then two damping filters. The order matters in two
 * places and both are marked below: the volume-spike bonus reads the running
 * totals, and the damping multiplies whatever has accumulated so far.
 */

import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from './config.js';
import * as m from './indicators/math.js';
import { candlePatterns } from './indicators/patterns.js';
import { liquidityZones, rsiDivergence, volumeProfileStats } from './indicators/structure.js';
import { evaluateRules, type DynamicStrategy, type EvalContext } from './strategy.js';
import type { Candle } from './types.js';

const BULLISH_PATTERNS = new Set([
  'bullish_engulfing', 'hammer', 'morning_star', 'three_white_soldiers', 'pin_bar_bullish',
]);
const BEARISH_PATTERNS = new Set([
  'bearish_engulfing', 'shooting_star', 'evening_star', 'three_black_crows', 'pin_bar_bearish',
]);

/**
 * signal_engine.dart — `_scoreV2Engine`.
 * Returns a signed score: positive favours CALL, negative favours PUT.
 */
export function scoreV2(
  candles: readonly Candle[],
  currentPrice: number,
  cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): number {
  let callScore = 0.0;
  let putScore = 0.0;

  const emaP = cfg.emaPeriods;
  const ema1 = m.ema(candles, emaP[0]!, currentPrice);
  const ema2 = m.ema(candles, emaP.length > 1 ? emaP[1]! : 21, currentPrice);
  const ema3 = m.ema(
    candles,
    Math.min(emaP.length > 2 ? emaP[2]! : 50, candles.length),
    currentPrice,
  );

  const rsiVal = m.rsi(candles, cfg.rsiPeriod);
  const macd = m.fullMacd(candles, currentPrice);
  const bb = m.bollingerBands(candles, cfg.bbPeriod, currentPrice, cfg.bbStddev);
  const sr = m.supportResistance(candles, currentPrice);
  const stoch = m.stochastic(candles, cfg.stochPeriod, cfg.stochSmooth, currentPrice);
  const adx = m.adxFull(candles, cfg.adxPeriod);
  const vwapVal = m.vwap(candles, currentPrice);
  const cmfVal = m.cmf(candles, cfg.cmfPeriod);
  const volDelta = m.volumeDelta(candles);
  const liq = liquidityZones(candles, currentPrice);
  const williamsRVal = m.williamsR(candles, cfg.williamsPeriod, currentPrice);
  const cciVal = m.cci(candles, cfg.cciPeriod);
  const mfiVal = m.mfi(candles, cfg.mfiPeriod);
  const rocVal = m.roc(candles, cfg.rocPeriod, currentPrice);
  const volProfile = volumeProfileStats(candles);
  const divergence = rsiDivergence(candles);
  const pattern = candlePatterns(candles);

  const { tier1Weight: w1, tier2Weight: w2, tier3Weight: w3, tier4Weight: w4, tier5Weight: w5 } = cfg;

  // ── TIER 1: primary trend ─────────────────────────────────────────────────
  if (ema1 > ema2 && ema2 > ema3) callScore += w1;
  else if (ema1 < ema2 && ema2 < ema3) putScore += w1;
  else if (ema1 > ema2) callScore += w1 / 2;
  else putScore += w1 / 2;

  if (macd.histogram > 0 && macd.macd > macd.signal) callScore += w1;
  else if (macd.histogram < 0 && macd.macd < macd.signal) putScore += w1;
  else if (macd.histogram > 0) callScore += w1 / 2;
  else putScore += w1 / 2;

  if (adx.adx > cfg.adxStrong) {
    if (adx.plusDi > adx.minusDi) callScore += w1;
    else putScore += w1;
  } else if (adx.adx > cfg.adxModerate) {
    if (adx.plusDi > adx.minusDi) callScore += w1 / 3;
    else putScore += w1 / 3;
  }

  // ── TIER 2: momentum ──────────────────────────────────────────────────────
  if (rsiVal < cfg.rsiOversoldExtreme) callScore += w2;
  else if (rsiVal > cfg.rsiOverboughtExtreme) putScore += w2;
  else if (rsiVal < cfg.rsiOversold) callScore += w2 * 0.6;
  else if (rsiVal > cfg.rsiOverbought) putScore += w2 * 0.6;
  else if (rsiVal > 55) callScore += w2 * 0.2;
  else if (rsiVal < 45) putScore += w2 * 0.2;

  if (divergence === 'bullish') callScore += w2;
  else if (divergence === 'bearish') putScore += w2;

  if (stoch.k < cfg.stochOversold) callScore += w2;
  else if (stoch.k > cfg.stochOverbought) putScore += w2;
  else if (stoch.k > stoch.d && stoch.k < 50) callScore += w2 * 0.6;
  else if (stoch.k < stoch.d && stoch.k > 50) putScore += w2 * 0.6;
  else if (stoch.k > 50) callScore += w2 * 0.2;
  else putScore += w2 * 0.2;

  // Note: extreme-high CCI counts BEARISH here (mean-reversion reading).
  if (cciVal > cfg.cciExtreme) putScore += w2;
  else if (cciVal < -cfg.cciExtreme) callScore += w2;
  else if (cciVal > cfg.cciStrong) callScore += w2 * 0.4;
  else if (cciVal < -cfg.cciStrong) putScore += w2 * 0.4;
  else if (cciVal > 0) callScore += w2 * 0.2;
  else putScore += w2 * 0.2;

  // ── TIER 3: volume and flow ───────────────────────────────────────────────
  if (mfiVal < cfg.mfiOversold) callScore += w3;
  else if (mfiVal > cfg.mfiOverbought) putScore += w3;
  else if (mfiVal > 60) callScore += w3 / 2;
  else if (mfiVal < 40) putScore += w3 / 2;

  if (cmfVal > cfg.cmfStrong) callScore += w3;
  else if (cmfVal < -cfg.cmfStrong) putScore += w3;
  else if (cmfVal > cfg.cmfMild) callScore += w3 * 0.6;
  else if (cmfVal < -cfg.cmfMild) putScore += w3 * 0.6;
  else if (cmfVal > 0) callScore += w3 * 0.25;
  else putScore += w3 * 0.25;

  if (volDelta > cfg.volDeltaStrong) callScore += w3;
  else if (volDelta < -cfg.volDeltaStrong) putScore += w3;
  else if (volDelta > cfg.volDeltaMild) callScore += w3 / 2;
  else if (volDelta < -cfg.volDeltaMild) putScore += w3 / 2;

  if (volProfile.trend === 'bullish') callScore += w3;
  else if (volProfile.trend === 'bearish') putScore += w3;

  // ORDER-DEPENDENT: the spike reinforces whichever side leads RIGHT NOW.
  if (volProfile.spike) {
    if (callScore > putScore) callScore += w3;
    else putScore += w3;
  }

  // ── TIER 4: price action ──────────────────────────────────────────────────
  if (currentPrice <= bb.lower) callScore += w4;
  else if (currentPrice >= bb.upper) putScore += w4;
  else {
    const bbRange = bb.upper - bb.lower;
    if (bbRange > 0) {
      const bbPos = (currentPrice - bb.lower) / bbRange;
      if (bbPos > 0.75) putScore += w4 / 2;
      if (bbPos < 0.25) callScore += w4 / 2;
    }
  }

  const srThreshold = currentPrice * cfg.srProximity;
  if (Math.abs(currentPrice - sr.support) <= srThreshold) callScore += w4;
  if (Math.abs(currentPrice - sr.resistance) <= srThreshold) putScore += w4;

  const vwapDist = Math.abs((currentPrice - vwapVal) / vwapVal);
  if (currentPrice > vwapVal) callScore += vwapDist > cfg.vwapProximity ? w4 : w4 / 2;
  else putScore += vwapDist > cfg.vwapProximity ? w4 : w4 / 2;

  if (liq.score > cfg.liquidityMinScore) {
    if (liq.zone.includes('Demand') || liq.zone.includes('Buy')) callScore += w4;
    else if (liq.zone.includes('Supply') || liq.zone.includes('Sell')) putScore += w4;
  }

  // ── TIER 5: confirmation ──────────────────────────────────────────────────
  if (BULLISH_PATTERNS.has(pattern)) callScore += w5;
  else if (BEARISH_PATTERNS.has(pattern)) putScore += w5;

  if (williamsRVal > cfg.williamsOverbought) putScore += w5;
  else if (williamsRVal < cfg.williamsOversold) callScore += w5;
  else if (williamsRVal > (cfg.williamsOversold + cfg.williamsOverbought) / 2) callScore += w5 / 3;
  else putScore += w5 / 3;

  if (rocVal > cfg.rocThreshold) callScore += w5;
  else if (rocVal < -cfg.rocThreshold) putScore += w5;
  else if (rocVal > 0) callScore += w5 / 3;
  else putScore += w5 / 3;

  // ── Quality filters: damp BOTH sides, applied after everything else ───────
  if (volProfile.ratio < cfg.lowVolThreshold) {
    callScore *= cfg.lowVolDamp;
    putScore *= cfg.lowVolDamp;
  }
  if (adx.adx < cfg.rangingAdx) {
    callScore *= cfg.rangingDamp;
    putScore *= cfg.rangingDamp;
  }

  return callScore - putScore;
}

/**
 * signal_engine.dart — the head of `_scoreV2Engine`: a loaded rule-based
 * strategy takes over completely and the parametric tiers never run.
 */
export function scoreStandard(
  ctx: EvalContext,
  dynamicStrategy: DynamicStrategy | null,
  cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): number {
  if (dynamicStrategy != null) return evaluateRules(dynamicStrategy, ctx);
  return scoreV2(ctx.candles, ctx.currentPrice, cfg);
}
