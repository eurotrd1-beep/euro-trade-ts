import 'dart:async';
// ignore: avoid_web_libraries_in_flutter
import 'dart:html' as html;
// ignore: avoid_web_libraries_in_flutter
import 'dart:js' as js;
import 'dart:ui_web' as ui;
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import '../constants.dart';
import '../services/language_service.dart';

class PriceChart extends StatefulWidget {
  final String  symbol;
  final String  interval;
  final String  mode;
  final bool    guaranteedWin;
  // Signal-driven trade (set by parent when signal fires)
  final String? signalDirection;   // 'CALL' | 'PUT' — null = no signal
  final double? signalEntryPrice;
  final int?    signalDurationMin;
  final int?    signalSecondsRemaining; // live countdown from signal engine
  // Called once after JS init; provides a closure to read the latest price
  final void Function(double Function() priceGetter)? onReady;

  const PriceChart({
    super.key,
    required this.symbol,
    this.interval              = '1m',
    this.mode                  = 'sim',
    this.guaranteedWin         = false,
    this.signalDirection,
    this.signalEntryPrice,
    this.signalDurationMin,
    this.signalSecondsRemaining,
    this.onReady,
  });

  @override
  State<PriceChart> createState() => _PriceChartState();
}

enum _TradeState { idle, active }

class _PriceChartState extends State<PriceChart> {
  late final String _id;

  _TradeState _tradeState  = _TradeState.idle;
  String  _direction       = '';
  double  _entryPrice      = 0;
  double  _currentPrice    = 0;
  int     _secondsLeft     = 0;
  int     _totalSeconds    = 0;
  Timer?  _countdownTimer;
  bool    _jsInitDone      = false;

  @override
  void initState() {
    super.initState();
    _id = 'cc-${DateTime.now().millisecondsSinceEpoch}';
    ui.platformViewRegistry.registerViewFactory(_id, (_) {
      final el = html.DivElement()
        ..id = _id
        ..style.width = '100%'
        ..style.height = '100%'
        ..style.backgroundColor = '#0A0714';
      // Prevent selection / iOS long-press image callout on the chart container.
      el.style.setProperty('user-select', 'none');
      el.style.setProperty('-webkit-user-select', 'none');
      el.style.setProperty('-webkit-touch-callout', 'none');
      el.onContextMenu.listen((e) => e.preventDefault());
      return el;
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_jsInitDone) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _jsInitDone = true;
      _jsInit();
    });
  }

  @override
  void didUpdateWidget(PriceChart old) {
    super.didUpdateWidget(old);

    // Symbol / interval / mode changed → restart chart
    if (old.symbol != widget.symbol ||
        old.interval != widget.interval ||
        old.mode != widget.mode) {
      if (_tradeState == _TradeState.active) _cancelTrade();
      _jsUpdate();
    }

    // Signal fired: direction changed to a new non-null value
    final newDir = widget.signalDirection;
    final oldDir = old.signalDirection;
    if (newDir != null &&
        newDir != 'WAIT' &&
        newDir != oldDir &&
        _tradeState == _TradeState.idle) {
      _autoOpenTrade(
        newDir,
        widget.signalEntryPrice ?? 0,
        widget.signalDurationMin ?? 1,
      );
    }
  }

  // ── JS bridge ─────────────────────────────────────────────────────────────

  void _jsInit() {
    try {
      js.context['CandleChart']
          ?.callMethod('init', [_id, widget.symbol, widget.interval, widget.mode]);
      widget.onReady?.call(_getLastPrice);
    } catch (_) {}
  }

  void _jsUpdate() {
    try {
      js.context['CandleChart']
          ?.callMethod('update', [_id, widget.symbol, widget.interval, widget.mode]);
    } catch (_) {}
  }

  double _getLastPrice() {
    try {
      final v = js.context['CandleChart']?.callMethod('getLastPrice', [_id]);
      if (v != null) return (v as num).toDouble();
    } catch (_) {}
    return 0;
  }

  void _setEntryLine(double? price, String direction) {
    try {
      js.context['CandleChart']?.callMethod(
        'setEntryLine',
        [_id, price, direction.isEmpty ? null : direction],
      );
    } catch (_) {}
  }

  void _jsTradeState({required bool active}) {
    try {
      js.context['CandleChart']?.callMethod('setTradeState', [
        _id,
        active,
        active ? _direction : '',
        active ? _entryPrice : 0.0,
        active ? _secondsLeft : 0,
        active && widget.guaranteedWin, // gwin applies to both sim and OTC
      ]);
    } catch (_) {}
  }

  // ── Trade logic ────────────────────────────────────────────────────────────

  int _candleIntervalSec() {
    switch (widget.interval) {
      case '5m':  return 300;
      case '15m': return 900;
      case '1h':  return 3600;
      case '1D':  return 86400;
      default:    return 60;
    }
  }

  /// Auto-opens a trade driven by the signal engine.
  void _autoOpenTrade(String direction, double entryPrice, int durationMin) {
    // Always use chart's actual live price — signal engine price may diverge
    final chartPrice = _getLastPrice();
    final price = chartPrice > 0 ? chartPrice : entryPrice;
    if (price == 0) return;
    entryPrice = price;
    // Use live secondsRemaining from signal engine if available,
    // otherwise align to the next candle boundary.
    int totalSec;
    if (widget.signalSecondsRemaining != null && widget.signalSecondsRemaining! > 0) {
      totalSec = widget.signalSecondsRemaining!;
    } else {
      final intervalSec = _candleIntervalSec();
      final nowSec = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final secsIntoCandle = nowSec % intervalSec;
      final secsRemaining  = intervalSec - secsIntoCandle;
      totalSec = secsRemaining + (durationMin - 1) * intervalSec;
    }
    setState(() {
      _tradeState   = _TradeState.active;
      _direction    = direction;
      _entryPrice   = entryPrice;
      _currentPrice = entryPrice;
      _secondsLeft  = totalSec;
      _totalSeconds = totalSec;
    });
    _setEntryLine(entryPrice, direction);
    _jsTradeState(active: true);
    _startCountdown();
  }

  void _startCountdown() {
    _countdownTimer?.cancel();
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) { t.cancel(); return; }
      final cp = _getLastPrice();
      setState(() {
        _secondsLeft--;
        if (cp > 0) _currentPrice = cp;
      });
      _jsTradeState(active: true);
      if (_secondsLeft <= 0) {
        t.cancel();
        _closeTrade();
      }
    });
  }

  void _cancelTrade() {
    _countdownTimer?.cancel();
    _jsTradeState(active: false);
    _setEntryLine(null, '');
    setState(() {
      _tradeState   = _TradeState.idle;
      _currentPrice = 0;
    });
  }

  void _closeTrade() {
    _jsTradeState(active: false);
    _setEntryLine(null, '');
    setState(() {
      _tradeState   = _TradeState.idle;
      _currentPrice = 0;
    });
    // Dialog is shown by MainScreen via signal engine — no duplicate needed
  }


  // ── UI ─────────────────────────────────────────────────────────────────────

  @override
  void dispose() {
    _countdownTimer?.cancel();
    try { js.context['CandleChart']?.callMethod('destroy', [_id]); } catch (_) {}
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        SizedBox(height: 300, child: HtmlElementView(viewType: _id)),
        _buildTradeBar(),
      ],
    );
  }

  Widget _buildTradeBar() {
    if (_tradeState != _TradeState.active) return const SizedBox.shrink();
    return Container(
      decoration: BoxDecoration(
        color: AppConstants.cardBgColor,
        border: Border(top: BorderSide(color: AppConstants.borderGlow, width: 1)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: _buildActiveBar(),
    );
  }

  // ── Active bar (with live P&L card) ───────────────────────────────────────

  Widget _buildActiveBar() {
    final isCall   = _direction == 'CALL';
    final color    = isCall ? AppConstants.callGreen : AppConstants.putRed;
    final progress = _totalSeconds > 0 ? _secondsLeft / _totalSeconds : 0.0;
    final mins     = _secondsLeft ~/ 60;
    final secs     = _secondsLeft % 60;
    final timeStr  =
        '${mins.toString().padLeft(2, '0')}:${secs.toString().padLeft(2, '0')}';

    // P&L
    final hasLive   = _currentPrice > 0 && _entryPrice > 0;
    final diff      = hasLive ? (_currentPrice - _entryPrice) : 0.0;
    final isWinning = isCall ? diff > 0 : diff < 0;
    final plColor   = isWinning ? AppConstants.callGreen : AppConstants.putRed;

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        // ── Top row: direction | entry | countdown ──
        Row(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: color.withAlpha(25),
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: color.withAlpha(100)),
              ),
              child: Text(
                isCall ? '▲ CALL' : '▼ PUT',
                style: GoogleFonts.outfit(
                    fontSize: 13, fontWeight: FontWeight.bold, color: color),
              ),
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(tr('دخول', 'Entry'),
                    style: GoogleFonts.outfit(
                        fontSize: 10, color: AppConstants.textSecondary)),
                Text(AppConstants.formatPrice(_entryPrice),
                    style: GoogleFonts.outfit(
                        fontSize: 13,
                        fontWeight: FontWeight.bold,
                        color: AppConstants.textPrimary)),
              ],
            ),
            const Spacer(),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(tr('الوقت المتبقي', 'Time left'),
                    style: GoogleFonts.outfit(
                        fontSize: 10, color: AppConstants.textSecondary)),
                Text(timeStr,
                    style: GoogleFonts.outfit(
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                        color: _secondsLeft <= 10
                            ? AppConstants.putRed
                            : AppConstants.accentCyan,
                        fontFeatures: [const FontFeature.tabularFigures()])),
              ],
            ),
          ],
        ),
        const SizedBox(height: 8),

        // ── Progress bar ──
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: progress,
            minHeight: 5,
            backgroundColor: AppConstants.borderGlow,
            valueColor: AlwaysStoppedAnimation<Color>(color),
          ),
        ),

        // ── Live P&L card ──
        if (hasLive) ...[
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: plColor.withAlpha(18),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: plColor.withAlpha(70)),
            ),
            child: Row(
              children: [
                // Current price
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(tr('السعر الحالي', 'Current price'),
                        style: GoogleFonts.outfit(
                            fontSize: 9, color: AppConstants.textSecondary)),
                    Text(AppConstants.formatPrice(_currentPrice),
                        style: GoogleFonts.outfit(
                            fontSize: 14,
                            fontWeight: FontWeight.bold,
                            color: AppConstants.textPrimary)),
                  ],
                ),
                const Spacer(),
                // Trend icon
                Icon(
                  isWinning
                      ? Icons.trending_up_rounded
                      : Icons.trending_down_rounded,
                  color: plColor,
                  size: 22,
                ),
                const SizedBox(width: 8),
                // Win / Loss label
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(tr('النتيجة الآن', 'Result now'),
                        style: GoogleFonts.outfit(
                            fontSize: 9, color: AppConstants.textSecondary)),
                    Text(
                      isWinning ? tr('رابح ✅', 'Winning ✅') : tr('خاسر ❌', 'Losing ❌'),
                      style: GoogleFonts.outfit(
                          fontSize: 13,
                          fontWeight: FontWeight.bold,
                          color: plColor),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
