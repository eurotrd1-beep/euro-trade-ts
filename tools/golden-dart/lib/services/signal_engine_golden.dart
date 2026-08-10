part of 'signal_engine.dart';

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN HARNESS — migration parity oracle.
//
// This file exists only inside the migration copy of the engine. It never ships.
// Its job: freeze the exact output of every indicator in the Dart engine so the
// TypeScript port can be proven identical, value for value.
//
// It lives as a `part` because _computeIndicator and _candles are library-private
// in signal_engine.dart; a part shares that library scope without touching the
// production source.
// ─────────────────────────────────────────────────────────────────────────────

/// Deterministic candle series. Uses a plain LCG (no dart:math Random) so the
/// series is reproducible across runs, platforms and languages.
///
/// The generated candles are written into the golden fixture, so the TypeScript
/// side never regenerates them — it reads the exact same numbers back.
List<Candle> goldenCandles({int count = 400, int seed = 20260810}) {
  var s = seed & 0x7FFFFFFF;
  double next() {
    s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
    return s / 0x7FFFFFFF;
  }

  double r6(double v) => double.parse(v.toStringAsFixed(6));

  final out = <Candle>[];
  var price = 1.100000;
  final start = DateTime.utc(2026, 1, 1);

  for (var i = 0; i < count; i++) {
    final open = price;
    final close = open + (next() - 0.5) * 0.0020;
    final hi = (open > close ? open : close) + next() * 0.0008;
    final lo = (open < close ? open : close) - next() * 0.0008;
    final vol = 100.0 + next() * 900.0;

    out.add(
      Candle(
        open: r6(open),
        high: r6(hi),
        low: r6(lo),
        close: r6(close),
        volume: r6(vol),
        time: start.add(Duration(minutes: i)),
      ),
    );
    price = close;
  }
  return out;
}

Map<String, dynamic> _candleToJson(Candle c) => {
  'open': c.open,
  'high': c.high,
  'low': c.low,
  'close': c.close,
  'volume': c.volume,
  'time': c.time.toUtc().toIso8601String(),
};

/// Normalises an indicator result into something JSON can carry losslessly.
/// NaN/Infinity are not valid JSON, so they become tagged strings the TS
/// comparator understands.
dynamic _normalise(dynamic v) {
  if (v is double) {
    if (v.isNaN) return '__NaN__';
    if (v == double.infinity) return '__Infinity__';
    if (v == double.negativeInfinity) return '__-Infinity__';
    return v;
  }
  if (v is int || v is String || v is bool || v == null) return v;
  return v.toString();
}

/// Runs every indicator in the dispatch switch against the golden candles and
/// returns the full fixture: input candles + expected output per indicator.
///
/// Indicators that throw are recorded under `errors` rather than aborting — a
/// throwing indicator is still a behaviour the port has to reproduce.
/// Captured once, before any indicator runs, so every clock-reading indicator
/// in a single fixture run is described by the same instant. The run itself
/// takes milliseconds, so the hour/weekday the indicators actually observe
/// cannot drift from this value in practice.
late final DateTime _fixtureNow;

Map<String, dynamic> buildGoldenFixture({int count = 400, int seed = 20260810}) {
  _fixtureNow = DateTime.now();
  final candles = goldenCandles(count: count, seed: seed);

  final engine = SignalEngine.golden();

  // Reproduce exactly the state `setRealCandles` leaves behind — candles,
  // last close as the current price, real-candle mode on. A plain _candles
  // write is NOT enough: _currentPrice would stay at its 1.08450 default while
  // the candles sit near 1.10, a state the live app never reaches.
  //
  // setRealCandles itself is not called because it also runs
  // _updateAllIndicators() + notifyListeners(). Neither affects this fixture —
  // _computeIndicator reads _currentPrice and _candles only, never the cached
  // _rsiVal/_stochK/... fields — and calling them stalls the test harness.
  engine._candles
    ..clear()
    ..addAll(candles);
  engine._currentPrice = candles.last.close;
  engine._realCandlesMode = true;

  final results = <String, dynamic>{};
  final errors = <String, String>{};

  for (final indicator in kAllIndicators) {
    final rule = StrategyRule(
      indicator: indicator,
      condition: 'gt',
      signal: 'CALL',
      score: 1.0,
    );
    try {
      // Fresh cache per indicator: the cache key folds in the rule params, so a
      // shared cache would be correct too — but a fresh one keeps each value
      // provably independent of evaluation order.
      final value = engine._computeIndicator(rule, <String, dynamic>{});
      results[indicator] = _normalise(value);
    } catch (e) {
      errors[indicator] = e.toString();
    }
  }

  return {
    '_doc':
        'Golden parity fixture for the Dart→TypeScript engine migration. '
        'Generated from euro_trade/lib/services/signal_engine.dart. Do not edit by hand.',
    'strategies': buildStrategyScenarios(engine),
    'v2': buildV2Scenarios(engine),
    'outcomes': buildOutcomeScenarios(),
    'seed': seed,
    'candleCount': count,
    // Recorded explicitly so the TypeScript side asserts against the engine's
    // real state instead of re-deriving it and hoping the derivation matches.
    'currentPrice': engine._currentPrice,
    'realCandlesMode': engine._realCandlesMode,
    // Ten indicators read the wall clock (kill_zone, session, day_of_week,
    // time_analysis, judas_swing, silver_bullet, …). Their recorded values are
    // only reproducible if the port is given the same clock, so both readings
    // the Dart code takes are captured verbatim:
    //   • hour   — from DateTime.now().toUtc().hour   (UTC)
    //   • weekday— from DateTime.now().weekday        (LOCAL, Mon=1..Sun=7)
    // They are stored as plain numbers rather than a timestamp so no timezone
    // re-derivation can drift between the two runtimes.
    'clock': {
      'utcHour': _fixtureNow.toUtc().hour,
      'weekday': _fixtureNow.weekday,
      'recordedAt': _fixtureNow.toUtc().toIso8601String(),
    },
    'indicatorCount': kAllIndicators.length,
    'defaultRule': {
      'condition': 'gt',
      'signal': 'CALL',
      'score': 1.0,
      'period': 14,
      'fast': 9,
      'slow': 21,
      'smooth': 3,
      'stddev': 2.0,
    },
    'candles': candles.map(_candleToJson).toList(),
    'results': results,
    'errors': errors,
  };
}
