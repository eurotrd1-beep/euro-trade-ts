import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import '../constants.dart';
import '../services/language_service.dart';
import '../services/push_notifications.dart';
import '../widgets/particles.dart';
import '../widgets/trading_background.dart';

/// Language selection screen.
///
/// Shown once after the splash on first launch (when no language has been
/// chosen yet), and also reachable any time from the signals screen via the
/// language icon. When [next] is provided the screen advances to it after a
/// choice (first-launch flow); otherwise it simply pops back (settings flow).
class LanguageScreen extends StatelessWidget {
  final Widget? next;

  const LanguageScreen({super.key, this.next});

  Future<void> _choose(BuildContext context, AppLanguage lang) async {
    await LanguageService.set(lang);
    // Ask for notification permission once, right after the language choice
    // (this tap is the required user gesture). Fire-and-forget.
    PushNotifications.requestPermissionOnce();
    if (!context.mounted) return;
    if (next != null) {
      Navigator.of(context).pushReplacement(PageRouteBuilder(
        pageBuilder: (context, animation, _) => next!,
        transitionsBuilder: (_, anim, secondary, child) =>
            FadeTransition(opacity: anim, child: child),
        transitionDuration: const Duration(milliseconds: 600),
      ));
    } else {
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final selected = LanguageService.language.value; // null on first launch
    final canPop = next == null;

    return Scaffold(
      backgroundColor: AppConstants.spaceBackground,
      body: Stack(
        children: [
          const RepaintBoundary(child: TradingBackground()),
          const BackgroundParticles(),

          // Ambient neon glow
          Positioned(
            top: -160,
            right: -140,
            child: Container(
              width: 340,
              height: 340,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                    color: AppConstants.accentCyan.withAlpha(24),
                    blurRadius: 110,
                    spreadRadius: 20,
                  )
                ],
              ),
            ),
          ),

          if (canPop)
            SafeArea(
              child: Align(
                alignment: AlignmentDirectional.topStart,
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: IconButton(
                    icon: const Icon(Icons.arrow_back_ios_new_rounded,
                        color: AppConstants.textSecondary, size: 20),
                    onPressed: () => Navigator.of(context).maybePop(),
                  ),
                ),
              ),
            ),

          Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 40),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 84,
                    height: 84,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(22),
                      border: Border.all(
                        color: AppConstants.accentCyan.withAlpha(80),
                        width: 1.5,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: AppConstants.accentCyan.withAlpha(30),
                          blurRadius: 24,
                          spreadRadius: 3,
                        )
                      ],
                    ),
                    child: const Icon(Icons.language_rounded,
                        color: AppConstants.textPrimary, size: 42),
                  ),
                  const SizedBox(height: 28),
                  // Bilingual heading so it reads on first launch regardless of
                  // the (not-yet-chosen) language.
                  Text(
                    'اختر لغتك',
                    textAlign: TextAlign.center,
                    style: GoogleFonts.outfit(
                      fontSize: 24,
                      fontWeight: FontWeight.w800,
                      color: AppConstants.textPrimary,
                      letterSpacing: 0.5,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Choose your language',
                    textAlign: TextAlign.center,
                    style: GoogleFonts.outfit(
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                      color: AppConstants.textSecondary,
                      letterSpacing: 2,
                    ),
                  ),
                  const SizedBox(height: 40),
                  _LanguageTile(
                    flag: '🇸🇦',
                    title: 'العربية',
                    subtitle: 'Arabic',
                    selected: selected == AppLanguage.arabic,
                    onTap: () => _choose(context, AppLanguage.arabic),
                  ),
                  const SizedBox(height: 16),
                  _LanguageTile(
                    flag: '🇬🇧',
                    title: 'English',
                    subtitle: 'الإنجليزية',
                    selected: selected == AppLanguage.english,
                    onTap: () => _choose(context, AppLanguage.english),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _LanguageTile extends StatelessWidget {
  final String flag;
  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;

  const _LanguageTile({
    required this.flag,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Container(
          width: 340,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
          decoration: BoxDecoration(
            color: AppConstants.cardBgColor,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(
              color: selected
                  ? AppConstants.accentCyan
                  : AppConstants.borderGlow,
              width: selected ? 1.8 : 1.2,
            ),
            boxShadow: selected
                ? [
                    BoxShadow(
                      color: AppConstants.accentCyan.withAlpha(40),
                      blurRadius: 20,
                      spreadRadius: 1,
                    )
                  ]
                : null,
          ),
          child: Row(
            children: [
              Text(flag, style: const TextStyle(fontSize: 30)),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: GoogleFonts.outfit(
                        fontSize: 18,
                        fontWeight: FontWeight.w700,
                        color: AppConstants.textPrimary,
                      ),
                    ),
                    Text(
                      subtitle,
                      style: GoogleFonts.outfit(
                        fontSize: 12,
                        color: AppConstants.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
              Icon(
                selected
                    ? Icons.check_circle_rounded
                    : Icons.arrow_forward_ios_rounded,
                color: selected
                    ? AppConstants.accentCyan
                    : AppConstants.textSecondary,
                size: selected ? 24 : 16,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
