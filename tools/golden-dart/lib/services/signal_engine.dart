import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../constants.dart';
import '../utils/web_utils.dart';
import 'language_service.dart';
import 'golden_indicators.dart';

part 'signal_engine_golden.dart';
part 'signal_engine_scenarios.dart';
part 'signal_engine_v2.dart';

class Candle {
  final double open;
  double high;
  double low;
  double close;
  double volume;
  final DateTime time;

  Candle({
    required this.open,
    required this.high,
    required this.low,
    required this.close,
    required this.time,
    this.volume = 0.0,
  });
}

class TradingSignal {
  final String pair;
  final String direction; // 'CALL', 'PUT', or 'WAIT'
  final int durationMinutes;
  final double entryPrice;
  double currentPrice;
  final double confidence; // e.g., 94.8
  final DateTime entryTime;
  final DateTime expiryTime;
  String status; // 'PENDING', 'ACTIVE', 'WIN', 'LOSS'
  double? exitPrice;
  List<Candle>? candlesSnapshot;
  final String marketCondition;
  final String recommendation;
  final String origin; // 'instant' | 'monitoring'

  TradingSignal({
    required this.pair,
    required this.direction,
    required this.durationMinutes,
    required this.entryPrice,
    required this.currentPrice,
    required this.confidence,
    required this.entryTime,
    required this.expiryTime,
    this.status = 'ACTIVE',
    this.exitPrice,
    this.candlesSnapshot,
    this.marketCondition = 'سوق مستقر وسليم',
    this.recommendation = 'دخول آمن',
    this.origin = 'instant',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// VIP INSTITUTIONAL ANALYSIS — DATA CLASSES
// ─────────────────────────────────────────────────────────────────────────────

class EngineResult {
  final bool passed;
  final double quality;
  final String status;
  final List<String> evidence;
  final String summary;
  const EngineResult({
    required this.passed,
    required this.quality,
    required this.status,
    required this.evidence,
    required this.summary,
  });
}

class VipHistoricalResult {
  final bool passed;
  final int sampleSize;
  final double winRate;
  final String verdict;
  final String summary;

  const VipHistoricalResult({
    required this.passed,
    required this.sampleSize,
    required this.winRate,
    required this.verdict,
    required this.summary,
  });
}

class VipAnalysisResult {
  final double netScore;
  final double confidence;
  final bool isApproved;
  final double overallScore;
  final String grade;
  final String riskAssessment;
  final List<String> scoreBreakdown;
  final String rejectionReason;
  final VipHistoricalResult? historical;

  const VipAnalysisResult({
    required this.netScore,
    required this.confidence,
    required this.isApproved,
    required this.overallScore,
    required this.grade,
    required this.riskAssessment,
    required this.scoreBreakdown,
    required this.rejectionReason,
    this.historical,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RULE ENGINE — fully dynamic strategy loaded from JSON
// ─────────────────────────────────────────────────────────────────────────────

class StrategyRule {
  final String indicator;
  final String
  condition; // gt, lt, gte, lte, eq, neq, between, bullish, bearish
  final String signal; // CALL, PUT, dominant/confirm
  final double score;
  final bool enabled;

  // ── Pyramid role ──────────────────────────────────────────────────────────
  // "primary"  → determines signal direction (e.g. trend, structure)
  // "confirm"  → must agree with primary direction (e.g. momentum, volume)
  // "filter"   → hard gate: if fails → no signal regardless of score
  // ""         → untagged: participates in normal scoring (default)
  final String role;
  final String type; // Category / School of analysis (Trend, Oscillator, etc.)

  // optional params
  final int period;
  final int fast;
  final int slow;
  final int smooth;
  final double stddev;
  final double? value;
  final double? valueMin;
  final double? valueMax;
  final String? pattern;

  const StrategyRule({
    required this.indicator,
    required this.condition,
    required this.signal,
    required this.score,
    this.enabled = true,
    this.role = '',
    this.type = '',
    this.period = 14,
    this.fast = 9,
    this.slow = 21,
    this.smooth = 3,
    this.stddev = 2.0,
    this.value,
    this.valueMin,
    this.valueMax,
    this.pattern,
  });

  factory StrategyRule.fromJson(Map<String, dynamic> j) => StrategyRule(
    indicator: j['indicator'] as String,
    condition: j['condition'] as String,
    signal: j['signal'] as String,
    score: (j['score'] as num).toDouble(),
    enabled: j['enabled'] as bool? ?? true,
    role: j['role'] as String? ?? '',
    type: j['type'] as String? ?? j['category'] as String? ?? '',
    period: (j['period'] as num?)?.toInt() ?? 14,
    fast: (j['fast'] as num?)?.toInt() ?? 9,
    slow: (j['slow'] as num?)?.toInt() ?? 21,
    smooth: (j['smooth'] as num?)?.toInt() ?? 3,
    stddev: (j['stddev'] as num?)?.toDouble() ?? 2.0,
    value: (j['value'] as num?)?.toDouble() ?? (j['level'] as num?)?.toDouble(),
    valueMin: (j['value_min'] as num?)?.toDouble(),
    valueMax: (j['value_max'] as num?)?.toDouble(),
    pattern:
        j['pattern'] as String? ??
        j['session'] as String? ??
        j['wave']?.toString(),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PYRAMID CONFIG — controls the 3-stage signal confirmation hierarchy
// ─────────────────────────────────────────────────────────────────────────────
class PyramidConfig {
  // Stage 1 (Primary): minimum score from primary rules before proceeding
  final double minPrimaryScore;
  // Stage 2 (Confirmation): minimum ratio (0–1) of confirm rules that must agree
  final double confirmationRatio;
  // Stage 3 (Filter): if true, ALL filter rules must pass (any fail → no signal)
  final bool requireAllFilters;
  // When pyramid fails, show reason in the wait message
  final String waitMessage;

  const PyramidConfig({
    this.minPrimaryScore = 3.0,
    this.confirmationRatio = 0.5,
    this.requireAllFilters = true,
    this.waitMessage = 'الهرم لم يكتمل — انتظار الشمعة القادمة',
  });

  factory PyramidConfig.fromJson(Map<String, dynamic> j) => PyramidConfig(
    minPrimaryScore: (j['min_primary_score'] as num?)?.toDouble() ?? 3.0,
    confirmationRatio: (j['confirmation_ratio'] as num?)?.toDouble() ?? 0.5,
    requireAllFilters: j['require_all_filters'] as bool? ?? true,
    waitMessage:
        j['wait_message'] as String? ??
        tr(
          'الهرم لم يكتمل — انتظار الشمعة القادمة',
          'Pyramid not complete — waiting for the next candle',
        ),
  );
}

class DynamicStrategy {
  final String name;
  final double minScore;
  // Optional cap for the "signal strength" bar (score ÷ max_score × 100%).
  // 0 = auto (sum of enabled rule scores).
  final double maxScore;
  final double confidenceBase;
  final double confidenceMax;
  final List<StrategyRule> rules;
  // null = standard scoring mode, non-null = pyramid mode
  final PyramidConfig? pyramid;

  const DynamicStrategy({
    this.name = 'Custom',
    this.minScore = 0.0,
    this.maxScore = 0.0,
    this.confidenceBase = 92.5,
    this.confidenceMax = 98.9,
    this.pyramid,
    required this.rules,
  });

  // Effective max score for the strength bar: explicit max_score, else the sum
  // of the absolute scores of all enabled rules.
  double get effectiveMaxScore {
    if (maxScore > 0) return maxScore;
    final sum = rules
        .where((r) => r.enabled)
        .fold<double>(0.0, (s, r) => s + r.score.abs());
    return sum > 0 ? sum : 1.0;
  }

  factory DynamicStrategy.fromJson(Map<String, dynamic> j) => DynamicStrategy(
    name: j['name'] as String? ?? 'Custom',
    minScore: (j['min_score'] as num?)?.toDouble() ?? 0.0,
    maxScore: (j['max_score'] as num?)?.toDouble() ?? 0.0,
    confidenceBase: (j['confidence_base'] as num?)?.toDouble() ?? 92.5,
    confidenceMax: (j['confidence_max'] as num?)?.toDouble() ?? 98.9,
    pyramid: j['pyramid'] != null
        ? PyramidConfig.fromJson(j['pyramid'] as Map<String, dynamic>)
        : null,
    rules: (j['rules'] as List<dynamic>)
        .map((r) => StrategyRule.fromJson(r as Map<String, dynamic>))
        .toList(),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY CONFIG — loaded from Firestore configs/strategy_standard or _vip
// ─────────────────────────────────────────────────────────────────────────────
class StrategyConfig {
  final String name;

  // Indicator periods
  final List<int> emaPeriods;
  final int rsiPeriod;
  final int macdFast;
  final int macdSlow;
  final int macdSignalPeriod;
  final int bbPeriod;
  final double bbStddev;
  final int stochPeriod;
  final int stochSmooth;
  final int adxPeriod;
  final int cciPeriod;
  final int mfiPeriod;
  final int cmfPeriod;
  final int williamsPeriod;
  final int rocPeriod;
  final int atrPeriod;

  // RSI thresholds
  final double rsiOversoldExtreme;
  final double rsiOversold;
  final double rsiOverbought;
  final double rsiOverboughtExtreme;

  // Stochastic
  final double stochOversold;
  final double stochOverbought;

  // ADX
  final double adxStrong;
  final double adxModerate;

  // CCI
  final double cciExtreme;
  final double cciStrong;

  // MFI
  final double mfiOversold;
  final double mfiOverbought;

  // CMF
  final double cmfStrong;
  final double cmfMild;

  // Volume Delta
  final double volDeltaStrong;
  final double volDeltaMild;

  // Volume Spike
  final double volSpikeMultiplier;

  // Price Action
  final double srProximity;
  final double vwapProximity;
  final double liquidityMinScore;

  // Williams %R
  final double williamsOversold;
  final double williamsOverbought;

  // ROC
  final double rocThreshold;

  // Quality filters
  final double lowVolThreshold;
  final double lowVolDamp;
  final double rangingAdx;
  final double rangingDamp;

  // Confidence
  final double confidenceBase;
  final double confidenceMax;

  // Tier weights (score added per indicator)
  final double tier1Weight;
  final double tier2Weight;
  final double tier3Weight;
  final double tier4Weight;
  final double tier5Weight;

  const StrategyConfig({
    this.name = 'Default',
    this.emaPeriods = const [9, 21, 50],
    this.rsiPeriod = 14,
    this.macdFast = 12,
    this.macdSlow = 26,
    this.macdSignalPeriod = 9,
    this.bbPeriod = 20,
    this.bbStddev = 2.0,
    this.stochPeriod = 14,
    this.stochSmooth = 3,
    this.adxPeriod = 14,
    this.cciPeriod = 20,
    this.mfiPeriod = 14,
    this.cmfPeriod = 20,
    this.williamsPeriod = 14,
    this.rocPeriod = 10,
    this.atrPeriod = 14,
    this.rsiOversoldExtreme = 25,
    this.rsiOversold = 35,
    this.rsiOverbought = 65,
    this.rsiOverboughtExtreme = 75,
    this.stochOversold = 15,
    this.stochOverbought = 85,
    this.adxStrong = 25,
    this.adxModerate = 15,
    this.cciExtreme = 150,
    this.cciStrong = 100,
    this.mfiOversold = 20,
    this.mfiOverbought = 80,
    this.cmfStrong = 0.1,
    this.cmfMild = 0.03,
    this.volDeltaStrong = 25,
    this.volDeltaMild = 10,
    this.volSpikeMultiplier = 1.8,
    this.srProximity = 0.0008,
    this.vwapProximity = 0.001,
    this.liquidityMinScore = 60,
    this.williamsOversold = -80,
    this.williamsOverbought = -20,
    this.rocThreshold = 0.1,
    this.lowVolThreshold = 0.6,
    this.lowVolDamp = 0.7,
    this.rangingAdx = 15,
    this.rangingDamp = 0.8,
    this.confidenceBase = 92.5,
    this.confidenceMax = 98.9,
    this.tier1Weight = 3.0,
    this.tier2Weight = 2.5,
    this.tier3Weight = 2.0,
    this.tier4Weight = 2.0,
    this.tier5Weight = 1.5,
  });

  factory StrategyConfig.fromJson(Map<String, dynamic> j) {
    List<int> parseEma() {
      final raw = j['ema_periods'];
      if (raw is List) return raw.map((e) => (e as num).toInt()).toList();
      return const [9, 21, 50];
    }

    return StrategyConfig(
      name: j['name'] as String? ?? 'Custom',
      emaPeriods: parseEma(),
      rsiPeriod: _i(j['rsi_period'], 14),
      macdFast: _i(j['macd_fast'], 12),
      macdSlow: _i(j['macd_slow'], 26),
      macdSignalPeriod: _i(j['macd_signal'], 9),
      bbPeriod: _i(j['bb_period'], 20),
      bbStddev: _d(j['bb_stddev'], 2.0),
      stochPeriod: _i(j['stoch_period'], 14),
      stochSmooth: _i(j['stoch_smooth'], 3),
      adxPeriod: _i(j['adx_period'], 14),
      cciPeriod: _i(j['cci_period'], 20),
      mfiPeriod: _i(j['mfi_period'], 14),
      cmfPeriod: _i(j['cmf_period'], 20),
      williamsPeriod: _i(j['williams_period'], 14),
      rocPeriod: _i(j['roc_period'], 10),
      atrPeriod: _i(j['atr_period'], 14),
      rsiOversoldExtreme: _d(j['rsi_oversold_extreme'], 25),
      rsiOversold: _d(j['rsi_oversold'], 35),
      rsiOverbought: _d(j['rsi_overbought'], 65),
      rsiOverboughtExtreme: _d(j['rsi_overbought_extreme'], 75),
      stochOversold: _d(j['stoch_oversold'], 15),
      stochOverbought: _d(j['stoch_overbought'], 85),
      adxStrong: _d(j['adx_strong'], 25),
      adxModerate: _d(j['adx_moderate'], 15),
      cciExtreme: _d(j['cci_extreme'], 150),
      cciStrong: _d(j['cci_strong'], 100),
      mfiOversold: _d(j['mfi_oversold'], 20),
      mfiOverbought: _d(j['mfi_overbought'], 80),
      cmfStrong: _d(j['cmf_strong'], 0.1),
      cmfMild: _d(j['cmf_mild'], 0.03),
      volDeltaStrong: _d(j['vol_delta_strong'], 25),
      volDeltaMild: _d(j['vol_delta_mild'], 10),
      volSpikeMultiplier: _d(j['vol_spike_multiplier'], 1.8),
      srProximity: _d(j['sr_proximity'], 0.0008),
      vwapProximity: _d(j['vwap_proximity'], 0.001),
      liquidityMinScore: _d(j['liquidity_min_score'], 60),
      williamsOversold: _d(j['williams_oversold'], -80),
      williamsOverbought: _d(j['williams_overbought'], -20),
      rocThreshold: _d(j['roc_threshold'], 0.1),
      lowVolThreshold: _d(j['low_vol_threshold'], 0.6),
      lowVolDamp: _d(j['low_vol_damp'], 0.7),
      rangingAdx: _d(j['ranging_adx'], 15),
      rangingDamp: _d(j['ranging_damp'], 0.8),
      confidenceBase: _d(j['confidence_base'], 92.5),
      confidenceMax: _d(j['confidence_max'], 98.9),
      tier1Weight: _d(j['tier1_weight'], 3.0),
      tier2Weight: _d(j['tier2_weight'], 2.5),
      tier3Weight: _d(j['tier3_weight'], 2.0),
      tier4Weight: _d(j['tier4_weight'], 2.0),
      tier5Weight: _d(j['tier5_weight'], 1.5),
    );
  }

  static double _d(dynamic v, double def) =>
      v == null ? def : (v as num).toDouble();
  static int _i(dynamic v, int def) => v == null ? def : (v as num).toInt();

  Map<String, dynamic> toJson() => {
    'name': name,
    'ema_periods': emaPeriods,
    'rsi_period': rsiPeriod,
    'macd_fast': macdFast,
    'macd_slow': macdSlow,
    'macd_signal': macdSignalPeriod,
    'bb_period': bbPeriod,
    'bb_stddev': bbStddev,
    'stoch_period': stochPeriod,
    'stoch_smooth': stochSmooth,
    'adx_period': adxPeriod,
    'cci_period': cciPeriod,
    'mfi_period': mfiPeriod,
    'cmf_period': cmfPeriod,
    'williams_period': williamsPeriod,
    'roc_period': rocPeriod,
    'atr_period': atrPeriod,
    'rsi_oversold_extreme': rsiOversoldExtreme,
    'rsi_oversold': rsiOversold,
    'rsi_overbought': rsiOverbought,
    'rsi_overbought_extreme': rsiOverboughtExtreme,
    'stoch_oversold': stochOversold,
    'stoch_overbought': stochOverbought,
    'adx_strong': adxStrong,
    'adx_moderate': adxModerate,
    'cci_extreme': cciExtreme,
    'cci_strong': cciStrong,
    'mfi_oversold': mfiOversold,
    'mfi_overbought': mfiOverbought,
    'cmf_strong': cmfStrong,
    'cmf_mild': cmfMild,
    'vol_delta_strong': volDeltaStrong,
    'vol_delta_mild': volDeltaMild,
    'vol_spike_multiplier': volSpikeMultiplier,
    'sr_proximity': srProximity,
    'vwap_proximity': vwapProximity,
    'liquidity_min_score': liquidityMinScore,
    'williams_oversold': williamsOversold,
    'williams_overbought': williamsOverbought,
    'roc_threshold': rocThreshold,
    'low_vol_threshold': lowVolThreshold,
    'low_vol_damp': lowVolDamp,
    'ranging_adx': rangingAdx,
    'ranging_damp': rangingDamp,
    'confidence_base': confidenceBase,
    'confidence_max': confidenceMax,
    'tier1_weight': tier1Weight,
    'tier2_weight': tier2Weight,
    'tier3_weight': tier3Weight,
    'tier4_weight': tier4Weight,
    'tier5_weight': tier5Weight,
  };
}

class SignalEngine extends ChangeNotifier {
  final Random _random = Random();

  // Standard vs VIP status
  String _userRole = 'standard'; // 'standard' or 'vip'
  DateTime? _vipExpiry;
  bool _vipJustExpired = false;

  // Guaranteed win mode (admin-controlled per user)
  bool _isGuaranteedWin = false;
  bool _marketClosed = false;

  // Per-account signal history key
  String _accountId = '';

  // Per-role strategy configs (parametric)
  StrategyConfig _stdStrategy = const StrategyConfig();
  StrategyConfig _vipStrategy = const StrategyConfig();

  // Per-role dynamic rule strategies (overrides parametric when set)
  DynamicStrategy? _stdDynamic;
  DynamicStrategy? _vipDynamic;

  // Last evaluated PRO result (for external query and UI feedback)
  Map<String, dynamic>? _lastProResult;
  Map<String, dynamic>? get lastProResult => _lastProResult;

  // Per-role MONITORING strategies (independent JSON from the signal strategies).
  // Same format + same engine — only the trigger differs (wait for a new candle).
  DynamicStrategy? _monStdDynamic;
  DynamicStrategy? _monVipDynamic;

  StrategyConfig get _cfg => _userRole == 'vip' ? _vipStrategy : _stdStrategy;

  DynamicStrategy? get _activeDynamic =>
      _userRole == 'vip' ? _vipDynamic : _stdDynamic;

  // The monitoring strategy for the current role (falls back to the other role's
  // monitoring strategy, then to the normal signal strategy, so a signal can
  // still fire if the admin only uploaded one).
  DynamicStrategy? get _activeMonitoringDynamic =>
      (_userRole == 'vip' ? _monVipDynamic : _monStdDynamic) ??
      _monStdDynamic ??
      _monVipDynamic ??
      _activeDynamic;

  // ── Smart monitoring state ────────────────────────────────────────────────
  bool _monitoring = false; // monitoring loop running
  String _monPhase = 'idle'; // 'idle' | 'waiting' | 'trade'
  int _monCountdown = 0; // seconds until the next candle opens
  double _lastSignalStrength = 0.0; // score ÷ max_score × 100 of the last fire
  DateTime? _monStartTime; // when the current monitoring session began
  bool _monLastCheckFailed = false; // last new candle didn't meet conditions
  int _monChecksDone = 0; // how many candles have been evaluated
  int _monSignalsFired =
      0; // signals fired since monitoring started (missed-alert)

  bool get isMonitoring => _monitoring;
  String get monitoringPhase => _monPhase;
  int get monitoringCountdown => _monCountdown;
  double get lastSignalStrength => _lastSignalStrength;
  bool get monitoringLastCheckFailed => _monLastCheckFailed;
  int get monitoringChecksDone => _monChecksDone;
  int get monitoringSignalsFired => _monSignalsFired;

  int get monitoringElapsedSeconds {
    if (_monStartTime == null) return 0;
    final s = DateTime.now().difference(_monStartTime!).inSeconds;
    return s > 0 ? s : 0;
  }

  String get formattedMonitoringElapsed {
    final s = monitoringElapsedSeconds;
    final h = s ~/ 3600;
    final m = (s % 3600) ~/ 60;
    final sec = s % 60;
    return "${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}:${sec.toString().padLeft(2, '0')}";
  }

  String get formattedMonitoringCountdown {
    final s = _monCountdown < 0 ? 0 : _monCountdown;
    final m = s ~/ 60;
    final sec = s % 60;
    return "${m.toString().padLeft(2, '0')}:${sec.toString().padLeft(2, '0')}";
  }

  VipAnalysisResult? _vipLastResult;

  String get userRole => _userRole;
  DateTime? get vipExpiry => _vipExpiry;
  bool get vipJustExpired => _vipJustExpired;
  VipAnalysisResult? get vipLastResult => _vipLastResult;

  void clearVipJustExpired() {
    _vipJustExpired = false;
    notifyListeners();
  }

  void clearActiveSignal() {
    evalJs("CandleChart.setGlobalEntryLine(null, null)");
    _activeSignal = null;
    _secondsRemaining = 0;
    _signalChangeNotice = '';
    notifyListeners();
  }

  void updateUserData(String role, DateTime? expiry) {
    _userRole = role;
    _vipExpiry = expiry?.toUtc(); // VIP expiry is absolute UTC
    notifyListeners();
  }

  bool get isGuaranteedWin => _isGuaranteedWin;
  bool get isMarketClosed => _marketClosed;
  // Weekend check independent of analysis — used by UI without needing to run analysis first
  // Single source of truth for the live room / social feed. `_marketClosed` is
  // computed per-system by main_screen._pollMarketStatus:
  //   • Pocket Option (OTC) pairs → closed ONLY when the N/A flag (po) is set.
  bool get isWeekendClosed => _marketClosed;

  void updateGuaranteedWin(bool value) {
    _isGuaranteedWin = value;
    notifyListeners();
  }

  void clearMarketClosed() {
    _marketClosed = false;
    notifyListeners();
  }

  /// Server-driven market open/closed flag (from proxy `marketOpen`).
  void setMarketClosed(bool value) {
    if (_marketClosed == value) return;
    _marketClosed = value;
    notifyListeners();
  }

  void updateStandardStrategy(Map<String, dynamic> json) {
    if (json.containsKey('rules')) {
      _stdDynamic = DynamicStrategy.fromJson(json);
    } else {
      _stdDynamic = null;
      _stdStrategy = StrategyConfig.fromJson(json);
    }
    notifyListeners();
  }

  void updateVipStrategy(Map<String, dynamic> json) {
    if (json.containsKey('rules')) {
      _vipDynamic = DynamicStrategy.fromJson(json);
    } else {
      _vipDynamic = null;
      _vipStrategy = StrategyConfig.fromJson(json);
    }
    notifyListeners();
  }

  void updateMonitoringStandardStrategy(Map<String, dynamic> json) {
    _monStdDynamic = json.containsKey('rules')
        ? DynamicStrategy.fromJson(json)
        : null;
    notifyListeners();
  }

  void updateMonitoringVipStrategy(Map<String, dynamic> json) {
    _monVipDynamic = json.containsKey('rules')
        ? DynamicStrategy.fromJson(json)
        : null;
    notifyListeners();
  }

  // ── Smart monitoring loop ──────────────────────────────────────────────────
  // Waits for a NEW candle to open, evaluates the monitoring strategy on it, and
  // fires a signal only when min_score is met. If not, it waits for the next
  // candle and repeats. After a fired trade completes, monitoring resumes
  // automatically for the next candle. All timing is wall-clock (candle
  // boundaries), independent of the device clock display, and re-reads the
  // timeframe/pair every loop so it adapts when the user changes either one.
  Future<void> startMonitoring(
    int selectedMinutes, {
    double Function()? livePriceGetter,
  }) async {
    if (_monitoring) return;
    _livePriceGetter = livePriceGetter;
    _monitoring = true;
    _monPhase = 'waiting';
    _monStartTime = DateTime.now();
    _monLastCheckFailed = false;
    _monChecksDone = 0;
    _monSignalsFired = 0;
    _activeSignal = null;
    _playActivateSound();
    notifyListeners();

    while (_monitoring) {
      if (_marketClosed) break;

      // 1) Wait for the current candle to close (next boundary).
      final cs = timeframeSeconds;
      final startSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final nextBoundary = (startSec ~/ cs + 1) * cs;
      _monPhase = 'waiting';
      while (_monitoring) {
        final nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
        final rem = nextBoundary - nowSec;
        if (rem <= 0) break;
        _monCountdown = rem;
        notifyListeners();
        await Future.delayed(const Duration(milliseconds: 250));
      }
      if (!_monitoring) break;
      _monCountdown = 0;

      // 2) Let the chart roll & seed the freshly-opened candle, then evaluate.
      await Future.delayed(const Duration(milliseconds: 200));
      if (!_monitoring) break;
      _updateAllIndicators();

      final dyn = _activeMonitoringDynamic;
      _pyramidRejectReason = '';
      double netScore;
      try {
        netScore = dyn != null
            ? _evaluateRules(dyn)
            : (_userRole == 'vip' ? _scoreV3VipEngine() : _scoreV2Engine());
      } catch (_) {
        netScore = 0.0;
      }
      final absScore = netScore.abs();
      final minScore = dyn?.minScore ?? 0.0;
      final rejected = _pyramidRejectReason.isNotEmpty;
      _monChecksDone++;

      // 3) min_score met → fire on this new candle, then wait out the trade.
      if (!rejected && absScore >= minScore) {
        _monLastCheckFailed = false;
        _monSignalsFired++;
        _fireMonitoringSignal(netScore, dyn);
        _monPhase = 'trade';
        notifyListeners();
        // Wait for the trade to finish...
        while (_monitoring &&
            _activeSignal != null &&
            _activeSignal!.status == 'ACTIVE') {
          await Future.delayed(const Duration(milliseconds: 250));
        }
        // ...then for the user to acknowledge the result (signal cleared), so a
        // new signal is never fired over an open review dialog. Monitoring then
        // resumes automatically for the next candle (no button press needed).
        while (_monitoring && _activeSignal != null) {
          await Future.delayed(const Duration(milliseconds: 250));
        }
        _monLastCheckFailed = false;
      } else {
        // Not met → show "conditions not met, waiting for next candle" and loop.
        _monLastCheckFailed = true;
        _monPhase = 'waiting';
        notifyListeners();
      }
    }

    _monitoring = false;
    _monPhase = 'idle';
    _monCountdown = 0;
    _monLastCheckFailed = false;
    _monStartTime = null;
    notifyListeners();
  }

  void stopMonitoring() {
    if (!_monitoring && _monPhase == 'idle') return;
    _monitoring = false;
    _monPhase = 'idle';
    _monCountdown = 0;
    _monLastCheckFailed = false;
    _monStartTime = null;
    notifyListeners();
  }

  // Builds + arms a signal from a monitoring hit on the just-opened candle.
  // Trade duration = exactly ONE candle of the active timeframe
  // (1m→1min, 5m→5min, 15m→15min, 1h→1h).
  void _fireMonitoringSignal(double netScore, DynamicStrategy? dyn) {
    final bool isCall = netScore >= 0;
    final double absScore = netScore.abs();

    final double maxScore =
        dyn?.effectiveMaxScore ?? (absScore > 0 ? absScore : 1.0);
    _lastSignalStrength = (absScore / maxScore * 100).clamp(0.0, 100.0);

    final double confBase = dyn?.confidenceBase ?? 92.5;
    final double confMax = dyn?.confidenceMax ?? 98.9;
    double confidence = (confBase + (absScore / 45.0) * (confMax - confBase))
        .clamp(confBase, confMax);

    final int nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final int cs = timeframeSeconds;
    final int cStartSec = (nowSec ~/ cs) * cs;
    final int expirySec = cStartSec + cs; // exactly one candle
    final alignedExpiry = DateTime.fromMillisecondsSinceEpoch(expirySec * 1000);
    final int alignedDuration = (expirySec - nowSec).clamp(1, cs + cs);

    final double liveNow = _livePriceGetter?.call() ?? 0;
    final double entryP = liveNow > 0 ? liveNow : _currentPrice;

    _activeSignal = TradingSignal(
      pair: _activePair,
      direction: isCall ? 'CALL' : 'PUT',
      durationMinutes: (cs / 60).round().clamp(1, 600),
      entryPrice: entryP,
      currentPrice: entryP,
      confidence: confidence,
      entryTime: DateTime.fromMillisecondsSinceEpoch(cStartSec * 1000),
      expiryTime: alignedExpiry,
      status: 'ACTIVE',
      marketCondition: isCall
          ? tr(
              '🎯 مراقبة ذكية — لحظة دخول صعود مؤكدة ✅',
              '🎯 Smart monitoring — confirmed CALL entry moment ✅',
            )
          : tr(
              '🎯 مراقبة ذكية — لحظة دخول هبوط مؤكدة ✅',
              '🎯 Smart monitoring — confirmed PUT entry moment ✅',
            ),
      recommendation: isCall
          ? tr(
              'دخول صفقة صعود (CALL) على بداية الشمعة — أفضل لحظة دخول.',
              'Enter a CALL trade at the candle open — the best entry moment.',
            )
          : tr(
              'دخول صفقة هبوط (PUT) على بداية الشمعة — أفضل لحظة دخول.',
              'Enter a PUT trade at the candle open — the best entry moment.',
            ),
      origin: 'monitoring',
    );

    _secondsRemaining = alignedDuration;
    // Distinct alert per direction (rising for CALL, falling for PUT).
    if (isCall) {
      _playCallSound();
    } else {
      _playPutSound();
    }
    evalJs(
      "CandleChart.setGlobalEntryLine($entryP, '${isCall ? 'CALL' : 'PUT'}')",
    );
    notifyListeners();
  }

  // ── Rule Engine ──────────────────────────────────────────────────────────

  // Computes any indicator value from a rule. Returns double or String.
  dynamic _computeIndicator(StrategyRule r, Map<String, dynamic> cache) {
    final key =
        '${r.indicator}_${r.period}_${r.fast}_${r.slow}_${r.smooth}_${r.stddev}';
    if (cache.containsKey(key)) return cache[key];

    dynamic result;
    switch (r.indicator) {
      case 'rsi':
        result = _calculateRsi(r.period);
      case 'macd_histogram':
        result = _calculateFullMacd()['histogram']!;
      case 'macd_line':
        result = _calculateFullMacd()['macd']!;
      case 'macd_signal':
        result = _calculateFullMacd()['signal']!;
      case 'ema':
        result = _calculateEma(min(r.period, _candles.length));
      case 'ema_cross':
        result =
            _calculateEma(min(r.fast, _candles.length)) -
            _calculateEma(min(r.slow, _candles.length));
      case 'adx':
        result = _calculateAdxFull(r.period)['adx']!;
      case 'plus_di':
        result = _calculateAdxFull(r.period)['plusDi']!;
      case 'minus_di':
        result = _calculateAdxFull(r.period)['minusDi']!;
      case 'stoch_k':
        result = _calculateStochastic(r.period, r.smooth)['k']!;
      case 'stoch_d':
        result = _calculateStochastic(r.period, r.smooth)['d']!;
      case 'stoch_cross':
        final s = _calculateStochastic(r.period, r.smooth);
        result = s['k']! - s['d']!;
      case 'cci':
        result = _calculateCci(r.period);
      case 'mfi':
        result = _calculateMfi(r.period);
      case 'cmf':
        result = _calculateCmf(r.period);
      case 'williams_r':
        result = _calculateWilliamsR(r.period);
      case 'roc':
        result = _calculateRoc(r.period);
      case 'atr':
        result = _calculateAtr(r.period);
      case 'bb_position':
        final bb = _calculateBollingerBands(r.period, r.stddev);
        final range = bb['upper']! - bb['lower']!;
        result = range > 0
            ? ((_currentPrice - bb['lower']!) / range) * 100.0
            : 50.0;
      case 'bb_upper':
        result = _calculateBollingerBands(r.period, r.stddev)['upper']!;
      case 'bb_lower':
        result = _calculateBollingerBands(r.period, r.stddev)['lower']!;
      case 'bb_width':
        final bb = _calculateBollingerBands(r.period, r.stddev);
        result = bb['upper']! - bb['lower']!;
      case 'vol_delta':
        result = _calculateVolumeDelta();
      case 'vol_ratio':
        result = (_analyzeVolumeProfile()['ratio'] as double);
      case 'obv':
        result = _calculateObv();
      case 'vwap':
        result = _calculateVwap();
      case 'price_vs_vwap':
        result = _currentPrice - _calculateVwap();
      case 'sr_support':
        result = _calculateSupportResistance()['support']!;
      case 'sr_resistance':
        result = _calculateSupportResistance()['resistance']!;
      case 'liquidity_score':
        result = (_calculateLiquidityZones()['score'] as double);
      case 'divergence':
        final d = _detectRsiDivergence();
        result = d == 'bullish'
            ? 1.0
            : d == 'bearish'
            ? -1.0
            : 0.0;
      case 'candle_pattern':
        result = _detectCandlePatterns(); // returns String
      case 'market_structure':
        result = _detectMarketStructure();
      case 'break_of_structure':
        result = _detectBreakOfStructure();
      case 'change_of_character':
        result = _detectChangeOfCharacter();
      case 'order_block':
        result = _detectOrderBlock();
      case 'fair_value_gap':
        result = _detectFairValueGap();
      case 'liquidity_sweep':
        result = _detectLiquiditySweep();
      case 'fibonacci':
        result = _detectFibonacci(r.value ?? 0.618);
      case 'volume':
        result = (_analyzeVolumeProfile()['ratio'] as double);
      case 'volume_profile':
        result = _detectVolumeProfile();
      case 'liquidity':
        result = _detectInstitutionalActivity();
      case 'time_analysis':
        result = _detectTimeSession(r.pattern ?? 'london_newyork_overlap');
      case 'elliott_wave':
        result = _detectElliottWave(r.pattern);
      case 'internal_bos':
        result = _detectInternalBos();
      case 'external_bos':
        result = _detectExternalBos();
      case 'breaker_block':
        result = _detectBreakerBlock();
      case 'rejection_block':
        result = _detectRejectionBlock();
      case 'mitigation_block':
        result = _detectMitigationBlock();
      case 'inverse_fvg':
        result = _detectInverseFvg();
      case 'imbalance':
        result = _detectFairValueGap();
      case 'bpr':
        result = _detectBalancedPriceRange();
      case 'equal_highs':
      case 'eqh':
        result = _detectEqualHighs();
      case 'equal_lows':
      case 'eql':
        result = _detectEqualLows();
      case 'premium_zone':
        result = _detectPremiumZone();
      case 'discount_zone':
        result = _detectDiscountZone();
      case 'ote':
        result = _detectOte();
      case 'dealing_range':
        result = _detectDealingRange();
      case 'market_maker_buy_model':
        result = _detectMarketMakerBuyModel();
      case 'market_maker_sell_model':
        result = _detectMarketMakerSellModel();
      case 'judas_swing':
        result = _detectJudasSwing();
      case 'session_open':
        result = _detectSessionOpen();
      case 'opening_range':
        result = _detectOpeningRange();
      case 'wyckoff_spring':
        result = _detectWyckoffSpring();
      case 'wyckoff_upthrust':
        result = _detectWyckoffUpthrust();
      case 'accumulation':
        result = _detectAccumulation();
      case 'distribution':
        result = _detectDistribution();
      case 'manipulation':
        result = _detectManipulation();
      case 'expansion':
        result = _detectExpansion();

      // ── Time Analysis Extended ──────────────────────────────────────────
      case 'kill_zone':
        result = _detectKillZone();
      case 'day_of_week':
        result = _detectDayOfWeek();
      case 'session':
        result = _detectTimeSession(r.pattern ?? 'london');
      case 'session_overlap':
        result = _detectSessionOverlap();

      // ── Chart Patterns ──────────────────────────────────────────────────
      case 'double_top':
        result = _detectDoubleTop();
      case 'double_bottom':
        result = _detectDoubleBottom();
      case 'head_and_shoulders':
        result = _detectHeadAndShoulders();
      case 'inverse_head_and_shoulders':
        result = _detectInverseHeadAndShoulders();
      case 'ascending_triangle':
        result = _detectAscendingTriangle();
      case 'descending_triangle':
        result = _detectDescendingTriangle();
      case 'symmetrical_triangle':
        result = _detectSymmetricalTriangle();
      case 'rising_wedge':
        result = _detectWedge(true);
      case 'falling_wedge':
        result = _detectWedge(false);
      case 'bull_flag':
        result = _detectFlag(true);
      case 'bear_flag':
        result = _detectFlag(false);
      case 'pennant':
        result = _detectSymmetricalTriangle();
      case 'rectangle':
        result = _detectRectangle();
      case 'channel_up':
        result = _detectChannel(true);
      case 'channel_down':
        result = _detectChannel(false);
      case 'horizontal_channel':
        result = _detectRectangle();
      case 'cup_and_handle':
        result = _detectCupAndHandle();

      // ── Harmonic Patterns ───────────────────────────────────────────────
      case 'gartley':
        result = _detectHarmonic('gartley');
      case 'bat':
        result = _detectHarmonic('bat');
      case 'alternate_bat':
        result = _detectHarmonic('bat');
      case 'butterfly':
        result = _detectHarmonic('butterfly');
      case 'crab':
        result = _detectHarmonic('crab');
      case 'deep_crab':
        result = _detectHarmonic('crab');
      case 'shark':
        result = _detectHarmonic('shark');
      case 'cypher':
        result = _detectHarmonic('cypher');
      case 'ab_cd':
        result = _detectHarmonic('ab_cd');
      case 'three_drives':
        result = _detectHarmonic('three_drives');
      case '5_0':
        result = _detectHarmonic('ab_cd');

      // ── Advanced Candlestick ────────────────────────────────────────────
      case 'advanced_candle':
      case 'doji':
      case 'dragonfly_doji':
      case 'gravestone_doji':
      case 'spinning_top':
      case 'marubozu':
      case 'tweezer':
      case 'harami':
      case 'kicker':
      case 'abandoned_baby':
      case 'belt_hold':
      case 'three_inside':
      case 'three_outside':
        result = _detectAdvancedCandlePattern();

      // ── Technical Schools / Methods ─────────────────────────────────────
      case 'pivot_point':
      case 'cpr':
        result = r.indicator == 'cpr' ? _detectCpr() : _detectPivotPoint();
      case 'supply_demand':
        result = _detectSupplyDemandZone();
      case 'breakout':
        result = _detectBreakoutSignal();
      case 'momentum_trading':
      case 'momentum':
        result = _detectMomentumSignal();
      case 'mean_reversion':
        result = _detectMeanReversionSignal();
      case 'nr4':
        result = _detectNrPattern(4);
      case 'nr7':
        result = _detectNrPattern(7);
      case 'vcp':
        result = _detectVcp();
      case 'orb':
      case 'opening_range_breakout':
        result = _detectOrbSignal();
      case 'heikin_ashi':
        result = _detectHeikinAshi();
      case 'anchored_vwap':
        result = _detectAnchoredVwap();
      case 'vwap_bands':
        result = _detectVwapBands();
      case 'trend_following':
      case 'dow_theory':
        result = _detectDowTrend();
      case 'vsa':
      case 'no_demand':
      case 'no_supply':
        result = _detectVsaSignal();
      case 'cvd':
      case 'cumulative_volume_delta':
        result = _detectCvd();
      case 'wolfe_waves':
        result = _detectWolfeWave();
      case 'demark':
      case 'td_sequential':
        result = _detectDemarkSequential();
      case 'darvas_box':
        result = _detectDarvasBox();
      case 'gann_angle':
        result = _detectGannAngle();
      case 'wyckoff':
        result = _detectWyckoffSpring();

      // ── Quantitative / Statistical ──────────────────────────────────────
      case 'hurst_exponent':
        result = _calculateHurstExponent();
      case 'fractal_dimension':
        result = 2.0 - _calculateHurstExponent();
      case 'entropy_analysis':
        result = _detectEntropyAnalysis();
      case 'regime_detection':
      case 'market_regime_classification':
        result = _detectMarketRegime();
      case 'volatility_regime_analysis':
        result = _detectVolatilityRegime();
      case 'anomaly_detection':
        result = _detectAnomaly();
      case 'liquidity_voids':
        result = _detectLiquidityVoid();
      case 'spectral_analysis':
        result = _detectSpectralCycle();
      case 'monte_carlo_risk_simulation':
        result = _detectMonteCarlo();
      case 'wavelet_decomposition':
        result = _detectWaveletTrend();
      case 'kelly_criterion':
        result = _detectKellyValue();

      // ── Trend Extended ────────────────────────────────────────────────────
      case 'supertrend':
        result = _detectSuperTrend(period: r.period, mult: r.value ?? 3.0);
      case 'ichimoku':
        result = _detectIchimoku();
      case 'hma':
      case 'hull_ma':
        result = _calculateHma(r.period);
      case 'dema':
        result = _calculateDema(r.period);
      case 'tema':
        result = _calculateTema(r.period);
      case 'alma':
        result = _calculateAlma(r.period);
      case 'lsma':
      case 'linear_regression':
        result = _calculateLinearRegression(r.period);
      case 'aroon_up':
        {
          final a = _calculateAroon(r.period);
          result = a['up']!;
        }
      case 'aroon_down':
        {
          final a = _calculateAroon(r.period);
          result = a['down']!;
        }
      case 'aroon':
      case 'aroon_oscillator':
        {
          final a = _calculateAroon(r.period);
          result = a['up']! - a['down']!;
        }
      case 'vortex_plus':
        {
          final v = _calculateVortex(r.period);
          result = v['plus']!;
        }
      case 'vortex_minus':
        {
          final v = _calculateVortex(r.period);
          result = v['minus']!;
        }
      case 'vortex':
        {
          final v = _calculateVortex(r.period);
          result = v['plus']! - v['minus']!;
        }
      case 'alligator':
        result = _detectAlligator();
      case 'ao':
      case 'awesome_oscillator':
        result = _calculateAo();

      // ── Oscillators Extended ──────────────────────────────────────────────
      case 'ultimate_oscillator':
        result = _calculateUltimateOscillator();
      case 'tsi':
        result = _calculateTsi();
      case 'fisher_transform':
        result = _calculateFisherTransform(r.period);
      case 'cmo':
        result = _calculateCmo(r.period);
      case 'rvi':
        result = _calculateRvi(r.period);
      case 'dpo':
        result = _calculateDpo(r.period);
      case 'connors_rsi':
        result = _calculateConnorsRsi();
      case 'stc':
        result = _calculateStc();
      case 'elder_bull_power':
      case 'bull_power':
        result = _calculateElderBullPower(r.period);
      case 'elder_bear_power':
      case 'bear_power':
        result = _calculateElderBearPower(r.period);
      case 'elder_force_index':
        result = _calculateElderForceIndex();
      case 'bop':
        result = _calculateBop();
      case 'ppo':
        result = _calculatePpo();
      case 'trix':
        result = _calculateTrix(r.period);
      case 'kst':
        result = _calculateKst();

      // ── Volatility Extended ───────────────────────────────────────────────
      case 'keltner_channel':
        result = _detectKeltnerChannel();
      case 'donchian_channel':
        result = _detectDonchianChannel(r.period);
      case 'mass_index':
        result = _calculateMassIndex(r.period);
      case 'historical_volatility':
      case 'hv':
        result = _calculateHistoricalVolatility(r.period);
      case 'ulcer_index':
        result = _calculateUlcerIndex(r.period);

      // ── Volume Extended ───────────────────────────────────────────────────
      case 'emv':
      case 'ease_of_movement':
        result = _calculateEmv(r.period);
      case 'pvt':
        result = _calculatePvt();
      case 'klinger':
      case 'klinger_oscillator':
        result = _calculateKlinger();
      case 'nvi':
        result = _calculateNvi();
      case 'pvi':
        result = _calculatePvi();
      case 'volume_oscillator':
        result = _calculateVolumeOscillator(r.fast, r.slow);

      // ── Price Action Extended ─────────────────────────────────────────────
      case 'fractals':
        result = _detectFractals();
      case 'inside_bar':
        result = _detectInsideBar();
      case 'outside_bar':
        result = _detectOutsideBar();
      case 'fakey':
      case 'inside_bar_fakey':
        result = _detectFakeyPattern();

      // ── ICT Extended ──────────────────────────────────────────────────────
      case 'power_of_three':
      case 'po3':
      case 'amd_cycle':
        result = _detectPowerOfThree();
      case 'turtle_soup':
        result = _detectTurtleSoup();
      case 'cisd':
        result = _detectCisd();
      case 'consequent_encroachment':
      case 'ce':
        result = _detectConsequentEncroachment();
      case 'inducement':
        result = _detectInducement();

      // ── Wyckoff Phases Extended ───────────────────────────────────────────
      case 'wyckoff_phase':
        result = _detectWyckoffPhase();

      // ── Market Profile ────────────────────────────────────────────────────
      case 'market_profile':
      case 'tpo':
        result = _detectMarketProfileZone();
      case 'poc':
        {
          final mp = _calculateMarketProfile();
          result = mp['poc']!;
        }
      case 'vah':
        {
          final mp = _calculateMarketProfile();
          result = mp['vah']!;
        }
      case 'val':
        {
          final mp = _calculateMarketProfile();
          result = mp['val']!;
        }

      // ── Pivot Systems Extended ────────────────────────────────────────────
      case 'camarilla_pivot':
      case 'camarilla':
        result = _detectCamarillaPivot();
      case 'woodie_pivot':
      case 'woodie':
        result = _detectWoodiePivot();
      case 'fibonacci_pivot':
      case 'fib_pivot':
        result = _detectFibPivot();

      // ── Chart Patterns Extended ───────────────────────────────────────────
      case 'broadening_wedge':
      case 'megaphone':
        result = _detectBroadeningWedge();
      case 'island_reversal':
        result = _detectIslandReversal();
      case 'diamond':
      case 'diamond_top':
        result = _detectDiamondPattern();
      case 'rounding_bottom':
        result = _detectRoundingPattern(true);
      case 'rounding_top':
        result = _detectRoundingPattern(false);

      // ── Time Extended ─────────────────────────────────────────────────────
      case 'opening_gap':
        result = _detectOpeningGap();
      case 'fibonacci_time_zone':
      case 'fib_time':
        result = _detectFibTimeZone();

      // ── Gann Extended ─────────────────────────────────────────────────────
      case 'gann_fan':
        result = _detectGannFan();

      // ── DeMark Extended ───────────────────────────────────────────────────
      case 'td_combo':
        result = _detectTdCombo();

      // ── Statistical Extended ──────────────────────────────────────────────
      case 'z_score':
        result = _calculateZScore(r.period);

      // ── Adaptive / Advanced MAs ───────────────────────────────────────────
      case 'kama':
        result = _calculateKama(r.period);
      case 't3':
        result = _calculateT3(r.period);
      case 'chande_kroll_stop':
      case 'ckstop':
        result = _detectChandeKrollStop(
          atrPeriod: r.period,
          mult: r.value ?? 1.5,
        );
      case 'ac':
      case 'accelerator_oscillator':
        result = _calculateAc();

      // ── Volatility / Price Action Extras ──────────────────────────────────
      case 'starc_bands':
      case 'starc':
        result = _detectStarcBands();
      case 'chaikin_volatility':
        result = _calculateChaikinVolatility(r.period);
      case 'idnr4':
        result = _detectIdnr4();
      case 'initial_balance':
      case 'ib':
        result = _detectInitialBalance();
      case 'silver_bullet':
        result = _detectSilverBullet();
      case 'institutional_candle':
        result = _detectInstitutionalCandle();
      case 'reaccumulation':
        result = _detectReaccumulation();
      case 'redistribution':
        result = _detectRedistribution();
      case 'pipe_top':
        result = _detectPipePattern(true);
      case 'pipe_bottom':
        result = _detectPipePattern(false);
      case 'bump_and_run':
        result = _detectBumpAndRun();
      case 'demark_pivot':
      case 'demark_p':
        result = _detectDemarkPivot();

      // ── Needs External Data (stubs) ─────────────────────────────────────
      case 'smt_divergence':
      case 'dom':
      case 'footprint':
      case 'iceberg_orders':
      case 'spoofing':
      case 'neural_network':
      case 'kalman_filter':
      case 'lunar_cycle':
      case 'astro':
      case 'seasonality':
      case 'intermarket':
      case 'market_breadth':
      case 'advance_decline':
      case 'microstructure_analysis':
      case 'smart_tape_reading':
      case 'latency_arbitrage_analysis':
      case 'statistical_arbitrage':
      case 'quantitative_factor_models':
      case 'risk_parity_analysis':
      case 'hidden_liquidity_models':
      case 'liquidity_heatmaps':
      case 'pca':
      case 'ica':
      case 'clustering_analysis':
      case 'reinforcement_learning_models':
      case 'deep_learning_pattern_recognition':
      case 'transformer_based_time_series':
      case 'bayesian_networks':
      case 'hidden_markov_models':
      case 'gaussian_process_regression':
      case 'cointegration_spread_analysis':
      case 'cross_asset_flow_analysis':
      case 'macro_cycle_analysis':
      case 'economic_calendar_impact_analysis':
      case 'news_sentiment_analysis':
      case 'social_sentiment_analysis':
      case 'on_chain_analysis':
      case 'funding_rate_analysis':
      case 'long_short_ratio_analysis':
      case 'liquidation_heatmap_analysis':
      case 'options_open_interest_analysis':
      case 'gamma_exposure':
      case 'delta_exposure':
      case 'max_pain_analysis':
      case 'dealer_positioning_analysis':
      // ── Market Breadth (requires multi-asset feed) ────────────────────────
      case 'advance_decline_line':
      case 'ad_line':
      case 'mcclellan_oscillator':
      case 'mcclellan_summation':
      case 'arms_index':
      case 'trin':
      case 'tick_index':
      case 'tick':
      case 'put_call_ratio':
      case 'vix':
      case 'new_highs_lows':
      case 'nhnl':
      case 'breadth_thrust':
      case 'zweig_breadth':
      case 'bullish_percent_index':
      case 'bpi':
      case 'sector_rotation':
      case 'relative_rotation_graph':
      case 'rrg':
      // ── Crypto / DeFi specific ────────────────────────────────────────────
      case 'exchange_netflow':
      case 'exchange_reserves':
      case 'hash_rate':
      case 'mining_difficulty':
      case 'whale_alert':
      case 'realized_pnl':
      case 'sopr':
      case 'nupl':
      case 'mvrv':
      case 'stock_to_flow':
      case 'pi_cycle':
      // ── Macro / Rates ─────────────────────────────────────────────────────
      case 'yield_curve':
      case 'us10y':
      case 'dxy':
      case 'gold_ratio':
      case 'risk_on_off':
      case 'cot_report':
      case 'commitment_of_traders':
      // ── ML / AI (requires trained models) ────────────────────────────────
      case 'xgboost':
      case 'random_forest':
      case 'lstm':
      case 'transformer':
      case 'cnn_pattern':
      case 'autoencoder':
      case 'som':
      case 'gradient_boosting':
      case 'svm_classifier':
      case 'tcn':
      case 'wavenet':
        result = 0.0; // requires external data
      case 'price':
        result = _currentPrice;
      default:
        result = 0.0;
    }

    cache[key] = result;
    return result;
  }

  bool _checkCondition(StrategyRule r, dynamic raw) {
    // String-based conditions (candle_pattern, etc.)
    if (raw is String) {
      final target = r.pattern ?? r.value?.toString() ?? '';
      switch (r.condition) {
        case 'eq':
          return raw == target;
        case 'neq':
          return raw != target;
        case 'bullish':
          return raw.contains('bullish') ||
              raw.contains('hammer') ||
              raw.contains('morning') ||
              raw.contains('soldiers') ||
              raw.contains('pin_bar_b');
        case 'bearish':
          return raw.contains('bearish') ||
              raw.contains('shooting') ||
              raw.contains('evening') ||
              raw.contains('crows') ||
              raw.contains('pin_bar_bear');
        default:
          return raw ==
              r.condition; // e.g. higher_high_higher_low, sell_side, etc.
      }
    }

    // Numeric conditions
    final v = (raw as num).toDouble();
    switch (r.condition) {
      case 'gt':
        return v > (r.value ?? 0);
      case 'lt':
        return v < (r.value ?? 0);
      case 'gte':
        return v >= (r.value ?? 0);
      case 'lte':
        return v <= (r.value ?? 0);
      case 'eq':
        return v == (r.value ?? 0);
      case 'neq':
        return v != (r.value ?? 0);
      case 'between':
        return v >= (r.valueMin ?? 0) && v <= (r.valueMax ?? 0);
      case 'bullish':
        return v > 0;
      case 'bearish':
        return v < 0;
      case 'is_true':
        return v != 0;
      case 'is_false':
        return v == 0;
      case 'gt_average':
        return v > 1.0;
      case 'lt_average':
        return v < 1.0;
      default:
        return false;
    }
  }

  // ── Pyramid rejection reason (read by WAIT message builder) ─────────────
  String _pyramidRejectReason = '';

  double _evaluateRules(DynamicStrategy strategy) {
    final cache = <String, dynamic>{};

    // ── PYRAMID MODE ──────────────────────────────────────────────────────────
    if (strategy.pyramid != null) {
      return _evaluateRulesPyramid(strategy, cache);
    }

    // ── STANDARD SCORING MODE ─────────────────────────────────────────────────
    double callScore = 0.0, putScore = 0.0;
    for (final rule in strategy.rules) {
      if (!rule.enabled) continue;
      try {
        final raw = _computeIndicator(rule, cache);
        if (!_checkCondition(rule, raw)) continue;
        switch (rule.signal) {
          case 'CALL':
            callScore += rule.score;
          case 'PUT':
            putScore += rule.score;
          case 'dominant':
          case 'confirm':
            if (callScore >= putScore) {
              callScore += rule.score;
            } else {
              putScore += rule.score;
            }
        }
      } catch (_) {
        continue;
      }
    }
    return callScore - putScore;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PYRAMID EVALUATION — 3-stage hierarchical signal filter
  //
  //  Stage 1 — Primary (role:"primary"):
  //    Determines raw signal direction (CALL / PUT).
  //    Must reach minPrimaryScore, otherwise → NO SIGNAL.
  //
  //  Stage 2 — Confirmation (role:"confirm"):
  //    A minimum ratio of confirm rules must agree with the primary direction.
  //    Otherwise → NO SIGNAL.
  //
  //  Stage 3 — Filter (role:"filter"):
  //    Hard gates. Any single filter that fails → NO SIGNAL.
  //
  //  Base rules (role:"" or untagged):
  //    Add additional weight to the final score (non-blocking).
  // ─────────────────────────────────────────────────────────────────────────────
  String getCategoryForIndicator(StrategyRule r) {
    if (r.type.isNotEmpty) return r.type;
    
    final ind = r.indicator.toLowerCase();
    
    // 1. فئة الاتجاه (Trend / Direction)
    if (ind == 'ichimoku' ||
        ind == 'supertrend' ||
        ind.contains('vortex') ||
        ind.contains('aroon') ||
        ind == 'alligator' ||
        ind == 'parabolic_sar' ||
        ind == 'sar' ||
        ind == 'sma' ||
        ind == 'ema' ||
        ind == 'wma' ||
        ind == 'hma' ||
        ind == 'hull_ma' ||
        ind == 'dema' ||
        ind == 'tema' ||
        ind == 'alma' ||
        ind == 'lsma' ||
        ind == 'kama' ||
        ind == 't3' ||
        ind == 'linear_regression' ||
        ind == 'dow_theory' ||
        ind == 'trend_following' ||
        ind == 'kalman' ||
        ind == 'mtf' ||
        ind == 'multi_timeframe_alignment') {
      return 'Trend';
    }
    
    // 2. فئة المستويات السعرية (Price Levels / Support-Resistance)
    if (ind == 'pivot_point' ||
        ind == 'pivot' ||
        ind == 'cpr' ||
        ind == 'pdh' ||
        ind == 'pdl' ||
        ind == 'pdh_pdl' ||
        ind == 'sr_support' ||
        ind == 'sr_resistance' ||
        ind == 'orb' ||
        ind == 'opening_range_breakout' ||
        ind == 'opening_range' ||
        ind == 'vwap' ||
        ind == 'anchored_vwap' ||
        ind == 'vwap_bands' ||
        ind == 'price_vs_vwap' ||
        ind == 'keltner_channels' ||
        ind == 'donchian_channels' ||
        ind.contains('bollinger') ||
        ind.startsWith('bb_') ||
        ind == 'support_resistance') {
      return 'Price Levels';
    }
    
    // 3. فئة الإحصاء المتقدم (Advanced Statistics / Mathematical)
    if (ind == 'z_score' ||
        ind == 'zscore' ||
        ind == 'hurst_exponent' ||
        ind == 'entropy_analysis' ||
        ind == 'regime_detection' ||
        ind == 'market_regime_classification' ||
        ind == 'volatility_regime_analysis' ||
        ind == 'anomaly_detection' ||
        ind == 'spectral_analysis' ||
        ind == 'monte_carlo_risk_simulation' ||
        ind == 'wavelet_decomposition' ||
        ind == 'kelly_criterion' ||
        ind == 'choppiness' ||
        ind == 'choppiness_index') {
      return 'Advanced Statistics';
    }
    
    // 4. فئة الأنماط النادرة (Rare Patterns / Technical Formations)
    if (ind == 'three_bar_reversal' ||
        ind == 'island_reversal' ||
        ind == 'exhaustion_gap' ||
        ind == 'breakout' ||
        ind == 'candle_pattern' ||
        ind == 'candles' ||
        ind == 'wyckoff' ||
        ind == 'wyckoff_phase' ||
        ind == 'wyckoff_spring' ||
        ind == 'wyckoff_upthrust' ||
        ind == 'elliott_wave' ||
        ind == 'order_block' ||
        ind == 'fair_value_gap' ||
        ind == 'breaker_block' ||
        ind == 'rejection_block' ||
        ind == 'mitigation_block' ||
        ind == 'inverse_fvg' ||
        ind == 'imbalance' ||
        ind == 'bpr' ||
        ind == 'liquidity_sweep' ||
        ind == 'equal_highs' ||
        ind == 'equal_lows' ||
        ind == 'eqh' ||
        ind == 'eql' ||
        ind == 'gartley' ||
        ind == 'bat' ||
        ind == 'alternate_bat' ||
        ind == 'butterfly' ||
        ind == 'crab' ||
        ind == 'deep_crab' ||
        ind == 'shark' ||
        ind == 'cypher' ||
        ind == 'ab_cd' ||
        ind == 'three_drives' ||
        ind == '5_0' ||
        ind.startsWith('harmonic')) {
      return 'Rare Patterns';
    }
    
    // Fallback standard Oscillators
    if (ind == 'rsi' ||
        ind == 'macd_histogram' ||
        ind == 'macd_line' ||
        ind == 'macd_signal' ||
        ind.startsWith('stoch') ||
        ind == 'cci' ||
        ind == 'mfi' ||
        ind == 'cmf' ||
        ind == 'williams_r' ||
        ind == 'roc') {
      return 'Oscillators';
    }
    
    return 'Other';
  }

  /// الدالة الموحدة لتقييم الاستراتيجية بالكامل متضمنة مضاعف إجماع الفئات
  Map<String, dynamic> evaluateStrategyPro(DynamicStrategy strategy) {
    final cache = <String, dynamic>{};
    return evaluateStrategyProWithCache(strategy, cache);
  }

  Map<String, dynamic> evaluateStrategyProWithCache(
    DynamicStrategy strategy,
    Map<String, dynamic> cache,
  ) {
    final rules = strategy.rules.where((r) => r.enabled).toList();
    final primary = rules.where((r) => r.role == 'primary').toList();
    final confirm = rules.where((r) => r.role == 'confirm').toList();
    final filters = rules.where((r) => r.role == 'filter').toList();

    // ── [1] و [2]: تقييم قواعد primary وتحديد الفئات المتفقة لكل اتجاه ──
    double rawCall = 0.0;
    double rawPut = 0.0;
    final Set<String> categoriesCall = {};
    final Set<String> categoriesPut = {};

    for (final r in primary) {
      try {
        final raw = _computeIndicator(r, cache);
        if (!_checkCondition(r, raw)) continue;

        final String cat = r.type.isNotEmpty ? r.type : getCategoryForIndicator(r);

        if (r.signal == 'CALL') {
          rawCall += r.score;
          if (cat.isNotEmpty) categoriesCall.add(cat);
        } else if (r.signal == 'PUT') {
          rawPut += r.score;
          if (cat.isNotEmpty) categoriesPut.add(cat);
        } else if (r.signal == 'dominant' || r.signal == 'confirm') {
          if (rawCall >= rawPut) {
            rawCall += r.score;
            if (cat.isNotEmpty) categoriesCall.add(cat);
          } else {
            rawPut += r.score;
            if (cat.isNotEmpty) categoriesPut.add(cat);
          }
        }
      } catch (_) {
        continue;
      }
    }

    // ── [3] تطبيق مضاعف الإجماع بين الفئات على مجموع النقاط ──
    double getMultiplier(int count) {
      if (count <= 1) return 1.0;
      if (count == 2) return 1.15;
      if (count == 3) return 1.3;
      return 1.5; // 4 فئات متفقة أو أكثر
    }

    final double multCall = getMultiplier(categoriesCall.length);
    final double multPut = getMultiplier(categoriesPut.length);

    final double multipliedCall = rawCall * multCall;
    final double multipliedPut = rawPut * multPut;

    // تحديد الاتجاه الغالب بناءً على النقاط المضاعفة
    final bool isPrimaryCall = multipliedCall >= multipliedPut;
    final String primaryDir = isPrimaryCall ? 'CALL' : 'PUT';
    final double winningPrimaryScore = isPrimaryCall ? multipliedCall : multipliedPut;

    // ── [4] بوابة الفلتر (filter) ──
    bool filterPassed = true;
    String? filterFailReason;
    for (final r in filters) {
      try {
        final raw = _computeIndicator(r, cache);
        if (!_checkCondition(r, raw)) {
          filterPassed = false;
          filterFailReason = 'فشل فلتر "${r.indicator}"';
          break;
        }
      } catch (_) {
        filterPassed = false;
        filterFailReason = 'خطأ أثناء حساب فلتر "${r.indicator}"';
        break;
      }
    }

    // ── [5] طبقة التأكيد (confirm) ──
    int agreed = 0;
    int totalConfirm = 0;
    int opposingTrue = 0;
    double confirmScoreAdded = 0.0;

    for (final r in confirm) {
      totalConfirm++;
      try {
        final raw = _computeIndicator(r, cache);
        final isTrue = _checkCondition(r, raw);
        final String ruleDir = (r.signal == 'dominant' || r.signal == 'confirm')
            ? primaryDir
            : r.signal;

        if (isTrue) {
          if (ruleDir == primaryDir) {
            agreed++;
            confirmScoreAdded += r.score;
          } else {
            opposingTrue++;
          }
        }
      } catch (_) {
        continue;
      }
    }

    // حساب النقاط النهائية (إضافة نقاط التأكيد للاتجاه الغالب فقط)
    double finalCall = multipliedCall;
    double finalPut = multipliedPut;
    if (primaryDir == 'CALL') {
      finalCall += confirmScoreAdded;
    } else {
      finalPut += confirmScoreAdded;
    }

    // إضافة نقاط القواعد الأساسية (base rules)
    final base = rules
        .where(
          (r) =>
              r.role != 'primary' && r.role != 'confirm' && r.role != 'filter',
        )
        .toList();
    for (final r in base) {
      try {
        final raw = _computeIndicator(r, cache);
        if (!_checkCondition(r, raw)) continue;
        if (r.signal == 'CALL') {
          finalCall += r.score;
        } else if (r.signal == 'PUT') {
          finalPut += r.score;
        } else if (r.signal == 'dominant' || r.signal == 'confirm') {
          if (finalCall >= finalPut) {
            finalCall += r.score;
          } else {
            finalPut += r.score;
          }
        }
      } catch (_) {
        continue;
      }
    }

    final double finalWinningScore = primaryDir == 'CALL' ? finalCall : finalPut;
    final double finalOppositeScore = primaryDir == 'CALL' ? finalPut : finalCall;
    final double gap = (finalWinningScore - finalOppositeScore).abs();

    // تحديد محاذاة التأكيد (confirm_alignment)
    String confirmAlignment = 'neutral';
    if (totalConfirm > 0) {
      if (opposingTrue > 0) {
        confirmAlignment = 'conflict';
      } else if (agreed > 0) {
        confirmAlignment = 'aligned';
      }
    }

    // ── [6] منطق القرار النهائي وتحديد البلوك ──
    String? reasonBlocked;
    final double minPrimary = strategy.pyramid?.minPrimaryScore ?? 3.0;

    if (winningPrimaryScore < minPrimary) {
      reasonBlocked = 'المرحلة الأولى (الأساس): النتيجة ${winningPrimaryScore.toStringAsFixed(1)} < الحد الأدنى $minPrimary';
    } else if (strategy.pyramid?.requireAllFilters == true && !filterPassed) {
      reasonBlocked = 'المرحلة الثالثة (الفلاتر): $filterFailReason';
    } else if (totalConfirm > 0 &&
        (agreed / totalConfirm) < (strategy.pyramid?.confirmationRatio ?? 0.5)) {
      final double ratio = agreed / totalConfirm;
      reasonBlocked = 'المرحلة الثانية (التأكيد): $agreed/$totalConfirm = ${(ratio * 100).round()}% < الحد الأدنى ${((strategy.pyramid?.confirmationRatio ?? 0.5) * 100).round()}%';
    } else if (gap < 4.0) {
      reasonBlocked = 'الفارق بين الاتجاهين ${gap.toStringAsFixed(1)} < حد الفارق الأدنى (4.0)';
    }

    final String resultStr = (reasonBlocked == null) ? 'SIGNAL' : 'NO_SIGNAL';
    final String? finalDirection = (reasonBlocked == null) ? primaryDir : null;

    // ── [7] تصنيف الثقة (confidence_tier) ──
    String? confidenceTier;
    if (reasonBlocked == null) {
      final int catCount = primaryDir == 'CALL' ? categoriesCall.length : categoriesPut.length;
      if (catCount >= 3 && confirmAlignment != 'conflict') {
        confidenceTier = 'STRONG';
      } else if ((catCount == 2 && confirmAlignment != 'conflict') || (catCount >= 3 && confirmAlignment == 'conflict')) {
        confidenceTier = 'MEDIUM';
      } else {
        confidenceTier = 'WEAK';
      }
    }
    final output = {
      'result': resultStr,
      'direction': finalDirection,
      'confidence_tier': confidenceTier,
      'raw_score': {'CALL': rawCall, 'PUT': rawPut},
      'final_score': {'CALL': finalCall, 'PUT': finalPut},
      'category_count': {'CALL': categoriesCall.length, 'PUT': categoriesPut.length},
      'gap': gap,
      'filter_passed': filterPassed,
      'confirm_alignment': confirmAlignment,
      'reason_blocked': reasonBlocked,
    };

    _lastProResult = output;
    return output;
  }

  double _evaluateRulesPyramid(
    DynamicStrategy strategy,
    Map<String, dynamic> cache,
  ) {
    final proResult = evaluateStrategyProWithCache(strategy, cache);
    
    // وضع سبب الرفض في المتغير المخصص للمهاد الذكي
    _pyramidRejectReason = proResult['reason_blocked'] ?? '';
    
    if (proResult['result'] == 'SIGNAL') {
      final double callScore = proResult['final_score']['CALL'] ?? 0.0;
      final double putScore = proResult['final_score']['PUT'] ?? 0.0;
      return callScore - putScore;
    } else {
      return 0.0;
    }
  }

  void setAccountId(String accountId) {
    if (_accountId == accountId) return;
    _accountId = accountId;
    _loadHistory();
  }

  Future<void> _loadHistory() async {
    _signalHistory.clear();
    if (_accountId.isEmpty) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString('signals_$_accountId');
      if (raw != null && raw.isNotEmpty) {
        final List<dynamic> list = jsonDecode(raw);
        for (final item in list) {
          _signalHistory.add(_signalFromJson(item as Map<String, dynamic>));
        }
      } else {
        _generateMockHistory();
        _saveHistory();
      }
    } catch (e) {
      debugPrint('Error loading history: $e');
    }
    notifyListeners();
  }

  Future<void> _saveHistory() async {
    if (_accountId.isEmpty) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      final list = _signalHistory.take(50).map(_signalToJson).toList();
      await prefs.setString('signals_$_accountId', jsonEncode(list));
    } catch (e) {
      debugPrint('Error saving history: $e');
    }
  }

  Map<String, dynamic> _signalToJson(TradingSignal s) => {
    'pair': s.pair,
    'direction': s.direction,
    'durationMinutes': s.durationMinutes,
    'entryPrice': s.entryPrice,
    'exitPrice': s.exitPrice ?? s.currentPrice,
    'confidence': s.confidence,
    'entryTime': s.entryTime.toIso8601String(),
    'status': s.status,
    'marketCondition': s.marketCondition,
    'recommendation': s.recommendation,
    'origin': s.origin,
  };

  TradingSignal _signalFromJson(Map<String, dynamic> j) {
    final entryTime = DateTime.parse(j['entryTime'] as String);
    final duration = j['durationMinutes'] as int;
    final exitPrice = (j['exitPrice'] as num).toDouble();
    return TradingSignal(
      pair: j['pair'] as String,
      direction: j['direction'] as String,
      durationMinutes: duration,
      entryPrice: (j['entryPrice'] as num).toDouble(),
      currentPrice: exitPrice,
      confidence: (j['confidence'] as num).toDouble(),
      entryTime: entryTime,
      expiryTime: entryTime.add(Duration(minutes: duration)),
      status: j['status'] as String,
      exitPrice: exitPrice,
      marketCondition: j['marketCondition'] as String? ?? '',
      recommendation: j['recommendation'] as String? ?? '',
      origin: j['origin'] as String? ?? 'instant',
    );
  }

  // Active pair and candlestick list (last 30 candles)
  String _activePair = 'EUR/USD (OTC)';
  final List<Candle> _candles = [];
  double _currentPrice = 1.08450;
  String _chartTimeframe = '1m';

  // When true, the candle buffer holds REAL OHLC (from the `candles` table) and
  // the synthetic ticker stops fabricating prices/candles. All indicators/rules
  // then evaluate on real market data. Toggled by the app based on price_system.
  bool _realCandlesMode = false;
  bool get realCandlesMode => _realCandlesMode;

  // Replace the candle buffer with REAL OHLC and recompute every indicator on it.
  // Called by the app after fetching from Supabase `candles` (scraping mode).
  void setRealCandles(List<Candle> candles) {
    if (candles.isEmpty) return;
    _realCandlesMode = true;
    _candles
      ..clear()
      ..addAll(candles);
    _currentPrice = candles.last.close;
    _updateAllIndicators();
    notifyListeners();
  }

  // Return to simulator behaviour (synthetic candles). Used when the admin sets
  // price_system = simulator, or when no real candles are available for a pair.
  void disableRealCandles() {
    if (!_realCandlesMode) return;
    _realCandlesMode = false;
    _initChart();
    _updateAllIndicators();
    notifyListeners();
  }

  // Real-time signals
  TradingSignal? _activeSignal;
  final List<TradingSignal> _signalHistory = [];
  bool _isAnalyzing = false;
  String _analysisStageText = '';
  String _signalChangeNotice = '';
  // Instant mode: set when a press yielded no valid opportunity (min_score not
  // reached / pyramid rejected). Shown as a banner instead of forcing a signal.
  String _lastWaitNotice = '';
  String get lastWaitNotice => _lastWaitNotice;

  // Social win feed simulated log
  final List<String> _socialWinLogs = [];

  // Live price getter from the chart widget (set on each requestNextSignal call)
  double Function()? _livePriceGetter;

  // Countdown timer for active signal
  int _secondsRemaining = 0;
  Timer? _tickTimer;
  Timer? _socialTimer;
  // Technical indicators values
  double _rsiVal = 52.3;
  double _macdVal = 0.00012;
  double _macdSignalLine = 0.0;
  double _macdHistogram = 0.0;
  double _bbUpper = 1.08520;
  double _bbLower = 1.08380;
  String _marketSentiment = 'Neutral';

  // Advanced indicators
  double _atrVal = 0.0; // Average True Range (Volatility)
  double _stochK = 50.0; // Stochastic %K
  double _stochD = 50.0; // Stochastic %D
  double _adxVal = 25.0; // Average Directional Index (Trend Strength)
  double _obvVal = 0.0; // On-Balance Volume
  double _vwapVal = 0.0; // Volume Weighted Average Price
  double _volumeDelta = 0.0; // Buy vs Sell volume pressure
  double _liquidityScore = 50.0; // Liquidity zone proximity score (0-100)
  String _liquidityZone = 'Neutral'; // Current liquidity zone
  double _ema50 = 0.0; // EMA 50 for trend
  double _cmfVal = 0.0; // Chaikin Money Flow
  String _trendStrength = 'Moderate'; // ADX-based trend strength

  // ============= Ultra-Advanced Indicators (V2 Engine) =============
  double _williamsR = -50.0; // Williams %R (-100 to 0)
  double _cciVal = 0.0; // Commodity Channel Index
  double _mfiVal = 50.0; // Money Flow Index (volume-weighted RSI)
  double _rocVal = 0.0; // Rate of Change (Momentum)
  double _ema9 = 0.0; // EMA 9 (fast)
  double _ema21 = 0.0; // EMA 21 (medium)
  bool _volumeSpike = false; // Volume spike detected
  double _volumeRatio = 1.0; // Current vol / avg vol ratio
  String _obvTrend = 'flat'; // OBV trend direction
  String _candlePattern = 'none'; // Detected candle pattern
  String _rsiDivergence = 'none'; // RSI divergence (bullish/bearish/none)
  double _plusDi = 0.0; // +DI for ADX direction
  double _minusDi = 0.0; // -DI for ADX direction

  // Getters
  String get activePair => _activePair;
  List<Candle> get candles => _candles;
  double get currentPrice => _currentPrice;
  String get chartTimeframe => _chartTimeframe;
  TradingSignal? get activeSignal => _activeSignal;
  List<TradingSignal> get signalHistory => _signalHistory;
  bool get isAnalyzing => _isAnalyzing;
  String get analysisStageText => _analysisStageText;
  String get signalChangeNotice => _signalChangeNotice;
  List<String> get socialWinLogs => _socialWinLogs;
  int get secondsRemaining => _secondsRemaining;
  double get rsiVal => _rsiVal;
  double get macdVal => _macdVal;
  double get macdSignalLine => _macdSignalLine;
  double get macdHistogram => _macdHistogram;
  double get bbUpper => _bbUpper;
  double get bbLower => _bbLower;
  String get marketSentiment => _marketSentiment;
  double get atrVal => _atrVal;
  double get stochK => _stochK;
  double get stochD => _stochD;
  double get adxVal => _adxVal;
  double get obvVal => _obvVal;
  double get vwapVal => _vwapVal;
  double get volumeDelta => _volumeDelta;
  double get liquidityScore => _liquidityScore;
  String get liquidityZone => _liquidityZone;
  double get cmfVal => _cmfVal;
  String get trendStrength => _trendStrength;
  double get williamsR => _williamsR;
  double get cciVal => _cciVal;
  double get mfiVal => _mfiVal;
  double get rocVal => _rocVal;
  double get ema9 => _ema9;
  double get ema21 => _ema21;
  bool get volumeSpike => _volumeSpike;
  double get volumeRatio => _volumeRatio;
  String get obvTrend => _obvTrend;
  String get candlePattern => _candlePattern;
  String get rsiDivergence => _rsiDivergence;
  double get plusDi => _plusDi;
  double get minusDi => _minusDi;

  int get candleRemainingSeconds {
    if (_candles.isEmpty) return 0;
    final activeCandle = _candles.last;
    final elapsed = DateTime.now().difference(activeCandle.time).inSeconds;
    final remaining = timeframeSeconds - elapsed;
    return remaining > 0 ? remaining : 0;
  }

  String get formattedCandleRemaining {
    final secs = candleRemainingSeconds;
    final minutes = secs ~/ 60;
    final seconds = secs % 60;
    return "${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}";
  }

  int get timeframeSeconds {
    switch (_chartTimeframe) {
      case '1m':
        return 60;
      case '5m':
        return 300;
      case '15m':
        return 900;
      case '30m':
        return 1800;
      case '1h':
        return 3600;
      default:
        return 60;
    }
  }

  void setChartTimeframe(String tf) {
    if (_chartTimeframe == tf) return;
    _chartTimeframe = tf;
    _initChart();
    _updateAllIndicators();
    notifyListeners();
  }

  Future<void> requestNextSignal(
    int selectedMinutes, {
    double Function()? livePriceGetter,
  }) async {
    if (_isAnalyzing ||
        (_activeSignal != null && _activeSignal!.status == 'ACTIVE')) {
      return;
    }
    // The instant button takes over from monitoring if it was running.
    if (_monitoring) stopMonitoring();
    _livePriceGetter = livePriceGetter; // save for entry + exit price lookups

    _isAnalyzing = true;
    _marketClosed = false;
    _signalChangeNotice = ''; // Clear previous warning notice
    _lastWaitNotice = ''; // Clear previous "no opportunity" banner
    _activeSignal =
        null; // Clear previous signal card to show analysis progress

    // Track live price samples across all stages to detect static market
    final double priceAtStart = livePriceGetter?.call() ?? 0;
    final Set<double> priceSamples = priceAtStart > 0 ? {priceAtStart} : {};
    void samplePrice() {
      if (livePriceGetter == null) return;
      final p = livePriceGetter();
      if (p > 0) priceSamples.add(p);
    }

    // Stage 1: Support & Resistance
    final sr = _calculateSupportResistance();
    _analysisStageText = tr(
      '📊 تحليل مستويات الدعم والمقاومة لـ ${_activePair.replaceAll(' (OTC)', '')} | الدعم: ${AppConstants.formatPrice(sr['support']!)} | المقاومة: ${AppConstants.formatPrice(sr['resistance']!)}...',
      '📊 Analyzing support & resistance for ${_activePair.replaceAll(' (OTC)', '')} | Support: ${AppConstants.formatPrice(sr['support']!)} | Resistance: ${AppConstants.formatPrice(sr['resistance']!)}...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Stage 2: Oscillators
    final rsi = _calculateRsi(14);
    final stoch = _calculateStochastic(14, 3);
    final cci = _calculateCci(20);
    _analysisStageText = tr(
      '📈 فحص مؤشرات التذبذب ومناطق التشبع | RSI: ${rsi.toStringAsFixed(1)} | Stochastic: ${stoch['k']!.toStringAsFixed(1)} | CCI: ${cci.toStringAsFixed(0)}...',
      '📈 Checking oscillators & overbought/oversold zones | RSI: ${rsi.toStringAsFixed(1)} | Stochastic: ${stoch['k']!.toStringAsFixed(1)} | CCI: ${cci.toStringAsFixed(0)}...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Stage 3: Volatility & Trend Strength
    final atr = _calculateAtr(14);
    final adxFull = _calculateAdxFull(14);
    _analysisStageText = tr(
      '⚡ فحص قوة الاتجاه ومعدل التذبذب | ATR: ${atr.toStringAsFixed(5)} | ADX: ${adxFull['adx']!.toStringAsFixed(1)}...',
      '⚡ Checking trend strength & volatility | ATR: ${atr.toStringAsFixed(5)} | ADX: ${adxFull['adx']!.toStringAsFixed(1)}...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Stage 4: Institutional Volume & MFI
    final vwap = _calculateVwap();
    final mfi = _calculateMfi(14);
    _analysisStageText = tr(
      '🏦 مراقبة تدفق سيولة الحوت والـ MFI | MFI: ${mfi.toStringAsFixed(1)} | VWAP: ${AppConstants.formatPrice(vwap)}...',
      '🏦 Watching whale liquidity flow & MFI | MFI: ${mfi.toStringAsFixed(1)} | VWAP: ${AppConstants.formatPrice(vwap)}...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Stage 5: Money Flow & Volume Delta
    final cmf = _calculateCmf(20);
    final volDelta = _calculateVolumeDelta();
    _analysisStageText = tr(
      '💰 حساب ضغط الشراء مقابل البيع | CMF: ${cmf.toStringAsFixed(3)} | Vol Delta: ${volDelta.toStringAsFixed(1)}%...',
      '💰 Calculating buying vs selling pressure | CMF: ${cmf.toStringAsFixed(3)} | Vol Delta: ${volDelta.toStringAsFixed(1)}%...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Stage 6: Order Blocks & Liquidity Zones
    final liq = _calculateLiquidityZones();
    _analysisStageText = tr(
      '🔍 تحديد مناطق الطلب والعرض والمستويات المؤسسية | LIQ Score: ${(liq['score'] as double).toStringAsFixed(0)}%...',
      '🔍 Identifying demand & supply zones and institutional levels | LIQ Score: ${(liq['score'] as double).toStringAsFixed(0)}%...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Stage 7: Candlestick Patterns & Divergences
    final pattern = _detectCandlePatterns();
    final divergence = _detectRsiDivergence();
    _analysisStageText = tr(
      '🕯️ تحليل البرايس أكشن ونموذج الشموع | Pattern: ${pattern.replaceAll('_', ' ')} | Divergence: $divergence...',
      '🕯️ Analyzing price action & candlestick patterns | Pattern: ${pattern.replaceAll('_', ' ')} | Divergence: $divergence...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Stage 8: Correlation & DXY Index
    _analysisStageText = tr(
      '⚙️ قياس قوة العملة مقابل مؤشر الدولار والعملات الأخرى (Correlation Index)...',
      '⚙️ Measuring currency strength vs the dollar index and other currencies (Correlation Index)...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Stage 9: Multi-Timeframe Confluence (1m / 5m / 15m)
    _analysisStageText = tr(
      '🔄 فحص محاذاة الاتجاه عبر الفريمات المتعددة لضمان دقة الدخول...',
      '🔄 Checking trend alignment across multiple timeframes to ensure entry accuracy...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Stage 10: Market Noise Filter
    _analysisStageText = tr(
      '🛡️ تصفية الضوضاء السعرية وكشف كسر الدعم والمقاومة الكاذب...',
      '🛡️ Filtering price noise and detecting false support/resistance breaks...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Stage 11: Safety Gates Assessment
    _analysisStageText = tr(
      '🔒 تطبيق مرشحات الأمان وفحص نسبة العائد للمخاطرة...',
      '🔒 Applying safety filters and checking the risk/reward ratio...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Stage 12: Confluence Scoring
    _analysisStageText = tr(
      '🏁 احتساب Confluence النهائي لـ 18 مؤشر فني وحسم اتجاه السوق...',
      '🏁 Computing the final confluence of 18 technical indicators and deciding market direction...',
    );
    notifyListeners();
    await Future.delayed(const Duration(milliseconds: 400));
    samplePrice();

    // Wait for the current candle to close.
    // Records the end of the CURRENT candle once, then counts down to it.
    // Display formula: currentCandleEnd - nowSec  (matches chart.js badge exactly)
    {
      final cs = timeframeSeconds;
      final startSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final currentCandleEnd = (startSec ~/ cs + 1) * cs;

      var lastRem = -1;
      while (true) {
        final nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
        final rem = currentCandleEnd - nowSec;
        if (rem <= 0) break;
        if (rem != lastRem) {
          lastRem = rem;
          _analysisStageText = tr(
            'بانتظار إغلاق الشمعة الحالية لفتح صفقة مع الشمعة القادمة: $rem ثانية...',
            'Waiting for the current candle to close to open a trade with the next candle: ${rem}s...',
          );
          notifyListeners();
          samplePrice();
        }
        await Future.delayed(const Duration(milliseconds: 100));
      }
    }

    // ── Market closed detection — weekend only for forex ─────────────────────
    final bool isForexPair = _isForexPairType();
    final bool isWeekend =
        DateTime.now().weekday == DateTime.saturday ||
        DateTime.now().weekday == DateTime.sunday;

    if (isForexPair && isWeekend) {
      _isAnalyzing = false;
      _activeSignal = null;
      _secondsRemaining = 0;
      _marketClosed = true;
      _socialWinLogs.clear();
      notifyListeners();
      return;
    }

    // Detect static price in scraping mode — price never changed across all
    // analysis stages. Skip for OTC (24/7): a quiet second ≠ closed market, so
    // we proceed to generate a signal instead of falsely showing "السوق مغلق".
    if (!_isOtcPair() &&
        _livePriceGetter != null &&
        priceSamples.length <= 1 &&
        priceSamples.isNotEmpty) {
      _isAnalyzing = false;
      _activeSignal = null;
      _secondsRemaining = 0;
      _marketClosed = true;
      _socialWinLogs.clear();
      notifyListeners();
      return;
    }

    _isAnalyzing = false;
    evalJs(
      "console.log('[SIG] wait loop done. price='+$_currentPrice+' candles='+${_candles.length}+' mins=$selectedMinutes')",
    );

    try {
      _generateNextSignal(selectedMinutes);
      evalJs(
        "console.log('[SIG] signal generated: '+\"${_activeSignal?.direction ?? 'null'}\"+' exp='+\"${_activeSignal?.expiryTime}\"+' secs='+$_secondsRemaining)",
      );
    } catch (e) {
      evalJs("console.error('[SIG] _generateNextSignal threw: '+\"$e\")");
      // Scoring threw — fall back to a simple direction based on last candles
      final isCall = _candles.length >= 2
          ? _candles.last.close >= _candles[_candles.length - 2].close
          : true;
      final nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      const cs = 60; // real-minutes duration, 1-minute aligned (not the chart frame)
      final cStart = (nowSec ~/ cs) * cs;
      final expiry = cStart + selectedMinutes * cs;
      final fallbackEntry = _livePriceGetter?.call() ?? _currentPrice;
      _activeSignal = TradingSignal(
        pair: _activePair,
        direction: isCall ? 'CALL' : 'PUT',
        durationMinutes: selectedMinutes,
        entryPrice: fallbackEntry,
        currentPrice: fallbackEntry,
        confidence: 75.0,
        entryTime: DateTime.fromMillisecondsSinceEpoch(cStart * 1000),
        expiryTime: DateTime.fromMillisecondsSinceEpoch(expiry * 1000),
        status: 'ACTIVE',
        marketCondition: tr('تحليل مباشر', 'Live analysis'),
        recommendation: isCall ? 'CALL ✅' : 'PUT ✅',
      );
      _secondsRemaining = (expiry - nowSec).clamp(1, selectedMinutes * cs + cs);
      _playNewSignalSound();
    }

    // Draw entry line on chart directly — works for both primary and fallback signal paths
    if (_activeSignal != null) {
      final ep = _activeSignal!.entryPrice;
      final dir = _activeSignal!.direction;
      evalJs("CandleChart.setGlobalEntryLine($ep, '$dir')");
    }
    notifyListeners();
  }

  SignalEngine() {
    _initChart();
    _startTicker();
    _startSocialFeed();
    initPreferences();
  }

  /// Golden-harness only: builds the engine with no timers, no chart, no prefs.
  /// Behaviour of _computeIndicator depends solely on _candles + rule params,
  /// so results are identical to a live instance but fully deterministic.
  SignalEngine.golden();

  Future<void> initPreferences() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      _userRole = prefs.getString('user_role') ?? 'standard';
      final expiryStr = prefs.getString('vip_expiry');
      if (expiryStr != null) {
        // Anchor to UTC: VIP duration is absolute (counts from activation in UTC,
        // regardless of the user's timezone or whether the app was open/closed).
        _vipExpiry = DateTime.tryParse(expiryStr)?.toUtc();
      }
      if (_userRole == 'vip' && _vipExpiry != null) {
        if (DateTime.now().toUtc().isAfter(_vipExpiry!)) {
          _userRole = 'standard';
          _vipJustExpired = true;
          await prefs.setString('user_role', 'standard');
          await prefs.remove('vip_expiry');
        }
      }
      notifyListeners();
    } catch (e) {
      debugPrint('Error initializing SharedPreferences: $e');
    }
  }

  // Set active asset and reset chart values
  void selectPair(String newPair) {
    if (_activePair == newPair) return;
    _activePair = newPair;
    _activeSignal = null;
    _initChart();
    _updateAllIndicators();
    notifyListeners();
  }

  // OTC (Pocket Option) pairs trade 24/7 — detect via is_otc / source=='po' /
  // an "otc" marker in the symbol. They never hit any time-based market closure.
  bool _isOtcPair() {
    final p = AppConstants.currencyPairs.firstWhere(
      (x) => x['symbol'] == _activePair,
      orElse: () => <String, dynamic>{},
    );
    return p['is_otc'] == true ||
        (p['source'] as String? ?? '') == 'po' ||
        _activePair.toLowerCase().contains('otc');
  }

  bool _isForexPairType() {
    // OTC pairs trade 24/7 (incl. weekends) — never a closeable "forex" market,
    // else the weekend gate wrongly shows "السوق مغلق" on Sat/Sun.
    if (_isOtcPair()) return false;
    final pair = AppConstants.currencyPairs.firstWhere(
      (p) => p['symbol'] == _activePair,
      orElse: () => <String, dynamic>{},
    );
    final category = (pair['category'] as String? ?? '').toLowerCase();
    // Crypto is 24/7
    if (category == 'crypto') return false;
    // Real markets close on weekends. (Pocket Option OTC variants trade on
    // weekends, but those are handled via the OTC/PO market-status path.)
    if (category == 'currencies' ||
        category == 'commodities' ||
        category == 'stocks' ||
        category == 'indices' ||
        category == 'forex' ||
        category == 'metals') {
      return true;
    }
    // Fallback: infer from symbol name for unlisted pairs
    return !_activePair.contains('BTC') &&
        !_activePair.contains('ETH') &&
        !_activePair.contains('SOL') &&
        !_activePair.contains('BNB') &&
        !_activePair.contains('XRP') &&
        !_activePair.contains('XAU') &&
        !_activePair.contains('XAG') &&
        !_activePair.contains('Gold') &&
        !_activePair.contains('Silver') &&
        !_activePair.contains('OIL') &&
        !_activePair.contains('Crude');
  }

  // Helper: Calculate RSI from historical candles list
  double _calculateRsi(int period) {
    if (_candles.length <= period) return 50.0;
    double totalGain = 0.0;
    double totalLoss = 0.0;
    for (int i = _candles.length - period; i < _candles.length; i++) {
      double change = _candles[i].close - _candles[i - 1].close;
      if (change > 0) {
        totalGain += change;
      } else {
        totalLoss -= change;
      }
    }
    if (totalLoss == 0) return 100.0;
    double rs = (totalGain / period) / (totalLoss / period);
    return 100.0 - (100.0 / (1.0 + rs));
  }

  // Helper: Calculate SMA (Simple Moving Average)
  double _calculateSma(int period) {
    if (_candles.length < period) return _currentPrice;
    double sum = 0.0;
    for (int i = _candles.length - period; i < _candles.length; i++) {
      sum += _candles[i].close;
    }
    return sum / period;
  }

  // Helper: Calculate EMA (Exponential Moving Average)
  double _calculateEma(int period) {
    if (_candles.length < period) return _currentPrice;

    // Start with SMA as the first EMA value
    double sum = 0.0;
    for (int i = 0; i < period; i++) {
      sum += _candles[i].close;
    }
    double ema = sum / period;

    // Multiplier
    double k = 2.0 / (period + 1);

    for (int i = period; i < _candles.length; i++) {
      ema = (_candles[i].close * k) + (ema * (1 - k));
    }

    return ema;
  }

  // Helper: Get dynamic support and resistance levels from history
  Map<String, double> _calculateSupportResistance() {
    if (_candles.length < 10) {
      return {
        'support': _currentPrice * 0.995,
        'resistance': _currentPrice * 1.005,
      };
    }

    double support = double.infinity;
    double resistance = double.negativeInfinity;

    final List<double> peaks = [];
    final List<double> valleys = [];

    for (int i = 1; i < _candles.length - 1; i++) {
      final prev = _candles[i - 1];
      final curr = _candles[i];
      final next = _candles[i + 1];

      if (curr.high > prev.high && curr.high > next.high) {
        peaks.add(curr.high);
      }
      if (curr.low < prev.low && curr.low < next.low) {
        valleys.add(curr.low);
      }
    }

    if (valleys.isEmpty) {
      support = _candles.map((c) => c.low).reduce(min);
    } else {
      support = valleys.reduce(min);
    }

    if (peaks.isEmpty) {
      resistance = _candles.map((c) => c.high).reduce(max);
    } else {
      resistance = peaks.reduce(max);
    }

    return {'support': support, 'resistance': resistance};
  }

  // Helper: Calculate Bollinger Bands
  Map<String, double> _calculateBollingerBands(
    int period, [
    double stdDevMult = 2.0,
  ]) {
    double sma = _calculateSma(period);
    if (_candles.length < period) {
      return {'upper': sma * 1.002, 'lower': sma * 0.998, 'middle': sma};
    }
    double varianceSum = 0.0;
    for (int i = _candles.length - period; i < _candles.length; i++) {
      varianceSum += pow(_candles[i].close - sma, 2);
    }
    double stdDev = sqrt(varianceSum / period);
    return {
      'upper': sma + (stdDevMult * stdDev),
      'lower': sma - (stdDevMult * stdDev),
      'middle': sma,
    };
  }

  // Helper: Calculate proper MACD (12, 26, 9) with Signal and Histogram
  Map<String, double> _calculateFullMacd() {
    final ema12 = _calculateEma(12);
    final ema26 = _calculateEma(26);
    final macdLine = ema12 - ema26;

    // Signal line = 9-period EMA of MACD line (approximated)
    // We compute a rolling average of recent MACD-like values
    if (_candles.length < 26) {
      return {'macd': macdLine, 'signal': 0.0, 'histogram': macdLine};
    }

    List<double> macdValues = [];
    for (int i = max(0, _candles.length - 9); i < _candles.length; i++) {
      double sum12 = 0, sum26 = 0;
      int cnt12 = 0, cnt26 = 0;
      for (int j = max(0, i - 11); j <= i; j++) {
        sum12 += _candles[j].close;
        cnt12++;
      }
      for (int j = max(0, i - 25); j <= i; j++) {
        sum26 += _candles[j].close;
        cnt26++;
      }
      macdValues.add((sum12 / cnt12) - (sum26 / cnt26));
    }

    double signalLine = macdValues.isEmpty
        ? 0.0
        : macdValues.reduce((a, b) => a + b) / macdValues.length;
    double histogram = macdLine - signalLine;

    return {'macd': macdLine, 'signal': signalLine, 'histogram': histogram};
  }

  // Helper: Calculate ATR (Average True Range) - Volatility Measure
  double _calculateAtr(int period) {
    if (_candles.length < period + 1) return _currentPrice * 0.001;

    double totalTR = 0.0;
    for (int i = _candles.length - period; i < _candles.length; i++) {
      final curr = _candles[i];
      final prev = _candles[i - 1];
      final tr1 = curr.high - curr.low;
      final tr2 = (curr.high - prev.close).abs();
      final tr3 = (curr.low - prev.close).abs();
      totalTR += max(tr1, max(tr2, tr3));
    }
    return totalTR / period;
  }

  // Helper: Stochastic Oscillator (%K and %D)
  Map<String, double> _calculateStochastic(int period, int smoothK) {
    if (_candles.length < period) return {'k': 50.0, 'd': 50.0};

    double highestHigh = double.negativeInfinity;
    double lowestLow = double.infinity;
    for (int i = _candles.length - period; i < _candles.length; i++) {
      if (_candles[i].high > highestHigh) highestHigh = _candles[i].high;
      if (_candles[i].low < lowestLow) lowestLow = _candles[i].low;
    }

    double range = highestHigh - lowestLow;
    double rawK = range == 0
        ? 50.0
        : ((_currentPrice - lowestLow) / range) * 100.0;
    rawK = rawK.clamp(0.0, 100.0);

    // Smooth %K using SMA of recent raw %K values
    List<double> kValues = [];
    for (int s = 0; s < smoothK && s < _candles.length - period; s++) {
      int offset = _candles.length - period - s;
      if (offset < 0) break;
      double hh = double.negativeInfinity;
      double ll = double.infinity;
      for (int i = offset; i < offset + period && i < _candles.length; i++) {
        if (_candles[i].high > hh) hh = _candles[i].high;
        if (_candles[i].low < ll) ll = _candles[i].low;
      }
      double r = hh - ll;
      kValues.add(
        r == 0
            ? 50.0
            : ((_candles[min(offset + period - 1, _candles.length - 1)].close -
                          ll) /
                      r) *
                  100.0,
      );
    }
    kValues.insert(0, rawK);

    double smoothedK = kValues.reduce((a, b) => a + b) / kValues.length;
    // %D is the LAGGING line: average the OLDER raw %K values (drop the newest)
    // so %K and %D genuinely differ and crossovers work. Previously %D was set
    // equal to %K, which made `stoch_cross` always 0 and killed the whole signal.
    double smoothedD = kValues.length > 1
        ? kValues.sublist(1).reduce((a, b) => a + b) / (kValues.length - 1)
        : smoothedK;

    return {'k': smoothedK.clamp(0.0, 100.0), 'd': smoothedD.clamp(0.0, 100.0)};
  }

  // Helper: OBV (On-Balance Volume) - Volume-based momentum
  double _calculateObv() {
    if (_candles.length < 2) return 0.0;
    double obv = 0.0;
    for (int i = 1; i < _candles.length; i++) {
      if (_candles[i].close > _candles[i - 1].close) {
        obv += _candles[i].volume;
      } else if (_candles[i].close < _candles[i - 1].close) {
        obv -= _candles[i].volume;
      }
    }
    return obv;
  }

  // Helper: VWAP (Volume Weighted Average Price) - Institutional price level
  double _calculateVwap() {
    if (_candles.isEmpty) return _currentPrice;
    double cumVolumePrice = 0.0;
    double cumVolume = 0.0;
    for (final c in _candles) {
      double typicalPrice = (c.high + c.low + c.close) / 3.0;
      cumVolumePrice += typicalPrice * c.volume;
      cumVolume += c.volume;
    }
    return cumVolume == 0 ? _currentPrice : cumVolumePrice / cumVolume;
  }

  // Helper: CMF (Chaikin Money Flow) - Money flow pressure
  double _calculateCmf(int period) {
    if (_candles.length < period) return 0.0;
    double mfvSum = 0.0;
    double volSum = 0.0;
    for (int i = _candles.length - period; i < _candles.length; i++) {
      final c = _candles[i];
      double hl = c.high - c.low;
      double mfMultiplier = hl == 0
          ? 0.0
          : ((c.close - c.low) - (c.high - c.close)) / hl;
      mfvSum += mfMultiplier * c.volume;
      volSum += c.volume;
    }
    return volSum == 0 ? 0.0 : (mfvSum / volSum).clamp(-1.0, 1.0);
  }

  // Helper: Volume Delta - Buy vs Sell pressure estimation
  double _calculateVolumeDelta() {
    if (_candles.length < 5) return 0.0;
    double buyVolume = 0.0;
    double sellVolume = 0.0;
    for (int i = _candles.length - 5; i < _candles.length; i++) {
      final c = _candles[i];
      double bodyRatio = c.high == c.low
          ? 0.5
          : (c.close - c.low) / (c.high - c.low);
      buyVolume += c.volume * bodyRatio;
      sellVolume += c.volume * (1.0 - bodyRatio);
    }
    double total = buyVolume + sellVolume;
    return total == 0 ? 0.0 : ((buyVolume - sellVolume) / total * 100.0);
  }

  // Helper: Liquidity Zone Analysis - Identifies institutional order blocks
  Map<String, dynamic> _calculateLiquidityZones() {
    if (_candles.length < 10) {
      return {'score': 50.0, 'zone': 'Neutral', 'nearestLevel': _currentPrice};
    }

    // Identify high-volume candles as liquidity zones (order blocks)
    List<double> volumeValues = _candles.map((c) => c.volume).toList();
    double avgVolume =
        volumeValues.reduce((a, b) => a + b) / volumeValues.length;

    // Find price levels where volume was significantly above average (1.5x+)
    List<double> liquidityLevels = [];
    for (final c in _candles) {
      if (c.volume > avgVolume * 1.5) {
        liquidityLevels.add((c.high + c.low) / 2.0);
      }
    }

    // Also add support/resistance as liquidity pools
    final sr = _calculateSupportResistance();
    liquidityLevels.add(sr['support']!);
    liquidityLevels.add(sr['resistance']!);

    // Add VWAP as institutional interest level
    liquidityLevels.add(_calculateVwap());

    // Calculate proximity score (how close price is to a liquidity zone)
    double minDist = double.infinity;
    double nearestLevel = _currentPrice;
    for (final level in liquidityLevels) {
      double dist = (_currentPrice - level).abs();
      if (dist < minDist) {
        minDist = dist;
        nearestLevel = level;
      }
    }

    // Score: 100 = right at liquidity zone, 0 = far away
    double atr = _calculateAtr(14);
    double proximityScore = atr == 0
        ? 50.0
        : (1.0 - (minDist / (atr * 3.0)).clamp(0.0, 1.0)) * 100.0;

    // Determine zone type
    String zoneType;
    if (proximityScore > 75) {
      if (_currentPrice <= nearestLevel) {
        zoneType = 'Demand Zone (Buy)';
      } else {
        zoneType = 'Supply Zone (Sell)';
      }
    } else if (proximityScore > 40) {
      zoneType = 'Transition Zone';
    } else {
      zoneType = 'Low Liquidity';
    }

    return {
      'score': proximityScore,
      'zone': zoneType,
      'nearestLevel': nearestLevel,
    };
  }

  // ======================================================================
  // == ULTRA-ADVANCED V2 INDICATORS ======================================
  // ======================================================================

  // Williams %R - Momentum oscillator (-100 to 0)
  double _calculateWilliamsR(int period) {
    if (_candles.length < period) return -50.0;
    double highestHigh = double.negativeInfinity;
    double lowestLow = double.infinity;
    for (int i = _candles.length - period; i < _candles.length; i++) {
      if (_candles[i].high > highestHigh) highestHigh = _candles[i].high;
      if (_candles[i].low < lowestLow) lowestLow = _candles[i].low;
    }
    double range = highestHigh - lowestLow;
    if (range == 0) return -50.0;
    return ((highestHigh - _currentPrice) / range) * -100.0;
  }

  // CCI (Commodity Channel Index) - Cyclic trend identification
  double _calculateCci(int period) {
    if (_candles.length < period) return 0.0;
    List<double> typicalPrices = [];
    for (int i = _candles.length - period; i < _candles.length; i++) {
      typicalPrices.add(
        (_candles[i].high + _candles[i].low + _candles[i].close) / 3.0,
      );
    }
    double mean = typicalPrices.reduce((a, b) => a + b) / typicalPrices.length;
    double meanDeviation =
        typicalPrices.map((tp) => (tp - mean).abs()).reduce((a, b) => a + b) /
        typicalPrices.length;
    if (meanDeviation == 0) return 0.0;
    double currentTP =
        (_candles.last.high + _candles.last.low + _candles.last.close) / 3.0;
    return (currentTP - mean) / (0.015 * meanDeviation);
  }

  // MFI (Money Flow Index) - Volume-weighted RSI, the most accurate volume indicator
  double _calculateMfi(int period) {
    if (_candles.length < period + 1) return 50.0;
    double posFlow = 0.0;
    double negFlow = 0.0;
    for (int i = _candles.length - period; i < _candles.length; i++) {
      double tp =
          (_candles[i].high + _candles[i].low + _candles[i].close) / 3.0;
      double prevTp =
          (_candles[i - 1].high + _candles[i - 1].low + _candles[i - 1].close) /
          3.0;
      double rawMF = tp * _candles[i].volume;
      if (tp > prevTp) {
        posFlow += rawMF;
      } else {
        negFlow += rawMF;
      }
    }
    if (negFlow == 0) return 100.0;
    double mfRatio = posFlow / negFlow;
    return 100.0 - (100.0 / (1.0 + mfRatio));
  }

  // Rate of Change (ROC) - Pure momentum measurement
  double _calculateRoc(int period) {
    if (_candles.length < period + 1) return 0.0;
    double pastPrice = _candles[_candles.length - period - 1].close;
    if (pastPrice == 0) return 0.0;
    return ((_currentPrice - pastPrice) / pastPrice) * 100.0;
  }

  // Enhanced ADX with +DI / -DI directional components
  Map<String, double> _calculateAdxFull(int period) {
    if (_candles.length < period + 1) {
      return {'adx': 25.0, 'plusDi': 50.0, 'minusDi': 50.0};
    }

    double plusDmSum = 0, minusDmSum = 0, trSum = 0;
    for (int i = _candles.length - period; i < _candles.length; i++) {
      final curr = _candles[i];
      final prev = _candles[i - 1];

      double upMove = curr.high - prev.high;
      double downMove = prev.low - curr.low;

      double plusDm = (upMove > downMove && upMove > 0) ? upMove : 0;
      double minusDm = (downMove > upMove && downMove > 0) ? downMove : 0;

      double tr = max(
        curr.high - curr.low,
        max((curr.high - prev.close).abs(), (curr.low - prev.close).abs()),
      );

      plusDmSum += plusDm;
      minusDmSum += minusDm;
      trSum += tr;
    }

    if (trSum == 0) return {'adx': 25.0, 'plusDi': 50.0, 'minusDi': 50.0};

    double plusDi = (plusDmSum / trSum) * 100;
    double minusDi = (minusDmSum / trSum) * 100;
    double diSum = plusDi + minusDi;

    if (diSum == 0) return {'adx': 25.0, 'plusDi': plusDi, 'minusDi': minusDi};
    double dx = ((plusDi - minusDi).abs() / diSum) * 100;

    return {'adx': dx.clamp(0.0, 100.0), 'plusDi': plusDi, 'minusDi': minusDi};
  }

  // Volume Profile Analysis - Spike detection, OBV trend, and volume confirmation
  Map<String, dynamic> _analyzeVolumeProfile() {
    if (_candles.length < 10) {
      return {
        'spike': false,
        'ratio': 1.0,
        'trend': 'flat',
        'avgVolume': 1000.0,
      };
    }

    // Average volume (excluding last candle)
    double totalVol = 0;
    int count = 0;
    for (int i = max(0, _candles.length - 11); i < _candles.length - 1; i++) {
      totalVol += _candles[i].volume;
      count++;
    }
    double avgVol = count > 0 ? totalVol / count : 1000.0;
    double currentVol = _candles.last.volume;
    double ratio = avgVol > 0 ? currentVol / avgVol : 1.0;
    bool spike = ratio > 1.8;

    // OBV trend (last 5 candles direction)
    double obvRecent = 0;
    for (int i = max(1, _candles.length - 5); i < _candles.length; i++) {
      if (_candles[i].close > _candles[i - 1].close) {
        obvRecent += _candles[i].volume;
      } else {
        obvRecent -= _candles[i].volume;
      }
    }
    String trend = obvRecent > 0
        ? 'bullish'
        : (obvRecent < 0 ? 'bearish' : 'flat');

    return {
      'spike': spike,
      'ratio': ratio,
      'trend': trend,
      'avgVolume': avgVol,
    };
  }

  // ── Smart Money Concepts ─────────────────────────────────────────────────

  String _detectMarketStructure() {
    if (_candles.length < 20) return 'none';

    final shPrices = <double>[];
    final slPrices = <double>[];

    for (int i = 2; i < _candles.length - 2; i++) {
      final h = _candles[i].high;
      if (h > _candles[i - 1].high &&
          h > _candles[i - 2].high &&
          h > _candles[i + 1].high &&
          h > _candles[i + 2].high) {
        shPrices.add(h);
      }
      final l = _candles[i].low;
      if (l < _candles[i - 1].low &&
          l < _candles[i - 2].low &&
          l < _candles[i + 1].low &&
          l < _candles[i + 2].low) {
        slPrices.add(l);
      }
    }

    if (shPrices.length < 2 || slPrices.length < 2) return 'none';

    final sh1 = shPrices[shPrices.length - 1];
    final sh2 = shPrices[shPrices.length - 2];
    final sl1 = slPrices[slPrices.length - 1];
    final sl2 = slPrices[slPrices.length - 2];

    final nowBullish = sh1 > sh2 && sl1 > sl2;
    final nowBearish = sh1 < sh2 && sl1 < sl2;

    if (shPrices.length >= 3 && slPrices.length >= 3) {
      final sh3 = shPrices[shPrices.length - 3];
      final sl3 = slPrices[slPrices.length - 3];
      final wasBullish = sh2 > sh3 && sl2 > sl3;
      final wasBearish = sh2 < sh3 && sl2 < sl3;

      if (wasBearish && nowBullish) return 'change_of_character_bullish';
      if (wasBullish && nowBearish) return 'change_of_character_bearish';
      if (nowBullish && _currentPrice > sh2) {
        return 'break_of_structure_bullish';
      }
      if (nowBearish && _currentPrice < sl2) {
        return 'break_of_structure_bearish';
      }
    }

    if (nowBullish) return 'higher_high_higher_low';
    if (nowBearish) return 'lower_low_lower_high';
    return 'none';
  }

  String _detectOrderBlock() {
    if (_candles.length < 10) return 'none';

    double totalBody = 0;
    for (final c in _candles) {
      totalBody += (c.close - c.open).abs();
    }
    final impulseThreshold = (totalBody / _candles.length) * 1.5;

    for (int i = _candles.length - 2; i >= 5; i--) {
      final c = _candles[i];
      final body = (c.close - c.open).abs();
      if (body < impulseThreshold) continue;

      if (c.close > c.open) {
        for (int j = i - 1; j >= max(0, i - 5); j--) {
          final ob = _candles[j];
          if (ob.close < ob.open) {
            if (_currentPrice >= ob.low && _currentPrice <= ob.high) {
              return 'bullish';
            }
            break;
          }
        }
      } else {
        for (int j = i - 1; j >= max(0, i - 5); j--) {
          final ob = _candles[j];
          if (ob.close > ob.open) {
            if (_currentPrice >= ob.low && _currentPrice <= ob.high) {
              return 'bearish';
            }
            break;
          }
        }
      }
    }
    return 'none';
  }

  String _detectFairValueGap() {
    if (_candles.length < 5) return 'none';

    for (int i = _candles.length - 1; i >= 2; i--) {
      final c1 = _candles[i - 2];
      final c3 = _candles[i];

      if (c3.low > c1.high) {
        if (_currentPrice >= c1.high && _currentPrice <= c3.low) {
          return 'bullish';
        }
      }
      if (c3.high < c1.low) {
        if (_currentPrice >= c3.high && _currentPrice <= c1.low) {
          return 'bearish';
        }
      }
    }
    return 'none';
  }

  String _detectLiquiditySweep() {
    if (_candles.length < 15) return 'none';

    final refEnd = _candles.length - 3;
    final refStart = max(0, _candles.length - 18);

    double refHigh = 0;
    double refLow = double.infinity;
    for (int i = refStart; i < refEnd; i++) {
      refHigh = max(refHigh, _candles[i].high);
      refLow = min(refLow, _candles[i].low);
    }

    final last3 = _candles.sublist(_candles.length - 3);
    if (last3.any((c) => c.low < refLow) && _currentPrice > refLow) {
      return 'sell_side';
    }
    if (last3.any((c) => c.high > refHigh) && _currentPrice < refHigh) {
      return 'buy_side';
    }
    return 'none';
  }

  String _detectElliottWave(String? targetWave) {
    if (_candles.length < 30) return 'none';

    final highPrices = <double>[];
    final highIdxs = <int>[];
    final lowPrices = <double>[];
    final lowIdxs = <int>[];

    for (int i = 2; i < _candles.length - 2; i++) {
      final h = _candles[i].high;
      final l = _candles[i].low;
      if (h > _candles[i - 1].high &&
          h > _candles[i - 2].high &&
          h > _candles[i + 1].high &&
          h > _candles[i + 2].high) {
        highPrices.add(h);
        highIdxs.add(i);
      }
      if (l < _candles[i - 1].low &&
          l < _candles[i - 2].low &&
          l < _candles[i + 1].low &&
          l < _candles[i + 2].low) {
        lowPrices.add(l);
        lowIdxs.add(i);
      }
    }

    if (highPrices.length < 2 || lowPrices.length < 2) return 'none';

    final lhPrice = highPrices.last;
    final phPrice = highPrices[highPrices.length - 2];
    final llPrice = lowPrices.last;
    final plPrice = lowPrices[lowPrices.length - 2];
    final lhIdx = highIdxs.last;
    final llIdx = lowIdxs.last;

    String detectedWave;
    String direction;

    if (lhIdx > llIdx) {
      // Last swing = HIGH → up move just completed
      final impulse = lhPrice - plPrice;
      final prevDown = phPrice - llPrice;
      if (impulse > prevDown * 1.3 && lhPrice > phPrice && llPrice > plPrice) {
        detectedWave = '3';
        direction = 'bullish';
      } else if (lhPrice > phPrice) {
        detectedWave = impulse < prevDown ? '5' : '1';
        direction = 'bullish';
      } else {
        detectedWave = 'B';
        direction = 'bearish';
      }
    } else {
      // Last swing = LOW → down move just completed
      final downSize = lhPrice - llPrice;
      final prevUp = lhPrice - plPrice;
      final retrace = prevUp > 0 ? downSize / prevUp : 0.5;
      if (llPrice < plPrice && lhPrice < phPrice) {
        detectedWave = downSize > prevUp * 1.3 ? '3' : 'C';
        direction = 'bearish';
      } else if (retrace >= 0.382 && retrace <= 0.786) {
        detectedWave = '2';
        direction = 'bearish';
      } else {
        detectedWave = 'C';
        direction = 'bearish';
      }
    }

    if (targetWave != null &&
        targetWave.isNotEmpty &&
        detectedWave != targetWave) {
      return 'none';
    }
    return direction;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  double _avgBodySize() {
    if (_candles.isEmpty) return 0.0001;
    double s = 0;
    for (final c in _candles) {
      s += (c.close - c.open).abs();
    }
    return s / _candles.length;
  }

  Map<String, List<double>> _swingPoints({int lookback = 50, int str = 2}) {
    final h = <double>[], l = <double>[];
    final start = max(str, _candles.length - lookback);
    for (int i = start; i < _candles.length - str; i++) {
      double ch = _candles[i].high, cl = _candles[i].low;
      bool iH = true, iL = true;
      for (int k = 1; k <= str; k++) {
        if (ch <= _candles[i - k].high || ch <= _candles[i + k].high) {
          iH = false;
        }
        if (cl >= _candles[i - k].low || cl >= _candles[i + k].low) iL = false;
      }
      if (iH) h.add(ch);
      if (iL) l.add(cl);
    }
    return {'h': h, 'l': l};
  }

  double _premiumDiscountPos() {
    if (_candles.length < 5) return 50;
    double rH = 0, rL = double.infinity;
    final lb = min(50, _candles.length);
    for (int i = _candles.length - lb; i < _candles.length; i++) {
      rH = max(rH, _candles[i].high);
      rL = min(rL, _candles[i].low);
    }
    final range = rH - rL;
    return range > 0 ? ((_currentPrice - rL) / range) * 100 : 50;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ICT / SMC EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectInternalBos() {
    if (_candles.length < 8) return 'none';
    final sp = _swingPoints(lookback: 12, str: 1);
    final h = sp['h']!;
    final l = sp['l']!;
    if (h.isNotEmpty && _currentPrice > h.last) return 'bullish';
    if (l.isNotEmpty && _currentPrice < l.last) return 'bearish';
    return 'none';
  }

  String _detectExternalBos() {
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: _candles.length, str: 3);
    final h = sp['h']!;
    final l = sp['l']!;
    if (h.length >= 2 && _currentPrice > h[h.length - 2]) return 'bullish';
    if (l.length >= 2 && _currentPrice < l[l.length - 2]) return 'bearish';
    return 'none';
  }

  String _detectBreakerBlock() {
    if (_candles.length < 15) return 'none';
    for (int i = _candles.length - 8; i >= 3; i--) {
      final obH = _candles[i].high, obL = _candles[i].low;
      bool bA = false, bB = false;
      for (int j = i + 1; j < min(i + 7, _candles.length); j++) {
        if (_candles[j].close > obH) bA = true;
        if (_candles[j].close < obL) bB = true;
      }
      if (bA && _currentPrice >= obL && _currentPrice <= obH) return 'bullish';
      if (bB && _currentPrice >= obL && _currentPrice <= obH) return 'bearish';
    }
    return 'none';
  }

  String _detectRejectionBlock() {
    if (_candles.length < 3) return 'none';
    for (int i = _candles.length - 1; i >= max(0, _candles.length - 5); i--) {
      final c = _candles[i];
      final range = c.high - c.low;
      if (range < 0.0001) continue;
      final body = (c.close - c.open).abs();
      final upW = c.high - max(c.open, c.close);
      final dnW = min(c.open, c.close) - c.low;
      if (dnW > range * 0.6 &&
          dnW > body * 2 &&
          (_currentPrice - c.low).abs() < range * 0.4) {
        return 'bullish';
      }
      if (upW > range * 0.6 &&
          upW > body * 2 &&
          (_currentPrice - c.high).abs() < range * 0.4) {
        return 'bearish';
      }
    }
    return 'none';
  }

  String _detectMitigationBlock() {
    if (_candles.length < 15) return 'none';
    final avg = _avgBodySize();
    for (int i = _candles.length - 10; i >= 5; i--) {
      final c = _candles[i];
      if ((c.close - c.open).abs() < avg * 2) continue;
      final zH = max(c.open, c.close), zL = min(c.open, c.close);
      bool moved = false;
      for (int j = i + 1; j < min(i + 5, _candles.length - 1); j++) {
        if ((_candles[j].close - c.close).abs() > avg * 3) {
          moved = true;
          break;
        }
      }
      if (moved && _currentPrice >= zL && _currentPrice <= zH) {
        return c.close > c.open ? 'bullish' : 'bearish';
      }
    }
    return 'none';
  }

  String _detectInverseFvg() {
    if (_candles.length < 10) return 'none';
    for (int i = min(_candles.length - 4, _candles.length - 1); i >= 4; i--) {
      final c1 = _candles[i - 2], c3 = _candles[i];
      if (c3.low > c1.high) {
        bool filled = false;
        for (int j = i + 1; j < _candles.length - 1; j++) {
          if (_candles[j].low <= c1.high) {
            filled = true;
            break;
          }
        }
        if (filled && _currentPrice >= c1.high && _currentPrice <= c3.low) {
          return 'bearish';
        }
      }
      if (c3.high < c1.low) {
        bool filled = false;
        for (int j = i + 1; j < _candles.length - 1; j++) {
          if (_candles[j].high >= c1.low) {
            filled = true;
            break;
          }
        }
        if (filled && _currentPrice >= c3.high && _currentPrice <= c1.low) {
          return 'bullish';
        }
      }
    }
    return 'none';
  }

  String _detectBalancedPriceRange() {
    if (_candles.length < 10) return 'none';
    final bL = <double>[], bH = <double>[], sL = <double>[], sH = <double>[];
    for (int i = 2; i < _candles.length; i++) {
      final c1 = _candles[i - 2], c3 = _candles[i];
      if (c3.low > c1.high) {
        bL.add(c1.high);
        bH.add(c3.low);
      }
      if (c3.high < c1.low) {
        sL.add(c3.high);
        sH.add(c1.low);
      }
    }
    for (int b = 0; b < bL.length; b++) {
      for (int s = 0; s < sL.length; s++) {
        final oL = max(bL[b], sL[s]), oH = min(bH[b], sH[s]);
        if (oH > oL && _currentPrice >= oL && _currentPrice <= oH) {
          return 'active';
        }
      }
    }
    return 'none';
  }

  String _detectEqualHighs() {
    if (_candles.length < 20) return 'none';
    final h = _swingPoints(lookback: 40, str: 2)['h']!;
    if (h.length < 2) return 'none';
    const tol = 0.001;
    for (int i = h.length - 1; i >= 1; i--) {
      if ((h[i] - h[i - 1]).abs() < tol && _currentPrice >= h[i] - tol) {
        return 'active';
      }
    }
    return 'none';
  }

  String _detectEqualLows() {
    if (_candles.length < 20) return 'none';
    final l = _swingPoints(lookback: 40, str: 2)['l']!;
    if (l.length < 2) return 'none';
    const tol = 0.001;
    for (int i = l.length - 1; i >= 1; i--) {
      if ((l[i] - l[i - 1]).abs() < tol && _currentPrice <= l[i] + tol) {
        return 'active';
      }
    }
    return 'none';
  }

  String _detectPremiumZone() =>
      _premiumDiscountPos() > 62 ? 'premium' : 'none';
  String _detectDiscountZone() =>
      _premiumDiscountPos() < 38 ? 'discount' : 'none';

  String _detectDealingRange() {
    final p = _premiumDiscountPos();
    if (p > 62) return 'premium';
    if (p < 38) return 'discount';
    return 'equilibrium';
  }

  String _detectOte() {
    if (_candles.length < 20) return 'none';
    double sH = 0, sL = double.infinity;
    int hIdx = 0, lIdx = 0;
    final lb = min(30, _candles.length - 3);
    for (int i = _candles.length - lb; i < _candles.length - 3; i++) {
      if (_candles[i].high > sH) {
        sH = _candles[i].high;
        hIdx = i;
      }
      if (_candles[i].low < sL) {
        sL = _candles[i].low;
        lIdx = i;
      }
    }
    final range = sH - sL;
    if (range < 0.0001) return 'none';
    if (lIdx < hIdx) {
      final lo = sH - range * 0.79, hi = sH - range * 0.62;
      if (_currentPrice >= lo && _currentPrice <= hi) return 'bullish';
    } else {
      final lo = sL + range * 0.62, hi = sL + range * 0.79;
      if (_currentPrice >= lo && _currentPrice <= hi) return 'bearish';
    }
    return 'none';
  }

  String _detectMarketMakerBuyModel() {
    if (_candles.length < 20) return 'none';
    final ms = _detectMarketStructure();
    final sweep = _detectLiquiditySweep();
    final exp = _detectExpansion();
    final bearCtx =
        ms.contains('lower') ||
        ms == 'change_of_character_bullish' ||
        sweep == 'sell_side';
    return (bearCtx && exp == 'bullish') ? 'bullish' : 'none';
  }

  String _detectMarketMakerSellModel() {
    if (_candles.length < 20) return 'none';
    final ms = _detectMarketStructure();
    final sweep = _detectLiquiditySweep();
    final exp = _detectExpansion();
    final bullCtx =
        ms.contains('higher') ||
        ms == 'change_of_character_bearish' ||
        sweep == 'buy_side';
    return (bullCtx && exp == 'bearish') ? 'bearish' : 'none';
  }

  String _detectJudasSwing() {
    if (_candles.length < 8) return 'none';
    final hour = DateTime.now().toUtc().hour;
    final inKZ =
        (hour >= 8 && hour <= 9) ||
        (hour >= 13 && hour <= 14) ||
        (hour >= 2 && hour <= 3);
    if (!inKZ) return 'none';
    final atr = _calculateAtr(5);
    final rec = _candles.sublist(max(0, _candles.length - 6));
    final mxH = rec.map((c) => c.high).reduce(max);
    final mnL = rec.map((c) => c.low).reduce(min);
    final mid = rec[rec.length ~/ 2].close;
    if (mnL < rec.first.close - atr * 1.5 && _currentPrice > mid) {
      return 'bullish';
    }
    if (mxH > rec.first.close + atr * 1.5 && _currentPrice < mid) {
      return 'bearish';
    }
    return 'none';
  }

  String _detectSessionOpen() {
    if (_candles.length < 3) return 'none';
    final open = _candles.first.open;
    if (_currentPrice > open * 1.0002) return 'above';
    if (_currentPrice < open * 0.9998) return 'below';
    return 'at';
  }

  String _detectOpeningRange() {
    if (_candles.length < 10) return 'none';
    final n = min(10, _candles.length);
    final orH = _candles.sublist(0, n).map((c) => c.high).reduce(max);
    final orL = _candles.sublist(0, n).map((c) => c.low).reduce(min);
    if (_currentPrice > orH) return 'breakout_up';
    if (_currentPrice < orL) return 'breakout_down';
    return 'inside';
  }

  String _detectWyckoffSpring() {
    if (_candles.length < 20) return 'none';
    double support = double.infinity;
    final refEnd = _candles.length - 3;
    for (int i = max(0, _candles.length - 18); i < refEnd; i++) {
      support = min(support, _candles[i].low);
    }
    final last3 = _candles.sublist(_candles.length - 3);
    if (last3.any((c) => c.low < support) && _currentPrice > support) {
      final deepest = last3.map((c) => c.low).reduce(min);
      if (support - deepest < support * 0.003) return 'bullish';
    }
    return 'none';
  }

  String _detectWyckoffUpthrust() {
    if (_candles.length < 20) return 'none';
    double resist = 0;
    final refEnd = _candles.length - 3;
    for (int i = max(0, _candles.length - 18); i < refEnd; i++) {
      resist = max(resist, _candles[i].high);
    }
    final last3 = _candles.sublist(_candles.length - 3);
    if (last3.any((c) => c.high > resist) && _currentPrice < resist) {
      final highest = last3.map((c) => c.high).reduce(max);
      if (highest - resist < resist * 0.003) return 'bearish';
    }
    return 'none';
  }

  String _detectAccumulation() {
    if (_candles.length < 20) return 'none';
    if (_calculateAtr(5) >= _calculateAtr(20) * 0.7) return 'none';
    final rL = _candles
        .sublist(max(0, _candles.length - 5))
        .map((c) => c.low)
        .reduce(min);
    final pL = _candles
        .sublist(max(0, _candles.length - 20), _candles.length - 5)
        .map((c) => c.low)
        .reduce(min);
    return rL > pL ? 'bullish' : 'none';
  }

  String _detectDistribution() {
    if (_candles.length < 20) return 'none';
    if (_calculateAtr(5) >= _calculateAtr(20) * 0.7) return 'none';
    final rH = _candles
        .sublist(max(0, _candles.length - 5))
        .map((c) => c.high)
        .reduce(max);
    final pH = _candles
        .sublist(max(0, _candles.length - 20), _candles.length - 5)
        .map((c) => c.high)
        .reduce(max);
    return rH < pH ? 'bearish' : 'none';
  }

  String _detectManipulation() {
    if (_candles.length < 8) return 'none';
    final avg = _avgBodySize();
    for (final c in _candles.sublist(max(0, _candles.length - 5)).reversed) {
      if ((c.close - c.open).abs() > avg * 3) {
        return c.close < c.open ? 'bullish' : 'bearish';
      }
    }
    return 'none';
  }

  String _detectExpansion() {
    if (_candles.length < 10) return 'none';
    if (_calculateAtr(5) < _calculateAtr(14) * 1.3) return 'none';
    final start = _candles[_candles.length - 5].close;
    if (_currentPrice > start) return 'bullish';
    if (_currentPrice < start) return 'bearish';
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TIME ANALYSIS EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectKillZone() {
    final h = DateTime.now().toUtc().hour;
    if (h >= 2 && h < 5) return 'asian_killzone';
    if (h >= 8 && h < 11) return 'london_killzone';
    if (h >= 13 && h < 16) return 'newyork_killzone';
    return 'none';
  }

  String _detectDayOfWeek() {
    switch (DateTime.now().weekday) {
      case 1:
        return 'monday';
      case 2:
        return 'tuesday';
      case 3:
        return 'wednesday';
      case 4:
        return 'thursday';
      case 5:
        return 'friday';
      default:
        return 'weekend';
    }
  }

  String _detectSessionOverlap() {
    final h = DateTime.now().toUtc().hour;
    if (h >= 8 && h < 9) return 'asian_london';
    if (h >= 13 && h < 17) return 'london_newyork';
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CHART PATTERNS
  // ══════════════════════════════════════════════════════════════════════════

  String _detectDoubleTop() {
    if (_candles.length < 20) return 'none';
    final h = _swingPoints(lookback: 40, str: 2)['h']!;
    if (h.length < 2) return 'none';
    const tol = 0.0015;
    if ((h.last - h[h.length - 2]).abs() < tol &&
        _currentPrice < h.last - tol) {
      return 'bearish';
    }
    return 'none';
  }

  String _detectDoubleBottom() {
    if (_candles.length < 20) return 'none';
    final l = _swingPoints(lookback: 40, str: 2)['l']!;
    if (l.length < 2) return 'none';
    const tol = 0.0015;
    if ((l.last - l[l.length - 2]).abs() < tol &&
        _currentPrice > l.last + tol) {
      return 'bullish';
    }
    return 'none';
  }

  String _detectHeadAndShoulders() {
    if (_candles.length < 30) return 'none';
    final h = _swingPoints(lookback: 60, str: 2)['h']!;
    if (h.length < 3) return 'none';
    final left = h[h.length - 3], head = h[h.length - 2], right = h.last;
    final shoulderAvg = (left + right) / 2;
    if (head > left * 1.002 &&
        head > right * 1.002 &&
        (left - right).abs() < shoulderAvg * 0.003) {
      if (_currentPrice < shoulderAvg) return 'bearish';
    }
    return 'none';
  }

  String _detectInverseHeadAndShoulders() {
    if (_candles.length < 30) return 'none';
    final l = _swingPoints(lookback: 60, str: 2)['l']!;
    if (l.length < 3) return 'none';
    final left = l[l.length - 3], head = l[l.length - 2], right = l.last;
    final shoulderAvg = (left + right) / 2;
    if (head < left * 0.998 &&
        head < right * 0.998 &&
        (left - right).abs() < shoulderAvg * 0.003) {
      if (_currentPrice > shoulderAvg) return 'bullish';
    }
    return 'none';
  }

  String _detectAscendingTriangle() {
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: 30, str: 2);
    final h = sp['h']!;
    final l = sp['l']!;
    if (h.length < 2 || l.length < 2) return 'none';
    final flatTop = (h.last - h[h.length - 2]).abs() < 0.0015;
    final risingLow = l.last > l[l.length - 2];
    if (flatTop && risingLow && _currentPrice > h.last) return 'bullish';
    return 'none';
  }

  String _detectDescendingTriangle() {
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: 30, str: 2);
    final h = sp['h']!;
    final l = sp['l']!;
    if (h.length < 2 || l.length < 2) return 'none';
    final flatBot = (l.last - l[l.length - 2]).abs() < 0.0015;
    final fallingHigh = h.last < h[h.length - 2];
    if (flatBot && fallingHigh && _currentPrice < l.last) return 'bearish';
    return 'none';
  }

  String _detectSymmetricalTriangle() {
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: 30, str: 2);
    final h = sp['h']!;
    final l = sp['l']!;
    if (h.length < 2 || l.length < 2) return 'none';
    final fallingH = h.last < h[h.length - 2];
    final risingL = l.last > l[l.length - 2];
    if (!fallingH || !risingL) return 'none';
    if (_currentPrice > h.last) return 'bullish';
    if (_currentPrice < l.last) return 'bearish';
    return 'none';
  }

  String _detectWedge(bool rising) {
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: 30, str: 2);
    final h = sp['h']!;
    final l = sp['l']!;
    if (h.length < 2 || l.length < 2) return 'none';
    if (rising) {
      if (h.last > h[h.length - 2] &&
          l.last > l[l.length - 2] &&
          _currentPrice < l.last) {
        return 'bearish';
      }
    } else {
      if (h.last < h[h.length - 2] &&
          l.last < l[l.length - 2] &&
          _currentPrice > h.last) {
        return 'bullish';
      }
    }
    return 'none';
  }

  String _detectFlag(bool bull) {
    if (_candles.length < 15) return 'none';
    final avg = _avgBodySize();
    // Strong impulse in first half, then consolidation
    final first5 = _candles.sublist(
      max(0, _candles.length - 15),
      _candles.length - 5,
    );
    final last5 = _candles.sublist(_candles.length - 5);
    final impulse = bull
        ? first5.last.close - first5.first.close
        : first5.first.close - first5.last.close;
    final consol =
        last5.map((c) => c.high).reduce(max) -
        last5.map((c) => c.low).reduce(min);
    if (impulse > avg * 5 && consol < impulse * 0.4) {
      if (bull && _currentPrice > last5.map((c) => c.high).reduce(max)) {
        return 'bullish';
      }
      if (!bull && _currentPrice < last5.map((c) => c.low).reduce(min)) {
        return 'bearish';
      }
    }
    return 'none';
  }

  String _detectChannel(bool up) {
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: 30, str: 2);
    final h = sp['h']!;
    final l = sp['l']!;
    if (h.length < 2 || l.length < 2) return 'none';
    if (up) {
      if (h.last > h[h.length - 2] && l.last > l[l.length - 2]) {
        return 'bullish';
      }
    } else {
      if (h.last < h[h.length - 2] && l.last < l[l.length - 2]) {
        return 'bearish';
      }
    }
    return 'none';
  }

  String _detectRectangle() {
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: 30, str: 2);
    final h = sp['h']!;
    final l = sp['l']!;
    if (h.length < 2 || l.length < 2) return 'none';
    const tol = 0.0020;
    final flatH = (h.last - h[h.length - 2]).abs() < tol;
    final flatL = (l.last - l[l.length - 2]).abs() < tol;
    if (!flatH || !flatL) return 'none';
    if (_currentPrice > h.last) return 'bullish';
    if (_currentPrice < l.last) return 'bearish';
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HARMONIC PATTERNS (XABCD)
  // ══════════════════════════════════════════════════════════════════════════

  String _detectHarmonic(String type) {
    if (_candles.length < 40) return 'none';
    final h = _swingPoints(lookback: 60, str: 2)['h']!;
    final l = _swingPoints(lookback: 60, str: 2)['l']!;
    if (h.length < 3 || l.length < 3) return 'none';

    // Simplified: use last 5 swing points alternating H/L
    // For bullish: X=L, A=H, B=L, C=H, D=L (current price near D)
    // Approximate ratios
    final xL = l.length >= 3 ? l[l.length - 3] : l.first;
    final aH = h.length >= 2 ? h[h.length - 2] : h.last;
    final bL = l.length >= 2 ? l[l.length - 2] : l.last;
    final cH = h.last;
    final dTarget = _currentPrice;

    final xa = aH - xL;
    final ab = aH - bL;
    final bc = cH - bL;
    if (xa < 0.0001) return 'none';

    final abXa = ab / xa;
    final bcAb = bc / ab.clamp(0.0001, double.infinity);

    bool matches = false;
    switch (type) {
      case 'gartley':
        matches = _inRange(abXa, 0.58, 0.65) && _inRange(bcAb, 0.36, 0.90);
        break;
      case 'bat':
        matches = _inRange(abXa, 0.38, 0.52) && _inRange(bcAb, 0.36, 0.90);
        break;
      case 'butterfly':
        matches = _inRange(abXa, 0.74, 0.82) && _inRange(bcAb, 0.36, 0.90);
        break;
      case 'crab':
        matches = _inRange(abXa, 0.36, 0.62) && _inRange(bcAb, 0.36, 0.90);
        break;
      case 'shark':
        matches = _inRange(abXa, 0.44, 0.55) && bcAb > 1.13;
        break;
      case 'cypher':
        matches = _inRange(abXa, 0.38, 0.62) && _inRange(bcAb, 1.13, 1.41);
        break;
      case 'ab_cd':
        matches = _inRange(bcAb, 0.62, 0.79);
        break;
      default:
        matches = false;
    }

    if (!matches) return 'none';

    // Determine direction (bullish = near D support, bearish = near D resistance)
    final midRange = (xL + aH) / 2;
    return dTarget < midRange ? 'bullish' : 'bearish';
  }

  bool _inRange(double v, double lo, double hi) => v >= lo && v <= hi;

  // ══════════════════════════════════════════════════════════════════════════
  // ADDITIONAL TECHNICAL SCHOOLS
  // ══════════════════════════════════════════════════════════════════════════

  String _detectPivotPoint() {
    if (_candles.length < 5) return 'none';
    // Classic pivot: P = (H + L + C) / 3 from last session
    final c = _candles[_candles.length - 2]; // previous candle as "session"
    final p = (c.high + c.low + c.close) / 3;
    final r1 = 2 * p - c.low;
    final s1 = 2 * p - c.high;
    if (_currentPrice > r1) return 'above_r1';
    if (_currentPrice < s1) return 'below_s1';
    if (_currentPrice > p) return 'above_pivot';
    if (_currentPrice < p) return 'below_pivot';
    return 'at_pivot';
  }

  String _detectSupplyDemandZone() {
    // Supply zone: strong bearish candle zone (unfilled) = price near it = resistance
    // Demand zone: strong bullish candle zone (unfilled) = price near it = support
    if (_candles.length < 10) return 'none';
    final avg = _avgBodySize();
    for (int i = _candles.length - 8; i >= 2; i--) {
      final c = _candles[i];
      if ((c.close - c.open).abs() < avg * 2) continue;
      final zH = max(c.open, c.close), zL = min(c.open, c.close);
      if (_currentPrice >= zL && _currentPrice <= zH) {
        return c.close > c.open ? 'demand' : 'supply';
      }
    }
    return 'none';
  }

  String _detectBreakoutSignal() {
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: 20, str: 2);
    final h = sp['h']!;
    final l = sp['l']!;
    if (h.isEmpty || l.isEmpty) return 'none';
    final res = h.last, sup = l.last;
    final atr = _calculateAtr(14);
    if (_currentPrice > res + atr * 0.3) return 'bullish';
    if (_currentPrice < sup - atr * 0.3) return 'bearish';
    return 'none';
  }

  String _detectMomentumSignal() {
    if (_candles.length < 10) return 'none';
    final roc = _calculateRoc(5);
    if (roc > 0.3) return 'bullish';
    if (roc < -0.3) return 'bearish';
    return 'none';
  }

  String _detectMeanReversionSignal() {
    if (_candles.length < 20) return 'none';
    final rsi = _calculateRsi(14);
    final bbPos = _premiumDiscountPos();
    if (rsi < 25 && bbPos < 10) return 'bullish';
    if (rsi > 75 && bbPos > 90) return 'bearish';
    return 'none';
  }

  String _detectNrPattern(int n) {
    // NR4/NR7: Narrowest Range in last n bars
    if (_candles.length < n + 1) return 'none';
    final recent = _candles.sublist(_candles.length - n);
    final ranges = recent.map((c) => c.high - c.low).toList();
    final lastRange = ranges.last;
    final isNr = ranges.every((r) => r >= lastRange);
    if (!isNr) return 'none';
    // Price direction after NR = breakout signal
    if (_currentPrice > recent.last.high) return 'bullish';
    if (_currentPrice < recent.last.low) return 'bearish';
    return 'active'; // Inside NR
  }

  String _detectCpr() {
    // Central Pivot Range: P±0.5*(H-L)
    if (_candles.length < 3) return 'none';
    final c = _candles[_candles.length - 2];
    final p = (c.high + c.low + c.close) / 3;
    final tc = (c.high + c.low) / 2; // top CPR
    final bc = 2 * p - tc; // bottom CPR
    if (_currentPrice > max(tc, bc)) return 'above_cpr';
    if (_currentPrice < min(tc, bc)) return 'below_cpr';
    return 'inside_cpr';
  }

  String _detectVcp() {
    // Volatility Contraction Pattern: sequential narrowing ranges
    if (_candles.length < 10) return 'none';
    final recent = _candles.sublist(_candles.length - 8);
    final ranges = recent.map((c) => c.high - c.low).toList();
    bool contracting = true;
    for (int i = 1; i < ranges.length - 1; i++) {
      if (ranges[i] >= ranges[i - 1] * 1.1) {
        contracting = false;
        break;
      }
    }
    if (!contracting) return 'none';
    if (_currentPrice > recent.last.high) return 'bullish';
    if (_currentPrice < recent.last.low) return 'bearish';
    return 'none';
  }

  String _detectOrbSignal() {
    // Opening Range Breakout: same as opening_range but as indicator
    return _detectOpeningRange() == 'breakout_up'
        ? 'bullish'
        : _detectOpeningRange() == 'breakout_down'
        ? 'bearish'
        : 'none';
  }

  String _detectHeikinAshi() {
    // Heikin Ashi converted candles: HA_close = (O+H+L+C)/4
    if (_candles.length < 3) return 'none';
    final c = _candles.last;
    final p = _candles[_candles.length - 2];
    final haClose = (c.open + c.high + c.low + c.close) / 4;
    final haOpen = (p.open + p.close) / 2;
    if (haClose > haOpen && c.low == min(c.open, c.close)) {
      return 'strong_bullish';
    }
    if (haClose < haOpen && c.high == max(c.open, c.close)) {
      return 'strong_bearish';
    }
    if (haClose > haOpen) return 'bullish';
    if (haClose < haOpen) return 'bearish';
    return 'none';
  }

  String _detectAnchoredVwap() {
    // Simplified anchored VWAP: VWAP from first candle in session
    if (_candles.length < 5) return 'none';
    final vwap = _calculateVwap();
    if (_currentPrice > vwap * 1.001) return 'above';
    if (_currentPrice < vwap * 0.999) return 'below';
    return 'at';
  }

  String _detectVwapBands() {
    if (_candles.length < 5) return 'none';
    final vwap = _calculateVwap();
    final atr = _calculateAtr(14);
    if (_currentPrice > vwap + atr) return 'above_upper';
    if (_currentPrice < vwap - atr) return 'below_lower';
    if (_currentPrice > vwap) return 'above';
    if (_currentPrice < vwap) return 'below';
    return 'at';
  }

  String _detectGannAngle() {
    // Simplified 1x1 Gann Angle: 45 degrees means price moves 1 pip per bar
    if (_candles.length < 10) return 'none';
    final n = min(10, _candles.length - 1);
    final startPrice = _candles[_candles.length - 1 - n].close;
    final pipPerBar = (_currentPrice - startPrice) / n;
    if (pipPerBar.abs() < 0.00005) return 'equilibrium'; // near 1x1
    return pipPerBar > 0 ? 'bullish' : 'bearish';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CANDLESTICK PATTERNS EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectAdvancedCandlePattern() {
    if (_candles.length < 5) return 'none';
    final c0 = _candles.last;
    final c1 = _candles[_candles.length - 2];
    final c2 = _candles.length > 2 ? _candles[_candles.length - 3] : c1;

    final range0 = c0.high - c0.low;
    final body0 = (c0.close - c0.open).abs();
    final upWick0 = c0.high - max(c0.open, c0.close);
    final dnWick0 = min(c0.open, c0.close) - c0.low;

    // Doji family
    if (body0 < range0 * 0.1) {
      if (dnWick0 > range0 * 0.6 && upWick0 < range0 * 0.1) {
        return 'dragonfly_doji';
      }
      if (upWick0 > range0 * 0.6 && dnWick0 < range0 * 0.1) {
        return 'gravestone_doji';
      }
      if (upWick0 > range0 * 0.3 && dnWick0 > range0 * 0.3) {
        return 'long_legged_doji';
      }
      return 'doji';
    }

    // Marubozu
    if (body0 > range0 * 0.95) {
      return c0.close > c0.open ? 'bullish_marubozu' : 'bearish_marubozu';
    }

    // Spinning Top
    if (body0 < range0 * 0.3 && upWick0 > body0 && dnWick0 > body0) {
      return 'spinning_top';
    }

    // Hammer / Hanging Man (single candle)
    if (dnWick0 > body0 * 2 && upWick0 < body0 * 0.5 && range0 > 0.0001) {
      return c0.close > c0.open ? 'hammer' : 'hanging_man';
    }

    // Inverted Hammer / Shooting Star
    if (upWick0 > body0 * 2 && dnWick0 < body0 * 0.5 && range0 > 0.0001) {
      return c0.close > c0.open ? 'inverted_hammer' : 'shooting_star';
    }

    // Two-candle patterns
    final body1 = (c1.close - c1.open).abs();
    // Engulfing
    if (c1.close < c1.open &&
        c0.close > c0.open &&
        c0.open <= c1.close &&
        c0.close >= c1.open) {
      return 'bullish_engulfing';
    }
    if (c1.close > c1.open &&
        c0.close < c0.open &&
        c0.open >= c1.close &&
        c0.close <= c1.open) {
      return 'bearish_engulfing';
    }

    // Harami
    if (c1.close < c1.open &&
        c0.close > c0.open &&
        c0.open > c1.close &&
        c0.close < c1.open) {
      return 'bullish_harami';
    }
    if (c1.close > c1.open &&
        c0.close < c0.open &&
        c0.open < c1.close &&
        c0.close > c1.open) {
      return 'bearish_harami';
    }
    if (c1.close < c1.open &&
        body0 < body1 * 0.25 &&
        c0.open > c1.close &&
        c0.close < c1.open) {
      return 'bullish_harami_cross';
    }
    if (c1.close > c1.open &&
        body0 < body1 * 0.25 &&
        c0.open < c1.close &&
        c0.close > c1.open) {
      return 'bearish_harami_cross';
    }

    // Piercing Line / Dark Cloud Cover
    if (c1.close < c1.open &&
        c0.close > c0.open &&
        c0.open < c1.close &&
        c0.close > (c1.open + c1.close) / 2) {
      return 'piercing_line';
    }
    if (c1.close > c1.open &&
        c0.close < c0.open &&
        c0.open > c1.close &&
        c0.close < (c1.open + c1.close) / 2) {
      return 'dark_cloud_cover';
    }

    // Tweezers
    if ((c1.high - c0.high).abs() < 0.0005 &&
        c1.close > c1.open &&
        c0.close < c0.open) {
      return 'tweezer_top';
    }
    if ((c1.low - c0.low).abs() < 0.0005 &&
        c1.close < c1.open &&
        c0.close > c0.open) {
      return 'tweezer_bottom';
    }

    // Three-candle patterns
    if (_candles.length >= 3) {
      // Morning Star / Evening Star (simplified)
      if (c2.close < c2.open &&
          body1 < (c2.close - c2.open).abs() * 0.3 &&
          c0.close > c0.open &&
          c0.close > (c2.open + c2.close) / 2) {
        return 'morning_star';
      }
      if (c2.close > c2.open &&
          body1 < (c2.close - c2.open).abs() * 0.3 &&
          c0.close < c0.open &&
          c0.close < (c2.open + c2.close) / 2) {
        return 'evening_star';
      }

      // Three White Soldiers / Three Black Crows
      if (c2.close > c2.open &&
          c1.close > c1.open &&
          c0.close > c0.open &&
          c1.close > c2.close &&
          c0.close > c1.close) {
        return 'three_white_soldiers';
      }
      if (c2.close < c2.open &&
          c1.close < c1.open &&
          c0.close < c0.open &&
          c1.close < c2.close &&
          c0.close < c1.close) {
        return 'three_black_crows';
      }

      // Three Inside Up/Down
      if (c2.close < c2.open &&
          c1.close > c1.open &&
          c1.open > c2.close &&
          c1.close < c2.open &&
          c0.close > c1.close) {
        return 'three_inside_up';
      }
      if (c2.close > c2.open &&
          c1.close < c1.open &&
          c1.open < c2.close &&
          c1.close > c2.open &&
          c0.close < c1.close) {
        return 'three_inside_down';
      }

      // Kicker
      if (c1.close < c1.open &&
          c0.close > c0.open &&
          c0.open >= c1.open &&
          (c0.open - c1.open).abs() < 0.0002) {
        return 'bullish_kicker';
      }
      if (c1.close > c1.open &&
          c0.close < c0.open &&
          c0.open <= c1.open &&
          (c0.open - c1.open).abs() < 0.0002) {
        return 'bearish_kicker';
      }

      // Abandoned Baby (gap + doji)
      if (c2.close < c2.open &&
          body1 < range0 * 0.1 &&
          c0.close > c0.open &&
          c1.low > c2.low &&
          c1.low > c0.low) {
        return 'abandoned_baby_bullish';
      }
      if (c2.close > c2.open &&
          body1 < range0 * 0.1 &&
          c0.close < c0.open &&
          c1.high < c2.high &&
          c1.high < c0.high) {
        return 'abandoned_baby_bearish';
      }
    }

    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DOW THEORY / TREND ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════

  String _detectDowTrend() {
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: 40, str: 2);
    final h = sp['h']!;
    final l = sp['l']!;
    if (h.length < 2 || l.length < 2) return 'none';
    final hhhl = h.last > h[h.length - 2] && l.last > l[l.length - 2];
    final llhl = h.last < h[h.length - 2] && l.last < l[l.length - 2];
    if (hhhl) return 'uptrend';
    if (llhl) return 'downtrend';
    return 'sideways';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VSA (Volume Spread Analysis)
  // ══════════════════════════════════════════════════════════════════════════

  String _detectVsaSignal() {
    if (_candles.length < 5) return 'none';
    final c = _candles.last;
    final spread = c.high - c.low;
    final volRatio = (_analyzeVolumeProfile()['ratio'] as double);

    // No Demand: narrow spread + low volume + close near bottom = bearish
    if (spread < _calculateAtr(5) * 0.5 &&
        volRatio < 0.7 &&
        c.close < (c.high + c.low) / 2) {
      return 'no_demand';
    }
    // No Supply: narrow spread + low volume + close near top = bullish
    if (spread < _calculateAtr(5) * 0.5 &&
        volRatio < 0.7 &&
        c.close > (c.high + c.low) / 2) {
      return 'no_supply';
    }
    // Effort Up: wide spread + high vol + close near top = bullish
    if (spread > _calculateAtr(5) * 1.3 &&
        volRatio > 1.5 &&
        c.close > (c.high + c.low) / 2) {
      return 'effort_up';
    }
    // Effort Down: wide spread + high vol + close near bottom = bearish
    if (spread > _calculateAtr(5) * 1.3 &&
        volRatio > 1.5 &&
        c.close < (c.high + c.low) / 2) {
      return 'effort_down';
    }
    return 'none';
  }

  String _detectCvd() {
    // Cumulative Volume Delta ≈ recent OBV trend: compare current OBV to OBV as
    // of ~10 candles ago. (Was recomputing the SAME full-buffer OBV into prevObv,
    // so obv==prevObv → always 'neutral', and `*1.01` was wrong for negative OBV.)
    final obv = _calculateObv();
    final n = min(10, _candles.length - 1);
    if (n < 1) return 'neutral';
    final end = _candles.length - n; // OBV excluding the last n candles = n bars ago
    double prevObv = 0.0;
    for (int i = 1; i < end; i++) {
      if (_candles[i].close > _candles[i - 1].close) {
        prevObv += _candles[i].volume;
      } else if (_candles[i].close < _candles[i - 1].close) {
        prevObv -= _candles[i].volume;
      }
    }
    final delta = obv - prevObv; // net signed volume over the last n candles
    if (delta > 0) return 'positive';
    if (delta < 0) return 'negative';
    return 'neutral';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WOLFE WAVES (simplified)
  // ══════════════════════════════════════════════════════════════════════════

  String _detectWolfeWave() {
    if (_candles.length < 30) return 'none';
    final sp = _swingPoints(lookback: 40, str: 2);
    final h = sp['h']!;
    final l = sp['l']!;
    if (h.length < 3 || l.length < 3) return 'none';
    // Bullish Wolfe: 5 waves down → point 5 near trendline 1-3 → reversal
    final pt1 = l[l.length - 3], pt3 = l[l.length - 2], pt5 = l.last;
    final trend13 = pt3 - pt1;
    final expected5 = pt3 + trend13;
    if ((pt5 - expected5).abs() < (trend13 * 0.15).abs() &&
        _currentPrice > pt5) {
      return 'bullish';
    }
    // Bearish Wolfe: 5 waves up → reversal
    final ph1 = h[h.length - 3], ph3 = h[h.length - 2], ph5 = h.last;
    final trendH = ph3 - ph1;
    final expH5 = ph3 + trendH;
    if ((ph5 - expH5).abs() < (trendH * 0.15).abs() && _currentPrice < ph5) {
      return 'bearish';
    }
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEMARK INDICATORS (simplified)
  // ══════════════════════════════════════════════════════════════════════════

  String _detectDemarkSequential() {
    if (_candles.length < 13) return 'none';
    // TD Setup: 9 consecutive closes above/below close 4 bars ago
    int upCount = 0, dnCount = 0;
    for (int i = 4; i < _candles.length; i++) {
      if (_candles[i].close > _candles[i - 4].close) {
        upCount++;
      } else {
        upCount = 0;
      }
      if (_candles[i].close < _candles[i - 4].close) {
        dnCount++;
      } else {
        dnCount = 0;
      }
    }
    if (upCount >= 9) {
      return 'sell_setup'; // 9-bar setup complete = potential reversal
    }
    if (dnCount >= 9) return 'buy_setup';
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MARKET INTERNALS (approximated from single asset)
  // ══════════════════════════════════════════════════════════════════════════

  String _detectDarvasBox() {
    if (_candles.length < 15) return 'none';
    final recent = _candles.sublist(max(0, _candles.length - 10));
    final boxH = recent
        .sublist(0, recent.length - 3)
        .map((c) => c.high)
        .reduce(max);
    final boxL = recent
        .sublist(0, recent.length - 3)
        .map((c) => c.low)
        .reduce(min);
    if (_currentPrice > boxH) return 'bullish';
    if (_currentPrice < boxL) return 'bearish';
    return 'inside';
  }

  String _detectCupAndHandle() {
    if (_candles.length < 30) return 'none';
    final mid = _candles.length ~/ 2;
    final leftH = _candles.sublist(0, mid ~/ 3).map((c) => c.high).reduce(max);
    final bottomL = _candles
        .sublist(mid ~/ 3, mid * 2 ~/ 3)
        .map((c) => c.low)
        .reduce(min);
    final rightH = _candles
        .sublist(mid * 2 ~/ 3, mid)
        .map((c) => c.high)
        .reduce(max);
    final handleL = _candles.sublist(mid).map((c) => c.low).reduce(min);
    final isU = (leftH - rightH).abs() < leftH * 0.01 && bottomL < leftH * 0.97;
    final isHandle = handleL > bottomL && handleL < leftH;
    if (isU && isHandle && _currentPrice > rightH) return 'bullish';
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ADAPTIVE / ADVANCED MOVING AVERAGES
  // ══════════════════════════════════════════════════════════════════════════

  double _calculateKama(int period) {
    // Kaufman Adaptive Moving Average
    if (_candles.length < period + 1) return _currentPrice;
    const fastSc = 2.0 / 3; // 2/(2+1)
    const slowSc = 2.0 / 31; // 2/(30+1)
    final closes = _candles.map((c) => c.close).toList();
    final n = min(period, closes.length - 1);
    double kama = closes[closes.length - 1 - n];
    for (int i = closes.length - n; i < closes.length; i++) {
      double noise = 0;
      for (int j = i - min(n, i); j < i; j++) {
        noise += (closes[j + 1] - closes[j]).abs();
      }
      final er = noise > 0
          ? (closes[i] - closes[i - min(n, i)]).abs() / noise
          : 0.0;
      final sc = pow(er * (fastSc - slowSc) + slowSc, 2).toDouble();
      kama += sc * (closes[i] - kama);
    }
    return kama;
  }

  double _calculateT3(int period) {
    // T3 = c1*e6 - c2*e5 + c3*e4 - c4*e3  (vFactor=0.7 default)
    const vf = 0.7;
    final c1 = -(vf * vf * vf),
        c2 = 3 * vf * vf + 3 * vf * vf * vf,
        c3 = -6 * vf * vf - 3 * vf - 3 * vf * vf * vf,
        c4 = 1 + 3 * vf + vf * vf * vf + 3 * vf * vf;
    final e1 = _calculateEma(period);
    final e2 = _calculateEma(max(1, period ~/ 2));
    final e3 = _calculateEma(max(1, period ~/ 3));
    return c4 * e1 +
        c3 * e2 +
        c2 * e3 +
        c1 * _calculateEma(max(1, period ~/ 4));
  }

  String _detectChandeKrollStop({
    int atrPeriod = 10,
    double mult = 1.5,
    int stopPeriod = 9,
  }) {
    if (_candles.length < atrPeriod + stopPeriod) return 'none';
    final atr = _calculateAtr(atrPeriod);
    // First stop lines
    final sub = _candles.sublist(_candles.length - stopPeriod);
    final hiH = sub.map((c) => c.high).reduce(max);
    final loL = sub.map((c) => c.low).reduce(min);
    final stopLong = hiH - mult * atr;
    final stopShort = loL + mult * atr;
    if (_currentPrice > stopShort) return 'bullish';
    if (_currentPrice < stopLong) return 'bearish';
    return 'none';
  }

  double _calculateAc() {
    // Accelerator = AO - SMA(AO, 5)
    if (_candles.length < 39) return 0;
    final ao = _calculateAo();
    // Approximate SMA of AO using 5 recent bars
    double aoSum = 0;
    for (int i = 0; i < 5; i++) {
      final sub = _candles.sublist(0, _candles.length - i);
      double s5 = 0, s34 = 0;
      for (int j = sub.length - 5; j < sub.length; j++) {
        s5 += (sub[j].high + sub[j].low) / 2;
      }
      for (int j = sub.length - 34; j < sub.length; j++) {
        s34 += (sub[j].high + sub[j].low) / 2;
      }
      aoSum += s5 / 5 - s34 / 34;
    }
    return ao - aoSum / 5;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TREND INDICATORS EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectSuperTrend({int period = 10, double mult = 3.0}) {
    if (_candles.length < period + 1) return 'none';
    final atr = _calculateAtr(period);
    double upB = 0, dnB = 0;
    bool bull = true;
    for (
      int i = max(1, _candles.length - period * 2);
      i < _candles.length;
      i++
    ) {
      final hl2 = (_candles[i].high + _candles[i].low) / 2;
      final up = hl2 + mult * atr, dn = hl2 - mult * atr;
      upB = (up < upB || _candles[i - 1].close > upB) ? up : upB;
      dnB = (dn > dnB || _candles[i - 1].close < dnB) ? dn : dnB;
      bull = _candles[i].close > upB
          ? true
          : _candles[i].close < dnB
          ? false
          : bull;
    }
    return bull ? 'bullish' : 'bearish';
  }

  String _detectIchimoku() {
    if (_candles.length < 52) return 'none';
    double hH, lL;
    hH = _candles
        .sublist(max(0, _candles.length - 9))
        .map((c) => c.high)
        .reduce(max);
    lL = _candles
        .sublist(max(0, _candles.length - 9))
        .map((c) => c.low)
        .reduce(min);
    final tenkan = (hH + lL) / 2;
    hH = _candles
        .sublist(max(0, _candles.length - 26))
        .map((c) => c.high)
        .reduce(max);
    lL = _candles
        .sublist(max(0, _candles.length - 26))
        .map((c) => c.low)
        .reduce(min);
    final kijun = (hH + lL) / 2;
    hH = _candles
        .sublist(max(0, _candles.length - 52))
        .map((c) => c.high)
        .reduce(max);
    lL = _candles
        .sublist(max(0, _candles.length - 52))
        .map((c) => c.low)
        .reduce(min);
    final senkouB = (hH + lL) / 2;
    final senkouA = (tenkan + kijun) / 2;
    final cloudH = max(senkouA, senkouB), cloudL = min(senkouA, senkouB);
    if (_currentPrice > cloudH && tenkan > kijun) return 'strong_bullish';
    if (_currentPrice < cloudL && tenkan < kijun) return 'strong_bearish';
    if (_currentPrice > cloudH) return 'bullish';
    if (_currentPrice < cloudL) return 'bearish';
    return 'in_cloud';
  }

  double _calculateWma(int period) {
    final n = min(period, _candles.length);
    double sum = 0, wt = 0;
    for (int i = 0; i < n; i++) {
      final w = n - i;
      sum += _candles[_candles.length - 1 - i].close * w;
      wt += w;
    }
    return wt > 0 ? sum / wt : _currentPrice;
  }

  double _calculateHma(int period) {
    return 2 * _calculateWma(max(1, period ~/ 2)) - _calculateWma(period);
  }

  double _calculateDema(int p) =>
      2 * _calculateEma(p) - _calculateEma(max(1, p ~/ 2));
  double _calculateTema(int p) =>
      3 * _calculateEma(p) -
      3 * _calculateEma(max(1, p ~/ 2)) +
      _calculateEma(max(1, p ~/ 3));

  double _calculateAlma(int period) {
    // Arnaud Legoux MA: Gaussian filter
    if (_candles.length < period) return _currentPrice;
    const sigma = 6.0, offset = 0.85;
    final m = offset * (period - 1);
    final s = period / sigma;
    double sum = 0, wt = 0;
    for (int i = 0; i < period; i++) {
      final w = exp(-pow(i - m, 2) / (2 * s * s));
      sum += _candles[_candles.length - period + i].close * w;
      wt += w;
    }
    return wt > 0 ? sum / wt : _currentPrice;
  }

  double _calculateLinearRegression(int period) {
    final n = min(period, _candles.length);
    if (n < 2) return _currentPrice;
    final cl = _candles
        .sublist(_candles.length - n)
        .map((c) => c.close)
        .toList();
    double sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (int i = 0; i < n; i++) {
      sx += i;
      sy += cl[i];
      sxy += i * cl[i];
      sx2 += i * i;
    }
    final d = n * sx2 - sx * sx;
    if (d == 0) return _currentPrice;
    return (sy - (n * sxy - sx * sy) / d * sx) / n +
        (n * sxy - sx * sy) / d * (n - 1);
  }

  Map<String, double> _calculateAroon(int period) {
    final n = min(period, _candles.length);
    final sub = _candles.sublist(_candles.length - n);
    int hi = 0, li = 0;
    for (int i = 0; i < sub.length; i++) {
      if (sub[i].high >= sub[hi].high) hi = i;
      if (sub[i].low <= sub[li].low) li = i;
    }
    return {'up': (hi / (n - 1)) * 100, 'down': (li / (n - 1)) * 100};
  }

  Map<String, double> _calculateVortex(int period) {
    final n = min(period, _candles.length - 1);
    if (n < 1) return {'plus': 1.0, 'minus': 1.0};
    double vp = 0, vm = 0, tr = 0;
    for (int i = _candles.length - n; i < _candles.length; i++) {
      final c = _candles[i], p = _candles[i - 1];
      vp += (c.high - p.low).abs();
      vm += (c.low - p.high).abs();
      tr += max(c.high, p.close) - min(c.low, p.close);
    }
    return tr > 0
        ? {'plus': vp / tr, 'minus': vm / tr}
        : {'plus': 1.0, 'minus': 1.0};
  }

  String _detectAlligator() {
    if (_candles.length < 13) return 'sleeping';
    final jaw = _calculateEma(min(13, _candles.length)),
        teeth = _calculateEma(min(8, _candles.length)),
        lips = _calculateEma(min(5, _candles.length));
    if (lips > teeth && teeth > jaw) return 'bullish';
    if (lips < teeth && teeth < jaw) return 'bearish';
    return 'sleeping';
  }

  double _calculateAo() {
    if (_candles.length < 34) return 0;
    double s5 = 0, s34 = 0;
    for (int i = _candles.length - 5; i < _candles.length; i++) {
      s5 += (_candles[i].high + _candles[i].low) / 2;
    }
    for (int i = _candles.length - 34; i < _candles.length; i++) {
      s34 += (_candles[i].high + _candles[i].low) / 2;
    }
    return s5 / 5 - s34 / 34;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // OSCILLATORS EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  double _calculateUltimateOscillator() {
    if (_candles.length < 29) return 50;
    double bp7 = 0, tr7 = 0, bp14 = 0, tr14 = 0, bp28 = 0, tr28 = 0;
    final n = min(28, _candles.length - 1);
    for (int i = _candles.length - n; i < _candles.length; i++) {
      final c = _candles[i], p = _candles[i - 1];
      final bp = c.close - min(c.low, p.close),
          tr = max(c.high, p.close) - min(c.low, p.close);
      final pos = _candles.length - i;
      if (pos <= 7) {
        bp7 += bp;
        tr7 += tr;
      }
      if (pos <= 14) {
        bp14 += bp;
        tr14 += tr;
      }
      bp28 += bp;
      tr28 += tr;
    }
    return 100 *
        (4 * (tr7 > 0 ? bp7 / tr7 : 0.5) +
            2 * (tr14 > 0 ? bp14 / tr14 : 0.5) +
            (tr28 > 0 ? bp28 / tr28 : 0.5)) /
        7;
  }

  double _calculateTsi() {
    if (_candles.length < 26) return 0;
    final n = min(25, _candles.length - 1);
    double ema1 = 0, aem1 = 0;
    final alpha = 2.0 / 14;
    for (int i = _candles.length - n; i < _candles.length; i++) {
      final m = _candles[i].close - _candles[i - 1].close;
      ema1 = alpha * m + (1 - alpha) * ema1;
      aem1 = alpha * m.abs() + (1 - alpha) * aem1;
    }
    return aem1 > 0 ? 100 * ema1 / aem1 : 0;
  }

  double _calculateFisherTransform(int period) {
    final n = min(period, _candles.length);
    final sub = _candles.sublist(_candles.length - n);
    final hi = sub.map((c) => c.high).reduce(max),
        lo = sub.map((c) => c.low).reduce(min);
    final range = hi - lo;
    if (range < 0.0001) return 0;
    final v = (2 * ((_currentPrice - lo) / range) - 1).clamp(-0.999, 0.999);
    return 0.5 * log((1 + v) / (1 - v));
  }

  double _calculateCmo(int period) {
    final n = min(period, _candles.length - 1);
    double su = 0, sd = 0;
    for (int i = _candles.length - n; i < _candles.length; i++) {
      final d = _candles[i].close - _candles[i - 1].close;
      if (d > 0) {
        su += d;
      } else {
        sd += d.abs();
      }
    }
    return (su + sd) > 0 ? 100 * (su - sd) / (su + sd) : 0;
  }

  double _calculateRvi(int period) {
    if (_candles.length < period + 3) return 0;
    double ns = 0, ds = 0;
    for (int i = _candles.length - period; i < _candles.length - 3; i++) {
      ns +=
          (_candles[i].close - _candles[i].open) +
          2 * (_candles[i + 1].close - _candles[i + 1].open) +
          2 * (_candles[i + 2].close - _candles[i + 2].open) +
          (_candles[i + 3].close - _candles[i + 3].open);
      ds +=
          (_candles[i].high - _candles[i].low) +
          2 * (_candles[i + 1].high - _candles[i + 1].low) +
          2 * (_candles[i + 2].high - _candles[i + 2].low) +
          (_candles[i + 3].high - _candles[i + 3].low);
    }
    return ds > 0.0001 ? ns / ds : 0;
  }

  double _calculateElderBullPower(int p) =>
      _candles.last.high - _calculateEma(min(p, _candles.length));
  double _calculateElderBearPower(int p) =>
      _candles.last.low - _calculateEma(min(p, _candles.length));
  double _calculateElderForceIndex() => _candles.length > 1
      ? (_candles.last.close - _candles[_candles.length - 2].close) *
            _candles.last.volume
      : 0;
  double _calculateBop() {
    final c = _candles.last, r = c.high - c.low;
    return r > 0 ? (c.close - c.open) / r : 0;
  }

  double _calculatePpo() {
    final e26 = _calculateEma(min(26, _candles.length));
    return e26 > 0
        ? (_calculateEma(min(12, _candles.length)) - e26) / e26 * 100
        : 0;
  }

  double _calculateTrix(int p) {
    final e = _calculateEma(p), e2 = _calculateEma(max(1, p ~/ 2));
    return e2 > 0 ? (e - e2) / e2 * 100 : 0;
  }

  double _calculateKst() =>
      _calculateRoc(10) +
      _calculateRoc(15) * 2 +
      _calculateRoc(20) * 3 +
      _calculateRoc(30) * 4;

  double _calculateDpo(int period) {
    // DPO = Close[i] - SMA(period)[i - period/2 - 1]
    if (_candles.length < period + 1) return 0;
    final shift = period ~/ 2 + 1;
    final refIdx = _candles.length - 1 - shift;
    if (refIdx < 0) return 0;
    double sma = 0;
    final n = min(period, refIdx + 1);
    for (int i = refIdx - n + 1; i <= refIdx; i++) {
      sma += _candles[i].close;
    }
    return _candles[refIdx].close - sma / n;
  }

  double _calculateConnorsRsi() {
    // Connors RSI = (RSI(3) + RSI(streak,2) + percentRank(ROC,100)) / 3
    final rsi3 = _calculateRsi(3);
    final roc = _calculateRoc(1);
    final pr = _candles.length > 100
        ? ((_currentPrice - _candles[_candles.length - 100].close) /
                  _candles[_candles.length - 100].close *
                  100)
              .clamp(0, 100)
        : 50;
    return (rsi3 + (roc > 0 ? 100 : 0) + pr) / 3;
  }

  double _calculateStc() {
    // Schaff Trend Cycle: MACD smoothed by stochastic
    final macd = _calculateFullMacd()['macd']!;
    final rsi = _calculateRsi(14);
    return (macd > 0 && rsi > 50)
        ? 75
        : (macd < 0 && rsi < 50)
        ? 25
        : 50;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VOLATILITY EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectKeltnerChannel() {
    final mid = _calculateEma(min(20, _candles.length)),
        atr = _calculateAtr(10);
    if (_currentPrice > mid + 2 * atr) return 'above_upper';
    if (_currentPrice < mid - 2 * atr) return 'below_lower';
    if (_currentPrice > mid) return 'upper_half';
    return 'lower_half';
  }

  String _detectDonchianChannel(int period) {
    final n = min(period, _candles.length);
    final hi = _candles
        .sublist(_candles.length - n)
        .map((c) => c.high)
        .reduce(max);
    final lo = _candles
        .sublist(_candles.length - n)
        .map((c) => c.low)
        .reduce(min);
    if (_currentPrice >= hi) return 'at_upper';
    if (_currentPrice <= lo) return 'at_lower';
    return 'inside';
  }

  double _calculateMassIndex(int period) {
    if (_candles.length < period + 9) return 25;
    double mi = 0,
        e1 =
            (_candles[_candles.length - period - 9].high -
            _candles[_candles.length - period - 9].low),
        e2 = e1;
    const alpha = 2.0 / 10;
    for (int i = _candles.length - period; i < _candles.length; i++) {
      e1 = alpha * (_candles[i].high - _candles[i].low) + (1 - alpha) * e1;
      e2 = alpha * e1 + (1 - alpha) * e2;
      if (e2 > 0) mi += e1 / e2;
    }
    return mi;
  }

  double _calculateHistoricalVolatility(int period) {
    if (_candles.length < period + 1) return 0;
    final rets = <double>[];
    for (int i = _candles.length - period; i < _candles.length; i++) {
      rets.add(log(_candles[i].close / _candles[i - 1].close));
    }
    final mean = rets.reduce((a, b) => a + b) / rets.length;
    double v = 0;
    for (final r in rets) {
      v += pow(r - mean, 2).toDouble();
    }
    return sqrt(v / rets.length) * sqrt(252) * 100;
  }

  double _calculateUlcerIndex(int period) {
    final n = min(period, _candles.length);
    double maxC = _candles.last.close, sq = 0;
    for (final c in _candles.sublist(_candles.length - n)) {
      maxC = max(maxC, c.close);
      sq += pow((c.close - maxC) / maxC * 100, 2).toDouble();
    }
    return sqrt(sq / n);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VOLUME EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  double _calculateEmv(int period) {
    final n = min(period, _candles.length - 1);
    double s = 0;
    for (int i = _candles.length - n; i < _candles.length; i++) {
      final c = _candles[i], p = _candles[i - 1];
      final dist = ((c.high + c.low) / 2) - ((p.high + p.low) / 2);
      final hl = c.high - c.low;
      final box = hl > 0 ? (c.volume / 1e8) / hl : 0;
      s += box > 0 ? dist / box : 0;
    }
    return s / n;
  }

  double _calculatePvt() {
    if (_candles.length < 2) return 0;
    double pvt = 0;
    for (int i = 1; i < _candles.length; i++) {
      pvt +=
          (_candles[i].close - _candles[i - 1].close) /
          _candles[i - 1].close *
          _candles[i].volume;
    }
    return pvt;
  }

  double _calculateKlinger() {
    if (_candles.length < 15) return 0;
    double kvo = 0;
    for (int i = 1; i < _candles.length; i++) {
      kvo +=
          _candles[i].volume *
          (_candles[i].close > _candles[i - 1].close ? 1.0 : -1.0);
    }
    return kvo * 2 / (34 + 1) - kvo * 2 / (55 + 1);
  }

  double _calculateNvi() {
    double nvi = 1000;
    for (int i = 1; i < _candles.length; i++) {
      if (_candles[i].volume < _candles[i - 1].volume) {
        nvi +=
            nvi *
            (_candles[i].close - _candles[i - 1].close) /
            _candles[i - 1].close;
      }
    }
    return nvi;
  }

  double _calculatePvi() {
    double pvi = 1000;
    for (int i = 1; i < _candles.length; i++) {
      if (_candles[i].volume > _candles[i - 1].volume) {
        pvi +=
            pvi *
            (_candles[i].close - _candles[i - 1].close) /
            _candles[i - 1].close;
      }
    }
    return pvi;
  }

  double _calculateVolumeOscillator(int fast, int slow) {
    if (_candles.length < slow) return 0;
    double sf = 0, ss = 0;
    for (int i = _candles.length - fast; i < _candles.length; i++) {
      sf += _candles[i].volume;
    }
    for (int i = _candles.length - slow; i < _candles.length; i++) {
      ss += _candles[i].volume;
    }
    final avgFast = sf / fast, avgSlow = ss / slow;
    return avgSlow > 0 ? (avgFast - avgSlow) / avgSlow * 100 : 0;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRICE ACTION EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectFractals() {
    if (_candles.length < 5) return 'none';
    final i = _candles.length - 3;
    final c = _candles[i];
    if (c.high > _candles[i - 1].high &&
        c.high > _candles[i - 2].high &&
        c.high > _candles[i + 1].high &&
        c.high > _candles[i + 2].high) {
      return 'bearish_fractal';
    }
    if (c.low < _candles[i - 1].low &&
        c.low < _candles[i - 2].low &&
        c.low < _candles[i + 1].low &&
        c.low < _candles[i + 2].low) {
      return 'bullish_fractal';
    }
    return 'none';
  }

  String _detectInsideBar() {
    if (_candles.length < 2) return 'none';
    final c = _candles.last, p = _candles[_candles.length - 2];
    return (c.high < p.high && c.low > p.low)
        ? (c.close > c.open ? 'bullish' : 'bearish')
        : 'none';
  }

  String _detectOutsideBar() {
    if (_candles.length < 2) return 'none';
    final c = _candles.last, p = _candles[_candles.length - 2];
    return (c.high > p.high && c.low < p.low)
        ? (c.close > c.open ? 'bullish' : 'bearish')
        : 'none';
  }

  String _detectFakeyPattern() {
    if (_candles.length < 4) return 'none';
    final c0 = _candles.last,
        c1 = _candles[_candles.length - 2],
        c2 = _candles[_candles.length - 3];
    if (!(c1.high < c2.high && c1.low > c2.low)) return 'none';
    if (c0.high > c2.high && c0.close < c2.high) return 'bearish';
    if (c0.low < c2.low && c0.close > c2.low) return 'bullish';
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ICT EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectPowerOfThree() {
    if (_candles.length < 15) return 'none';
    final sweep = _detectLiquiditySweep(), exp = _detectExpansion();
    if (sweep == 'sell_side' && exp == 'bullish') return 'distribution_bullish';
    if (sweep == 'buy_side' && exp == 'bearish') return 'distribution_bearish';
    if (_calculateAtr(5) < _calculateAtr(14) * 0.7) return 'accumulation';
    return 'none';
  }

  String _detectTurtleSoup() {
    if (_candles.length < 22) return 'none';
    final ref = _candles.sublist(_candles.length - 22, _candles.length - 2);
    final rH = ref.map((c) => c.high).reduce(max),
        rL = ref.map((c) => c.low).reduce(min);
    final l2 = _candles.sublist(_candles.length - 2);
    if (l2.any((c) => c.high > rH) && _currentPrice < rH) return 'bearish';
    if (l2.any((c) => c.low < rL) && _currentPrice > rL) return 'bullish';
    return 'none';
  }

  String _detectCisd() {
    if (_candles.length < 5) return 'none';
    final c = _candles.last, body = (c.close - c.open).abs();
    if (body < _avgBodySize() * 2.5) return 'none';
    final sp = _swingPoints(lookback: 10, str: 1);
    if (c.close > c.open && sp['h']!.isNotEmpty && c.close > sp['h']!.last) {
      return 'bullish';
    }
    if (c.close < c.open && sp['l']!.isNotEmpty && c.close < sp['l']!.last) {
      return 'bearish';
    }
    return 'none';
  }

  String _detectConsequentEncroachment() {
    if (_candles.length < 5) return 'none';
    for (int i = _candles.length - 1; i >= 2; i--) {
      final c1 = _candles[i - 2], c3 = _candles[i];
      if (c3.low > c1.high) {
        final ce = (c3.low + c1.high) / 2;
        if ((_currentPrice - ce).abs() < (c3.low - c1.high) * 0.1) {
          return 'bullish_ce';
        }
      }
      if (c3.high < c1.low) {
        final ce = (c1.low + c3.high) / 2;
        if ((_currentPrice - ce).abs() < (c1.low - c3.high) * 0.1) {
          return 'bearish_ce';
        }
      }
    }
    return 'none';
  }

  String _detectInducement() {
    // Inducement: intermediate swing high/low used to draw liquidity before BOS
    if (_candles.length < 15) return 'none';
    final sp = _swingPoints(lookback: 15, str: 1);
    final h = sp['h']!, l = sp['l']!;
    if (h.length >= 2 && l.isNotEmpty) {
      // Inducement high: intermediate high between two lows (draw liquidity above)
      if (h.last < h[h.length - 2] &&
          (_currentPrice - h.last).abs() < _calculateAtr(5)) {
        return 'inducement_high';
      }
    }
    if (l.length >= 2 && h.isNotEmpty) {
      if (l.last > l[l.length - 2] &&
          (_currentPrice - l.last).abs() < _calculateAtr(5)) {
        return 'inducement_low';
      }
    }
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WYCKOFF PHASES EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectWyckoffPhase() {
    if (_candles.length < 30) return 'none';
    final sp = _swingPoints(lookback: 40, str: 2);
    final highs = sp['h']!, lows = sp['l']!;
    if (highs.length < 2 || lows.length < 2) return 'none';
    final isDown =
        highs.last < highs[highs.length - 2] &&
        lows.last < lows[lows.length - 2];
    final isUp =
        highs.last > highs[highs.length - 2] &&
        lows.last > lows[lows.length - 2];
    final vr = (_analyzeVolumeProfile()['ratio'] as double);
    final atrR = _calculateAtr(5) / _calculateAtr(20);
    final lastClose = _candles.last.close,
        lastHL = (_candles.last.high + _candles.last.low) / 2;
    if (isDown && vr > 2.0 && atrR > 1.5 && lastClose > lastHL) return 'sc';
    if (isDown && lastClose > _candles[_candles.length - 3].close * 1.005) {
      return 'ar';
    }
    if (_detectWyckoffSpring() == 'bullish') return 'spring_test';
    if (!isDown && isUp && vr > 1.5) return 'sos';
    if (isUp && atrR < 0.7) return 'lps';
    if (isUp && vr > 2.0 && atrR > 1.5 && lastClose < lastHL) return 'bc';
    if (_detectWyckoffUpthrust() == 'bearish') return 'utad';
    if (vr < 0.7) return 'st';
    if (isDown && vr > 1.2) return 'ps';
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MARKET PROFILE
  // ══════════════════════════════════════════════════════════════════════════

  Map<String, double> _calculateMarketProfile() {
    final lb = min(50, _candles.length);
    final sub = _candles.sublist(_candles.length - lb);
    final hi = sub.map((c) => c.high).reduce(max),
        lo = sub.map((c) => c.low).reduce(min);
    final range = hi - lo;
    if (range < 0.0001) {
      return {'poc': _currentPrice, 'vah': _currentPrice, 'val': _currentPrice};
    }
    final buckets = List<double>.filled(10, 0);
    for (final c in sub) {
      buckets[((c.close - lo) / range * 9).round().clamp(0, 9)] += c.volume;
    }
    int pocB = 0;
    for (int i = 1; i < 10; i++) {
      if (buckets[i] > buckets[pocB]) pocB = i;
    }
    final poc = lo + pocB / 9 * range;
    final tot = buckets.reduce((a, b) => a + b);
    double acc = buckets[pocB];
    int lB = pocB, hB = pocB;
    while (acc < tot * 0.7 && (lB > 0 || hB < 9)) {
      final aH = hB < 9 ? buckets[hB + 1] : 0,
          aL = lB > 0 ? buckets[lB - 1] : 0;
      if (aH >= aL && hB < 9) {
        hB++;
        acc += buckets[hB];
      } else if (lB > 0) {
        lB--;
        acc += buckets[lB];
      } else
        hB++;
    }
    return {'poc': poc, 'vah': lo + hB / 9 * range, 'val': lo + lB / 9 * range};
  }

  String _detectMarketProfileZone() {
    final mp = _calculateMarketProfile();
    if (_currentPrice > mp['vah']!) return 'above_vah';
    if (_currentPrice < mp['val']!) return 'below_val';
    if ((_currentPrice - mp['poc']!).abs() < _calculateAtr(5)) return 'at_poc';
    return _currentPrice > mp['poc']! ? 'above_poc' : 'below_poc';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PIVOT SYSTEMS EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectCamarillaPivot() {
    if (_candles.length < 2) return 'none';
    final c = _candles[_candles.length - 2], r = c.high - c.low;
    final h4 = c.close + r * 1.1 / 2,
        h3 = c.close + r * 1.1 / 4,
        l3 = c.close - r * 1.1 / 4,
        l4 = c.close - r * 1.1 / 2;
    if (_currentPrice > h4) return 'above_h4';
    if (_currentPrice < l4) return 'below_l4';
    if (_currentPrice > h3) return 'above_h3';
    if (_currentPrice < l3) return 'below_l3';
    return 'inside';
  }

  String _detectWoodiePivot() {
    if (_candles.length < 2) return 'none';
    final c = _candles[_candles.length - 2];
    final p = (c.high + c.low + 2 * c.close) / 4,
        r1 = 2 * p - c.low,
        s1 = 2 * p - c.high;
    if (_currentPrice > r1) return 'above_r1';
    if (_currentPrice < s1) return 'below_s1';
    return _currentPrice > p ? 'above_p' : 'below_p';
  }

  String _detectFibPivot() {
    if (_candles.length < 2) return 'none';
    final c = _candles[_candles.length - 2];
    final p = (c.high + c.low + c.close) / 3, r = c.high - c.low;
    final r2 = p + 0.618 * r,
        r1 = p + 0.382 * r,
        s1 = p - 0.382 * r,
        s2 = p - 0.618 * r;
    if (_currentPrice > r2) return 'above_r2';
    if (_currentPrice < s2) return 'below_s2';
    if (_currentPrice > r1) return 'above_r1';
    if (_currentPrice < s1) return 'below_s1';
    return _currentPrice > p ? 'above_p' : 'below_p';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CHART PATTERNS EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectBroadeningWedge() {
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: 30, str: 2);
    final h = sp['h']!, l = sp['l']!;
    if (h.length < 2 || l.length < 2) return 'none';
    if (h.last > h[h.length - 2] && l.last < l[l.length - 2]) {
      if (_currentPrice > h.last) return 'bearish';
      if (_currentPrice < l.last) return 'bullish';
      return 'active';
    }
    return 'none';
  }

  String _detectIslandReversal() {
    if (_candles.length < 6) return 'none';
    final atr = _calculateAtr(14);
    for (int i = 2; i < _candles.length - 2; i++) {
      if (_candles[i].low > _candles[i - 1].high + atr * 0.5 &&
          _candles[i + 1].high < _candles[i].low - atr * 0.5) {
        return 'bearish';
      }
      if (_candles[i].high < _candles[i - 1].low - atr * 0.5 &&
          _candles[i + 1].low > _candles[i].high + atr * 0.5) {
        return 'bullish';
      }
    }
    return 'none';
  }

  String _detectDiamondPattern() {
    if (_candles.length < 30) return 'none';
    final sp = _swingPoints(lookback: 30, str: 2);
    final h = sp['h']!, l = sp['l']!;
    if (h.length < 4 || l.length < 4) return 'none';
    if (h[h.length - 3] > h[h.length - 4] &&
        l[l.length - 3] < l[l.length - 4] &&
        h.last < h[h.length - 2] &&
        l.last > l[l.length - 2]) {
      if (_currentPrice > h.last) return 'bullish';
      if (_currentPrice < l.last) return 'bearish';
    }
    return 'none';
  }

  String _detectRoundingPattern(bool bottom) {
    if (_candles.length < 20) return 'none';
    final n = min(20, _candles.length);
    final sub = _candles.sublist(_candles.length - n);
    final first = sub.first.close, last = sub.last.close;
    final extreme = bottom
        ? sub.map((c) => c.low).reduce(min)
        : sub.map((c) => c.high).reduce(max);
    if (bottom &&
        extreme < first * 0.998 &&
        extreme < last * 0.998 &&
        _currentPrice > last) {
      return 'bullish';
    }
    if (!bottom &&
        extreme > first * 1.002 &&
        extreme > last * 1.002 &&
        _currentPrice < last) {
      return 'bearish';
    }
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TIME ANALYSIS EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectOpeningGap() {
    if (_candles.length < 2) return 'none';
    final atr = _calculateAtr(14);
    final gap = _candles.last.open - _candles[_candles.length - 2].close;
    if (gap > atr * 0.5) return 'gap_up';
    if (gap < -atr * 0.5) return 'gap_down';
    return 'none';
  }

  String _detectFibTimeZone() {
    const fibs = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
    return fibs.contains(_candles.length % 90) ? 'fib_zone' : 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GANN EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectGannFan() {
    if (_candles.length < 10) return 'none';
    final n = min(10, _candles.length - 1);
    final pips = (_currentPrice - _candles[_candles.length - 1 - n].low) / n;
    final atr = _calculateAtr(14);
    if (pips.abs() >= atr * 0.8 && pips.abs() <= atr * 1.2) return 'on_1x1';
    if (pips > atr * 1.2) return 'above_1x1';
    if (pips > 0) return 'below_1x1';
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEMARK EXTENDED
  // ══════════════════════════════════════════════════════════════════════════

  String _detectTdCombo() {
    if (_candles.length < 14) return 'none';
    int up = 0, dn = 0;
    for (int i = 2; i < _candles.length; i++) {
      if (_candles[i].close > _candles[i - 2].close &&
          _candles[i].close > _candles[i - 1].close) {
        up++;
      } else {
        up = 0;
      }
      if (_candles[i].close < _candles[i - 2].close &&
          _candles[i].close < _candles[i - 1].close) {
        dn++;
      } else {
        dn = 0;
      }
    }
    if (up >= 13) return 'sell_signal';
    if (dn >= 13) return 'buy_signal';
    return 'none';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Z-SCORE / STATISTICAL
  // ══════════════════════════════════════════════════════════════════════════

  double _calculateZScore(int period) {
    final n = min(period, _candles.length);
    final cl = _candles
        .sublist(_candles.length - n)
        .map((c) => c.close)
        .toList();
    final mean = cl.reduce((a, b) => a + b) / cl.length;
    double v = 0;
    for (final c in cl) {
      v += pow(c - mean, 2).toDouble();
    }
    final sd = sqrt(v / cl.length);
    return sd > 0 ? (_currentPrice - mean) / sd : 0;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VOLATILITY / PRICE ACTION EXTRAS
  // ══════════════════════════════════════════════════════════════════════════

  String _detectStarcBands() {
    // STARC = SMA(5) ± 1.5 * ATR(15)
    final mid = _calculateSma(min(5, _candles.length));
    final atr = _calculateAtr(min(15, _candles.length));
    if (_currentPrice > mid + 1.5 * atr) return 'above_upper';
    if (_currentPrice < mid - 1.5 * atr) return 'below_lower';
    return _currentPrice > mid ? 'upper_half' : 'lower_half';
  }

  double _calculateChaikinVolatility(int period) {
    // % change in (H-L) EMA over period
    if (_candles.length < period * 2) return 0;
    double ema1 = 0, ema2 = 0;
    final alpha = 2.0 / (period + 1);
    final n = min(period * 2, _candles.length);
    for (int i = _candles.length - n; i < _candles.length - period; i++) {
      ema2 = alpha * (_candles[i].high - _candles[i].low) + (1 - alpha) * ema2;
    }
    for (int i = _candles.length - period; i < _candles.length; i++) {
      ema1 = alpha * (_candles[i].high - _candles[i].low) + (1 - alpha) * ema1;
    }
    return ema2 > 0 ? (ema1 - ema2) / ema2 * 100 : 0;
  }

  String _detectNr4() {
    // Narrow Range 4: current bar has the smallest range of last 4 bars
    if (_candles.length < 4) return 'none';
    final ranges = List.generate(
      4,
      (i) =>
          _candles[_candles.length - 1 - i].high -
          _candles[_candles.length - 1 - i].low,
    );
    return (ranges[0] <= ranges[1] &&
            ranges[0] <= ranges[2] &&
            ranges[0] <= ranges[3])
        ? 'nr4'
        : 'none';
  }

  String _detectIdnr4() {
    // IDNR4 = Inside Bar + NR4
    if (_detectInsideBar() == 'none') return 'none';
    return _detectNr4() == 'nr4' ? 'idnr4' : 'none';
  }

  String _detectInitialBalance() {
    // Initial Balance: first 2 candles of session approximate the range
    if (_candles.length < 3) return 'none';
    final ibH = max(_candles[0].high, _candles[1].high);
    final ibL = min(_candles[0].low, _candles[1].low);
    if (_currentPrice > ibH) return 'above_ibh';
    if (_currentPrice < ibL) return 'below_ibl';
    return 'inside_ib';
  }

  String _detectSilverBullet() {
    // ICT Silver Bullet: 3 specific windows (10-11, 14-15, 15-16 NY)
    // Using available time info from _detectTimeSession
    final ts = _detectTimeSession('new_york');
    if (ts != 'new_york') return 'none';
    final now = DateTime.now().toUtc().subtract(const Duration(hours: 4)); // NY
    final h = now.hour, m = now.minute;
    if ((h == 10 && m < 0) || (h == 10 && m >= 0 && h < 11)) {
      return 'window_10_11';
    }
    if (h == 14 || (h == 15 && m < 0)) return 'window_14_15';
    if (h == 15) return 'window_15_16';
    return 'none';
  }

  String _detectInstitutionalCandle() {
    // Large body candle ≥ 2.5x average body
    final c = _candles.last, body = (c.close - c.open).abs();
    if (body < _avgBodySize() * 2.5) return 'none';
    return c.close > c.open ? 'bullish_institutional' : 'bearish_institutional';
  }

  String _detectReaccumulation() {
    // Reaccumulation: consolidation within uptrend (pullback with low volume)
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: 20, str: 2);
    final h = sp['h']!, l = sp['l']!;
    if (h.length < 2 || l.length < 2) return 'none';
    final isUp = h.last > h[h.length - 2] && l.last > l[l.length - 2];
    final vr = (_analyzeVolumeProfile()['ratio'] as double);
    final atrR = _calculateAtr(5) / _calculateAtr(14);
    return isUp && vr < 0.8 && atrR < 0.7 ? 'reaccumulation' : 'none';
  }

  String _detectRedistribution() {
    // Redistribution: consolidation within downtrend
    if (_candles.length < 20) return 'none';
    final sp = _swingPoints(lookback: 20, str: 2);
    final h = sp['h']!, l = sp['l']!;
    if (h.length < 2 || l.length < 2) return 'none';
    final isDown = h.last < h[h.length - 2] && l.last < l[l.length - 2];
    final vr = (_analyzeVolumeProfile()['ratio'] as double);
    final atrR = _calculateAtr(5) / _calculateAtr(14);
    return isDown && vr < 0.8 && atrR < 0.7 ? 'redistribution' : 'none';
  }

  String _detectPipePattern(bool top) {
    // Pipe Top/Bottom: two adjacent candles with nearly equal high (top) or low (bottom)
    if (_candles.length < 2) return 'none';
    final c = _candles.last, p = _candles[_candles.length - 2];
    final atr = _calculateAtr(14), thresh = atr * 0.15;
    if (top && (c.high - p.high).abs() < thresh) return 'pipe_top';
    if (!top && (c.low - p.low).abs() < thresh) return 'pipe_bottom';
    return 'none';
  }

  String _detectBumpAndRun() {
    // Bump: steep acceleration (large range), Run: reversal back to trend line
    if (_candles.length < 25) return 'none';
    final lead = _candles.sublist(_candles.length - 25, _candles.length - 10);
    final bump = _candles.sublist(_candles.length - 10, _candles.length - 2);
    final atrLead =
        lead.map((c) => c.high - c.low).reduce((a, b) => a + b) / lead.length;
    final atrBump =
        bump.map((c) => c.high - c.low).reduce((a, b) => a + b) / bump.length;
    if (atrBump < atrLead * 2) return 'none';
    // Run: price reverting toward trend line
    final leadAvg =
        lead.map((c) => c.close).reduce((a, b) => a + b) / lead.length;
    if (_currentPrice < leadAvg && bump.last.close < bump.first.close) {
      return 'bearish_run';
    }
    if (_currentPrice > leadAvg && bump.last.close > bump.first.close) {
      return 'bullish_run';
    }
    return 'none';
  }

  String _detectDemarkPivot() {
    if (_candles.length < 2) return 'none';
    final c = _candles[_candles.length - 2];
    double x;
    if (c.close < c.open) {
      x = c.high + 2 * c.low + c.close;
    } else if (c.close > c.open)
      x = 2 * c.high + c.low + c.close;
    else
      x = c.high + c.low + 2 * c.close;
    final p = x / 4, r1 = x / 2 - c.low, s1 = x / 2 - c.high;
    if (_currentPrice > r1) return 'above_r1';
    if (_currentPrice < s1) return 'below_s1';
    return _currentPrice > p ? 'above_p' : 'below_p';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // QUANTITATIVE / STATISTICAL
  // ══════════════════════════════════════════════════════════════════════════

  double _calculateHurstExponent() {
    if (_candles.length < 20) return 0.5;
    final n = min(40, _candles.length);
    final prices = _candles
        .sublist(_candles.length - n)
        .map((c) => c.close)
        .toList();
    final rets = <double>[];
    for (int i = 1; i < prices.length; i++) {
      rets.add(prices[i] - prices[i - 1]);
    }
    if (rets.isEmpty) return 0.5;
    final mean = rets.reduce((a, b) => a + b) / rets.length;
    double cum = 0;
    final cumDev = <double>[];
    for (final r in rets) {
      cum += r - mean;
      cumDev.add(cum);
    }
    final R = cumDev.reduce(max) - cumDev.reduce(min);
    double variance = 0;
    for (final r in rets) {
      variance += pow(r - mean, 2).toDouble();
    }
    final S = sqrt(variance / rets.length);
    if (S < 1e-10 || R <= 0) return 0.5;
    return (log(R / S) / log(rets.length.toDouble())).clamp(0.0, 1.0);
  }

  String _detectEntropyAnalysis() {
    if (_candles.length < 10) return 'none';
    final n = min(30, _candles.length - 1);
    int up = 0, dn = 0, flat = 0;
    for (int i = _candles.length - n; i < _candles.length - 1; i++) {
      final d = _candles[i + 1].close - _candles[i].close;
      if (d > 0.00005) {
        up++;
      } else if (d < -0.00005)
        dn++;
      else
        flat++;
    }
    final total = (up + dn + flat).toDouble();
    if (total == 0) return 'none';
    double entropy = 0;
    for (final cnt in [up, dn, flat]) {
      if (cnt > 0) {
        final p = cnt / total;
        entropy -= p * log(p);
      }
    }
    final norm = entropy / log(3);
    if (norm > 0.95) return 'high_entropy';
    if (norm < 0.60) return 'low_entropy';
    return 'medium_entropy';
  }

  String _detectMarketRegime() {
    if (_candles.length < 20) return 'none';
    final adx = _calculateAdxFull(14)['adx']!;
    final rAtr = _calculateAtr(5);
    final lAtr = _calculateAtr(20);
    if (adx > 30 && rAtr > lAtr * 1.2) return 'trending_volatile';
    if (adx > 25) return 'trending';
    if (rAtr < lAtr * 0.7) return 'quiet_ranging';
    return 'ranging';
  }

  String _detectVolatilityRegime() {
    if (_candles.length < 20) return 'none';
    final rAtr = _calculateAtr(5);
    final lAtr = _calculateAtr(20);
    if (rAtr > lAtr * 1.5) return 'high';
    if (rAtr < lAtr * 0.6) return 'low';
    return 'normal';
  }

  String _detectAnomaly() {
    if (_candles.length < 20) return 'none';
    final n = min(20, _candles.length);
    final closes = _candles
        .sublist(_candles.length - n)
        .map((c) => c.close)
        .toList();
    final mean = closes.reduce((a, b) => a + b) / closes.length;
    double variance = 0;
    for (final c in closes) {
      variance += pow(c - mean, 2).toDouble();
    }
    final sd = sqrt(variance / closes.length);
    if (sd < 1e-10) return 'none';
    final z = (_currentPrice - mean) / sd;
    if (z > 2.5) return 'anomaly_up';
    if (z < -2.5) return 'anomaly_down';
    return 'normal';
  }

  String _detectLiquidityVoid() {
    if (_candles.length < 5) return 'none';
    final atr = _calculateAtr(14);
    for (int i = _candles.length - 2; i >= 1; i--) {
      final gapUp = _candles[i].low - _candles[i - 1].high;
      final gapDown = _candles[i - 1].low - _candles[i].high;
      if (gapUp > atr * 3 &&
          _currentPrice >= _candles[i - 1].high &&
          _currentPrice <= _candles[i].low) {
        return 'bullish';
      }
      if (gapDown > atr * 3 &&
          _currentPrice >= _candles[i].high &&
          _currentPrice <= _candles[i - 1].low) {
        return 'bearish';
      }
    }
    return 'none';
  }

  String _detectSpectralCycle() {
    if (_candles.length < 20) return 'none';
    final n = min(30, _candles.length);
    final series = _candles
        .sublist(_candles.length - n)
        .map((c) => c.close)
        .toList();
    final mean = series.reduce((a, b) => a + b) / series.length;
    double maxCorr = 0;
    int domPeriod = 0;
    for (int lag = 2; lag <= min(15, n ~/ 2); lag++) {
      double corr = 0, denom = 0;
      for (int i = lag; i < series.length; i++) {
        corr += (series[i] - mean) * (series[i - lag] - mean);
        denom += pow(series[i] - mean, 2).toDouble();
      }
      if (denom > 0 && (corr / denom).abs() > maxCorr) {
        maxCorr = (corr / denom).abs();
        domPeriod = lag;
      }
    }
    if (domPeriod <= 0) return 'none';
    if (domPeriod <= 5) return 'short_cycle';
    if (domPeriod <= 10) return 'medium_cycle';
    return 'long_cycle';
  }

  String _detectMonteCarlo() {
    if (_candles.length < 20) return 'none';
    final vol = _calculateAtr(14) / _currentPrice;
    final lb = min(14, _candles.length - 1);
    final drift =
        (_candles.last.close - _candles[_candles.length - 1 - lb].close) /
        _candles[_candles.length - 1 - lb].close /
        lb;
    int upCount = 0;
    for (int s = 0; s < 200; s++) {
      final u1 = _random.nextDouble().clamp(1e-10, 1.0);
      final u2 = _random.nextDouble();
      final z = sqrt(-2 * log(u1)) * cos(2 * pi * u2);
      final fp =
          _currentPrice *
          exp((drift - 0.5 * vol * vol) * 5 + vol * sqrt(5.0) * z);
      if (fp > _currentPrice) upCount++;
    }
    if (upCount > 130) return 'bullish';
    if (upCount < 70) return 'bearish';
    return 'neutral';
  }

  String _detectWaveletTrend() {
    if (_candles.length < 34) return 'none';
    final f = _calculateEma(min(5, _candles.length));
    final m = _calculateEma(min(13, _candles.length));
    final s = _calculateEma(min(34, _candles.length));
    final bull = (f > m ? 1 : 0) + (m > s ? 1 : 0) + (f > s ? 1 : 0);
    if (bull == 3) return 'bullish';
    if (bull == 0) return 'bearish';
    return 'mixed';
  }

  double _detectKellyValue() {
    if (_signalHistory.length < 10) return 0.0;
    int wins = 0;
    for (final sig in _signalHistory) {
      if (sig.status == 'WIN') wins++;
    }
    final total = _signalHistory.length;
    final w = wins / total;
    if (w <= 0 || w >= 1) return 0.0;
    return (w - (1 - w)).clamp(-1.0, 1.0); // simplified Kelly
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BREAK_OF_STRUCTURE / CHANGE_OF_CHARACTER (aliases already defined below)
  // ══════════════════════════════════════════════════════════════════════════

  String _detectBreakOfStructure() {
    final ms = _detectMarketStructure();
    if (ms == 'break_of_structure_bullish') return 'bullish';
    if (ms == 'break_of_structure_bearish') return 'bearish';
    return 'none';
  }

  String _detectChangeOfCharacter() {
    final ms = _detectMarketStructure();
    if (ms == 'change_of_character_bullish') return 'bullish';
    if (ms == 'change_of_character_bearish') return 'bearish';
    return 'none';
  }

  String _detectFibonacci(double level) {
    if (_candles.length < 20) return 'none';

    final recent = _candles.sublist(max(0, _candles.length - 30));
    double swingHigh = recent.map((c) => c.high).reduce(max);
    double swingLow = recent.map((c) => c.low).reduce(min);
    final range = swingHigh - swingLow;
    if (range < 0.0001) return 'none';

    final fibUp = swingLow + range * level;
    final fibDown = swingHigh - range * level;
    final tol = range * 0.05;

    final last = _candles.last;
    final prev = _candles.length > 1 ? _candles[_candles.length - 2] : last;

    if ((_currentPrice - fibUp).abs() < tol &&
        last.close > last.open &&
        last.close > prev.close) {
      return 'bullish_rejection';
    }
    if ((_currentPrice - fibDown).abs() < tol &&
        last.close < last.open &&
        last.close < prev.close) {
      return 'bearish_rejection';
    }
    return 'none';
  }

  String _detectVolumeProfile() {
    final score = (_calculateLiquidityZones()['score'] as double);
    if (score > 65) return 'high_volume_node';
    if (score < 35) return 'low_volume_node';
    return 'neutral';
  }

  String _detectInstitutionalActivity() {
    final volRatio = (_analyzeVolumeProfile()['ratio'] as double);
    final volDelta = _calculateVolumeDelta();
    final cmf = _calculateCmf(20);
    if (volRatio > 1.5 && volDelta > 0 && cmf > 0.05) {
      return 'institutional_buying';
    }
    if (volRatio > 1.5 && volDelta < 0 && cmf < -0.05) {
      return 'institutional_selling';
    }
    return 'none';
  }

  String _detectTimeSession(String session) {
    final hour = DateTime.now().toUtc().hour;
    switch (session) {
      case 'london_newyork_overlap':
        return (hour >= 13 && hour < 17) ? 'active' : 'inactive';
      case 'london':
        return (hour >= 8 && hour < 16) ? 'active' : 'inactive';
      case 'new_york':
        return (hour >= 13 && hour < 22) ? 'active' : 'inactive';
      case 'tokyo':
        return (hour >= 0 && hour < 9) ? 'active' : 'inactive';
      default:
        return 'inactive';
    }
  }

  // RSI Divergence Detection - Extremely powerful reversal indicator
  String _detectRsiDivergence() {
    if (_candles.length < 20) return 'none';

    // Find two recent swing lows and highs in price
    int lookback = min(15, _candles.length - 5);
    List<double> prices = [];
    List<double> rsiValues = [];

    for (int i = _candles.length - lookback; i < _candles.length; i++) {
      prices.add(_candles[i].close);
    }

    // Calculate RSI at multiple points
    for (int i = _candles.length - lookback; i < _candles.length; i++) {
      if (i < 15) {
        rsiValues.add(50.0);
        continue;
      }
      double totalGain = 0.0;
      double totalLoss = 0.0;
      for (int j = i - 13; j <= i; j++) {
        double change = _candles[j].close - _candles[j - 1].close;
        if (change > 0) {
          totalGain += change;
        } else {
          totalLoss -= change;
        }
      }
      double rs = totalLoss == 0
          ? 100.0
          : (totalGain / 14.0) / (totalLoss / 14.0);
      rsiValues.add(100.0 - (100.0 / (1.0 + rs)));
    }

    if (prices.length < 5 || rsiValues.length < 5) return 'none';

    // Compare first half vs second half
    int mid = prices.length ~/ 2;
    double priceFirst = prices.sublist(0, mid).reduce((a, b) => a + b) / mid;
    double priceLast =
        prices.sublist(mid).reduce((a, b) => a + b) / (prices.length - mid);
    double rsiFirst = rsiValues.sublist(0, mid).reduce((a, b) => a + b) / mid;
    double rsiLast =
        rsiValues.sublist(mid).reduce((a, b) => a + b) /
        (rsiValues.length - mid);

    // Bullish divergence: price making lower lows but RSI making higher lows
    if (priceLast < priceFirst && rsiLast > rsiFirst + 3) return 'bullish';

    // Bearish divergence: price making higher highs but RSI making lower highs
    if (priceLast > priceFirst && rsiLast < rsiFirst - 3) return 'bearish';

    return 'none';
  }

  // Candle Pattern Recognition - 12 professional patterns
  String _detectCandlePatterns() {
    if (_candles.length < 3) return 'none';

    final last = _candles[_candles.length - 1];
    final prev = _candles[_candles.length - 2];
    final prev2 = _candles[_candles.length - 3];

    double lastBody = (last.close - last.open).abs();
    double lastRange = last.high - last.low;
    double prevBody = (prev.close - prev.open).abs();

    if (lastRange == 0) return 'none';

    // Doji (indecision - very small body)
    if (lastBody / lastRange < 0.1) return 'doji';

    // Bullish Engulfing
    if (prev.close < prev.open &&
        last.close > last.open &&
        last.open <= prev.close &&
        last.close >= prev.open) {
      return 'bullish_engulfing';
    }

    // Bearish Engulfing
    if (prev.close > prev.open &&
        last.close < last.open &&
        last.open >= prev.close &&
        last.close <= prev.open) {
      return 'bearish_engulfing';
    }

    double lowerWick = min(last.open, last.close) - last.low;
    double upperWick = last.high - max(last.open, last.close);

    // Hammer (bullish reversal)
    if (lowerWick / lastRange > 0.6 &&
        upperWick / lastRange < 0.15 &&
        lastBody / lastRange > 0.1) {
      return 'hammer';
    }

    // Shooting Star (bearish reversal)
    if (upperWick / lastRange > 0.6 &&
        lowerWick / lastRange < 0.15 &&
        lastBody / lastRange > 0.1) {
      return 'shooting_star';
    }

    // Morning Star (3-candle bullish reversal)
    if (prev2.close < prev2.open &&
        prevBody < lastBody * 0.4 &&
        last.close > last.open &&
        last.close > (prev2.open + prev2.close) / 2) {
      return 'morning_star';
    }

    // Evening Star (3-candle bearish reversal)
    if (prev2.close > prev2.open &&
        prevBody < lastBody * 0.4 &&
        last.close < last.open &&
        last.close < (prev2.open + prev2.close) / 2) {
      return 'evening_star';
    }

    // Three White Soldiers
    if (prev2.close > prev2.open &&
        prev.close > prev.open &&
        last.close > last.open &&
        prev.close > prev2.close &&
        last.close > prev.close) {
      return 'three_white_soldiers';
    }

    // Three Black Crows
    if (prev2.close < prev2.open &&
        prev.close < prev.open &&
        last.close < last.open &&
        prev.close < prev2.close &&
        last.close < prev.close) {
      return 'three_black_crows';
    }

    // Pin Bar Bullish
    if (lowerWick / lastRange > 0.65) return 'pin_bar_bullish';

    // Pin Bar Bearish
    if (upperWick / lastRange > 0.65) return 'pin_bar_bearish';

    return 'none';
  }

  // ======================================================================
  // == COMPREHENSIVE V2 INDICATOR REFRESH ================================
  // ======================================================================
  void _updateAllIndicators() {
    _rsiVal = _calculateRsi(14);

    final fullMacd = _calculateFullMacd();
    _macdVal = fullMacd['macd']!;
    _macdSignalLine = fullMacd['signal']!;
    _macdHistogram = fullMacd['histogram']!;

    final bb = _calculateBollingerBands(20);
    _bbUpper = bb['upper']!;
    _bbLower = bb['lower']!;

    _atrVal = _calculateAtr(14);

    final stoch = _calculateStochastic(14, 3);
    _stochK = stoch['k']!;
    _stochD = stoch['d']!;

    // Enhanced ADX with directional indicators
    final adxFull = _calculateAdxFull(14);
    _adxVal = adxFull['adx']!;
    _plusDi = adxFull['plusDi']!;
    _minusDi = adxFull['minusDi']!;

    _obvVal = _calculateObv();
    _vwapVal = _calculateVwap();
    _cmfVal = _calculateCmf(20);
    _volumeDelta = _calculateVolumeDelta();

    _ema9 = _calculateEma(min(9, _candles.length));
    _ema21 = _calculateEma(min(21, _candles.length));
    _ema50 = _calculateEma(min(50, _candles.length));

    final liqZones = _calculateLiquidityZones();
    _liquidityScore = liqZones['score'] as double;
    _liquidityZone = liqZones['zone'] as String;

    // V2 Ultra indicators
    _williamsR = _calculateWilliamsR(14);
    _cciVal = _calculateCci(20);
    _mfiVal = _calculateMfi(14);
    _rocVal = _calculateRoc(10);

    final volProfile = _analyzeVolumeProfile();
    _volumeSpike = volProfile['spike'] as bool;
    _volumeRatio = (volProfile['ratio'] as double).clamp(0.0, 10.0);
    _obvTrend = volProfile['trend'] as String;

    _candlePattern = _detectCandlePatterns();
    _rsiDivergence = _detectRsiDivergence();

    // ADX-based trend strength
    if (_adxVal > 50) {
      _trendStrength = 'Very Strong';
    } else if (_adxVal > 35) {
      _trendStrength = 'Strong';
    } else if (_adxVal > 20) {
      _trendStrength = 'Moderate';
    } else {
      _trendStrength = 'Weak / Ranging';
    }

    // Ultra market sentiment using ALL 11 indicators
    int bullSignals = 0;
    int bearSignals = 0;

    if (_rsiVal > 50) {
      bullSignals++;
    } else {
      bearSignals++;
    }
    if (_macdHistogram > 0) {
      bullSignals++;
    } else {
      bearSignals++;
    }
    if (_currentPrice > _vwapVal) {
      bullSignals++;
    } else {
      bearSignals++;
    }
    if (_stochK > 50) {
      bullSignals++;
    } else {
      bearSignals++;
    }
    if (_cmfVal > 0) {
      bullSignals++;
    } else {
      bearSignals++;
    }
    if (_volumeDelta > 0) {
      bullSignals++;
    } else {
      bearSignals++;
    }
    if (_currentPrice > _ema50) {
      bullSignals++;
    } else {
      bearSignals++;
    }
    if (_mfiVal > 50) {
      bullSignals++;
    } else {
      bearSignals++;
    }
    if (_cciVal > 0) {
      bullSignals++;
    } else {
      bearSignals++;
    }
    if (_williamsR > -50) {
      bullSignals++;
    } else {
      bearSignals++;
    }
    if (_plusDi > _minusDi) {
      bullSignals++;
    } else {
      bearSignals++;
    }

    if (_rsiVal > 70 && _stochK > 80 && _mfiVal > 80) {
      _marketSentiment = 'Strong Overbought (Sell)';
    } else if (_rsiVal < 30 && _stochK < 20 && _mfiVal < 20) {
      _marketSentiment = 'Strong Oversold (Buy)';
    } else if (bullSignals >= 9) {
      _marketSentiment = 'Strong Bullish';
    } else if (bearSignals >= 9) {
      _marketSentiment = 'Strong Bearish';
    } else if (bullSignals >= 7) {
      _marketSentiment = 'Moderate Bullish';
    } else if (bearSignals >= 7) {
      _marketSentiment = 'Moderate Bearish';
    } else {
      _marketSentiment = 'Neutral / Consolidating';
    }
  }

  // Build initial candles. Pass [realPrice] to anchor the chart to a live price.
  void _initChart({double? realPrice}) {
    _candles.clear();
    // If real price already fetched, use it directly — skip the fake-price block
    if (realPrice != null && realPrice > 0) {
      double base = realPrice;
      final int rollSecs = timeframeSeconds;
      DateTime time = DateTime.now().subtract(Duration(seconds: 30 * rollSecs));
      for (int i = 0; i < 30; i++) {
        double change = (_random.nextDouble() - 0.5) * (base * 0.001);
        double open = base;
        double close = base + change;
        double high = max(open, close) + _random.nextDouble() * (base * 0.0003);
        double low = min(open, close) - _random.nextDouble() * (base * 0.0003);
        double volume =
            500.0 +
            _random.nextDouble() * 2000.0 +
            ((high - low) / base) * 50000.0;
        _candles.add(
          Candle(
            open: open,
            high: high,
            low: low,
            close: close,
            time: time,
            volume: volume,
          ),
        );
        base = close;
        time = time.add(Duration(seconds: rollSecs));
      }
      _currentPrice = base;
      return;
    }
    double basePrice = 1.08450;

    // Distribute base prices — most specific checks first to avoid substring conflicts
    // BCH must precede BTC; ZAR/USD vs USD/ZAR need separate branches, etc.
    if (_activePair.contains('BCH')) {
      if (_activePair.contains('JPY')) {
        basePrice = 58000.0 + _random.nextDouble() * 2000.0;
      } else if (_activePair.contains('EUR')) {
        basePrice = 350.0 + _random.nextDouble() * 10.0;
      } else if (_activePair.contains('GBP')) {
        basePrice = 300.0 + _random.nextDouble() * 10.0;
      } else {
        basePrice = 380.0 + _random.nextDouble() * 15.0;
      }
    } else if (_activePair.contains('BTC')) {
      if (_activePair.contains('JPY')) {
        basePrice = 9800000.0 + _random.nextDouble() * 200000.0;
      } else if (_activePair.contains('GBP')) {
        basePrice = 50000.0 + _random.nextDouble() * 1500.0;
      } else {
        basePrice = 64500.0 + _random.nextDouble() * 2000.0;
      }
    } else if (_activePair.contains('ETH')) {
      basePrice = 3450.0 + _random.nextDouble() * 150.0;
    } else if (_activePair.contains('SOL')) {
      basePrice = 142.0 + _random.nextDouble() * 8.0;
    } else if (_activePair.contains('BNB')) {
      basePrice = 572.0 + _random.nextDouble() * 20.0;
    } else if (_activePair.contains('XRP')) {
      basePrice = 0.4900 + _random.nextDouble() * 0.0500;
    } else if (_activePair.contains('ADA')) {
      basePrice = 0.35 + _random.nextDouble() * 0.10;
    } else if (_activePair.contains('DOGE')) {
      basePrice = 0.11 + _random.nextDouble() * 0.04;
    } else if (_activePair.contains('LTC')) {
      basePrice = 75.0 + _random.nextDouble() * 10.0;
    } else if (_activePair.contains('LINK')) {
      basePrice = 14.0 + _random.nextDouble() * 2.0;
    } else if (_activePair.contains('DOT')) {
      basePrice = 6.50 + _random.nextDouble() * 0.50;
    } else if (_activePair.contains('AVAX')) {
      basePrice = 32.0 + _random.nextDouble() * 3.0;
    } else if (_activePair.contains('TRX')) {
      basePrice = 0.12 + _random.nextDouble() * 0.01;
    } else if (_activePair.contains('MATIC')) {
      basePrice = 0.60 + _random.nextDouble() * 0.05;
    } else if (_activePair.contains('TON')) {
      basePrice = 5.80 + _random.nextDouble() * 0.40;
    } else if (_activePair.contains('DASH')) {
      basePrice = 28.0 + _random.nextDouble() * 2.0;
    } else if ((_activePair.contains('XAU') || _activePair.contains('Gold')) &&
        _activePair.contains('EUR')) {
      basePrice = 2160.0 + _random.nextDouble() * 40.0;
    } else if ((_activePair.contains('XAG') ||
            _activePair.contains('Silver')) &&
        _activePair.contains('EUR')) {
      basePrice = 27.0 + _random.nextDouble() * 1.0;
    } else if (_activePair.contains('Gold') || _activePair.contains('XAU')) {
      basePrice = 2335.0 + _random.nextDouble() * 40.0;
    } else if (_activePair.contains('Silver') || _activePair.contains('XAG')) {
      basePrice = 29.20 + _random.nextDouble() * 1.50;
    } else if (_activePair.contains('Palladium') ||
        _activePair.contains('XPD')) {
      basePrice = 1000.0 + _random.nextDouble() * 40.0;
    } else if (_activePair.contains('PLATINUM') ||
        _activePair.contains('Platinum') ||
        _activePair.contains('XPT')) {
      basePrice = 950.0 + _random.nextDouble() * 30.0;
    } else if (_activePair.contains('BRENT') ||
        _activePair.contains('Oil') ||
        _activePair.contains('CRUDE') ||
        _activePair.contains('WTI')) {
      basePrice = 75.0 + _random.nextDouble() * 5.0;
    } else if (_activePair.contains('GAS') ||
        _activePair.contains('Gas') ||
        _activePair.contains('NATURAL')) {
      basePrice = 2.10 + _random.nextDouble() * 0.80;
    } else if (_activePair.contains('COPPER') ||
        _activePair.contains('Copper')) {
      basePrice = 4.10 + _random.nextDouble() * 0.60;
      // --- Forex cross pairs (order: specifics before broad JPY/EUR/USD checks) ---
    } else if (_activePair.contains('CHF') && _activePair.contains('JPY')) {
      basePrice = 173.0 + _random.nextDouble() * 3.0;
    } else if (_activePair.contains('JPY')) {
      basePrice = 155.0 + _random.nextDouble() * 3.0;
    } else if (_activePair.contains('EUR/CAD')) {
      basePrice = 1.475 + _random.nextDouble() * 0.010;
    } else if (_activePair.contains('EUR/AUD')) {
      basePrice = 1.65 + _random.nextDouble() * 0.02;
    } else if (_activePair.contains('EUR/CHF')) {
      basePrice = 0.965 + _random.nextDouble() * 0.010;
    } else if (_activePair.contains('EUR/NZD')) {
      basePrice = 1.78 + _random.nextDouble() * 0.02;
    } else if (_activePair.contains('EUR/RUB')) {
      basePrice = 97.0 + _random.nextDouble() * 2.0;
    } else if (_activePair.contains('EUR/TRY')) {
      basePrice = 36.0 + _random.nextDouble() * 1.0;
    } else if (_activePair.contains('EUR/USD') ||
        _activePair.contains('GBP/USD') ||
        _activePair.contains('EUR/GBP') ||
        _activePair.contains('AUD/USD') ||
        _activePair.contains('NZD/USD') ||
        _activePair.contains('USD/CAD')) {
      basePrice = 1.08000 + _random.nextDouble() * 0.02000;
    } else if (_activePair.contains('GBP/AUD')) {
      basePrice = 1.93 + _random.nextDouble() * 0.02;
    } else if (_activePair.contains('GBP/CAD')) {
      basePrice = 1.72 + _random.nextDouble() * 0.02;
    } else if (_activePair.contains('GBP/CHF')) {
      basePrice = 1.14 + _random.nextDouble() * 0.02;
    } else if (_activePair.contains('GBP/NZD')) {
      basePrice = 2.08 + _random.nextDouble() * 0.03;
    } else if (_activePair.contains('AUD/NZD')) {
      basePrice = 1.075 + _random.nextDouble() * 0.010;
    } else if (_activePair.contains('AUD/CAD')) {
      basePrice = 0.89 + _random.nextDouble() * 0.01;
    } else if (_activePair.contains('AUD/CHF')) {
      basePrice = 0.60 + _random.nextDouble() * 0.01;
    } else if (_activePair.contains('CAD/CHF')) {
      basePrice = 0.66 + _random.nextDouble() * 0.01;
    } else if (_activePair.contains('NZD/CHF') ||
        _activePair.contains('NZD/CAD')) {
      basePrice = 0.57 + _random.nextDouble() * 0.01;
    } else if (_activePair.contains('USD/CHF')) {
      basePrice = 0.8900 + _random.nextDouble() * 0.0100;
    } else if (_activePair.contains('ZAR/USD')) {
      basePrice = 0.054 + _random.nextDouble() * 0.002;
    } else if (_activePair.contains('ZAR') || _activePair.contains('MXN')) {
      basePrice = 18.0 + _random.nextDouble() * 0.5;
    } else if (_activePair.contains('NGN/USD')) {
      basePrice = 0.00067 + _random.nextDouble() * 0.00002;
    } else if (_activePair.contains('NGN')) {
      basePrice = 1500.0 + _random.nextDouble() * 50.0;
    } else if (_activePair.contains('KES')) {
      basePrice = 0.0077 + _random.nextDouble() * 0.0002;
    } else if (_activePair.contains('UAH')) {
      basePrice = 0.025 + _random.nextDouble() * 0.001;
    } else if (_activePair.contains('TND')) {
      basePrice = 0.322 + _random.nextDouble() * 0.005;
    } else if (_activePair.contains('CLP')) {
      basePrice = 925.0 + _random.nextDouble() * 15.0;
    } else if (_activePair.contains('SGD')) {
      basePrice = 1.34 + _random.nextDouble() * 0.02;
    } else if (_activePair.contains('THB')) {
      basePrice = 36.5 + _random.nextDouble() * 0.5;
    } else if (_activePair.contains('IDR')) {
      basePrice = 16000.0 + _random.nextDouble() * 200.0;
    } else if (_activePair.contains('OMR')) {
      basePrice = 18.8 + _random.nextDouble() * 0.3;
    } else if (_activePair.contains('DZD')) {
      basePrice = 134.0 + _random.nextDouble() * 2.0;
    } else if (_activePair.contains('MYR')) {
      basePrice = 4.70 + _random.nextDouble() * 0.10;
    } else if (_activePair.contains('RUB')) {
      basePrice = 90.0 + _random.nextDouble() * 2.0;
    } else if (_activePair.contains('CNH')) {
      basePrice = 7.26 + _random.nextDouble() * 0.04;
    } else if (_activePair.contains('INR')) {
      basePrice = 84.0 + _random.nextDouble() * 1.0;
    } else if (_activePair.contains('AED')) {
      basePrice = 1.97 + _random.nextDouble() * 0.02;
    } else if (_activePair.contains('QAR')) {
      basePrice = 1.97 + _random.nextDouble() * 0.02;
    } else if (_activePair.contains('NOK')) {
      basePrice = 11.80 + _random.nextDouble() * 0.20;
    } else if (_activePair.contains('YER')) {
      basePrice = 0.00399 + _random.nextDouble() * 0.0001;
    } else if (_activePair.contains('MAD')) {
      basePrice = 0.0997 + _random.nextDouble() * 0.002;
    } else if (_activePair.contains('HUF')) {
      basePrice = 388.0 + _random.nextDouble() * 5.0;
    } else if (_activePair.contains('EGP')) {
      basePrice = 48.50 + _random.nextDouble() * 0.50;
    } else if (_activePair.contains('COP')) {
      basePrice = 3940.0 + _random.nextDouble() * 40.0;
    } else if (_activePair.contains('BHD')) {
      basePrice = 19.20 + _random.nextDouble() * 0.30;
    } else if (_activePair.contains('SAR')) {
      basePrice = 1.93 + _random.nextDouble() * 0.02;
    } else if (_activePair.contains('JOD')) {
      basePrice = 10.22 + _random.nextDouble() * 0.10;
    } else if (_activePair.contains('MRY')) {
      basePrice = 39.50 + _random.nextDouble() * 0.50;
    } else if (_activePair.contains('VND')) {
      basePrice = 25100.0 + _random.nextDouble() * 100.0;
    } else if (_activePair.contains('LBP')) {
      basePrice = 89500.0 + _random.nextDouble() * 500.0;
    } else if (_activePair.contains('ARS')) {
      basePrice = 900.0 + _random.nextDouble() * 20.0;
    } else if (_activePair.contains('PKR')) {
      basePrice = 278.0 + _random.nextDouble() * 5.0;
    } else if (_activePair.contains('BDT')) {
      basePrice = 117.0 + _random.nextDouble() * 3.0;
    } else if (_activePair.contains('PHP')) {
      basePrice = 58.0 + _random.nextDouble() * 2.0;
    } else if (_activePair.contains('BRL')) {
      basePrice = 5.4 + _random.nextDouble() * 0.2;
    }

    _currentPrice = basePrice;

    final int rollSecs = timeframeSeconds;
    DateTime time = DateTime.now().subtract(Duration(seconds: 30 * rollSecs));
    for (int i = 0; i < 30; i++) {
      double change = (_random.nextDouble() - 0.5) * (basePrice * 0.001);
      double open = basePrice;
      double close = basePrice + change;
      double high =
          max(open, close) + _random.nextDouble() * (basePrice * 0.0003);
      double low =
          min(open, close) - _random.nextDouble() * (basePrice * 0.0003);
      // Realistic volume simulation (higher on bigger candles, random base)
      double baseVolume = 500.0 + _random.nextDouble() * 2000.0;
      double volatilityBonus = ((high - low) / basePrice) * 50000.0;
      double volume = baseVolume + volatilityBonus;

      _candles.add(
        Candle(
          open: open,
          high: high,
          low: low,
          close: close,
          time: time,
          volume: volume,
        ),
      );
      basePrice = close;
      time = time.add(Duration(seconds: rollSecs));
    }
    _currentPrice = basePrice;
  }

  // Ticks every 300ms to update current price and active candle
  void _startTicker() {
    _tickTimer = Timer.periodic(const Duration(milliseconds: 300), (timer) {
      if (_candles.isEmpty) return;

      // Check VIP Expiration (UTC — absolute, online/offline independent)
      if (_userRole == 'vip' && _vipExpiry != null) {
        if (DateTime.now().toUtc().isAfter(_vipExpiry!)) {
          _userRole = 'standard';
          _vipJustExpired = true;
          SharedPreferences.getInstance().then((prefs) {
            prefs.setString('user_role', 'standard');
            prefs.remove('vip_expiry');
          });
        }
      }

      // Synthetic price walk — ONLY in simulator mode. When real OHLC candles
      // are fed (scraping mode), we never fabricate prices/candles; the buffer is
      // refreshed from the real `candles` table by the app.
      if (!_realCandlesMode) {
        double volatility = _currentPrice * 0.00025;
        double priceChange =
            (_random.nextDouble() - 0.492) * volatility; // slight upward drift

        // Guaranteed win: tiny additive bias keeps Dart's internal price trending toward win
        // (visual guaranteed win is handled by chart.js's own tick micro-bias via _trade.gwin)
        if (_isGuaranteedWin &&
            _activeSignal != null &&
            _activeSignal!.status == 'ACTIVE') {
          final signal = _activeSignal!;
          final isCall = signal.direction == 'CALL';
          final diff = _currentPrice - signal.entryPrice;
          final losing = isCall ? diff <= 0 : diff >= 0;
          if (losing) {
            priceChange += isCall ? volatility * 0.08 : -volatility * 0.08;
          }
        }

        // Update price
        _currentPrice += priceChange;

        // Update active candle (the last one)
        Candle activeCandle = _candles.last;
        activeCandle.close = _currentPrice;
        if (_currentPrice > activeCandle.high) {
          activeCandle.high = _currentPrice;
        }
        if (_currentPrice < activeCandle.low) activeCandle.low = _currentPrice;
        // Accumulate tick volume on active candle
        activeCandle.volume += 10.0 + _random.nextDouble() * 50.0;
      }

      // Re-calculate ALL indicator states from the current candle buffer
      _updateAllIndicators();

      // Update active signal countdown using real-time difference from expiry
      if (_activeSignal != null && _activeSignal!.status == 'ACTIVE') {
        _activeSignal!.currentPrice = _currentPrice;
        final difference = _activeSignal!.expiryTime
            .difference(DateTime.now())
            .inSeconds;
        _secondsRemaining = difference > 0 ? difference : 0;
        if (_secondsRemaining <= 0) {
          _evaluateSignalResult();
        }
      }

      // Roll candles based on timeframe — simulator mode only. In real mode the
      // rolling comes from the refreshed `candles` table data.
      if (!_realCandlesMode) {
        DateTime now = DateTime.now();
        final Candle activeCandle = _candles.last;
        if (now.difference(activeCandle.time).inSeconds >= timeframeSeconds) {
          _candles.removeAt(0);
          _candles.add(
            Candle(
              open: _currentPrice,
              high: _currentPrice,
              low: _currentPrice,
              close: _currentPrice,
              time: now,
              volume: 0.0,
            ),
          );

          // Re-evaluate signal dynamically at candle boundary
          _reEvaluateActiveSignalDirection();
        }
      }

      notifyListeners();
    });
  }

  // Infinite social feed wins simulation
  void _startSocialFeed() {
    _socialTimer = Timer.periodic(const Duration(seconds: 4), (timer) {
      // Market/weekend closed — clear any stale entries and notify UI
      if (isWeekendClosed) {
        if (_socialWinLogs.isNotEmpty) {
          _socialWinLogs.clear();
          notifyListeners();
        } else {
          // No entries but UI still needs to know it's closed
          notifyListeners();
        }
        return;
      }
      final names = [
        'Tariq',
        'Ahmed',
        'VIP_Trader',
        'FX_King',
        'Youssef',
        'Omar',
        'Amr',
        'Saeed',
        'Ziad',
        'Karam',
      ];
      final ids = [
        '2948',
        '3840',
        '1947',
        '8302',
        '5512',
        '7492',
        '1093',
        '6738',
        '4802',
        '3819',
      ];
      final name = names[_random.nextInt(names.length)];
      final id = ids[_random.nextInt(ids.length)];
      final profit = 50 + _random.nextInt(250);
      if (AppConstants.currencyPairs.isEmpty) return;
      final asset =
          AppConstants.currencyPairs[_random.nextInt(
            AppConstants.currencyPairs.length,
          )]['symbol'];
      final direction = _random.nextBool() ? 'CALL \u{1F7E2}' : 'PUT \u{1F534}';

      _socialWinLogs.insert(
        0,
        'VIP $name ($id***) won +\$$profit on ${(asset as String).replaceAll(' (OTC)', '')} $direction',
      );
      if (_socialWinLogs.length > 20) {
        _socialWinLogs.removeLast();
      }
      notifyListeners();
    });
  }

  void _generateMockHistory() {
    final now = DateTime.now();
    final basePrices = {
      'EUR/USD (OTC)': 1.08450,
      'GBP/USD (OTC)': 1.26850,
      'BTC/USD': 64250.0,
      'USD/JPY (OTC)': 156.40,
      'Gold (OTC)': 2335.0,
    };

    // 15 total mock signals
    // 13 wins and 2 losses to keep a high win rate (~86%)
    final mockData = [
      // Today (5 signals)
      {
        'pair': 'EUR/USD (OTC)',
        'dir': 'CALL',
        'isWin': true,
        'age': const Duration(minutes: 45),
      },
      {
        'pair': 'BTC/USD',
        'dir': 'PUT',
        'isWin': true,
        'age': const Duration(hours: 2),
      },
      {
        'pair': 'GBP/USD (OTC)',
        'dir': 'CALL',
        'isWin': false,
        'age': const Duration(hours: 3, minutes: 20),
      },
      {
        'pair': 'USD/JPY (OTC)',
        'dir': 'PUT',
        'isWin': true,
        'age': const Duration(hours: 5),
      },
      {
        'pair': 'Gold (OTC)',
        'dir': 'CALL',
        'isWin': true,
        'age': const Duration(hours: 8),
      },

      // Yesterday (5 signals)
      {
        'pair': 'EUR/USD (OTC)',
        'dir': 'PUT',
        'isWin': true,
        'age': const Duration(days: 1, hours: 1),
      },
      {
        'pair': 'GBP/USD (OTC)',
        'dir': 'CALL',
        'isWin': true,
        'age': const Duration(days: 1, hours: 4),
      },
      {
        'pair': 'BTC/USD',
        'dir': 'CALL',
        'isWin': true,
        'age': const Duration(days: 1, hours: 7),
      },
      {
        'pair': 'USD/JPY (OTC)',
        'dir': 'CALL',
        'isWin': false,
        'age': const Duration(days: 1, hours: 10),
      },
      {
        'pair': 'Gold (OTC)',
        'dir': 'PUT',
        'isWin': true,
        'age': const Duration(days: 1, hours: 14),
      },

      // Previous days (5 signals)
      {
        'pair': 'EUR/USD (OTC)',
        'dir': 'CALL',
        'isWin': true,
        'age': const Duration(days: 2, hours: 3),
      },
      {
        'pair': 'GBP/USD (OTC)',
        'dir': 'PUT',
        'isWin': true,
        'age': const Duration(days: 2, hours: 11),
      },
      {
        'pair': 'BTC/USD',
        'dir': 'PUT',
        'isWin': true,
        'age': const Duration(days: 3, hours: 2),
      },
      {
        'pair': 'USD/JPY (OTC)',
        'dir': 'CALL',
        'isWin': true,
        'age': const Duration(days: 3, hours: 16),
      },
      {
        'pair': 'Gold (OTC)',
        'dir': 'CALL',
        'isWin': true,
        'age': const Duration(days: 4, hours: 5),
      },
    ];

    for (final item in mockData) {
      final String pair = item['pair'] as String;
      final String direction = item['dir'] as String;
      final bool isWin = item['isWin'] as bool;
      final Duration age = item['age'] as Duration;

      final entryTime = now.subtract(age);
      final duration = 5;
      final expiryTime = entryTime.add(Duration(minutes: duration));

      final double base = basePrices[pair] ?? 1.0;
      final double variation = (_random.nextDouble() - 0.5) * (base * 0.005);
      final double entryPrice = base + variation;

      double exitPrice;
      if (direction == 'CALL') {
        exitPrice = isWin
            ? entryPrice + (base * 0.001)
            : entryPrice - (base * 0.001);
      } else {
        exitPrice = isWin
            ? entryPrice - (base * 0.001)
            : entryPrice + (base * 0.001);
      }

      _signalHistory.add(
        TradingSignal(
          pair: pair,
          direction: direction,
          durationMinutes: duration,
          entryPrice: entryPrice,
          currentPrice: exitPrice,
          confidence: 93.0 + _random.nextDouble() * 5.0,
          entryTime: entryTime,
          expiryTime: expiryTime,
          status: isWin ? 'WIN' : 'LOSS',
          exitPrice: exitPrice,
        ),
      );
    }
  }

  // ======================================================================
  // == V2 ULTRA PREDICTION ENGINE - 18 INDICATORS WITH 5-TIER SCORING ====
  // ======================================================================
  // Tier 1 - Primary Trend (3.0): Multi-EMA Alignment, MACD+Signal, ADX+DI
  // Tier 2 - Momentum (2.5): RSI+Divergence, Stochastic, CCI
  // Tier 3 - Volume & Flow (2.0): MFI, CMF, Volume Delta, OBV Trend, Volume Spike
  // Tier 4 - Price Action (2.0): Bollinger, S/R, VWAP, Liquidity Zones
  // Tier 5 - Confirmation (1.5): Candle Patterns, Williams %R, ROC
  // ======================================================================

  double _scoreV2Engine() {
    // If a rule-based strategy is loaded, delegate entirely to it
    final dynamic = _activeDynamic;
    if (dynamic != null) return _evaluateRules(dynamic);

    final c = _cfg; // strategy config shorthand
    double callScore = 0.0;
    double putScore = 0.0;

    final emaP = c.emaPeriods;
    final ema1 = _calculateEma(emaP[0]);
    final ema2 = _calculateEma(emaP.length > 1 ? emaP[1] : 21);
    final ema3 = _calculateEma(
      min(emaP.length > 2 ? emaP[2] : 50, _candles.length),
    );
    final rsi = _calculateRsi(c.rsiPeriod);
    final fullMacd = _calculateFullMacd();
    final macdHist = fullMacd['histogram']!;
    final macdLine = fullMacd['macd']!;
    final macdSignal = fullMacd['signal']!;
    final bb = _calculateBollingerBands(c.bbPeriod, c.bbStddev);
    final sr = _calculateSupportResistance();
    final stoch = _calculateStochastic(c.stochPeriod, c.stochSmooth);
    final adxFull = _calculateAdxFull(c.adxPeriod);
    final adx = adxFull['adx']!;
    final pDi = adxFull['plusDi']!;
    final mDi = adxFull['minusDi']!;
    final vwap = _calculateVwap();
    final cmf = _calculateCmf(c.cmfPeriod);
    final volDelta = _calculateVolumeDelta();
    final liqZones = _calculateLiquidityZones();
    final williamsR = _calculateWilliamsR(c.williamsPeriod);
    final cci = _calculateCci(c.cciPeriod);
    final mfi = _calculateMfi(c.mfiPeriod);
    final roc = _calculateRoc(c.rocPeriod);
    final volProfile = _analyzeVolumeProfile();
    final divergence = _detectRsiDivergence();
    final pattern = _detectCandlePatterns();

    final w1 = c.tier1Weight;
    final w2 = c.tier2Weight;
    final w3 = c.tier3Weight;
    final w4 = c.tier4Weight;
    final w5 = c.tier5Weight;

    // TIER 1: Primary Trend
    if (ema1 > ema2 && ema2 > ema3) {
      callScore += w1;
    } else if (ema1 < ema2 && ema2 < ema3) {
      putScore += w1;
    } else if (ema1 > ema2) {
      callScore += w1 / 2;
    } else {
      putScore += w1 / 2;
    }

    if (macdHist > 0 && macdLine > macdSignal) {
      callScore += w1;
    } else if (macdHist < 0 && macdLine < macdSignal) {
      putScore += w1;
    } else if (macdHist > 0) {
      callScore += w1 / 2;
    } else {
      putScore += w1 / 2;
    }

    if (adx > c.adxStrong) {
      if (pDi > mDi) {
        callScore += w1;
      } else {
        putScore += w1;
      }
    } else if (adx > c.adxModerate) {
      if (pDi > mDi) {
        callScore += w1 / 3;
      } else {
        putScore += w1 / 3;
      }
    }

    // TIER 2: Momentum
    if (rsi < c.rsiOversoldExtreme) {
      callScore += w2;
    } else if (rsi > c.rsiOverboughtExtreme) {
      putScore += w2;
    } else if (rsi < c.rsiOversold) {
      callScore += w2 * 0.6;
    } else if (rsi > c.rsiOverbought) {
      putScore += w2 * 0.6;
    } else if (rsi > 55) {
      callScore += w2 * 0.2;
    } else if (rsi < 45) {
      putScore += w2 * 0.2;
    }

    if (divergence == 'bullish') {
      callScore += w2;
    } else if (divergence == 'bearish') {
      putScore += w2;
    }

    final stochK = stoch['k']!;
    final stochD = stoch['d']!;
    if (stochK < c.stochOversold) {
      callScore += w2;
    } else if (stochK > c.stochOverbought) {
      putScore += w2;
    } else if (stochK > stochD && stochK < 50) {
      callScore += w2 * 0.6;
    } else if (stochK < stochD && stochK > 50) {
      putScore += w2 * 0.6;
    } else if (stochK > 50) {
      callScore += w2 * 0.2;
    } else {
      putScore += w2 * 0.2;
    }

    if (cci > c.cciExtreme) {
      putScore += w2;
    } else if (cci < -c.cciExtreme) {
      callScore += w2;
    } else if (cci > c.cciStrong) {
      callScore += w2 * 0.4;
    } else if (cci < -c.cciStrong) {
      putScore += w2 * 0.4;
    } else if (cci > 0) {
      callScore += w2 * 0.2;
    } else {
      putScore += w2 * 0.2;
    }

    // TIER 3: Volume & Flow
    if (mfi < c.mfiOversold) {
      callScore += w3;
    } else if (mfi > c.mfiOverbought) {
      putScore += w3;
    } else if (mfi > 60) {
      callScore += w3 / 2;
    } else if (mfi < 40) {
      putScore += w3 / 2;
    }

    if (cmf > c.cmfStrong) {
      callScore += w3;
    } else if (cmf < -c.cmfStrong) {
      putScore += w3;
    } else if (cmf > c.cmfMild) {
      callScore += w3 * 0.6;
    } else if (cmf < -c.cmfMild) {
      putScore += w3 * 0.6;
    } else if (cmf > 0) {
      callScore += w3 * 0.25;
    } else {
      putScore += w3 * 0.25;
    }

    if (volDelta > c.volDeltaStrong) {
      callScore += w3;
    } else if (volDelta < -c.volDeltaStrong) {
      putScore += w3;
    } else if (volDelta > c.volDeltaMild) {
      callScore += w3 / 2;
    } else if (volDelta < -c.volDeltaMild) {
      putScore += w3 / 2;
    }

    final obvDir = volProfile['trend'] as String;
    if (obvDir == 'bullish') {
      callScore += w3;
    } else if (obvDir == 'bearish') {
      putScore += w3;
    }

    final hasSpike = volProfile['spike'] as bool;
    if (hasSpike) {
      if (callScore > putScore) {
        callScore += w3;
      } else {
        putScore += w3;
      }
    }

    // TIER 4: Price Action
    if (_currentPrice <= bb['lower']!) {
      callScore += w4;
    } else if (_currentPrice >= bb['upper']!) {
      putScore += w4;
    } else {
      final bbRange = bb['upper']! - bb['lower']!;
      if (bbRange > 0) {
        final bbPos = (_currentPrice - bb['lower']!) / bbRange;
        if (bbPos > 0.75) {
          putScore += w4 / 2;
        }
        if (bbPos < 0.25) {
          callScore += w4 / 2;
        }
      }
    }

    final srThreshold = _currentPrice * c.srProximity;
    if ((_currentPrice - sr['support']!).abs() <= srThreshold) {
      callScore += w4;
    }
    if ((_currentPrice - sr['resistance']!).abs() <= srThreshold) {
      putScore += w4;
    }

    final vwapDist = ((_currentPrice - vwap) / vwap).abs();
    if (_currentPrice > vwap) {
      callScore += vwapDist > c.vwapProximity ? w4 : w4 / 2;
    } else {
      putScore += vwapDist > c.vwapProximity ? w4 : w4 / 2;
    }

    final liqScore = liqZones['score'] as double;
    final liqZone = liqZones['zone'] as String;
    if (liqScore > c.liquidityMinScore) {
      if (liqZone.contains('Demand') || liqZone.contains('Buy')) {
        callScore += w4;
      } else if (liqZone.contains('Supply') || liqZone.contains('Sell')) {
        putScore += w4;
      }
    }

    // TIER 5: Confirmation
    if (pattern == 'bullish_engulfing' ||
        pattern == 'hammer' ||
        pattern == 'morning_star' ||
        pattern == 'three_white_soldiers' ||
        pattern == 'pin_bar_bullish') {
      callScore += w5;
    } else if (pattern == 'bearish_engulfing' ||
        pattern == 'shooting_star' ||
        pattern == 'evening_star' ||
        pattern == 'three_black_crows' ||
        pattern == 'pin_bar_bearish') {
      putScore += w5;
    }

    if (williamsR > c.williamsOverbought) {
      putScore += w5;
    } else if (williamsR < c.williamsOversold) {
      callScore += w5;
    } else if (williamsR > (c.williamsOversold + c.williamsOverbought) / 2) {
      callScore += w5 / 3;
    } else {
      putScore += w5 / 3;
    }

    if (roc > c.rocThreshold) {
      callScore += w5;
    } else if (roc < -c.rocThreshold) {
      putScore += w5;
    } else if (roc > 0) {
      callScore += w5 / 3;
    } else {
      putScore += w5 / 3;
    }

    // Quality filters
    final volRatio = volProfile['ratio'] as double;
    if (volRatio < c.lowVolThreshold) {
      callScore *= c.lowVolDamp;
      putScore *= c.lowVolDamp;
    }
    if (adx < c.rangingAdx) {
      callScore *= c.rangingDamp;
      putScore *= c.rangingDamp;
    }

    return callScore - putScore;
  }

  void _generateNextSignal(int selectedMinutes) {
    _pyramidRejectReason = '';
    double netScore = _userRole == 'vip'
        ? _scoreV3VipEngine()
        : _scoreV2Engine();
    double absScore = netScore.abs();

    // Respect the strategy's gates (same as monitoring): if min_score isn't met
    // or the pyramid rejected the setup, DON'T force a signal — show a
    // "no opportunity now" banner instead.
    final DynamicStrategy? gateDyn = _activeDynamic;
    final double minScore = gateDyn?.minScore ?? 0.0;
    final bool rejected = _pyramidRejectReason.isNotEmpty;
    if (rejected || absScore < minScore) {
      _lastWaitNotice = rejected
          ? tr(
              'لا توجد فرصة دخول الآن — لم تتحقق شروط الاستراتيجية',
              'No entry opportunity now — the strategy conditions were not met',
            )
          : tr(
              'لا توجد فرصة دخول الآن — لم يتحقق الحد الأدنى للتوافق (min_score)',
              'No entry opportunity now — the minimum confluence (min_score) was not reached',
            );
      _activeSignal = null;
      _secondsRemaining = 0;
      evalJs("CandleChart.setGlobalEntryLine(null, null)");
      notifyListeners();
      return;
    }
    _lastWaitNotice = '';

    bool isCall = netScore >= 0;

    double confidence;
    if (_userRole == 'vip') {
      confidence = _vipLastResult?.confidence ?? 70.0;
    } else {
      final confBase = _activeDynamic?.confidenceBase ?? _cfg.confidenceBase;
      final confMax = _activeDynamic?.confidenceMax ?? _cfg.confidenceMax;
      confidence = confBase + (absScore / 45.0) * (confMax - confBase);
      confidence = confidence.clamp(confBase, confMax);
    }

    // Duration is REAL minutes regardless of the chart timeframe (the user picks
    // "N minutes"; the chart frame is only a view). Align to the 1-minute boundary
    // so the trade still ends on a clean candle close. (Was multiplying minutes by
    // the frame seconds → a "5 min" trade ran 75 min on a 15m chart.)
    final nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    const cs = 60;
    final cStartSec = (nowSec ~/ cs) * cs;
    final expirySec = cStartSec + selectedMinutes * cs;
    final alignedExpiry = DateTime.fromMillisecondsSinceEpoch(expirySec * 1000);
    final alignedDuration = (expirySec - nowSec).clamp(
      1,
      selectedMinutes * cs + cs,
    );

    // Use live chart price as entry — it's always correct for both sim and OTC modes
    final liveNow = _livePriceGetter?.call() ?? 0;
    final entryP = liveNow > 0 ? liveNow : _currentPrice;

    _activeSignal = TradingSignal(
      pair: _activePair,
      direction: isCall ? 'CALL' : 'PUT',
      durationMinutes: selectedMinutes,
      entryPrice: entryP,
      currentPrice: entryP,
      confidence: confidence,
      entryTime: DateTime.fromMillisecondsSinceEpoch(cStartSec * 1000),
      expiryTime: alignedExpiry,
      status: 'ACTIVE',
      marketCondition: _userRole == 'vip'
          ? '${_vipLastResult?.grade ?? "VIP"} | Score: ${_vipLastResult?.overallScore.toStringAsFixed(0) ?? "—"}/100 | ${_vipLastResult?.riskAssessment ?? ""}'
          : (isCall
                ? tr(
                    'اتجاه صاعد مستقر وقوي مدعوم بسيولة ممتازة ✅',
                    'Stable, strong uptrend backed by excellent liquidity ✅',
                  )
                : tr(
                    'اتجاه هابط حاد وضغط بيعي قوي مدعوم بسيولة ممتازة ✅',
                    'Sharp downtrend with strong selling pressure backed by excellent liquidity ✅',
                  )),
      recommendation: _userRole == 'vip'
          ? '${isCall ? "VIP CALL ✅" : "VIP PUT ✅"} | ${_vipLastResult?.historical?.summary ?? tr("تحليل مزدوج مؤكد", "Confirmed dual analysis")}'
          : (isCall
                ? tr(
                    'دخول صفقة صعود (CALL) فوراً - فرصة دخول آمنة ونسبة نجاح عالية.',
                    'Enter a CALL trade now — a safe entry with a high success rate.',
                  )
                : tr(
                    'دخول صفقة هبوط (PUT) فوراً - فرصة دخول آمنة ونسبة نجاح عالية.',
                    'Enter a PUT trade now — a safe entry with a high success rate.',
                  )),
    );

    _secondsRemaining = alignedDuration;
    _playNewSignalSound();
    // Draw entry line directly on ALL chart instances — bypasses Flutter widget tree
    evalJs(
      "CandleChart.setGlobalEntryLine(${_activeSignal!.entryPrice}, '${isCall ? 'CALL' : 'PUT'}')",
    );
    notifyListeners();
  }

  // V2/V3 Adaptive re-evaluation using full indicator confluence
  void _reEvaluateActiveSignalDirection() {
    if (_activeSignal == null || _activeSignal!.status != 'ACTIVE') return;

    double netScore = _userRole == 'vip'
        ? _scoreV3VipEngine()
        : _scoreV2Engine();
    // VIP: skip direction flip if consensus engine rejected the setup
    if (_userRole == 'vip' &&
        _vipLastResult != null &&
        !_vipLastResult!.isApproved) {
      return;
    }
    bool isCall = netScore >= 0;
    double absScore = netScore.abs();

    double confidence;
    if (_userRole == 'vip') {
      confidence = _vipLastResult?.confidence ?? 70.0;
    } else {
      final confBase = _activeDynamic?.confidenceBase ?? _cfg.confidenceBase;
      final confMax = _activeDynamic?.confidenceMax ?? _cfg.confidenceMax;
      confidence = confBase + (absScore / 45.0) * (confMax - confBase);
      confidence = confidence.clamp(confBase, confMax);
    }

    final newDirection = isCall ? 'CALL' : 'PUT';
    if (_activeSignal!.direction != newDirection) {
      _activeSignal = TradingSignal(
        pair: _activeSignal!.pair,
        direction: newDirection,
        durationMinutes: _activeSignal!.durationMinutes,
        entryPrice: _activeSignal!.entryPrice,
        currentPrice: _activeSignal!.currentPrice,
        confidence: confidence,
        entryTime: _activeSignal!.entryTime,
        expiryTime: _activeSignal!.expiryTime,
        status: _activeSignal!.status,
        marketCondition: _userRole == 'vip'
            ? '${_vipLastResult?.grade ?? "VIP"} | Score: ${_vipLastResult?.overallScore.toStringAsFixed(0) ?? "—"}/100 | ${_vipLastResult?.riskAssessment ?? ""}'
            : (newDirection == 'CALL'
                  ? tr(
                      'تم تحديث الاتجاه إلى صعود قوي ✅',
                      'Direction updated to a strong uptrend ✅',
                    )
                  : tr(
                      'تم تحديث الاتجاه إلى هبوط قوي ✅',
                      'Direction updated to a strong downtrend ✅',
                    )),
        recommendation: _userRole == 'vip'
            ? '${newDirection == "CALL" ? "VIP CALL ✅" : "VIP PUT ✅"} | ${_vipLastResult?.historical?.summary ?? tr("تحليل مزدوج مؤكد", "Confirmed dual analysis")}'
            : (newDirection == 'CALL'
                  ? tr(
                      'تحديث التوصية: دخول صفقة صعود (CALL) مع الشمعة الحالية.',
                      'Updated recommendation: enter a CALL trade with the current candle.',
                    )
                  : tr(
                      'تحديث التوصية: دخول صفقة هبوط (PUT) مع الشمعة الحالية.',
                      'Updated recommendation: enter a PUT trade with the current candle.',
                    )),
      );

      String tfLabel = tr('دقيقة واحدة', '1 minute');
      if (_chartTimeframe == '5m') {
        tfLabel = tr('5 دقائق', '5 minutes');
      } else if (_chartTimeframe == '15m') {
        tfLabel = tr('15 دقيقة', '15 minutes');
      } else if (_chartTimeframe == '30m') {
        tfLabel = tr('30 دقيقة', '30 minutes');
      } else if (_chartTimeframe == '1h') {
        tfLabel = tr('ساعة واحدة', '1 hour');
      }

      _signalChangeNotice = _userRole == 'vip'
          ? tr(
              'تنبيه VIP: تم تصحيح مسار الإشارة وتحديث الاتجاه فوراً ($tfLabel)',
              'VIP alert: the signal path was corrected and the direction updated instantly ($tfLabel)',
            )
          : tr(
              'تم تحديث اتجاه الإشارة مع الشمعة الحالية ($tfLabel)',
              'The signal direction was updated with the current candle ($tfLabel)',
            );

      _playNewSignalSound();
      notifyListeners();
    }
  }

  void _evaluateSignalResult() {
    if (_activeSignal == null) return;

    final signal = _activeSignal!;
    final bool isCall = signal.direction == 'CALL';

    // Exit price must be on the SAME scale as the entry price. We only trust the
    // live chart price when it is genuinely close to entry (< 1% away). This
    // guards against a null/stale getter or the Dart-internal fallback price,
    // which live on a different scale and would otherwise make the review dialog
    // show an entry and a close from two different worlds (the old bug).
    final double live = _livePriceGetter?.call() ?? 0.0;
    final bool liveSane =
        live > 0 && (live - signal.entryPrice).abs() / signal.entryPrice < 0.01;
    double exitP = liveSane ? live : signal.entryPrice;

    if (_isGuaranteedWin) {
      // Guaranteed win (admin, per-user): the close is FORCED onto the winning
      // side of entry, deterministically. If the live price already wins on the
      // same scale we keep it (so the number matches the chart); otherwise we
      // snap to a small realistic margin. Either way it is always a win and the
      // entry/exit pair is always coherent — never derived from another scale.
      final bool winning =
          liveSane &&
          (isCall ? live > signal.entryPrice : live < signal.entryPrice);
      if (winning) {
        exitP = live;
      } else {
        final double margin =
            signal.entryPrice * 0.00008 * (0.6 + _random.nextDouble() * 0.8);
        exitP = isCall
            ? signal.entryPrice + margin
            : signal.entryPrice - margin;
      }
    }

    final double diff = exitP - signal.entryPrice;
    // Three outcomes: exit == entry → TIE (تعادل, stake refunded); otherwise
    // WIN/LOSS by direction. "Equal" is judged at real price precision (no
    // meaningful move ≈ half a tick), not exact float equality, so a flat close
    // is correctly a tie. Applies to every mode (sim / OTC). Guaranteed-win
    // forces a winning margin above this threshold, so it never ties.
    final double tieEps = signal.entryPrice.abs() * 5e-6 + 1e-12;
    String result;
    if (diff.abs() <= tieEps) {
      result = 'TIE';
    } else if (isCall) {
      result = diff > 0 ? 'WIN' : 'LOSS';
    } else {
      // PUT
      result = diff < 0 ? 'WIN' : 'LOSS';
    }

    _activeSignal!.exitPrice = exitP;
    _activeSignal!.candlesSnapshot = _candles
        .map(
          (c) => Candle(
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            time: c.time,
            volume: c.volume,
          ),
        )
        .toList();

    _activeSignal!.status = result;
    _signalHistory.insert(0, _activeSignal!);
    _saveHistory();

    // Play corresponding outcome sound (no sound for a tie)
    if (result == 'WIN') {
      _playWinSound();
    } else if (result == 'LOSS') {
      _playLossSound();
    }
  }

  // --- Sound Effects Synthesizer using Web Audio API via JavaScript ---
  void _playNewSignalSound() {
    if (!kIsWeb) return;
    try {
      evalJs("""
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)();
          var osc1 = ctx.createOscillator();
          var osc2 = ctx.createOscillator();
          var gain = ctx.createGain();
          
          osc1.type = 'triangle';
          osc2.type = 'sine';
          
          osc1.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
          osc1.frequency.exponentialRampToValueAtTime(783.99, ctx.currentTime + 0.15); // G5
          
          osc2.frequency.setValueAtTime(659.25, ctx.currentTime + 0.05); // E5
          osc2.frequency.exponentialRampToValueAtTime(987.77, ctx.currentTime + 0.25); // B5

          gain.gain.setValueAtTime(0.1, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(ctx.destination);

          osc1.start();
          osc2.start();
          osc1.stop(ctx.currentTime + 0.35);
          osc2.stop(ctx.currentTime + 0.35);
        } catch(e) { console.log('Audio error:', e); }
        """);
    } catch (e) {
      debugPrint('Error playing sound: $e');
    }
  }

  void _playWinSound() {
    if (!kIsWeb) return;
    try {
      evalJs("""
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)();
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          
          osc.type = 'sine';
          osc.frequency.setValueAtTime(659.25, ctx.currentTime); // E5
          osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.1); // A5
          osc.frequency.setValueAtTime(1318.51, ctx.currentTime + 0.2); // E6
          
          gain.gain.setValueAtTime(0.12, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
          
          osc.connect(gain);
          gain.connect(ctx.destination);
          
          osc.start();
          osc.stop(ctx.currentTime + 0.5);
        } catch(e) {}
        """);
    } catch (e) {
      debugPrint('Error playing sound: $e');
    }
  }

  void _playLossSound() {
    if (!kIsWeb) return;
    try {
      evalJs("""
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)();
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(220.00, ctx.currentTime); // A3
          osc.frequency.linearRampToValueAtTime(110.00, ctx.currentTime + 0.4); // A2
          
          gain.gain.setValueAtTime(0.1, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
          
          osc.connect(gain);
          gain.connect(ctx.destination);
          
          osc.start();
          osc.stop(ctx.currentTime + 0.45);
        } catch(e) {}
        """);
    } catch (e) {
      debugPrint('Error playing sound: $e');
    }
  }

  // Monitoring: "activated" blip — a short, soft two-note confirmation.
  void _playActivateSound() {
    if (!kIsWeb) return;
    try {
      evalJs("""
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)();
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(440.00, ctx.currentTime); // A4
          osc.frequency.setValueAtTime(587.33, ctx.currentTime + 0.09); // D5
          gain.gain.setValueAtTime(0.07, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.22);
        } catch(e) {}
        """);
    } catch (e) {
      debugPrint('Error playing sound: $e');
    }
  }

  // Monitoring CALL alert — bright, rising, positive triple-note.
  void _playCallSound() {
    if (!kIsWeb) return;
    try {
      evalJs("""
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)();
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(523.25, ctx.currentTime);       // C5
          osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.11); // E5
          osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.22); // A5
          gain.gain.setValueAtTime(0.14, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.5);
        } catch(e) {}
        """);
    } catch (e) {
      debugPrint('Error playing sound: $e');
    }
  }

  // Monitoring PUT alert — lower, descending, cautionary triple-note.
  void _playPutSound() {
    if (!kIsWeb) return;
    try {
      evalJs("""
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)();
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(440.00, ctx.currentTime);       // A4
          osc.frequency.setValueAtTime(349.23, ctx.currentTime + 0.11); // F4
          osc.frequency.setValueAtTime(261.63, ctx.currentTime + 0.22); // C4
          gain.gain.setValueAtTime(0.12, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.5);
        } catch(e) {}
        """);
    } catch (e) {
      debugPrint('Error playing sound: $e');
    }
  }

  // ======================================================================
  // == VIP INSTITUTIONAL ENGINE V5 — MULTI-ENGINE PIPELINE ==============
  // == Core → Structure → Regime → HTF → MTF → Trend → SMC → PA       ==
  // == → Institutional Scoring → Historical → Consensus                ==
  // ======================================================================

  // ── Helpers: multi-timeframe candle aggregation ───────────────────
  List<Candle> _aggregateCandles(int factor) {
    if (factor <= 1 || _candles.isEmpty) return List.from(_candles);
    final result = <Candle>[];
    for (int i = 0; i + factor <= _candles.length; i += factor) {
      final g = _candles.sublist(i, i + factor);
      result.add(
        Candle(
          open: g.first.open,
          high: g.map((c) => c.high).reduce(max),
          low: g.map((c) => c.low).reduce(min),
          close: g.last.close,
          time: g.first.time,
          volume: g.fold(0.0, (s, c) => s + c.volume),
        ),
      );
    }
    return result;
  }

  double _emaOnList(List<Candle> c, int period) {
    if (c.isEmpty) return 0;
    int p = period.clamp(1, c.length);
    double k = 2.0 / (p + 1);
    double ema = c.sublist(0, p).fold(0.0, (s, x) => s + x.close) / p;
    for (int i = p; i < c.length; i++) {
      ema = c[i].close * k + ema * (1 - k);
    }
    return ema;
  }

  double _rsiOnList(List<Candle> c, int period) {
    if (c.length < 2) return 50;
    int p = period.clamp(2, c.length - 1);
    double g = 0, l = 0;
    for (int i = c.length - p; i < c.length; i++) {
      double ch = c[i].close - c[i - 1].close;
      if (ch > 0) {
        g += ch;
      } else {
        l -= ch;
      }
    }
    if (l == 0) return 100;
    return 100 - 100 / (1 + (g / p) / (l / p));
  }

  // ══════════════════════════════════════════════════════════════════════
  // STEP 1 — MARKET STRUCTURE ENGINE
  // ══════════════════════════════════════════════════════════════════════
  EngineResult _runMarketStructureEngine() {
    if (_candles.length < 20) {
      return EngineResult(
        passed: false,
        quality: 0,
        status: 'FAIL',
        evidence: const ['Insufficient candle data (<20)'],
        summary: tr(
          'FAIL: بيانات غير كافية — رفض',
          'FAIL: Insufficient data — rejected',
        ),
      );
    }
    final adxD = _calculateAdxFull(14);
    final adx = adxD['adx']!;
    final atr = _calculateAtr(14);
    final avgR =
        _candles.map((c) => c.high - c.low).reduce((a, b) => a + b) /
        _candles.length;

    int dirChanges = 0;
    for (int i = max(2, _candles.length - 8); i < _candles.length; i++) {
      if ((_candles[i].close > _candles[i - 1].close) !=
          (_candles[i - 1].close > _candles[i - 2].close)) {
        dirChanges++;
      }
    }
    if (adx < 15 && dirChanges >= 4) {
      return EngineResult(
        passed: false,
        quality: 0,
        status: 'FAIL',
        evidence: const ['ADX < 15 + Erratic moves — Chaotic'],
        summary: tr(
          'FAIL: سوق عشوائي فوضوي — رفض فوري',
          'FAIL: Random chaotic market — instant rejection',
        ),
      );
    }
    if (adx < 15 && atr < avgR * 0.4) {
      return EngineResult(
        passed: false,
        quality: 0,
        status: 'FAIL',
        evidence: const ['ADX < 15 + Tight ATR — Sideways/Range'],
        summary: tr(
          'FAIL: سوق عرضي مضغوط — رفض',
          'FAIL: Tight sideways market — rejected',
        ),
      );
    }

    final sHigh = <double>[], sLow = <double>[];
    for (int i = 2; i < _candles.length - 2; i++) {
      if (_candles[i].high > _candles[i - 1].high &&
          _candles[i].high > _candles[i + 1].high &&
          _candles[i].high > _candles[i - 2].high &&
          _candles[i].high > _candles[i + 2].high) {
        sHigh.add(_candles[i].high);
      }
      if (_candles[i].low < _candles[i - 1].low &&
          _candles[i].low < _candles[i + 1].low &&
          _candles[i].low < _candles[i - 2].low &&
          _candles[i].low < _candles[i + 2].low) {
        sLow.add(_candles[i].low);
      }
    }

    if (sHigh.length < 2 || sLow.length < 2) {
      double q = adx > 20
          ? 62
          : adx > 17
          ? 45
          : 35;
      return EngineResult(
        passed: true,
        quality: q,
        status: 'PASS',
        evidence: ['Limited pivots', 'ADX ${adx.toStringAsFixed(0)}'],
        summary:
            'PASS: Limited Structure | ADX ${adx.toStringAsFixed(0)} | Q: ${q.toStringAsFixed(0)}',
      );
    }

    bool hh = sHigh.last > sHigh[sHigh.length - 2];
    bool hl = sLow.last > sLow[sLow.length - 2];
    bool lh = sHigh.last < sHigh[sHigh.length - 2];
    bool ll = sLow.last < sLow[sLow.length - 2];
    bool bosBull = _currentPrice > sHigh.last;
    bool bosBear = _currentPrice < sLow.last;

    String state;
    double quality;
    if (bosBull && hh && hl && adx > 25) {
      state = 'Strong Bull (BOS+HH+HL)';
      quality = 95;
    } else if (bosBear && lh && ll && adx > 25) {
      state = 'Strong Bear (BOS+LH+LL)';
      quality = 95;
    } else if (hh && hl && adx > 20) {
      state = 'Healthy Bull (HH+HL)';
      quality = 82;
    } else if (lh && ll && adx > 20) {
      state = 'Healthy Bear (LH+LL)';
      quality = 82;
    } else if (adx >= 17) {
      state = 'Partial Trend';
      quality = 55;
    } else {
      state = 'Weak Trend';
      quality = 38;
    }

    return EngineResult(
      passed: true,
      quality: quality,
      status: 'PASS',
      evidence: [
        'Structure: $state',
        'ADX: ${adx.toStringAsFixed(0)}',
        'BOS-Bull:$bosBull BOS-Bear:$bosBear',
      ],
      summary:
          'PASS: $state | ADX ${adx.toStringAsFixed(0)} | Q: ${quality.toStringAsFixed(0)}',
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // STEP 2 — MARKET REGIME ENGINE
  // ══════════════════════════════════════════════════════════════════════
  EngineResult _runMarketRegimeEngine() {
    final adxD = _calculateAdxFull(14);
    final adx = adxD['adx']!;
    final atr = _calculateAtr(14);
    final avgR = _candles.isNotEmpty
        ? _candles.map((c) => c.high - c.low).reduce((a, b) => a + b) /
              _candles.length
        : 0.0001;
    final bb = _calculateBollingerBands(20);
    final bbW = bb['upper']! - bb['lower']!;
    final bbWp = _currentPrice > 0 ? bbW / _currentPrice * 100 : 0;
    final volP = _analyzeVolumeProfile();
    final volR = (volP['ratio'] as double).clamp(0.0, 5.0);

    if (adx < 20) {
      return EngineResult(
        passed: false,
        quality: 0,
        status: 'FAIL',
        evidence: ['ADX ${adx.toStringAsFixed(0)} < 20'],
        summary: tr(
          'FAIL: Weak Trend Regime (ADX ${adx.toStringAsFixed(0)}) — رفض',
          'FAIL: Weak Trend Regime (ADX ${adx.toStringAsFixed(0)}) — rejected',
        ),
      );
    }
    if (bbWp < 0.12 && atr < avgR * 0.45) {
      return EngineResult(
        passed: false,
        quality: 0,
        status: 'FAIL',
        evidence: [
          'BB Width ${bbWp.toStringAsFixed(3)}% compressed',
          'ATR low',
        ],
        summary: tr(
          'FAIL: Compression Regime — رفض',
          'FAIL: Compression Regime — rejected',
        ),
      );
    }

    String regime;
    double quality;
    if (adx > 30 && bbWp > 0.25 && atr > avgR * 0.7 && volR > 1.4) {
      regime = 'Expansion';
      quality = 95;
    } else if (adx > 30 && bbWp > 0.25) {
      regime = 'Trending';
      quality = 88;
    } else if (adx >= 20) {
      regime = 'Trending';
      quality = 75;
    } else {
      regime = 'Pullback';
      quality = 70;
    }

    if (_candles.length >= 20) {
      double hi20 = _candles
          .sublist(_candles.length - 20)
          .map((c) => c.high)
          .reduce(max);
      double lo20 = _candles
          .sublist(_candles.length - 20)
          .map((c) => c.low)
          .reduce(min);
      if ((_currentPrice > hi20 * 0.9998 || _currentPrice < lo20 * 1.0002) &&
          volR > 1.3) {
        regime = 'Clean Breakout';
        quality = min(quality + 5, 100);
      }
    }
    return EngineResult(
      passed: true,
      quality: quality,
      status: 'PASS',
      evidence: [
        'Regime: $regime',
        'ADX: ${adx.toStringAsFixed(0)}',
        'BB%: ${bbWp.toStringAsFixed(3)}',
        'Vol: ${(volR * 100).toStringAsFixed(0)}%',
      ],
      summary:
          'PASS: $regime | ADX ${adx.toStringAsFixed(0)} | Q: ${quality.toStringAsFixed(0)}',
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // STEP 3 — HIGHER TIMEFRAME ENGINE  (H4 / H1 / M30 simulated)
  // ══════════════════════════════════════════════════════════════════════
  EngineResult _runHigherTimeframeEngine() {
    int tfSec = timeframeSeconds;
    final evid = <String>[];
    final votes = <int>[];

    void analyzeHtf(List<Candle> c, String label) {
      if (c.length < 8) return;
      final e9 = _emaOnList(c, min(9, c.length));
      final e21 = _emaOnList(c, min(21, c.length));
      final rsi = _rsiOnList(c, min(14, c.length - 1));
      if (e9 > e21 && rsi > 50) {
        votes.add(1);
        evid.add('$label: Bullish ↑');
      } else if (e9 < e21 && rsi < 50) {
        votes.add(-1);
        evid.add('$label: Bearish ↓');
      } else {
        votes.add(0);
        evid.add('$label: Neutral ↔');
      }
    }

    int fH4 = max(1, (14400 / tfSec).round());
    int fH1 = max(1, (3600 / tfSec).round());
    int fM30 = max(1, (1800 / tfSec).round());
    if (_candles.length >= fH4 * 3) {
      analyzeHtf(_aggregateCandles(fH4), 'H4-sim');
    }
    if (_candles.length >= fH1 * 3) {
      analyzeHtf(_aggregateCandles(fH1), 'H1-sim');
    }
    if (_candles.length >= fM30 * 3) {
      analyzeHtf(_aggregateCandles(fM30), 'M30-sim');
    }

    if (votes.isEmpty) {
      final e50 = _calculateEma(min(50, _candles.length));
      final e100 = _calculateEma(min(100, _candles.length));
      final e200 = _calculateEma(min(200, _candles.length));
      if (e50 > e100 && e100 > e200) {
        votes.add(1);
        evid.add('HTF-EMA proxy: Bullish');
      } else if (e50 < e100 && e100 < e200) {
        votes.add(-1);
        evid.add('HTF-EMA proxy: Bearish');
      } else {
        votes.add(0);
        evid.add('HTF-EMA proxy: Mixed');
      }
    }

    int bull = votes.where((v) => v == 1).length;
    int bear = votes.where((v) => v == -1).length;
    if (bull > 0 && bear > 0) {
      return EngineResult(
        passed: false,
        quality: 20,
        status: 'FAIL',
        evidence: evid,
        summary: tr(
          'FAIL: HTF Major Conflict (Bull:$bull Bear:$bear) — رفض',
          'FAIL: HTF Major Conflict (Bull:$bull Bear:$bear) — rejected',
        ),
      );
    }
    String dir = bull > bear
        ? 'Bullish'
        : (bear > bull ? 'Bearish' : 'Neutral');
    double q = (bull == votes.length || bear == votes.length) ? 90 : 72;
    return EngineResult(
      passed: true,
      quality: q,
      status: 'PASS',
      evidence: evid,
      summary: 'PASS: HTF $dir | Q: ${q.toStringAsFixed(0)}',
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // STEP 4 — MULTI-TIMEFRAME ENGINE
  // ══════════════════════════════════════════════════════════════════════
  EngineResult _runMultiTimeframeEngine() {
    int tfSec = timeframeSeconds;
    final evid = <String>[];
    final dirs = <int>[];
    final qs = <double>[];

    void analyzeMtf(List<Candle> c, String label) {
      if (c.length < 10) return;
      final e9 = _emaOnList(c, min(9, c.length));
      final e21 = _emaOnList(c, min(21, c.length));
      final rsi = _rsiOnList(c, min(14, c.length - 1));
      final fast = _emaOnList(c, min(12, c.length));
      final slow = _emaOnList(c, min(26, c.length));
      final hist = fast - slow;
      if (e9 > e21 && rsi > 50 && hist > 0) {
        dirs.add(1);
        qs.add(85);
        evid.add('$label: Bullish ✅');
      } else if (e9 < e21 && rsi < 50 && hist < 0) {
        dirs.add(-1);
        qs.add(85);
        evid.add('$label: Bearish ✅');
      } else {
        dirs.add(0);
        qs.add(50);
        evid.add('$label: Mixed');
      }
    }

    analyzeMtf(_candles, 'Base-TF');
    int f5 = max(1, (300 / tfSec).round());
    int f15 = max(1, (900 / tfSec).round());
    int f30 = max(1, (1800 / tfSec).round());
    if (f5 > 1 && _candles.length >= f5 * 5) {
      analyzeMtf(_aggregateCandles(f5), 'M5-sim');
    }
    if (f15 > 1 && _candles.length >= f15 * 5) {
      analyzeMtf(_aggregateCandles(f15), 'M15-sim');
    }
    if (f30 > 1 && _candles.length >= f30 * 5) {
      analyzeMtf(_aggregateCandles(f30), 'M30-sim');
    }

    if (dirs.isEmpty) {
      return const EngineResult(
        passed: false,
        quality: 0,
        status: 'FAIL',
        evidence: ['No MTF data'],
        summary: 'FAIL: No MTF data',
      );
    }
    int bull = dirs.where((v) => v == 1).length;
    int bear = dirs.where((v) => v == -1).length;
    int tot = dirs.length;
    if (bull > 0 && bear > 0 && bull / tot > 0.3 && bear / tot > 0.3) {
      return EngineResult(
        passed: false,
        quality: 0,
        status: 'FAIL',
        evidence: [...evid, 'MTF Major Conflict: $bull Bull / $bear Bear'],
        summary: tr(
          'FAIL: MTF Major Conflict — رفض',
          'FAIL: MTF Major Conflict — rejected',
        ),
      );
    }
    double avgQ = qs.reduce((a, b) => a + b) / qs.length;
    bool aligned = bull == tot || bear == tot;
    if (!aligned) avgQ *= 0.85;
    String dir = bull > bear
        ? 'Bullish'
        : (bear > bull ? 'Bearish' : 'Neutral');
    bool passed = avgQ >= 60;
    return EngineResult(
      passed: passed,
      quality: avgQ,
      status: passed ? 'PASS' : 'FAIL',
      evidence: evid,
      summary:
          '${passed ? "PASS" : "FAIL"}: MTF $dir | ${aligned ? "Perfect Alignment" : "Partial"} | Q: ${avgQ.toStringAsFixed(0)}',
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // STEP 5 — TREND ENGINE
  // ══════════════════════════════════════════════════════════════════════
  EngineResult _runTrendEngine() {
    final ema9 = _calculateEma(9);
    final ema20 = _calculateEma(min(20, _candles.length));
    final ema50 = _calculateEma(min(50, _candles.length));
    final ema100 = _calculateEma(min(100, _candles.length));
    final ema200 = _calculateEma(min(200, _candles.length));
    final vwap = _calculateVwap();
    final adxD = _calculateAdxFull(14);
    final adx = adxD['adx']!;
    final pDi = adxD['plusDi']!;
    final mDi = adxD['minusDi']!;
    final atr = _calculateAtr(14);

    if (adx < 17) {
      return EngineResult(
        passed: false,
        quality: 0,
        status: 'FAIL',
        evidence: ['ADX ${adx.toStringAsFixed(0)} < 17 — Trend too weak'],
        summary: tr(
          'FAIL: ADX ${adx.toStringAsFixed(0)} — Trend too weak — رفض',
          'FAIL: ADX ${adx.toStringAsFixed(0)} — Trend too weak — rejected',
        ),
      );
    }

    int bullPts = 0, bearPts = 0;
    if (ema9 > ema20) {
      bullPts++;
    } else {
      bearPts++;
    }
    if (ema20 > ema50) {
      bullPts++;
    } else {
      bearPts++;
    }
    if (ema50 > ema100) {
      bullPts++;
    } else {
      bearPts++;
    }
    if (ema100 > ema200) {
      bullPts++;
    } else {
      bearPts++;
    }

    if (bullPts == 2 && bearPts == 2) {
      return const EngineResult(
        passed: false,
        quality: 35,
        status: 'FAIL',
        evidence: ['EMA 9/20/50/100/200: Split 2/2 — Mixed Trend'],
        summary: 'FAIL: EMA Split 2/2 — Mixed Trend',
      );
    }

    bool isBull = bullPts > bearPts;
    bool perfect = bullPts == 4 || bearPts == 4;
    bool vwapOk =
        (isBull && _currentPrice > vwap) || (!isBull && _currentPrice < vwap);
    bool diOk = (isBull && pDi > mDi) || (!isBull && mDi > pDi);
    double midP = (_candles.last.high + _candles.last.low) / 2;
    bool stOk =
        (isBull && _currentPrice > midP - 3.0 * atr) ||
        (!isBull && _currentPrice < midP + 3.0 * atr);
    List<double> recentLows = _candles
        .sublist(max(0, _candles.length - 5))
        .map((c) => c.low)
        .toList();
    List<double> recentHighs = _candles
        .sublist(max(0, _candles.length - 5))
        .map((c) => c.high)
        .toList();
    bool sarOk = isBull
        ? _currentPrice > recentLows.reduce(min) - atr * 0.02
        : _currentPrice < recentHighs.reduce(max) + atr * 0.02;

    int confs =
        (perfect ? 2 : 1) +
        (vwapOk ? 1 : 0) +
        (diOk ? 1 : 0) +
        (stOk ? 1 : 0) +
        (sarOk ? 1 : 0);
    double quality = confs >= 5
        ? 95
        : confs == 4
        ? 88
        : confs == 3
        ? 80
        : confs == 2
        ? 65
        : 42;

    if (quality < 65) {
      return EngineResult(
        passed: false,
        quality: quality,
        status: 'FAIL',
        evidence: [
          'EMA: ${bullPts}B/${bearPts}Br',
          'ADX: ${adx.toStringAsFixed(0)}',
          '$confs/5 confirmations',
        ],
        summary:
            'FAIL: Trend Q ${quality.toStringAsFixed(0)} — $confs/5 confirmations',
      );
    }
    return EngineResult(
      passed: true,
      quality: quality,
      status: 'PASS',
      evidence: [
        'EMA: ${perfect ? "Perfect" : "Partial"} ${isBull ? "Bull" : "Bear"}',
        'ADX: ${adx.toStringAsFixed(0)} (${adx > 30 ? "Strong" : "Average"})',
        'VWAP:${vwapOk ? "✅" : "❌"} DI:${diOk ? "✅" : "❌"} SAR:${sarOk ? "✅" : "❌"}',
      ],
      summary:
          'PASS: ${adx > 30 ? "Strong" : "Average"} ${isBull ? "Bull" : "Bear"} Trend | Q: ${quality.toStringAsFixed(0)} | $confs/5',
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // SMART MONEY ENGINE — Institutional Footprint
  // ══════════════════════════════════════════════════════════════════════
  EngineResult _runSmartMoneyEngine(int direction) {
    bool isCall = direction > 0;
    final atr = _calculateAtr(14);
    final vwap = _calculateVwap();
    final evid = <String>[];
    final weak = <String>[];
    double score = 0;

    final sHigh = <double>[], sLow = <double>[];
    for (int i = 2; i < _candles.length - 2; i++) {
      if (_candles[i].high > _candles[i - 1].high &&
          _candles[i].high > _candles[i + 1].high &&
          _candles[i].high > _candles[i - 2].high &&
          _candles[i].high > _candles[i + 2].high) {
        sHigh.add(_candles[i].high);
      }
      if (_candles[i].low < _candles[i - 1].low &&
          _candles[i].low < _candles[i + 1].low &&
          _candles[i].low < _candles[i - 2].low &&
          _candles[i].low < _candles[i + 2].low) {
        sLow.add(_candles[i].low);
      }
    }

    // BOS (+20)
    bool bosBull = sHigh.isNotEmpty && _currentPrice > sHigh.last;
    bool bosBear = sLow.isNotEmpty && _currentPrice < sLow.last;
    if ((isCall && bosBull) || (!isCall && bosBear)) {
      score += 20;
      evid.add('BOS ${isCall ? "Bullish" : "Bearish"} confirmed ✅');
    } else {
      weak.add('BOS not confirmed');
    }

    // CHoCH (+15)
    if (sHigh.length >= 2 && sLow.length >= 2) {
      bool chBull =
          sHigh.last < sHigh[sHigh.length - 2] && _currentPrice > sHigh.last;
      bool chBear =
          sLow.last > sLow[sLow.length - 2] && _currentPrice < sLow.last;
      if ((isCall && chBull) || (!isCall && chBear)) {
        score += 15;
        evid.add('CHoCH ${isCall ? "Bullish" : "Bearish"} ✅');
      } else {
        weak.add('No CHoCH in trade direction');
      }
    }

    // Liquidity Sweep (+15)
    final lc = _candles.last;
    bool bullSweep =
        sLow.isNotEmpty && lc.low < sLow.last && lc.close > sLow.last;
    bool bearSweep =
        sHigh.isNotEmpty && lc.high > sHigh.last && lc.close < sHigh.last;
    if ((isCall && bullSweep) || (!isCall && bearSweep)) {
      score += 15;
      evid.add('Liquidity Sweep ${isCall ? "Below" : "Above"} ✅');
    } else {
      weak.add('No liquidity sweep');
    }

    // Order Block (+15)
    bool obFound = false;
    for (
      int i = _candles.length - min(15, _candles.length - 4);
      i < _candles.length - 3;
      i++
    ) {
      final ob = _candles[i];
      double obB = (ob.open - ob.close).abs();
      if (obB < 0.000001) continue;
      double futMv = _candles[min(i + 3, _candles.length - 1)].close - ob.close;
      bool bullOb =
          ob.close < ob.open &&
          futMv > obB * 1.2 &&
          _currentPrice >= ob.close &&
          _currentPrice <= ob.open;
      bool bearOb =
          ob.close > ob.open &&
          futMv < -obB * 1.2 &&
          _currentPrice <= ob.close &&
          _currentPrice >= ob.open;
      if ((isCall && bullOb) || (!isCall && bearOb)) {
        score += 15;
        evid.add('Order Block ${isCall ? "Demand" : "Supply"} ✅');
        obFound = true;
        break;
      }
    }
    if (!obFound) {
      weak.add('No valid Order Block at current price');
    }

    // FVG (+10)
    bool bullFvg =
        _candles.length >= 3 &&
        _candles[_candles.length - 3].high < _candles.last.low;
    bool bearFvg =
        _candles.length >= 3 &&
        _candles[_candles.length - 3].low > _candles.last.high;
    if ((isCall && bullFvg) || (!isCall && bearFvg)) {
      score += 10;
      evid.add('FVG ${isCall ? "Bullish" : "Bearish"} ✅');
    } else {
      weak.add('No FVG in direction');
    }

    // OTE 61.8%–78.6% (+10)
    int fibN = min(20, _candles.length);
    double fibHi = _candles
        .sublist(_candles.length - fibN)
        .map((c) => c.high)
        .reduce(max);
    double fibLo = _candles
        .sublist(_candles.length - fibN)
        .map((c) => c.low)
        .reduce(min);
    double fibR = fibHi - fibLo;
    if (fibR > 0 &&
        _currentPrice >= fibHi - fibR * 0.786 &&
        _currentPrice <= fibHi - fibR * 0.618) {
      score += 10;
      evid.add('OTE Zone (61.8%–78.6%) ✅');
    } else {
      weak.add('Price not in OTE zone');
    }

    // AMD (+5)
    if (_candles.length >= 9) {
      double t1 =
          _candles
              .sublist(_candles.length - 9, _candles.length - 6)
              .map((c) => c.high - c.low)
              .reduce((a, b) => a + b) /
          3;
      double t2 =
          _candles
              .sublist(_candles.length - 6, _candles.length - 3)
              .map((c) => c.high - c.low)
              .reduce((a, b) => a + b) /
          3;
      double t3 =
          _candles
              .sublist(_candles.length - 3)
              .map((c) => c.high - c.low)
              .reduce((a, b) => a + b) /
          3;
      if (t2 > t1 * 1.3 && t3 > t2 * 1.2) {
        score += 5;
        evid.add('AMD Pattern ✅');
      }
    }

    // Kill Zone (+5)
    int utcH = DateTime.now().toUtc().hour;
    if ((utcH >= 7 && utcH <= 10) || (utcH >= 12 && utcH <= 15)) {
      score += 5;
      evid.add('Kill Zone active ($utcH:00 UTC) ✅');
    } else {
      weak.add('Outside Kill Zone ($utcH:00 UTC)');
    }

    // VWAP Institutional Zone (+5)
    if (atr > 0 && (_currentPrice - vwap).abs() <= atr) {
      score += 5;
      evid.add('VWAP Institutional Zone ✅');
    }

    // Hard rejection: no BOS + no OB + no FVG
    bool noBos = !((isCall && bosBull) || (!isCall && bosBear));
    bool noFvg = !((isCall && bullFvg) || (!isCall && bearFvg));
    if (noBos && !obFound && noFvg) {
      return EngineResult(
        passed: false,
        quality: score.clamp(0, 100),
        status: 'FAIL',
        evidence: [...evid, ...weak.map((w) => '⚠ $w')],
        summary: tr(
          'FAIL: No BOS + No OB + No FVG — Zero SMC evidence — رفض',
          'FAIL: No BOS + No OB + No FVG — Zero SMC evidence — rejected',
        ),
      );
    }
    double quality = score.clamp(0, 100);
    if (quality < 35) {
      return EngineResult(
        passed: false,
        quality: quality,
        status: 'FAIL',
        evidence: [...evid, ...weak.map((w) => '⚠ $w')],
        summary: tr(
          'FAIL: SMC Quality ${quality.toStringAsFixed(0)} — Zero institutional evidence — رفض',
          'FAIL: SMC Quality ${quality.toStringAsFixed(0)} — Zero institutional evidence — rejected',
        ),
      );
    }
    return EngineResult(
      passed: true,
      quality: quality,
      status: 'PASS',
      evidence: [...evid, ...weak.map((w) => '⚠ $w')],
      summary:
          'PASS: SMC ${isCall ? "Bullish" : "Bearish"} | Q: ${quality.toStringAsFixed(0)} | Institutional Confidence HIGH',
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // PRICE ACTION ENGINE
  // ══════════════════════════════════════════════════════════════════════
  EngineResult _runPriceActionEngine(int direction) {
    bool isCall = direction > 0;
    final rsi = _calculateRsi(14);
    final stochK = _calculateStochastic(14, 3)['k']!;
    final cci = _calculateCci(20);
    final mfi = _calculateMfi(14);
    final cmf = _calculateCmf(20);
    final atr = _calculateAtr(14);
    final bb = _calculateBollingerBands(20);
    final sr = _calculateSupportResistance();
    final macdH = _calculateFullMacd()['histogram']!;
    final volD = _calculateVolumeDelta();
    final volP = _analyzeVolumeProfile();
    final volR = (volP['ratio'] as double).clamp(0.0, 5.0);
    final diverg = _detectRsiDivergence();
    final patt = _detectCandlePatterns();
    final liq = _calculateLiquidityZones();
    final evid = <String>[];
    double score = 0;

    // Pattern
    const strongBull = [
      'bullish_engulfing',
      'morning_star',
      'three_white_soldiers',
    ];
    const strongBear = [
      'bearish_engulfing',
      'evening_star',
      'three_black_crows',
    ];
    const medBull = ['hammer', 'pin_bar_bullish'];
    const medBear = ['shooting_star', 'pin_bar_bearish'];
    if ((isCall && strongBull.contains(patt)) ||
        (!isCall && strongBear.contains(patt))) {
      score += 20;
      evid.add('Pattern: ${patt.replaceAll("_", " ")} — Strong ✅');
    } else if ((isCall && medBull.contains(patt)) ||
        (!isCall && medBear.contains(patt))) {
      score += 12;
      evid.add('Pattern: ${patt.replaceAll("_", " ")} — Moderate ✅');
    } else if (patt == 'doji') {
      score -= 5;
      evid.add('Pattern: Doji — Indecision ⚠️');
    } else {
      evid.add('Pattern: ${patt.replaceAll("_", " ")} — No clear bias');
    }

    // RSI Divergence
    if ((isCall && diverg == 'bullish') || (!isCall && diverg == 'bearish')) {
      score += 15;
      evid.add('RSI $diverg Divergence ✅');
    }

    // S/R
    double atThr = atr > 0 ? atr * 1.5 : _currentPrice * 0.001;
    bool atSup = (_currentPrice - sr['support']!).abs() <= atThr;
    bool atRes = (_currentPrice - sr['resistance']!).abs() <= atThr;
    if ((isCall && (atSup || _currentPrice <= bb['lower']! * 1.001)) ||
        (!isCall && (atRes || _currentPrice >= bb['upper']! * 0.999))) {
      score += 15;
      evid.add('S/R: At ${isCall ? "Support/BB-Low" : "Resistance/BB-High"} ✅');
    } else {
      evid.add('S/R: No key level at price');
    }

    // Supply/Demand
    String liqZ = (liq['zone'] as String).toLowerCase();
    if ((isCall && (liq['score'] as double) > 60 && liqZ.contains('demand')) ||
        (!isCall && (liq['score'] as double) > 60 && liqZ.contains('supply'))) {
      score += 10;
      evid.add('S&D: Institutional ${isCall ? "Demand" : "Supply"} zone ✅');
    } else {
      evid.add('S&D: Not at key zone');
    }

    // Fibonacci
    int fibN = min(30, _candles.length);
    double fibHi = _candles
        .sublist(_candles.length - fibN)
        .map((c) => c.high)
        .reduce(max);
    double fibLo = _candles
        .sublist(_candles.length - fibN)
        .map((c) => c.low)
        .reduce(min);
    double fibR = fibHi - fibLo;
    if (fibR > 0) {
      double tol = atr * 1.5;
      final levels = {
        '23.6%': fibHi - fibR * 0.236,
        '38.2%': fibHi - fibR * 0.382,
        '50%': fibHi - fibR * 0.5,
        '61.8%': fibHi - fibR * 0.618,
        '78.6%': fibHi - fibR * 0.786,
      };
      String? hit;
      levels.forEach((k, v) {
        if ((_currentPrice - v).abs() <= tol) hit = k;
      });
      if (hit != null) {
        score += 8;
        evid.add('Fibonacci: Near $hit ✅');
      } else {
        evid.add('Fibonacci: No key level nearby');
      }
    }

    // Volume
    bool obvOk =
        (isCall && volP['trend'] == 'bullish') ||
        (!isCall && volP['trend'] == 'bearish');
    bool cmfOk = (isCall && cmf > 0.05) || (!isCall && cmf < -0.05);
    bool mfiOk = (isCall && mfi > 55) || (!isCall && mfi < 45);
    bool vdOk = (isCall && volD > 10) || (!isCall && volD < -10);
    int volConfs =
        (obvOk ? 1 : 0) + (cmfOk ? 1 : 0) + (mfiOk ? 1 : 0) + (vdOk ? 1 : 0);
    if (volConfs >= 3) {
      score += 12;
      evid.add(
        'Volume: $volConfs/4 confirmed ✅ Vol:${(volR * 100).toStringAsFixed(0)}%',
      );
    } else if (volConfs >= 2) {
      score += 6;
      evid.add('Volume: $volConfs/4 moderate');
    } else {
      evid.add('Volume: Weak ($volConfs/4)');
    }

    // Momentum
    bool rsiOk =
        (isCall && rsi > 50 && rsi < 70) || (!isCall && rsi < 50 && rsi > 30);
    bool macdOk = (isCall && macdH > 0) || (!isCall && macdH < 0);
    bool stochOk =
        (isCall && stochK > 50 && stochK < 80) ||
        (!isCall && stochK < 50 && stochK > 20);
    bool cciOk =
        (isCall && cci > 0 && cci < 150) || (!isCall && cci < 0 && cci > -150);
    int momConfs =
        (rsiOk ? 1 : 0) +
        (macdOk ? 1 : 0) +
        (stochOk ? 1 : 0) +
        (cciOk ? 1 : 0);
    if (momConfs >= 3) {
      score += 10;
      evid.add(
        'Momentum: $momConfs/4 confirmed ✅ RSI:${rsi.toStringAsFixed(0)}',
      );
    } else if (momConfs >= 2) {
      score += 5;
      evid.add('Momentum: $momConfs/4');
    } else {
      evid.add('Momentum: Weak ($momConfs/4)');
    }

    // Volatility
    double avgR = _candles.isNotEmpty
        ? _candles.map((c) => c.high - c.low).reduce((a, b) => a + b) /
              _candles.length
        : 0.0001;
    if (atr >= avgR * 0.5 && atr <= avgR * 3.0) {
      score += 5;
      evid.add('Volatility: ATR healthy ✅');
    } else if (atr < avgR * 0.3) {
      score -= 10;
      evid.add('Volatility: ATR dead market ⛔');
    } else {
      evid.add('Volatility: ATR elevated — caution');
    }

    double quality = score.clamp(0, 100);
    bool passed = quality >= 75;
    return EngineResult(
      passed: passed,
      quality: quality,
      status: passed ? 'PASS' : 'FAIL',
      evidence: evid,
      summary:
          '${passed ? "PASS" : "FAIL"}: PA Q: ${quality.toStringAsFixed(0)} | Patt:${patt.replaceAll("_", " ")} Mom:$momConfs/4',
    );
  }

  // ── HISTORICAL BACKTESTING ENGINE ────────────────────────────────
  VipHistoricalResult _runHistoricalEngine(int direction) {
    if (_candles.length < 20) {
      return VipHistoricalResult(
        passed: false,
        sampleSize: 0,
        winRate: 0,
        verdict: 'FAIL',
        summary: tr(
          'Historical: HISTORICAL DATA NOT AVAILABLE — بيانات غير كافية',
          'Historical: HISTORICAL DATA NOT AVAILABLE — insufficient data',
        ),
      );
    }

    final curRsi = _calculateRsi(14);
    final curMacdHist = _calculateFullMacd()['histogram']!;
    final curEma9 = _calculateEma(9);
    final curEma21 = _calculateEma(21);
    final curAdxData = _calculateAdxFull(14);
    final curAdx = curAdxData['adx']!;

    bool curEmaUp = curEma9 > curEma21;
    bool curRsiHigh = curRsi > 55;
    bool curRsiLow = curRsi < 45;
    bool curMacdBull = curMacdHist > 0;
    bool curStrTrend = curAdx > 20;

    int scanStart = 14;
    int scanEnd = _candles.length - 4;
    int sampleSize = 0, wins = 0, losses = 0;
    double totalDd = 0;

    for (int i = scanStart; i < scanEnd; i++) {
      int rPer = min(14, i);
      if (rPer < 3) continue;
      double g = 0, l = 0;
      for (int j = max(1, i - rPer + 1); j <= i; j++) {
        double ch = _candles[j].close - _candles[j - 1].close;
        if (ch > 0) {
          g += ch;
        } else {
          l -= ch;
        }
      }
      double hRsi = l == 0
          ? 100.0
          : 100.0 - (100.0 / (1.0 + (g / rPer) / (l / rPer)));

      double s9 = 0, s21 = 0;
      int c9 = 0, c21 = 0;
      for (int j = max(0, i - 8); j <= i; j++) {
        s9 += _candles[j].close;
        c9++;
      }
      for (int j = max(0, i - 20); j <= i; j++) {
        s21 += _candles[j].close;
        c21++;
      }
      bool hEmaUp = (c9 > 0 && c21 > 0) ? (s9 / c9) > (s21 / c21) : curEmaUp;

      double s26 = 0;
      int c26 = 0;
      for (int j = max(0, i - 25); j <= i; j++) {
        s26 += _candles[j].close;
        c26++;
      }
      bool hMacdBull = c9 > 0 && c26 > 0 && (s9 / c9) > (s26 / c26);

      double trSum = 0;
      int trCnt = 0;
      for (int j = max(1, i - 13); j <= i; j++) {
        double tr = max(
          _candles[j].high - _candles[j].low,
          max(
            (_candles[j].high - _candles[j - 1].close).abs(),
            (_candles[j].low - _candles[j - 1].close).abs(),
          ),
        );
        trSum += tr;
        trCnt++;
      }
      double avgTr = trCnt > 0 ? trSum / trCnt : 0;
      bool hStrTrend =
          avgTr > 0 && _currentPrice > 0 && (avgTr / _currentPrice) > 0.0002;

      int sim = 0;
      if (hEmaUp == curEmaUp) sim += 3;
      if ((hRsi > 55) == curRsiHigh && (hRsi < 45) == curRsiLow) sim += 2;
      if (hMacdBull == curMacdBull) sim += 2;
      if (hStrTrend == curStrTrend) sim += 1;
      if (sim < 6) continue;

      sampleSize++;
      int fi = min(i + 3, _candles.length - 1);
      double futureMove = _candles[fi].close - _candles[i].close;
      bool win =
          (direction > 0 && futureMove > 0) ||
          (direction < 0 && futureMove < 0);

      if (win) {
        wins++;
      } else {
        losses++;
        double entry = _candles[i].close;
        double worst = entry;
        for (int j = i + 1; j <= fi; j++) {
          if (direction > 0 && _candles[j].low < worst) worst = _candles[j].low;
          if (direction < 0 && _candles[j].high > worst) {
            worst = _candles[j].high;
          }
        }
        if (entry > 0) totalDd += (worst - entry).abs() / entry * 100;
      }
    }

    int total = wins + losses;
    if (sampleSize < 1) {
      return const VipHistoricalResult(
        passed: true,
        sampleSize: 0,
        winRate: 0.55,
        verdict: 'NEUTRAL',
        summary:
            'Historical: No similar setups — neutral (not blocking confidence)',
      );
    }
    double wr = total > 0 ? wins / total : 0;
    double avgDd = losses > 0 ? totalDd / losses : 0;
    if (wr < 0.50) {
      return VipHistoricalResult(
        passed: false,
        sampleSize: sampleSize,
        winRate: wr,
        verdict: 'FAIL',
        summary:
            'Historical FAIL ⛔: ${(wr * 100).toStringAsFixed(0)}% win | $sampleSize setups | (min 50%) — REJECT',
      );
    }
    return VipHistoricalResult(
      passed: true,
      sampleSize: sampleSize,
      winRate: wr,
      verdict: 'PASS ✅',
      summary:
          'Historical PASS ✅: ${(wr * 100).toStringAsFixed(0)}% win | $sampleSize setups | Avg DD ${avgDd.toStringAsFixed(2)}%',
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // CONSENSUS ENGINE — Final Decision
  // ══════════════════════════════════════════════════════════════════════
  VipAnalysisResult _runVipConsensusEngine() {
    // ── CRITICAL GATE: Market Structure (chaos/range filter only) ────
    final msR = _runMarketStructureEngine();
    if (!msR.passed) {
      return VipAnalysisResult(
        netScore: 0,
        confidence: 0,
        isApproved: false,
        overallScore: 0,
        grade: 'Rejected ❌',
        riskAssessment: '🔴 REJECTED — Chaotic/Range Market',
        scoreBreakdown: [msR.summary],
        rejectionReason: msR.summary,
        historical: null,
      );
    }

    // ── DIRECTION: 7-vote system (odd — no ties possible) ────────────
    final ema9 = _calculateEma(9);
    final ema21 = _calculateEma(21);
    final ema50 = _calculateEma(min(50, _candles.length));
    final vwap = _calculateVwap();
    final adxD = _calculateAdxFull(14);
    final cmf = _calculateCmf(20);
    final rsi = _calculateRsi(14);
    final macdH = _calculateFullMacd()['histogram']!;
    int bv = 0, brv = 0;
    if (ema9 > ema21) {
      bv++;
    } else {
      brv++;
    }
    if (ema21 > ema50) {
      bv++;
    } else {
      brv++;
    }
    if (adxD['plusDi']! > adxD['minusDi']!) {
      bv++;
    } else {
      brv++;
    }
    if (rsi > 50) {
      bv++;
    } else {
      brv++;
    }
    if (macdH > 0) {
      bv++;
    } else {
      brv++;
    }
    if (_currentPrice > vwap) {
      bv++;
    } else {
      brv++;
    }
    if (cmf > 0) {
      bv++;
    } else {
      brv++;
    }
    int direction = bv > brv ? 1 : -1;

    // ── SCORING ENGINES (all contribute weighted score) ───────────────
    final tR = _runTrendEngine();
    final mrR = _runMarketRegimeEngine();
    final htfR = _runHigherTimeframeEngine();
    final mtfR = _runMultiTimeframeEngine();
    final smR = _runSmartMoneyEngine(direction);
    final paR = _runPriceActionEngine(direction);

    // ── SEMI-CRITICAL: zero institutional evidence → reject ───────────
    if (!smR.passed) {
      return VipAnalysisResult(
        netScore: 0,
        confidence: 0,
        isApproved: false,
        overallScore: 0,
        grade: 'Rejected ❌',
        riskAssessment: '🔴 REJECTED — No Institutional Evidence',
        scoreBreakdown: [msR.summary, smR.summary],
        rejectionReason: smR.summary,
        historical: null,
      );
    }

    // ── COMPOSITE WEIGHTED SCORE ──────────────────────────────────────
    // Weights: SMC 30% | Trend 18% | HTF 12% | PA 12% | MS 10% | Regime 10% | MTF 8%
    double total =
        (smR.quality * 0.30 +
                tR.quality * 0.18 +
                htfR.quality * 0.12 +
                paR.quality * 0.12 +
                msR.quality * 0.10 +
                mrR.quality * 0.10 +
                mtfR.quality * 0.08)
            .clamp(0.0, 100.0);

    final fullBd = <String>[
      msR.summary,
      tR.summary,
      mrR.summary,
      htfR.summary,
      mtfR.summary,
      smR.summary,
      paR.summary,
      '📊 Composite: ${total.toStringAsFixed(1)}/100 | Direction: ${bv}B/${brv}Br',
    ];

    if (total < 58) {
      return VipAnalysisResult(
        netScore: 0,
        confidence: 0,
        isApproved: false,
        overallScore: total,
        grade: 'Rejected ❌',
        riskAssessment:
            '🔴 REJECTED — Score ${total.toStringAsFixed(0)}/100 (min 58)',
        scoreBreakdown: fullBd,
        rejectionReason:
            'Score ${total.toStringAsFixed(0)}/100 below threshold — WAIT',
        historical: null,
      );
    }

    // ── HISTORICAL VALIDATION ─────────────────────────────────────────
    final hist = _runHistoricalEngine(direction);
    if (!hist.passed) {
      return VipAnalysisResult(
        netScore: 0,
        confidence: 0,
        isApproved: false,
        overallScore: total,
        grade: 'Rejected ❌',
        riskAssessment:
            '🔴 REJECTED — Historical WR ${(hist.winRate * 100).toStringAsFixed(0)}% < 50%',
        scoreBreakdown: [...fullBd, hist.summary],
        rejectionReason: hist.summary,
        historical: hist,
      );
    }

    // ── HONEST CONFIDENCE (max 88%) ───────────────────────────────────
    double scorePct = ((total - 58.0) / 42.0).clamp(0.0, 1.0);
    double histPct = ((hist.winRate - 0.50) / 0.40).clamp(0.0, 1.0);
    double samplePct = hist.sampleSize.clamp(0, 10) / 10.0;
    int failCnt =
        (!tR.passed ? 1 : 0) +
        (!mrR.passed ? 1 : 0) +
        (!htfR.passed ? 1 : 0) +
        (!mtfR.passed ? 1 : 0) +
        (!paR.passed ? 1 : 0);
    double conflPen = failCnt >= 3
        ? 8.0
        : failCnt == 2
        ? 4.0
        : failCnt == 1
        ? 2.0
        : 0.0;
    double confidence =
        (50.0 + scorePct * 28.0 + histPct * 12.0 + samplePct * 5.0 - conflPen)
            .clamp(50.0, 88.0);

    String grade;
    if (total >= 92) {
      grade = 'Institutional Grade 🏛️';
    } else if (total >= 85)
      grade = 'Excellent ⭐⭐⭐⭐⭐';
    else if (total >= 75)
      grade = 'Very Good ⭐⭐⭐⭐';
    else
      grade = 'Acceptable ⭐⭐⭐';

    String risk = failCnt == 0 && confidence >= 72
        ? '🟢 Low — Score ${total.toStringAsFixed(0)} | WR ${(hist.winRate * 100).toStringAsFixed(0)}% | All Clear'
        : failCnt <= 1
        ? '🟡 Medium — $failCnt engine below optimal'
        : '🟠 Medium-High — $failCnt conflicts, reduce size';

    return VipAnalysisResult(
      netScore: direction * total,
      confidence: confidence,
      isApproved: true,
      overallScore: total,
      grade: grade,
      riskAssessment: risk,
      scoreBreakdown: [...fullBd, hist.summary],
      rejectionReason: '',
      historical: hist,
    );
  }

  // ── VIP score router ─────────────────────────────────────────────────────
  // If the admin uploaded a JSON strategy for VIP → use it (+ pyramid logic).
  // Otherwise → fall back to the built-in multi-layer consensus engine.
  double _scoreV3VipEngine() {
    if (_vipDynamic != null) {
      // JSON strategy is active — pyramid system handles everything
      return _evaluateRules(_vipDynamic!);
    }
    // No JSON strategy → built-in consensus engine
    final result = _runVipConsensusEngine();
    _vipLastResult = result;
    return result.isApproved ? result.netScore : 0.0;
  }

  @override
  void dispose() {
    _tickTimer?.cancel();
    _socialTimer?.cancel();
    super.dispose();
  }
}
