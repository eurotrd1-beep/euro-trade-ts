import 'dart:js' as js;

void openBrowserTab(String url) {
  try {
    js.context.callMethod('open', [url]);
  } catch (e) {
    print('Failed to open tab in web: $e');
  }
}

void evalJs(String code) {
  try {
    js.context.callMethod('eval', [code]);
  } catch (e) {
    print('Failed to evaluate JS in web: $e');
  }
}

void setUserBroker(String broker) {
  try {
    js.context.callMethod('setUserBroker', [broker]);
  } catch (_) {}
}

/// Point the live candle chart (window.CandleChart) at a new proxy
/// base URL. Applied to subsequent candle fetches / websocket connections.
void setChartProxy(String url) {
  try {
    final cc = js.context['CandleChart'];
    if (cc != null) cc.callMethod('setProxy', [url]);
  } catch (_) {}
}
