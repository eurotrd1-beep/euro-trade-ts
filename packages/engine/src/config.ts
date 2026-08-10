/**
 * StrategyConfig — the parametric fallback used when no rule-based
 * (`DynamicStrategy`) config is loaded.
 *
 * Ported from signal_engine.dart:277. Every default below is copied from the
 * Dart constructor; they feed the V2 scorer directly, so a changed default is
 * a changed trading decision.
 */

export interface StrategyConfig {
  name: string;

  // Indicator periods
  emaPeriods: number[];
  rsiPeriod: number;
  macdFast: number;
  macdSlow: number;
  macdSignalPeriod: number;
  bbPeriod: number;
  bbStddev: number;
  stochPeriod: number;
  stochSmooth: number;
  adxPeriod: number;
  cciPeriod: number;
  mfiPeriod: number;
  cmfPeriod: number;
  williamsPeriod: number;
  rocPeriod: number;
  atrPeriod: number;

  // Thresholds
  rsiOversoldExtreme: number;
  rsiOversold: number;
  rsiOverbought: number;
  rsiOverboughtExtreme: number;
  stochOversold: number;
  stochOverbought: number;
  adxStrong: number;
  adxModerate: number;
  cciExtreme: number;
  cciStrong: number;
  mfiOversold: number;
  mfiOverbought: number;
  cmfStrong: number;
  cmfMild: number;
  volDeltaStrong: number;
  volDeltaMild: number;
  volSpikeMultiplier: number;
  srProximity: number;
  vwapProximity: number;
  liquidityMinScore: number;
  williamsOversold: number;
  williamsOverbought: number;
  rocThreshold: number;

  // Quality filters
  lowVolThreshold: number;
  lowVolDamp: number;
  rangingAdx: number;
  rangingDamp: number;

  // Confidence
  confidenceBase: number;
  confidenceMax: number;

  // Tier weights
  tier1Weight: number;
  tier2Weight: number;
  tier3Weight: number;
  tier4Weight: number;
  tier5Weight: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  name: 'Default',
  emaPeriods: [9, 21, 50],
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignalPeriod: 9,
  bbPeriod: 20,
  bbStddev: 2.0,
  stochPeriod: 14,
  stochSmooth: 3,
  adxPeriod: 14,
  cciPeriod: 20,
  mfiPeriod: 14,
  cmfPeriod: 20,
  williamsPeriod: 14,
  rocPeriod: 10,
  atrPeriod: 14,
  rsiOversoldExtreme: 25,
  rsiOversold: 35,
  rsiOverbought: 65,
  rsiOverboughtExtreme: 75,
  stochOversold: 15,
  stochOverbought: 85,
  adxStrong: 25,
  adxModerate: 15,
  cciExtreme: 150,
  cciStrong: 100,
  mfiOversold: 20,
  mfiOverbought: 80,
  cmfStrong: 0.1,
  cmfMild: 0.03,
  volDeltaStrong: 25,
  volDeltaMild: 10,
  volSpikeMultiplier: 1.8,
  srProximity: 0.0008,
  vwapProximity: 0.001,
  liquidityMinScore: 60,
  williamsOversold: -80,
  williamsOverbought: -20,
  rocThreshold: 0.1,
  lowVolThreshold: 0.6,
  lowVolDamp: 0.7,
  rangingAdx: 15,
  rangingDamp: 0.8,
  confidenceBase: 92.5,
  confidenceMax: 98.9,
  tier1Weight: 3.0,
  tier2Weight: 2.5,
  tier3Weight: 2.0,
  tier4Weight: 2.0,
  tier5Weight: 1.5,
};

/** Mirrors Dart's `StrategyConfig.fromJson`, key names and all. */
export function strategyConfigFromJson(j: Record<string, unknown>): StrategyConfig {
  const d = (k: string, def: number): number => (j[k] == null ? def : Number(j[k]));
  const i = (k: string, def: number): number =>
    j[k] == null ? def : Math.trunc(Number(j[k]));

  const rawEma = j['ema_periods'];
  const emaPeriods = Array.isArray(rawEma)
    ? rawEma.map((e) => Math.trunc(Number(e)))
    : [9, 21, 50];

  return {
    name: (j['name'] as string | undefined) ?? 'Custom',
    emaPeriods,
    rsiPeriod: i('rsi_period', 14),
    macdFast: i('macd_fast', 12),
    macdSlow: i('macd_slow', 26),
    macdSignalPeriod: i('macd_signal', 9),
    bbPeriod: i('bb_period', 20),
    bbStddev: d('bb_stddev', 2.0),
    stochPeriod: i('stoch_period', 14),
    stochSmooth: i('stoch_smooth', 3),
    adxPeriod: i('adx_period', 14),
    cciPeriod: i('cci_period', 20),
    mfiPeriod: i('mfi_period', 14),
    cmfPeriod: i('cmf_period', 20),
    williamsPeriod: i('williams_period', 14),
    rocPeriod: i('roc_period', 10),
    atrPeriod: i('atr_period', 14),
    rsiOversoldExtreme: d('rsi_oversold_extreme', 25),
    rsiOversold: d('rsi_oversold', 35),
    rsiOverbought: d('rsi_overbought', 65),
    rsiOverboughtExtreme: d('rsi_overbought_extreme', 75),
    stochOversold: d('stoch_oversold', 15),
    stochOverbought: d('stoch_overbought', 85),
    adxStrong: d('adx_strong', 25),
    adxModerate: d('adx_moderate', 15),
    cciExtreme: d('cci_extreme', 150),
    cciStrong: d('cci_strong', 100),
    mfiOversold: d('mfi_oversold', 20),
    mfiOverbought: d('mfi_overbought', 80),
    cmfStrong: d('cmf_strong', 0.1),
    cmfMild: d('cmf_mild', 0.03),
    volDeltaStrong: d('vol_delta_strong', 25),
    volDeltaMild: d('vol_delta_mild', 10),
    volSpikeMultiplier: d('vol_spike_multiplier', 1.8),
    srProximity: d('sr_proximity', 0.0008),
    vwapProximity: d('vwap_proximity', 0.001),
    liquidityMinScore: d('liquidity_min_score', 60),
    williamsOversold: d('williams_oversold', -80),
    williamsOverbought: d('williams_overbought', -20),
    rocThreshold: d('roc_threshold', 0.1),
    lowVolThreshold: d('low_vol_threshold', 0.6),
    lowVolDamp: d('low_vol_damp', 0.7),
    rangingAdx: d('ranging_adx', 15),
    rangingDamp: d('ranging_damp', 0.8),
    confidenceBase: d('confidence_base', 92.5),
    confidenceMax: d('confidence_max', 98.9),
    tier1Weight: d('tier1_weight', 3.0),
    tier2Weight: d('tier2_weight', 2.5),
    tier3Weight: d('tier3_weight', 2.0),
    tier4Weight: d('tier4_weight', 2.0),
    tier5Weight: d('tier5_weight', 1.5),
  };
}
