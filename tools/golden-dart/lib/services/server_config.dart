import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// Holds the backend proxy server URL, sourced dynamically from Supabase
/// `configs` so the admin can switch which Render server the app talks to —
/// instantly, with no rebuild or redeploy.
///
/// This single proxy hosts the OTC data path: candle history + scraper status
/// (`/api/otc/*`) and the live price WebSocket (`/ws`).
class ServerConfig {
  /// Fallback used until the config loads (points at the live proxy so the app
  /// works on first paint / if Supabase is unreachable).
  static const String defaultProxyUrl = 'https://euro-trade-proxy-1.onrender.com';

  /// Current proxy base URL (no trailing slash). Listen to this to react to
  /// admin changes (reconnect chart / re-fetch).
  static final ValueNotifier<String> proxyServerUrl =
      ValueNotifier<String>(defaultProxyUrl);

  static StreamSubscription? _sub;

  static String _clean(String? url) {
    final u = (url ?? '').trim();
    if (u.isEmpty) return '';
    // Strip a trailing slash so `$base/api/...` never doubles up.
    return u.endsWith('/') ? u.substring(0, u.length - 1) : u;
  }

  /// One-shot load at startup so the correct URL is ready before the chart builds.
  /// Prefers the `proxy_server_url` config row, falling back to the legacy
  /// `tv_server_url` row if the migration hasn't been applied yet.
  static Future<void> load() async {
    for (final id in const ['proxy_server_url', 'tv_server_url']) {
      try {
        final row = await Supabase.instance.client
            .from('configs')
            .select('data')
            .eq('id', id)
            .maybeSingle()
            .timeout(const Duration(seconds: 5));
        final data = row?['data'] as Map<String, dynamic>? ?? {};
        final url = _clean(data['url'] as String?);
        if (url.isNotEmpty) {
          proxyServerUrl.value = url;
          return;
        }
      } catch (_) {}
    }
  }

  /// Realtime subscription — pushes admin changes to every open app instantly.
  static void startRealtime() {
    _sub?.cancel();
    try {
      _sub = Supabase.instance.client
          .from('configs')
          .stream(primaryKey: ['id'])
          .eq('id', 'proxy_server_url')
          .listen((rows) {
        if (rows.isEmpty) return;
        final data = rows.first['data'] as Map<String, dynamic>? ?? {};
        final url = _clean(data['url'] as String?);
        if (url.isNotEmpty && url != proxyServerUrl.value) {
          proxyServerUrl.value = url;
        }
      });
    } catch (_) {}
  }

  static void dispose() {
    _sub?.cancel();
    _sub = null;
  }
}
