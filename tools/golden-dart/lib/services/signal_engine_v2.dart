part of 'signal_engine.dart';

// ─────────────────────────────────────────────────────────────────────────────
// V2 SCORER + SIGNAL LIFECYCLE — parity oracle.
//
// `_scoreV2Engine` is the parametric fallback that runs whenever no rule-based
// strategy is loaded. It is 200+ lines of weighted tiers with two order
// dependencies, so it gets its own recorded scenarios rather than being trusted
// to "look right".
//
// Also recorded here: the confidence curve and the WIN/LOSS/TIE decision, both
// of which the user sees directly on every trade.
// ─────────────────────────────────────────────────────────────────────────────

Map<String, dynamic> _configToJson(StrategyConfig c) => {
  'name': c.name,
  'ema_periods': c.emaPeriods,
  'rsi_period': c.rsiPeriod,
  'bb_period': c.bbPeriod,
  'bb_stddev': c.bbStddev,
  'stoch_period': c.stochPeriod,
  'stoch_smooth': c.stochSmooth,
  'adx_period': c.adxPeriod,
  'cci_period': c.cciPeriod,
  'mfi_period': c.mfiPeriod,
  'cmf_period': c.cmfPeriod,
  'williams_period': c.williamsPeriod,
  'roc_period': c.rocPeriod,
  'atr_period': c.atrPeriod,
  'rsi_oversold_extreme': c.rsiOversoldExtreme,
  'rsi_oversold': c.rsiOversold,
  'rsi_overbought': c.rsiOverbought,
  'rsi_overbought_extreme': c.rsiOverboughtExtreme,
  'stoch_oversold': c.stochOversold,
  'stoch_overbought': c.stochOverbought,
  'adx_strong': c.adxStrong,
  'adx_moderate': c.adxModerate,
  'cci_extreme': c.cciExtreme,
  'cci_strong': c.cciStrong,
  'mfi_oversold': c.mfiOversold,
  'mfi_overbought': c.mfiOverbought,
  'cmf_strong': c.cmfStrong,
  'cmf_mild': c.cmfMild,
  'vol_delta_strong': c.volDeltaStrong,
  'vol_delta_mild': c.volDeltaMild,
  'vol_spike_multiplier': c.volSpikeMultiplier,
  'sr_proximity': c.srProximity,
  'vwap_proximity': c.vwapProximity,
  'liquidity_min_score': c.liquidityMinScore,
  'williams_oversold': c.williamsOversold,
  'williams_overbought': c.williamsOverbought,
  'roc_threshold': c.rocThreshold,
  'low_vol_threshold': c.lowVolThreshold,
  'low_vol_damp': c.lowVolDamp,
  'ranging_adx': c.rangingAdx,
  'ranging_damp': c.rangingDamp,
  'confidence_base': c.confidenceBase,
  'confidence_max': c.confidenceMax,
  'tier1_weight': c.tier1Weight,
  'tier2_weight': c.tier2Weight,
  'tier3_weight': c.tier3Weight,
  'tier4_weight': c.tier4Weight,
  'tier5_weight': c.tier5Weight,
};

/// The confidence curve used for non-VIP signals, lifted from
/// `_generateNextSignal`: base + (|score| / 45) × (max − base), clamped.
double _confidenceFor(double absScore, double base, double max) {
  final c = base + (absScore / 45.0) * (max - base);
  return c.clamp(base, max);
}

List<Map<String, dynamic>> buildV2Scenarios(SignalEngine engine) {
  final out = <Map<String, dynamic>>[];

  void record(String name, StrategyConfig cfg) {
    // No dynamic strategy loaded → _scoreV2Engine runs its parametric path.
    engine._stdDynamic = null;
    engine._userRole = 'standard';
    engine._stdStrategy = cfg;

    final score = engine._scoreV2Engine();
    out.add({
      'name': name,
      'config': _configToJson(cfg),
      'score': score,
      'confidence': _confidenceFor(
        score.abs(),
        cfg.confidenceBase,
        cfg.confidenceMax,
      ),
    });
  }

  // Stock defaults — the configuration the vast majority of users run on.
  record('default_config', const StrategyConfig());

  // Shifted thresholds: pushes several tiers onto different branches.
  record(
    'tight_thresholds',
    const StrategyConfig(
      name: 'Tight',
      rsiOversold: 45,
      rsiOverbought: 55,
      stochOversold: 40,
      stochOverbought: 60,
      adxStrong: 10,
      adxModerate: 5,
      cciExtreme: 50,
      cciStrong: 20,
      mfiOversold: 45,
      mfiOverbought: 55,
      cmfStrong: 0.01,
      cmfMild: 0.001,
      volDeltaStrong: 1,
      volDeltaMild: 0.1,
      liquidityMinScore: 5,
      rocThreshold: 0.001,
    ),
  );

  // Re-weighted tiers, and damping forced on so both multipliers apply.
  record(
    'reweighted_damped',
    const StrategyConfig(
      name: 'Reweighted',
      tier1Weight: 1.0,
      tier2Weight: 5.0,
      tier3Weight: 0.5,
      tier4Weight: 4.0,
      tier5Weight: 2.5,
      lowVolThreshold: 99.0,
      lowVolDamp: 0.5,
      rangingAdx: 99.0,
      rangingDamp: 0.25,
    ),
  );

  // Different EMA set — tier 1 changes shape entirely.
  record(
    'alt_emas',
    const StrategyConfig(
      name: 'Alt EMAs',
      emaPeriods: [5, 13, 34],
      rsiPeriod: 7,
      bbPeriod: 10,
      stochPeriod: 21,
      adxPeriod: 21,
    ),
  );

  // Restore the engine to its starting state so later scenarios are unaffected.
  engine._stdStrategy = const StrategyConfig();
  return out;
}

/// Records the WIN / LOSS / TIE decision across the boundary cases.
///
/// Only the non-guaranteed path is recorded: the guaranteed-win branch draws a
/// random margin, so it cannot be value-matched between runtimes.
List<Map<String, dynamic>> buildOutcomeScenarios() {
  final cases = <List<dynamic>>[
    // [direction, entry, exit]
    ['CALL', 1.10000, 1.10050],
    ['CALL', 1.10000, 1.09950],
    ['CALL', 1.10000, 1.10000],
    ['PUT', 1.10000, 1.09950],
    ['PUT', 1.10000, 1.10050],
    ['PUT', 1.10000, 1.10000],
    // Just inside / outside the tie epsilon (entry × 5e-6 ≈ 0.0000055).
    ['CALL', 1.10000, 1.1000010],
    ['CALL', 1.10000, 1.1000100],
    ['PUT', 1.10000, 1.0999990],
    ['PUT', 1.10000, 1.0999900],
    // Large moves and a different price scale.
    ['CALL', 0.00001234, 0.00001240],
    ['PUT', 155.250, 154.900],
  ];

  return [
    for (final c in cases)
      () {
        final dir = c[0] as String;
        final entry = c[1] as double;
        final exit = c[2] as double;
        final isCall = dir == 'CALL';
        final diff = exit - entry;
        final tieEps = entry.abs() * 5e-6 + 1e-12;
        final String result;
        if (diff.abs() <= tieEps) {
          result = 'TIE';
        } else if (isCall) {
          result = diff > 0 ? 'WIN' : 'LOSS';
        } else {
          result = diff < 0 ? 'WIN' : 'LOSS';
        }
        return {
          'direction': dir,
          'entry': entry,
          'exit': exit,
          'tie_eps': tieEps,
          'result': result,
        };
      }(),
  ];
}
