import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The two languages the app ships with. Arabic is the original/default;
/// English is the added translation.
enum AppLanguage { arabic, english }

/// App-wide language state + inline translation helper.
///
/// The whole UI keeps its Arabic strings inline and pairs each with an English
/// variant via the top-level [tr] helper, so switching language is instant and
/// requires no code-gen. [LanguageService.language] drives a [ValueListenableBuilder]
/// at the root of the app (see main.dart) so every screen rebuilds on change.
class LanguageService {
  static const String _prefsKey = 'app_language';

  /// `null` means the user has **not** chosen a language yet (first launch) —
  /// used by the splash flow to show the language-selection screen once.
  static final ValueNotifier<AppLanguage?> language =
      ValueNotifier<AppLanguage?>(null);

  /// True unless English was explicitly selected. Arabic is the fallback so the
  /// app still reads correctly if state is missing.
  static bool get isArabic => language.value != AppLanguage.english;

  static bool get hasChosen => language.value != null;

  static Locale get locale =>
      isArabic ? const Locale('ar') : const Locale('en');

  static TextDirection get direction =>
      isArabic ? TextDirection.rtl : TextDirection.ltr;

  /// Loads the persisted choice at startup. Leaves [language] as `null` when no
  /// choice has been made yet.
  static Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getString(_prefsKey);
      if (v == 'en') {
        language.value = AppLanguage.english;
      } else if (v == 'ar') {
        language.value = AppLanguage.arabic;
      }
    } catch (_) {}
  }

  /// Persists and applies a language choice; triggers a rebuild of the app.
  static Future<void> set(AppLanguage lang) async {
    language.value = lang;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_prefsKey, lang == AppLanguage.english ? 'en' : 'ar');
    } catch (_) {}
  }
}

/// Inline translation helper. Returns the Arabic [ar] or English [en] variant
/// depending on the currently selected language. Both variants may contain
/// string interpolation since they are evaluated at the call site.
String tr(String ar, String en) => LanguageService.isArabic ? ar : en;
