import 'dart:math';
import 'package:flutter/material.dart';
import '../constants.dart';

class BackgroundParticles extends StatefulWidget {
  const BackgroundParticles({super.key});

  @override
  State<BackgroundParticles> createState() => _BackgroundParticlesState();
}

class _BackgroundParticlesState extends State<BackgroundParticles>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  final List<_Particle> _particles = [];
  final Random _random = Random();

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 10),
    )..repeat();

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final size = MediaQuery.of(context).size;
      for (int i = 0; i < 12; i++) {
        _particles.add(_Particle(
          x: _random.nextDouble() * size.width,
          y: _random.nextDouble() * size.height,
          radius: _random.nextDouble() * 2.5 + 0.8,
          speedX: (_random.nextDouble() - 0.5) * 0.35,
          speedY: (_random.nextDouble() - 0.5) * 0.35,
          color: _random.nextBool()
              ? AppConstants.accentCyan
                  .withAlpha((_random.nextDouble() * 55 + 18).toInt())
              : AppConstants.accentBlue
                  .withAlpha((_random.nextDouble() * 55 + 18).toInt()),
          screenWidth: size.width,
          screenHeight: size.height,
        ));
      }
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // RepaintBoundary isolates repaints to this layer only —
    // parent widget tree is never invalidated by particle animation.
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, child) {
          for (final p in _particles) {
            p.update();
          }
          return CustomPaint(
            painter: _ParticlePainter(_particles),
            size: Size.infinite,
          );
        },
      ),
    );
  }
}

class _Particle {
  double x, y, radius, speedX, speedY, screenWidth, screenHeight;
  Color color;

  _Particle({
    required this.x,
    required this.y,
    required this.radius,
    required this.speedX,
    required this.speedY,
    required this.color,
    required this.screenWidth,
    required this.screenHeight,
  });

  void update() {
    x += speedX;
    y += speedY;
    if (x < 0) x = screenWidth;
    if (x > screenWidth) x = 0;
    if (y < 0) y = screenHeight;
    if (y > screenHeight) y = 0;
  }
}

class _ParticlePainter extends CustomPainter {
  final List<_Particle> particles;

  _ParticlePainter(this.particles);

  @override
  void paint(Canvas canvas, Size size) {
    for (final p in particles) {
      canvas.drawCircle(
        Offset(p.x, p.y),
        p.radius,
        Paint()..color = p.color,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _ParticlePainter old) => true;
}
