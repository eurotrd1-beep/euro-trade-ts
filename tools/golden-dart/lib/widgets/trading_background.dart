import 'dart:math';
import 'package:flutter/material.dart';
import '../constants.dart';

class TradingBackground extends StatelessWidget {
  const TradingBackground({super.key});

  @override
  Widget build(BuildContext context) {
    return SizedBox.expand(
      child: CustomPaint(
        painter: _TradingBackgroundPainter(),
      ),
    );
  }
}

class _TradingBackgroundPainter extends CustomPainter {
  // Pre-build text painters once to avoid recreation on every paint call.
  static final List<(String, Color)> _texts = [
    ('+94.7%', AppConstants.callGreen),
    ('+87.2%', AppConstants.callGreen),
    ('-12.3%', AppConstants.putRed),
    ('+96.1%', AppConstants.callGreen),
    ('+91.5%', AppConstants.callGreen),
    ('WIN',    AppConstants.callGreen),
    ('+78.9%', AppConstants.callGreen),
    ('CALL',   AppConstants.callGreen),
    ('PUT',    AppConstants.putRed),
  ];

  static final List<(String, double)> _symbols = [
    ('\$', 22.0), ('\$', 16.0), ('◆', 10.0), ('\$', 20.0), ('◆', 8.0),
  ];

  @override
  void paint(Canvas canvas, Size size) {
    _drawGrid(canvas, size);
    _drawCandlestickChart(canvas, size);
    _drawProfitTexts(canvas, size);
    _drawTrendArrows(canvas, size);
    _drawFloatingSymbols(canvas, size);
  }

  void _drawGrid(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = AppConstants.accentCyan.withAlpha(8)
      ..strokeWidth = 0.5;
    for (double y = 0; y < size.height; y += 60) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }
    for (double x = 0; x < size.width; x += 80) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
  }

  void _drawCandlestickChart(Canvas canvas, Size size) {
    final random = Random(7);
    final wickPaint = Paint()..strokeWidth = 1.0..style = PaintingStyle.stroke;
    final bodyPaint = Paint()..style = PaintingStyle.fill;

    final configs = [
      (size.height * 0.25, 12, 20),
      (size.height * 0.55, 10, 25),
      (size.height * 0.80,  8, 18),
    ];

    for (final (yCenter, alpha, count) in configs) {
      double basePrice = yCenter;
      final double candleWidth = size.width / (count + 2);
      for (int i = 0; i < count; i++) {
        final double x = (i + 1) * candleWidth;
        final double change = (random.nextDouble() - 0.48) * 30;
        final double open  = basePrice;
        final double close = basePrice + change;
        final bool isBull  = close < open;
        final double high  = min(open, close) - random.nextDouble() * 12;
        final double low   = max(open, close) + random.nextDouble() * 12;
        final color = isBull
            ? AppConstants.callGreen.withAlpha(alpha)
            : AppConstants.putRed.withAlpha(alpha);
        wickPaint.color = bodyPaint.color = color;
        canvas.drawLine(
          Offset(x + candleWidth * 0.3, high),
          Offset(x + candleWidth * 0.3, low),
          wickPaint,
        );
        canvas.drawRect(
          Rect.fromLTRB(
            x + candleWidth * 0.1, min(open, close),
            x + candleWidth * 0.5, max(open, close),
          ),
          bodyPaint,
        );
        basePrice = close;
      }
    }
  }

  void _drawProfitTexts(Canvas canvas, Size size) {
    final offsets = [
      Offset(size.width * 0.08, size.height * 0.12),
      Offset(size.width * 0.75, size.height * 0.08),
      Offset(size.width * 0.85, size.height * 0.45),
      Offset(size.width * 0.12, size.height * 0.72),
      Offset(size.width * 0.60, size.height * 0.88),
      Offset(size.width * 0.42, size.height * 0.15),
      Offset(size.width * 0.30, size.height * 0.92),
      Offset(size.width * 0.80, size.height * 0.70),
      Offset(size.width * 0.15, size.height * 0.42),
    ];

    for (int i = 0; i < _texts.length; i++) {
      final (text, color) = _texts[i];
      final tp = TextPainter(
        text: TextSpan(
          text: text,
          style: TextStyle(
            color: color.withAlpha(14),
            fontSize: text.length <= 4 ? 18 : 13,
            fontWeight: FontWeight.w900,
            letterSpacing: 2,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, offsets[i]);
    }
  }

  void _drawTrendArrows(Canvas canvas, Size size) {
    final paint = Paint()
      ..strokeWidth = 1.5
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    final up = [
      Offset(size.width * 0.20, size.height * 0.35),
      Offset(size.width * 0.70, size.height * 0.20),
      Offset(size.width * 0.50, size.height * 0.65),
      Offset(size.width * 0.90, size.height * 0.55),
    ];
    paint.color = AppConstants.callGreen.withAlpha(12);
    for (final p in up) {
      canvas.drawPath(
        Path()
          ..moveTo(p.dx, p.dy + 20)..lineTo(p.dx, p.dy)
          ..moveTo(p.dx - 6, p.dy + 7)..lineTo(p.dx, p.dy)
          ..lineTo(p.dx + 6, p.dy + 7),
        paint,
      );
    }

    final down = [
      Offset(size.width * 0.35, size.height * 0.50),
      Offset(size.width * 0.82, size.height * 0.35),
    ];
    paint.color = AppConstants.putRed.withAlpha(10);
    for (final p in down) {
      canvas.drawPath(
        Path()
          ..moveTo(p.dx, p.dy)..lineTo(p.dx, p.dy + 20)
          ..moveTo(p.dx - 6, p.dy + 13)..lineTo(p.dx, p.dy + 20)
          ..lineTo(p.dx + 6, p.dy + 13),
        paint,
      );
    }
  }

  void _drawFloatingSymbols(Canvas canvas, Size size) {
    final offsets = [
      Offset(size.width * 0.05, size.height * 0.55),
      Offset(size.width * 0.92, size.height * 0.18),
      Offset(size.width * 0.40, size.height * 0.78),
      Offset(size.width * 0.25, size.height * 0.18),
      Offset(size.width * 0.68, size.height * 0.60),
    ];

    for (int i = 0; i < _symbols.length; i++) {
      final (symbol, fontSize) = _symbols[i];
      final tp = TextPainter(
        text: TextSpan(
          text: symbol,
          style: TextStyle(
            color: AppConstants.accentCyan.withAlpha(10),
            fontSize: fontSize,
            fontWeight: FontWeight.bold,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, offsets[i]);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
