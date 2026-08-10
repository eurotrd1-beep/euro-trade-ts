import 'dart:math';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

class AppConstants {
  // Central price formatting helper
  static String formatPrice(double price) {
    if (price >= 1000) return price.toStringAsFixed(2);
    if (price >= 10) return price.toStringAsFixed(3);
    return price.toStringAsFixed(5);
  }

  // A stable per-device/browser id (generated once, persisted locally). Used to
  // lock a VIP account to a single device.
  static const String keyDeviceId = 'device_id';
  static Future<String> getDeviceId() async {
    final prefs = await SharedPreferences.getInstance();
    var id = prefs.getString(keyDeviceId);
    if (id == null || id.isEmpty) {
      id = 'd${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}'
          '${Random().nextInt(0x7fffffff).toRadixString(36)}';
      await prefs.setString(keyDeviceId, id);
    }
    return id;
  }

  // --- Broker Affiliate Links ---
  static const String quotexAffiliateLink = 'https://broker-qx.pro/sign-up/?lid=2154439';
  static const String pocketOptionAffiliateLink = 'https://pocketoption.com/register/?utm_source=affiliate&a=VIPTRADER';
  static const String expertOptionAffiliateLink = 'https://expertoption-track.com/143787056';

  // --- Local Storage Keys ---
  static const String keyUserVerified = 'user_verified';
  static const String keyUserAccountId = 'user_account_id';
  static const String keyUserBroker = 'user_broker';

  // --- Premium Styling Color System ---
  static const Color spaceBackground = Color(0xFF0A0714);
  static const Color cardBgColor = Color(0xFF161129);
  static Color accentCyan = const Color(0xFF00FFF0);
  static Color accentBlue = const Color(0xFF1A8CFF);

  static const Color callGreen = Color(0xFF00FF7F);
  static const Color putRed = Color(0xFFFF2A6D);
  static const Color warningOrange = Color(0xFFFFAD00);

  static const Color textPrimary = Color(0xFFFFFFFF);
  static const Color textSecondary = Color(0xFF8B88A0);
  static const Color borderGlow = Color(0xFF2C2250);

  static const LinearGradient backgroundGradient = LinearGradient(
    colors: [Color(0xFF06030C), Color(0xFF0E091F), Color(0xFF05030A)],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );

  // --- Trading Pairs (Always populated locally, independent of the backend) ---
  // Pre-load fallback (Pocket Option / OTC). Uses the unified 5-category taxonomy
  // + source/enabled/is_otc keys; the Supabase `pairs` stream replaces this list
  // once it loads. Kept in sync with the admin's category names.
  static const List<Map<String, dynamic>> defaultCurrencyPairs = [
    // --- CURRENCIES (Pocket Option OTC) ---
    {'symbol': 'EUR/USD OTC', 'chartSymbol': 'EURUSD_otc', 'category': 'currencies', 'type': 'currencies', 'source': 'po', 'is_otc': true, 'enabled': true},
    {'symbol': 'GBP/USD OTC', 'chartSymbol': 'GBPUSD_otc', 'category': 'currencies', 'type': 'currencies', 'source': 'po', 'is_otc': true, 'enabled': true},
    {'symbol': 'USD/JPY OTC', 'chartSymbol': 'USDJPY_otc', 'category': 'currencies', 'type': 'currencies', 'source': 'po', 'is_otc': true, 'enabled': true},
    {'symbol': 'AUD/USD OTC', 'chartSymbol': 'AUDUSD_otc', 'category': 'currencies', 'type': 'currencies', 'source': 'po', 'is_otc': true, 'enabled': true},
    {'symbol': 'USD/CAD OTC', 'chartSymbol': 'USDCAD_otc', 'category': 'currencies', 'type': 'currencies', 'source': 'po', 'is_otc': true, 'enabled': true},
    {'symbol': 'AUD/CAD OTC', 'chartSymbol': 'AUDCAD_otc', 'category': 'currencies', 'type': 'currencies', 'source': 'po', 'is_otc': true, 'enabled': true},
    {'symbol': 'EUR/JPY OTC', 'chartSymbol': 'EURJPY_otc', 'category': 'currencies', 'type': 'currencies', 'source': 'po', 'is_otc': true, 'enabled': true},
    {'symbol': 'CAD/JPY OTC', 'chartSymbol': 'CADJPY_otc', 'category': 'currencies', 'type': 'currencies', 'source': 'po', 'is_otc': true, 'enabled': true},

    // --- COMMODITIES (Pocket Option OTC) ---
    {'symbol': 'Gold OTC', 'chartSymbol': 'XAUUSD_otc', 'category': 'commodities', 'type': 'commodities', 'source': 'po', 'is_otc': true, 'enabled': true},
    {'symbol': 'Silver OTC', 'chartSymbol': 'XAGUSD_otc', 'category': 'commodities', 'type': 'commodities', 'source': 'po', 'is_otc': true, 'enabled': true},
  ];

  static List<Map<String, dynamic>> currencyPairs = List.from(defaultCurrencyPairs);

  /// Maps a display pair name to its Pocket Option chart symbol
  /// (e.g. "EUR/USD" → "EURUSD", "Gold OTC" → "XAUUSD_otc").
  static String chartSymbolFor(String displaySymbol) {
    for (final p in currencyPairs) {
      if (p['symbol'] == displaySymbol) return p['chartSymbol'] as String;
    }
    // Fallback: drop the OTC marker + slash; re-append the PO "_otc" suffix if
    // the display name carried it.
    final isOtc = displaySymbol.toUpperCase().contains('OTC');
    final base = displaySymbol
        .replaceAll(RegExp(r'\s*\(?OTC\)?', caseSensitive: false), '')
        .replaceAll('/', '')
        .trim();
    return isOtc ? '${base}_otc' : base;
  }
}
