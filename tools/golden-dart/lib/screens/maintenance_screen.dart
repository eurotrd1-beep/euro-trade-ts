import 'dart:async';
import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:google_fonts/google_fonts.dart';
import '../constants.dart';
import '../services/language_service.dart';
import '../widgets/particles.dart';
import '../widgets/trading_background.dart';
import 'notice_screen.dart';
import 'main_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

class MaintenanceScreen extends StatefulWidget {
  const MaintenanceScreen({super.key});

  @override
  State<MaintenanceScreen> createState() => _MaintenanceScreenState();
}

class _MaintenanceScreenState extends State<MaintenanceScreen> {
  Timer? _countdownTimer;
  Duration _remaining = Duration.zero;
  String _message = tr('التطبيق متوقف مؤقتاً للصيانة، سنعود قريباً',
      'The app is temporarily down for maintenance. We\'ll be back soon.');
  StreamSubscription<List<Map<String, dynamic>>>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = Supabase.instance.client
        .from('configs')
        .stream(primaryKey: ['id'])
        .eq('id', 'maintenance')
        .listen((rows) {
      if (!mounted || rows.isEmpty) return;
      final d = rows.first['data'] as Map<String, dynamic>? ?? {};

      final isActive = d['isActive'] as bool? ?? false;
      if (!isActive) {
        _navigateAway();
        return;
      }
      final msg = d['message'] as String? ?? _message;
      DateTime? endsAt;
      final endsAtStr = d['endsAt'] as String?;
      if (endsAtStr != null) endsAt = DateTime.tryParse(endsAtStr);
      setState(() => _message = msg);
      if (endsAt != null) _startCountdown(endsAt);
    });
  }

  void _startCountdown(DateTime endsAt) {
    _countdownTimer?.cancel();
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      final rem = endsAt.difference(DateTime.now());
      if (rem.isNegative) {
        _countdownTimer?.cancel();
        setState(() => _remaining = Duration.zero);
      } else {
        setState(() => _remaining = rem);
      }
    });
  }

  Future<void> _navigateAway() async {
    _sub?.cancel();
    _countdownTimer?.cancel();
    final prefs = await SharedPreferences.getInstance();
    final isVerified = prefs.getBool(AppConstants.keyUserVerified) ?? false;
    final accountId  = prefs.getString(AppConstants.keyUserAccountId);
    if (!mounted) return;
    Navigator.of(context).pushReplacement(PageRouteBuilder(
      pageBuilder: (_, animation, secondary) =>
          (isVerified && accountId != null) ? const MainScreen() : const NoticeScreen(),
      transitionsBuilder: (_, anim, secondary, child) =>
          FadeTransition(opacity: anim, child: child),
      transitionDuration: const Duration(milliseconds: 600),
    ));
  }

  @override
  void dispose() {
    _sub?.cancel();
    _countdownTimer?.cancel();
    super.dispose();
  }

  String _formatDuration(Duration d) {
    final h = d.inHours;
    final m = d.inMinutes % 60;
    final s = d.inSeconds % 60;
    if (h > 0) return '$h:${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
    return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final hasCountdown = _remaining > Duration.zero;
    return Scaffold(
      backgroundColor: AppConstants.spaceBackground,
      body: Stack(
        children: [
          const RepaintBoundary(child: TradingBackground()),
          const BackgroundParticles(),
          Center(
            child: Padding(
              padding: const EdgeInsets.all(32.0),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Container(
                    width: 90, height: 90,
                    decoration: BoxDecoration(
                      color: AppConstants.putRed.withAlpha(20),
                      shape: BoxShape.circle,
                      border: Border.all(color: AppConstants.putRed.withAlpha(80), width: 2),
                    ),
                    child: const Icon(Icons.construction_rounded, color: AppConstants.putRed, size: 44),
                  ),
                  const SizedBox(height: 28),
                  Text(tr('جاري الصيانة', 'Under maintenance'),
                      style: GoogleFonts.outfit(
                          fontSize: 28, fontWeight: FontWeight.bold,
                          color: AppConstants.textPrimary)),
                  const SizedBox(height: 12),
                  Text(_message,
                      textAlign: TextAlign.center,
                      style: GoogleFonts.outfit(
                          fontSize: 14, color: AppConstants.textSecondary, height: 1.6)),
                  if (hasCountdown) ...[
                    const SizedBox(height: 28),
                    Text(tr('التطبيق سيعود خلال', 'The app will be back in'), style: GoogleFonts.outfit(fontSize: 12, color: AppConstants.textSecondary)),
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                      decoration: BoxDecoration(
                        color: AppConstants.cardBgColor,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppConstants.putRed.withAlpha(80)),
                      ),
                      child: Text(
                        _formatDuration(_remaining),
                        style: GoogleFonts.outfit(
                            fontSize: 32, fontWeight: FontWeight.bold,
                            color: AppConstants.putRed, letterSpacing: 4),
                      ),
                    ),
                  ],
                  const SizedBox(height: 40),
                  Text(tr('سيتم تحديث الصفحة تلقائياً عند انتهاء الصيانة', 'The page will refresh automatically when maintenance ends'),
                      style: GoogleFonts.outfit(fontSize: 11, color: AppConstants.textSecondary.withAlpha(140))),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
