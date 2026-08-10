import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'push_web_stub.dart' if (dart.library.js) 'push_web.dart' as pushweb;

/// Web Push notifications (works on Android via the browser/PWA — no APK).
///
/// Flow:
///  1. [requestPermissionOnce] — asked once, right after language selection.
///  2. [registerForUser] — once the account id is known (on the signals
///     screen): subscribes via the push service worker and stores the
///     subscription in Supabase `push_subscriptions`.
///  3. [notifyNewSignal] — when the engine fires a new signal, invokes the
///     `send-signal-notification` Edge Function, which delivers the push (so it
///     shows even when the tab/app is backgrounded).
///
/// The public VAPID key is read from the Supabase `configs` row `push`
/// (`{"vapidPublicKey": "..."}`), so keys can be rotated without shipping code.
class PushNotifications {
  static const String _promptedKey = 'push_permission_prompted';
  static String _vapidPublicKey = '';

  /// Whether the current platform/browser can do Web Push at all.
  static bool get isSupported => pushweb.isSupported();

  static Future<String> _getVapidPublicKey() async {
    if (_vapidPublicKey.isNotEmpty) return _vapidPublicKey;
    try {
      final row = await Supabase.instance.client
          .from('configs')
          .select('data')
          .eq('id', 'push')
          .maybeSingle()
          .timeout(const Duration(seconds: 5));
      final data = row?['data'] as Map<String, dynamic>? ?? {};
      _vapidPublicKey = (data['vapidPublicKey'] as String?)?.trim() ?? '';
    } catch (_) {}
    return _vapidPublicKey;
  }

  /// Prompts for notification permission a single time (guarded by a local
  /// flag). Best called from a user gesture — e.g. right after the user taps a
  /// language on the language screen.
  static Future<void> requestPermissionOnce() async {
    if (!isSupported) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getBool(_promptedKey) == true) return;
      await prefs.setBool(_promptedKey, true);
      await pushweb.requestPermission();
    } catch (_) {}
  }

  /// Subscribes this device to push and upserts the subscription for [userId].
  /// Safe to call repeatedly; does nothing if unsupported, permission isn't
  /// granted, or the admin hasn't configured a VAPID public key yet.
  static Future<void> registerForUser(String userId) async {
    if (!isSupported || userId.isEmpty || userId == '----') return;
    try {
      final key = await _getVapidPublicKey();
      if (key.isEmpty) return;
      final subJson = await pushweb.subscribe(key);
      if (subJson == null || subJson.isEmpty) return;
      final sub = jsonDecode(subJson) as Map<String, dynamic>;
      final endpoint = sub['endpoint'] as String?;
      if (endpoint == null || endpoint.isEmpty) return;
      await Supabase.instance.client.from('push_subscriptions').upsert(
        {
          'user_id': userId,
          'endpoint': endpoint,
          'subscription': sub,
        },
        onConflict: 'endpoint',
      );
    } catch (_) {}
  }

  /// Asks the Edge Function to deliver a push for a freshly-fired signal.
  /// Targets only [userId]'s subscriptions (pass an empty [userId] server-side
  /// to broadcast — see the function). [title]/[body] are already localized.
  static Future<void> notifyNewSignal({
    required String userId,
    required String title,
    required String body,
    String tag = 'euro-signal',
  }) async {
    if (userId.isEmpty || userId == '----') return;
    try {
      await Supabase.instance.client.functions.invoke(
        'send-signal-notification',
        body: {
          'user_id': userId,
          'title': title,
          'body': body,
          'url': pushweb.appUrl(),
          'tag': tag,
        },
      );
    } catch (_) {}
  }
}
