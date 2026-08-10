import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'supabase_config.dart';
import 'constants.dart';
import 'services/language_service.dart';
import 'services/server_config.dart';
import 'screens/splash_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // ── Global crash surfacing ────────────────────────────────────────────────
  // A single un-caught widget-build exception used to freeze the whole UI (chart
  // + live countdown stopped) with only an obfuscated `main.dart.js` trace in the
  // console. Surface the REAL Dart error, keep it from tearing down the app, and
  // replace the frozen render with a readable on-screen message per subtree.
  FlutterError.onError = (FlutterErrorDetails details) {
    FlutterError.dumpErrorToConsole(details);
    debugPrint('🔴 FlutterError: ${details.exceptionAsString()}');
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    debugPrint('🔴 Uncaught async error: $error\n$stack');
    return true; // handled → don't let it bubble up and kill the isolate
  };
  ErrorWidget.builder = (FlutterErrorDetails details) {
    return Material(
      color: const Color(0xFF0A0714),
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            'خطأ في العرض:\n${details.exceptionAsString()}',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Color(0xFFFF6B6B), fontSize: 13),
          ),
        ),
      ),
    );
  };

  try {
    await Supabase.initialize(url: supabaseUrl, anonKey: supabaseAnonKey);
  } catch (e) {
    debugPrint('Supabase init failed: $e');
  }
  await LanguageService.load();
  await ServerConfig.load();
  ServerConfig.startRealtime();
  await _loadAppTheme();
  runApp(const EuroTradeApp());
}

Future<void> _loadAppTheme() async {
  try {
    final row = await Supabase.instance.client
        .from('configs')
        .select('data')
        .eq('id', 'theme')
        .maybeSingle()
        .timeout(const Duration(seconds: 3));
    if (row != null) {
      final data = row['data'] as Map<String, dynamic>? ?? {};
      final primary   = data['primaryColor']   as int?;
      final secondary = data['secondaryColor'] as int?;
      if (primary   != null) AppConstants.accentCyan = Color(primary);
      if (secondary != null) AppConstants.accentBlue = Color(secondary);
    }
  } catch (_) {}
}

class EuroTradeApp extends StatelessWidget {
  const EuroTradeApp({super.key});

  @override
  Widget build(BuildContext context) {
    // Rebuild the whole app (and flip text direction) whenever the language
    // changes, so every inline tr() call re-evaluates.
    return ValueListenableBuilder<AppLanguage?>(
      valueListenable: LanguageService.language,
      builder: (context, lang, child) {
        return MaterialApp(
          title: 'Euro Trade - Premium VIP Signals',
          debugShowCheckedModeBanner: false,
          locale: LanguageService.locale,
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          supportedLocales: const [Locale('ar'), Locale('en')],
          theme: ThemeData(
            brightness: Brightness.dark,
            scaffoldBackgroundColor: AppConstants.spaceBackground,
            primaryColor: AppConstants.accentCyan,
            colorScheme: ColorScheme.dark(
              primary: AppConstants.accentCyan,
              secondary: AppConstants.accentBlue,
              surface: AppConstants.cardBgColor,
            ),
            dividerTheme: const DividerThemeData(
              color: AppConstants.borderGlow,
              thickness: 1.0,
            ),
            useMaterial3: true,
          ),
          home: const SplashScreen(),
        );
      },
    );
  }
}
