import 'package:flutter/material.dart';
import '../constants.dart';

class PriceChart extends StatelessWidget {
  final String  symbol;
  final String  interval;
  final String  mode;
  final bool    guaranteedWin;
  final String? signalDirection;
  final double? signalEntryPrice;
  final int?    signalDurationMin;
  final int?    signalSecondsRemaining;
  final void Function(double Function() priceGetter)? onReady;

  const PriceChart({
    super.key,
    required this.symbol,
    this.interval               = '1m',
    this.mode                   = 'sim',
    this.guaranteedWin          = false,
    this.signalDirection,
    this.signalEntryPrice,
    this.signalDurationMin,
    this.signalSecondsRemaining,
    this.onReady,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 380,
      decoration: BoxDecoration(
        color: AppConstants.cardBgColor,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppConstants.borderGlow),
      ),
      child: const Center(
        child: Text(
          'Chart available on web only',
          style: TextStyle(color: AppConstants.textSecondary),
        ),
      ),
    );
  }
}
