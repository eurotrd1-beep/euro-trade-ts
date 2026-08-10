// Web implementation: bridges to window.euroPush (see web/push/push_client.js)
// via dart:js. Subscription uses a poll-based API instead of Promise bridging,
// which is reliable across browsers and avoids dart:js Promise quirks.
import 'dart:async';
import 'dart:js' as js;

js.JsObject? get _ep {
  try {
    return js.context['euroPush'] as js.JsObject?;
  } catch (_) {
    return null;
  }
}

bool isSupported() {
  try {
    final ep = _ep;
    if (ep == null) return false;
    return ep.callMethod('isSupported', const []) == true;
  } catch (_) {
    return false;
  }
}

/// Fires the native permission prompt. We don't need the result here.
Future<String> requestPermission() async {
  try {
    _ep?.callMethod('requestPermission', const []);
  } catch (_) {}
  return 'default';
}

/// Starts subscription in JS and polls until it finishes, returning the
/// subscription JSON string (endpoint + keys) or null.
Future<String?> subscribe(String vapidPublicKey) async {
  final ep = _ep;
  if (ep == null) return null;
  try {
    ep.callMethod('startSubscribe', [vapidPublicKey]);
    // Poll up to ~14s (SW install + subscribe + permission prompt).
    for (var i = 0; i < 70; i++) {
      await Future.delayed(const Duration(milliseconds: 200));
      if (ep.callMethod('isDone', const []) == true) {
        final res = ep.callMethod('getResult', const []);
        return res as String?;
      }
    }
  } catch (_) {}
  return null;
}

String appUrl() {
  try {
    final ep = _ep;
    if (ep == null) return '';
    return (ep.callMethod('appUrl', const []) as String?) ?? '';
  } catch (_) {
    return '';
  }
}
