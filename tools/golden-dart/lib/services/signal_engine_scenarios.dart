part of 'signal_engine.dart';

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY SCENARIOS — parity oracle for the layer ABOVE the indicators.
//
// The indicator fixture proves each indicator computes the same value. It does
// not prove the pyramid reaches the same decision. These scenarios exercise
// that layer: primary / confirm / filter / base roles, pyramid and standard
// scoring, agreeing and conflicting directions, string-label conditions, and
// the category consensus multiplier.
//
// Rules are built deterministically from kAllIndicators by index, and the full
// rule list is written into the fixture, so the TypeScript side replays the
// exact same strategies rather than reconstructing them by guesswork.
// ─────────────────────────────────────────────────────────────────────────────

Map<String, dynamic> _ruleToJson(StrategyRule r) => {
  'indicator': r.indicator,
  'condition': r.condition,
  'signal': r.signal,
  'score': r.score,
  'enabled': r.enabled,
  'role': r.role,
  'type': r.type,
  'period': r.period,
  'fast': r.fast,
  'slow': r.slow,
  'smooth': r.smooth,
  'stddev': r.stddev,
  'value': r.value,
  'value_min': r.valueMin,
  'value_max': r.valueMax,
  'pattern': r.pattern,
};

/// Picks `count` indicator names spread across the full list starting at
/// `offset`, so each scenario draws a different but reproducible slice.
List<String> _pick(int offset, int count, int stride) => [
  for (var i = 0; i < count; i++)
    kAllIndicators[(offset + i * stride) % kAllIndicators.length],
];

List<StrategyRule> _rulesFor(
  List<String> names,
  String role,
  String signal,
  String condition,
  double score,
) => [
  for (final n in names)
    StrategyRule(
      indicator: n,
      condition: condition,
      signal: signal,
      score: score,
      role: role,
    ),
];

List<Map<String, dynamic>> buildStrategyScenarios(SignalEngine engine) {
  final scenarios = <Map<String, dynamic>>[];

  void add(String name, DynamicStrategy s) {
    // A fresh cache per scenario keeps results independent of the order the
    // scenarios happen to run in.
    final pro = engine.evaluateStrategyProWithCache(s, <String, dynamic>{});
    final score = engine._evaluateRules(s);
    scenarios.add({
      'name': name,
      'strategy': {
        'name': s.name,
        'min_score': s.minScore,
        'max_score': s.maxScore,
        'confidence_base': s.confidenceBase,
        'confidence_max': s.confidenceMax,
        'pyramid': s.pyramid == null
            ? null
            : {
                'min_primary_score': s.pyramid!.minPrimaryScore,
                'confirmation_ratio': s.pyramid!.confirmationRatio,
                'require_all_filters': s.pyramid!.requireAllFilters,
                'wait_message': s.pyramid!.waitMessage,
              },
        'rules': s.rules.map(_ruleToJson).toList(),
      },
      'effective_max_score': s.effectiveMaxScore,
      'pro': pro,
      'evaluate_rules_score': score,
    });
  }

  // 1. Standard scoring (no pyramid) — mixed CALL/PUT with numeric conditions.
  add(
    'standard_mixed',
    DynamicStrategy(
      name: 'Standard Mixed',
      rules: [
        ..._rulesFor(_pick(0, 8, 7), '', 'CALL', 'gt', 2.0),
        ..._rulesFor(_pick(3, 8, 11), '', 'PUT', 'lt', 1.5),
      ],
    ),
  );

  // 2. Pyramid with primary rules only — stage-1 gate plus consensus multiplier.
  add(
    'pyramid_primary_only',
    DynamicStrategy(
      name: 'Pyramid Primary',
      pyramid: const PyramidConfig(),
      rules: _rulesFor(_pick(1, 12, 5), 'primary', 'CALL', 'gt', 2.0),
    ),
  );

  // 3. Full pyramid — primary + confirm + filter + untagged base rules.
  add(
    'pyramid_full',
    DynamicStrategy(
      name: 'Pyramid Full',
      pyramid: const PyramidConfig(
        minPrimaryScore: 4.0,
        confirmationRatio: 0.6,
      ),
      rules: [
        ..._rulesFor(_pick(2, 10, 6), 'primary', 'CALL', 'gt', 2.5),
        ..._rulesFor(_pick(5, 8, 9), 'confirm', 'CALL', 'gt', 1.0),
        ..._rulesFor(_pick(7, 4, 13), 'filter', 'CALL', 'gte', 0.0),
        ..._rulesFor(_pick(11, 6, 17), '', 'PUT', 'lt', 1.0),
      ],
    ),
  );

  // 4. Confirms pointing both ways — exercises 'conflict' alignment.
  add(
    'pyramid_conflict',
    DynamicStrategy(
      name: 'Pyramid Conflict',
      pyramid: const PyramidConfig(
        minPrimaryScore: 1.0,
        confirmationRatio: 0.3,
      ),
      rules: [
        ..._rulesFor(_pick(4, 8, 5), 'primary', 'CALL', 'gt', 3.0),
        ..._rulesFor(_pick(6, 5, 8), 'confirm', 'PUT', 'gt', 1.0),
        ..._rulesFor(_pick(9, 5, 8), 'confirm', 'CALL', 'gt', 1.0),
      ],
    ),
  );

  // 5. A filter that cannot pass — stage-3 rejection path.
  add(
    'pyramid_filter_fail',
    DynamicStrategy(
      name: 'Pyramid Filter Fail',
      pyramid: const PyramidConfig(minPrimaryScore: 1.0),
      rules: [
        ..._rulesFor(_pick(0, 6, 3), 'primary', 'CALL', 'gt', 5.0),
        const StrategyRule(
          indicator: 'rsi',
          condition: 'gt',
          signal: 'CALL',
          score: 1.0,
          role: 'filter',
          value: 1e9,
        ),
      ],
    ),
  );

  // 6. 'dominant' signals — the order-dependent accumulation branch.
  add(
    'dominant_signals',
    DynamicStrategy(
      name: 'Dominant',
      pyramid: const PyramidConfig(
        minPrimaryScore: 0.0,
        confirmationRatio: 0.0,
      ),
      rules: _rulesFor(_pick(13, 14, 4), 'primary', 'dominant', 'gt', 2.0),
    ),
  );

  // 7. String-label conditions — the non-numeric branch of _checkCondition.
  add(
    'string_conditions',
    DynamicStrategy(
      name: 'String Conditions',
      rules: const [
        StrategyRule(
          indicator: 'candle_pattern',
          condition: 'bullish',
          signal: 'CALL',
          score: 3.0,
        ),
        StrategyRule(
          indicator: 'market_structure',
          condition: 'bearish',
          signal: 'PUT',
          score: 3.0,
        ),
        StrategyRule(
          indicator: 'order_block',
          condition: 'eq',
          signal: 'CALL',
          score: 2.0,
          pattern: 'bullish',
        ),
        StrategyRule(
          indicator: 'liquidity_sweep',
          condition: 'sell_side',
          signal: 'CALL',
          score: 2.0,
        ),
        StrategyRule(
          indicator: 'day_of_week',
          condition: 'neq',
          signal: 'PUT',
          score: 1.0,
          pattern: 'monday',
        ),
      ],
    ),
  );

  // 8. Rules carrying an explicit `type` — bypasses getCategoryForIndicator and
  //    drives the multiplier straight from the declared categories.
  add(
    'explicit_categories',
    DynamicStrategy(
      name: 'Explicit Categories',
      pyramid: const PyramidConfig(minPrimaryScore: 1.0),
      rules: [
        for (var i = 0; i < 8; i++)
          StrategyRule(
            indicator: kAllIndicators[(i * 23) % kAllIndicators.length],
            condition: 'gt',
            signal: 'CALL',
            score: 2.0,
            role: 'primary',
            type: const [
              'Trend',
              'Oscillators',
              'Price Levels',
              'Rare Patterns',
            ][i % 4],
          ),
      ],
    ),
  );

  return scenarios;
}
