// Non-web fallback: push notifications are a Web Push feature, so these are
// no-ops on other platforms.

bool isSupported() => false;
Future<String> requestPermission() async => 'denied';
Future<String?> subscribe(String vapidPublicKey) async => null;
String appUrl() => '';
