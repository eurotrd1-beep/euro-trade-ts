import 'dart:async';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:google_fonts/google_fonts.dart';
import '../constants.dart';
import '../services/language_service.dart';
import '../widgets/particles.dart';
import '../widgets/trading_background.dart';
import 'main_screen.dart';
import 'notice_screen.dart';
import 'maintenance_screen.dart';
import 'language_screen.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> with SingleTickerProviderStateMixin {
  late AnimationController _fadeController;
  late Animation<double> _fadeAnimation;
  late Animation<double> _scaleAnimation;

  @override
  void initState() {
    super.initState();
    _fadeController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    );

    _fadeAnimation = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(parent: _fadeController, curve: Curves.easeIn),
    );

    _scaleAnimation = Tween<double>(begin: 0.85, end: 1.0).animate(
      CurvedAnimation(parent: _fadeController, curve: Curves.fastOutSlowIn),
    );

    _fadeController.forward();
    _checkUserStatus();
  }

  Future<void> _checkUserStatus() async {
    final prefs = await SharedPreferences.getInstance();
    final isVerified = prefs.getBool(AppConstants.keyUserVerified) ?? false;
    final accountId  = prefs.getString(AppConstants.keyUserAccountId);

    // Run animation delay + Firestore checks concurrently
    final results = await Future.wait([
      Future.delayed(const Duration(milliseconds: 3200)),
      _fetchMaintenanceStatus(),
    ]);

    final maintenance = results[1] as Map<String, dynamic>?;
    final isMaintenanceActive = maintenance?['isActive'] as bool? ?? false;
    final endsAtRaw = maintenance?['endsAt'];
    final endsAt = endsAtRaw is String ? DateTime.tryParse(endsAtRaw) : null;
    final maintenanceStillActive =
        isMaintenanceActive && (endsAt == null || endsAt.isAfter(DateTime.now()));

    if (!mounted) return;

    if (maintenanceStillActive) {
      Navigator.of(context).pushReplacement(PageRouteBuilder(
        pageBuilder: (context, animation, _) => const MaintenanceScreen(),
        transitionsBuilder: (_, anim, secondary, child) => FadeTransition(opacity: anim, child: child),
        transitionDuration: const Duration(milliseconds: 600),
      ));
      return;
    }

    // Check user ban if logged in
    if (isVerified && accountId != null) {
      bool isBanned = false;
      String banReason = '';
      try {
        final userRow = await Supabase.instance.client
              .from('users').select().eq('id', accountId).maybeSingle();
        if (userRow != null) {
          isBanned  = userRow['is_banned'] as bool? ?? false;
          banReason = userRow['ban_reason'] as String? ?? '';
        }
      } catch (_) {}

      if (!mounted) return;
      if (isBanned) {
        _showBanDialog(banReason);
        return;
      }
    }

    if (!mounted) return;

    final Widget destination =
        (isVerified && accountId != null) ? const MainScreen() : const NoticeScreen();

    // First launch: show the language-selection screen once, then continue to
    // the resolved destination. On later launches go straight through.
    final Widget firstScreen = LanguageService.hasChosen
        ? destination
        : LanguageScreen(next: destination);

    Navigator.of(context).pushReplacement(
      PageRouteBuilder(
        pageBuilder: (context, animation, _) => firstScreen,
        transitionsBuilder: (_, anim, secondary, child) =>
            FadeTransition(opacity: anim, child: child),
        transitionDuration: const Duration(milliseconds: 800),
      ),
    );
  }

  Future<Map<String, dynamic>?> _fetchMaintenanceStatus() async {
    try {
      final row = await Supabase.instance.client
          .from('configs')
          .select('data')
          .eq('id', 'maintenance')
          .maybeSingle()
          .timeout(const Duration(seconds: 4));
      return row?['data'] as Map<String, dynamic>?;
    } catch (_) {}
    return null;
  }

  void _showBanDialog(String reason) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF111827),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: Row(children: [
          const Icon(Icons.block_rounded, color: Color(0xFFEF4444), size: 22),
          const SizedBox(width: 10),
          Text(tr('تم حظر حسابك', 'Your account is banned'), style: GoogleFonts.outfit(color: const Color(0xFFF9FAFB), fontWeight: FontWeight.bold)),
        ]),
        content: Text(
          reason.isNotEmpty
              ? tr('تم حظر حسابك من قِبَل الإدارة.\nالسبب: $reason', 'Your account has been banned by the administration.\nReason: $reason')
              : tr('تم حظر حسابك من قِبَل الإدارة.\nللمزيد من المعلومات تواصل مع الدعم.', 'Your account has been banned by the administration.\nContact support for more information.'),
          style: GoogleFonts.outfit(color: const Color(0xFF9CA3AF), height: 1.6),
        ),
        actions: [
          ElevatedButton(
            onPressed: () async {
              Navigator.pop(ctx);
              final prefs = await SharedPreferences.getInstance();
              await prefs.clear();
              if (mounted) {
                Navigator.of(context).pushReplacement(PageRouteBuilder(
                  pageBuilder: (context, animation, _) => const NoticeScreen(),
                  transitionsBuilder: (_, anim, secondary, child) => FadeTransition(opacity: anim, child: child),
                  transitionDuration: const Duration(milliseconds: 600),
                ));
              }
            },
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFFEF4444), foregroundColor: Colors.white),
            child: Text(tr('موافق', 'OK'), style: GoogleFonts.outfit(fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _fadeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppConstants.spaceBackground,
      body: Stack(
        children: [
          const RepaintBoundary(child: TradingBackground()),
          const BackgroundParticles(),
          
          // Diagonal Neon Ambient Glows
          Positioned(
            top: -150,
            left: -150,
            child: Container(
              width: 350,
              height: 350,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                    color: AppConstants.accentCyan.withAlpha(20),
                    blurRadius: 100,
                    spreadRadius: 20,
                  )
                ],
              ),
            ),
          ),
          Positioned(
            bottom: -150,
            right: -150,
            child: Container(
              width: 350,
              height: 350,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                    color: AppConstants.accentBlue.withAlpha(20),
                    blurRadius: 100,
                    spreadRadius: 20,
                  )
                ],
              ),
            ),
          ),

          // Main Center Content
          Center(
            child: FadeTransition(
              opacity: _fadeAnimation,
              child: ScaleTransition(
                scale: _scaleAnimation,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    // Premium Floating Trading Logo
                    Container(
                      width: 140,
                      height: 140,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(24),
                        boxShadow: [
                          BoxShadow(
                            color: AppConstants.accentCyan.withAlpha(30),
                            blurRadius: 30,
                            spreadRadius: 5,
                          )
                        ],
                        border: Border.all(
                          color: AppConstants.accentCyan.withAlpha(80),
                          width: 1.5,
                        ),
                      ),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(22),
                        child: Image.asset(
                          'assets/logo.jpg',
                          fit: BoxFit.cover,
                        ),
                      ),
                    ),
                    const SizedBox(height: 30),
                    
                    // App Title
                    Text(
                      'EURO TRADE',
                      style: GoogleFonts.outfit(
                        fontSize: 40,
                        fontWeight: FontWeight.w900,
                        letterSpacing: 6,
                        color: AppConstants.textPrimary,
                        shadows: [
                          Shadow(
                            color: AppConstants.accentCyan.withAlpha(120),
                            blurRadius: 20,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 10),
                    
                    // Subtitle
                    Text(
                      'PREMIUM VIP SIGNALS ENGINE',
                      style: GoogleFonts.outfit(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 4,
                        color: AppConstants.textSecondary,
                      ),
                    ),
                    
                    const SizedBox(height: 60),
                    // Glassmorphism Loading Indicator
                    SizedBox(
                      width: 180,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: LinearProgressIndicator(
                          color: AppConstants.accentCyan,
                          backgroundColor: AppConstants.borderGlow,
                          minHeight: 4,
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),
                    Text(
                      'Initializing VIP Server Sync...',
                      style: GoogleFonts.outfit(
                        fontSize: 11,
                        color: AppConstants.textSecondary.withAlpha(180),
                        letterSpacing: 1.5,
                      ),
                    )
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
