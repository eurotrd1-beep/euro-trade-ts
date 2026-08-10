import 'dart:async';
import 'dart:math';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:google_fonts/google_fonts.dart';
import '../utils/web_utils.dart';
import '../constants.dart';
import '../services/signal_engine.dart';
import '../services/language_service.dart';
import '../services/push_notifications.dart';
import '../services/server_config.dart';
import '../widgets/particles.dart';
import '../widgets/trading_background.dart';
import '../widgets/price_chart.dart';
import 'notice_screen.dart';
import 'maintenance_screen.dart';
import 'language_screen.dart';

/// Result of a market-hours check: whether it's open + (if closed) the next
/// open time in UTC.
class MarketStatus {
  final bool open;
  final DateTime? nextOpenUtc;
  const MarketStatus(this.open, [this.nextOpenUtc]);
}

/// Pure, UTC-based market-hours calculator per asset category.
///   • OTC (any) + real crypto → 24/7 (never closed)
///   • Currencies (forex)      → Sun 22:00 → Fri 22:00 UTC (closed weekends)
///   • Stocks / Indices        → Mon-Fri 13:30-20:00 UTC (US 9:30-16:00 ET)
///   • Commodities             → forex hours minus a 1h daily break (21:00 UTC)
class MarketHours {
  static const _arDays = [
    '',
    'الاثنين',
    'الثلاثاء',
    'الأربعاء',
    'الخميس',
    'الجمعة',
    'السبت',
    'الأحد',
  ];
  static const _enDays = [
    '',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ];

  static MarketStatus statusFor(String category, bool isOtc) {
    if (isOtc) return const MarketStatus(true); // OTC never closes
    final now = DateTime.now().toUtc();
    switch (category) {
      case 'crypto':
        return const MarketStatus(true); // real crypto is 24/7
      case 'stocks':
      case 'indices':
        return _usEquity(now);
      case 'commodities':
        return _commodities(now);
      case 'currencies':
      default:
        return _forex(now);
    }
  }

  static MarketStatus _forex(DateTime now) {
    final wd = now.weekday, h = now.hour;
    bool open;
    if (wd == DateTime.saturday) {
      open = false;
    } else if (wd == DateTime.sunday) {
      open = h >= 22;
    } else if (wd == DateTime.friday) {
      open = h < 22;
    } else {
      open = true;
    }
    return MarketStatus(open, open ? null : _nextSundayOpen(now));
  }

  static MarketStatus _commodities(DateTime now) {
    final fx = _forex(now);
    if (!fx.open) return fx;
    if (now.hour == 21) {
      return MarketStatus(
        false,
        DateTime.utc(now.year, now.month, now.day, 22),
      );
    }
    return const MarketStatus(true);
  }

  static MarketStatus _usEquity(DateTime now) {
    final wd = now.weekday;
    final mins = now.hour * 60 + now.minute;
    const openMin = 13 * 60 + 30, closeMin = 20 * 60;
    final weekday = wd >= DateTime.monday && wd <= DateTime.friday;
    if (weekday && mins >= openMin && mins < closeMin) {
      return const MarketStatus(true);
    }
    return MarketStatus(false, _nextEquityOpen(now));
  }

  static DateTime _nextSundayOpen(DateTime now) {
    var d = DateTime.utc(now.year, now.month, now.day, 22);
    while (d.weekday != DateTime.sunday || !d.isAfter(now)) {
      d = d.add(const Duration(days: 1));
      d = DateTime.utc(d.year, d.month, d.day, 22);
    }
    return d;
  }

  static DateTime _nextEquityOpen(DateTime now) {
    final openToday = DateTime.utc(now.year, now.month, now.day, 13, 30);
    if (now.isBefore(openToday) && now.weekday <= DateTime.friday) {
      return openToday;
    }
    var day = DateTime.utc(now.year, now.month, now.day);
    do {
      day = day.add(const Duration(days: 1));
    } while (day.weekday == DateTime.saturday ||
        day.weekday == DateTime.sunday);
    return DateTime.utc(day.year, day.month, day.day, 13, 30);
  }

  /// "Opens [Day] at HH:MM" in the device's local timezone.
  static String nextOpenLabel(DateTime? nextOpenUtc) {
    if (nextOpenUtc == null) return '';
    final l = nextOpenUtc.toLocal();
    final hh = l.hour.toString().padLeft(2, '0');
    final mm = l.minute.toString().padLeft(2, '0');
    return tr(
      'يفتح ${_arDays[l.weekday]} الساعة $hh:$mm',
      'Opens ${_enDays[l.weekday]} at $hh:$mm',
    );
  }
}

class MainScreen extends StatefulWidget {
  const MainScreen({super.key});

  @override
  State<MainScreen> createState() => _MainScreenState();
}

class _MainScreenState extends State<MainScreen> with WidgetsBindingObserver {
  late SignalEngine _signalEngine;
  String _userAccountId = '----';
  String _userBroker = 'Quotex';
  bool _soundEnabled = true;
  String _selectedCategory = 'currencies';
  int _selectedMinutes = 1;
  double Function()? _livePriceGetter;
  TradingSignal? _lastProcessedSignal;
  TradingSignal? _lastPushedSignal; // guards against duplicate push per signal
  String _searchQuery = '';
  String _historyFilter = 'today';
  DateTimeRange? _customDateRange;
  // _roleListener stays a realtime subscription (needs instant ban/delete/VIP).
  StreamSubscription<List<Map<String, dynamic>>>? _roleListener;
  // The rest are rarely-changing admin config/pairs reads. They were realtime
  // .stream()s, but a transient DB blip made ALL of them re-subscribe + re-fetch
  // at once → a 522/CORS error storm in the console + extra DB churn. They're now
  // 30s polls (Timer), which never storm. Timer.cancel() matches the old API.
  // Realtime subscriptions (NOT polling). Polling these every 30s per user ate
  // ~5.6GB Egress in 2 days; realtime sends only the initial snapshot + deltas.
  StreamSubscription<List<Map<String, dynamic>>>? _maintenanceListener;
  StreamSubscription<List<Map<String, dynamic>>>? _stdStrategyListener;
  StreamSubscription<List<Map<String, dynamic>>>? _vipStrategyListener;
  StreamSubscription<List<Map<String, dynamic>>>? _monStdStrategyListener;
  StreamSubscription<List<Map<String, dynamic>>>? _monVipStrategyListener;
  StreamSubscription<List<Map<String, dynamic>>>? _chartModeListener;
  StreamSubscription<List<Map<String, dynamic>>>? _pairsListener;
  StreamSubscription<List<Map<String, dynamic>>>? _priceSystemListener;
  StreamSubscription<List<Map<String, dynamic>>>? _displaySourceListener;
  String _chartMode = 'sim';
  // Admin System Settings (configs, live): price source + which source shows.
  String?
  _priceSystemRaw; // 'simulator' | 'scraping' (null = fall back to chart_settings)
  String _displaySource = 'all'; // 'po' | 'all'
  String _activeChartSymbol = '';
  String _brokerLogoUrl = '';
  bool _updateChecked = false;

  // Cached Supabase stream for the social-links footer. MUST be created once and
  // reused — building it inline in build() spawned a brand-new realtime
  // subscription + REST snapshot fetch on EVERY rebuild (60/s while the chart
  // animates), hammering the `configs` table and helping choke the database.
  Stream<List<Map<String, dynamic>>>? _socialStream;
  Stream<List<Map<String, dynamic>>> get _socialCfgStream =>
      _socialStream ??= Supabase.instance.client
          .from('configs')
          .stream(primaryKey: ['id'])
          .eq('id', 'social');

  Timer? _marketStatusTimer;
  // OTC chartSymbol → true when Pocket Option marks it closed (po=false). Rebuilt
  // from /api/otc/status each poll; used to lock closed pairs in the asset picker.
  Map<String, bool> _closedPairs = {};
  Timer? _realCandlesTimer;
  Timer? _accountCheckTimer;
  // ── Background realtime suspend (frees the Supabase connection slot when the
  // tab/app is hidden). _rtBackgrounded guards against double subscribe/resume;
  // _bgSuspendTimer debounces so a quick tab-flick never reconnects needlessly.
  bool _rtBackgrounded = false;
  Timer? _bgSuspendTimer;
  bool _marketOpen = true; // optimistic default until first poll
  // OTC data health: true while the OTC scraper is repairing/reconnecting/down,
  // so we block new-signal requests on stale/incomplete OTC data.
  bool _otcUnhealthy = false;
  bool _marketClosedDialogShown = false;
  bool _marketClosedDialogOpen = false;
  String _nextOpenLabel =
      ''; // "يفتح الاثنين الساعة 12:00" for the closed dialog

  // --- VIP expiry handling ---
  Timer? _vipExpiryTimer;
  bool _vipExpiredDialogShown = false; // guard: expired dialog shows once
  bool _vipReminderShown = false; // guard: 24h reminder shows once per session
  bool _vipDowngradeInFlight = false; // avoid duplicate Supabase updates
  String _telegramContact = '';

  // --- Promotional announcement (admin-controlled, configs/promo) ---
  bool _promoChecked = false; // fetch & decide only once per session

  // --- Account-deletion detection ---
  bool _userRowSeen = false; // we've seen our users row at least once
  bool _accountDeletedHandled = false; // guard so the dialog shows only once

  // --- VIP single-device lock ---
  String _deviceId = ''; // this device/browser id
  bool _deviceMismatchHandled = false; // guard so the kick happens once

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _signalEngine = SignalEngine();
    _signalEngine.addListener(_onSignalEngineUpdate);
    _loadUserData();
    _startMaintenanceListener();

    // Apply the current proxy URL to the chart, and react live when
    // the admin switches servers (Supabase realtime → ServerConfig).
    setChartProxy(ServerConfig.proxyServerUrl.value);
    ServerConfig.proxyServerUrl.addListener(_onProxyUrlChanged);

    _selectedCategory = 'currencies';
    // Do NOT default to a hardcoded pair (e.g. EUR/USD). The real
    // pair list comes from the admin `pairs` table via _startPairsListener; until
    // it arrives (and if the admin enabled nothing) we show an empty state. This
    // starts empty so the first shown pair is the first ENABLED pair (PO or TV),
    // never a stale default.
    AppConstants.currencyPairs = [];

    // Server-driven market status: poll immediately, then every 5s.
    _startMarketStatusPolling();

    // Feed REAL OHLC candles into the signal engine so indicators/rules compute
    // on the real market (scraping mode). Refreshes every 3s + on demand.
    _syncEngineCandles();
    _realCandlesTimer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => _syncEngineCandles(),
    );
  }

  // Admin switched the proxy server: point the live chart at it
  // (chart.js reconnects tv-mode charts itself) and re-check market status so
  // the new server's `marketOpen` is picked up immediately.
  void _onProxyUrlChanged() {
    setChartProxy(ServerConfig.proxyServerUrl.value);
    _pollMarketStatus();
  }

  // Loads the real OHLC candle series for the active pair+timeframe from the
  // Supabase `candles` table (key `<chartSymbol>_<interval>`) and hands it to the
  // engine. In simulator mode it falls back to the engine's synthetic candles.
  Future<void> _syncEngineCandles() async {
    if (!mounted) return;
    if (_effectivePriceSystem == 'simulator') {
      _signalEngine.disableRealCandles();
      return;
    }
    final sym = _activeChartSymbol;
    if (sym.isEmpty) return;
    final iv = _signalEngine.chartTimeframe;
    try {
      final proxyUrl = ServerConfig.proxyServerUrl.value.replaceAll(
        RegExp(r'/$'),
        '',
      );
      final res = await http
          .get(Uri.parse('$proxyUrl/api/otc/candles?symbol=$sym&interval=$iv'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final data = body['candles'] as List?;
      if (data == null || data.isEmpty) return; // keep current buffer
      final candles = <Candle>[];
      for (final e in data) {
        if (e is! Map) continue;
        final o = (e['o'] as num?)?.toDouble();
        final h = (e['h'] as num?)?.toDouble();
        final l = (e['l'] as num?)?.toDouble();
        final c = (e['c'] as num?)?.toDouble();
        final t = (e['t'] as num?)?.toInt();
        if (o == null || h == null || l == null || c == null || t == null) {
          continue;
        }
        candles.add(
          Candle(
            open: o,
            high: h,
            low: l,
            close: c,
            time: DateTime.fromMillisecondsSinceEpoch(t * 1000),
            volume: 1000.0,
          ),
        );
      }
      if (candles.isNotEmpty && mounted) _signalEngine.setRealCandles(candles);
    } catch (_) {}
  }

  // ── Market status polling ────────────────────────────────────────────────

  /// Strips any exchange prefix and '/' to get the bare symbol the proxy expects
  /// (e.g. "EURUSD_otc" -> "EURUSDOTC" style is kept as-is; "BTC/USDT" -> "BTCUSDT").
  String _bareSymbol() {
    var s = _activeChartSymbol.isNotEmpty
        ? _activeChartSymbol
        : AppConstants.chartSymbolFor(_signalEngine.activePair);
    final colon = s.indexOf(':');
    if (colon != -1) s = s.substring(colon + 1);
    return s.replaceAll('/', '').replaceAll(' (OTC)', '').trim();
  }

  // True when Pocket Option currently marks this pair closed (po=false). Matched
  // case-tolerantly against the cached status (PO keys keep their exact case).
  bool _isPairClosed(Map<String, dynamic> pair) {
    final cs = (pair['chartSymbol'] as String? ?? '').trim();
    if (cs.isEmpty) return false;
    if (_closedPairs[cs] == true) return true;
    final lc = cs.toLowerCase();
    for (final e in _closedPairs.entries) {
      if (e.key.toLowerCase() == lc) return e.value;
    }
    return false;
  }

  void _startMarketStatusPolling() {
    _marketStatusTimer?.cancel();
    _pollMarketStatus(); // immediate poll so closed market shows instantly
    _marketStatusTimer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => _pollMarketStatus(),
    );
  }

  /// True when the active pair comes from Pocket Option (source 'po'). Its data
  /// + market status come from Supabase (the PO scraper) — the app is
  /// Pocket-Option-only now.
  bool _isActiveOtc() {
    final cs = _activeChartSymbol.isNotEmpty
        ? _activeChartSymbol
        : AppConstants.chartSymbolFor(_signalEngine.activePair);
    final p = AppConstants.currencyPairs.firstWhere(
      (e) => (e['chartSymbol'] as String? ?? '') == cs,
      orElse: () => const <String, dynamic>{},
    );
    return (p['source'] as String? ?? 'po') == 'po';
  }

  // Look up a symbol in the otc_prices map tolerantly: PO keys keep their exact
  // case (lowercase "_otc", e.g. "EURJPY_otc", "#AAPL_otc"), so an upper-cased
  // lookup misses them → the pair looked "unhealthy" though its chart was live.
  Map<String, dynamic>? _otcEntry(Map<String, dynamic> prices, String sym) {
    final direct = prices[sym];
    if (direct is Map<String, dynamic>) return direct;
    final lc = sym.toLowerCase();
    for (final k in prices.keys) {
      if (k.toLowerCase() == lc) return prices[k] as Map<String, dynamic>?;
    }
    return null;
  }

  // The active pair's row (category / isOtc / source) from the loaded list.
  Map<String, dynamic> _activePairInfo() {
    final cs = _activeChartSymbol.isNotEmpty
        ? _activeChartSymbol
        : AppConstants.chartSymbolFor(_signalEngine.activePair);
    return AppConstants.currencyPairs.firstWhere(
      (e) => (e['chartSymbol'] as String? ?? '') == cs,
      orElse: () => const <String, dynamic>{},
    );
  }

  Future<void> _pollMarketStatus() async {
    final sym = _bareSymbol();
    if (sym.isEmpty) return;

    final info = _activePairInfo();

    // Startup guard: the pairs list is empty until the Supabase stream arrives,
    // so _activePairInfo() returns {} and the pair is unknown. Until we actually
    // know the pair, treat as OPEN (24/7 for
    // the default OTC pair); the next poll re-decides once the info is loaded.
    if (info.isEmpty) {
      _otcUnhealthy = false;
      _nextOpenLabel = '';
      if (mounted) _applyMarketStatus(true);
      return;
    }

    final source = info['source'] as String? ?? 'po';

    // All pairs are Pocket Option now. Market-closed depends ONLY on PO's own
    // N/A flag (`po`) — no time rules:
    //   po === false → N/A → market CLOSED (chart shows closed + live room closes)
    //   otherwise    → fully live (last 100 candles) + room open.
    // Any non-'po' row (shouldn't happen) is treated as open.
    if (source != 'po') {
      _otcUnhealthy = false;
      _nextOpenLabel = '';
      if (mounted) _applyMarketStatus(true);
      return;
    }
    bool open = true;
    try {
      final proxyUrl = ServerConfig.proxyServerUrl.value.replaceAll(
        RegExp(r'/$'),
        '',
      );
      final res = await http
          .get(Uri.parse('$proxyUrl/api/otc/status'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return;
      final rows = jsonDecode(res.body) as List;
      final row = rows.firstWhere(
        (r) => r['id'] == 'otc_prices',
        orElse: () => null,
      );
      final prices = (row?['data'] as Map<String, dynamic>?) ?? {};
      // Cache every pair's closed state (po=false) so the asset picker can lock
      // pairs Pocket Option has marked closed, not just the active one.
      final closedMap = <String, bool>{};
      prices.forEach((k, v) {
        if (v is Map && v['po'] == false) closedMap[k] = true;
      });
      _closedPairs = closedMap;
      final entry = _otcEntry(prices, sym);
      final t = (entry?['t'] as num?)?.toInt() ?? 0;
      final nowSec = DateTime.now().toUtc().millisecondsSinceEpoch ~/ 1000;
      // Only flag "reconnecting" on a REAL stall. Prices refresh ~sub-second, but
      // brief scraper reconnects / proxy redeploys / poll jitter can leave the
      // last sample a few seconds old — a 20s window fired the banner constantly.
      // 60s still blocks a genuine outage while ignoring normal blips.
      _otcUnhealthy = !(entry != null && (nowSec - t) < 60);
      // ONLY the N/A flag closes the market. Missing flag/data ⇒ open.
      open = entry?['po'] != false;
      final no = (entry?['no'] as num?)?.toInt() ?? 0;
      _nextOpenLabel = (!open && no > 1000000000)
          ? MarketHours.nextOpenLabel(
              DateTime.fromMillisecondsSinceEpoch(no * 1000, isUtc: true),
            )
          : '';
    } catch (_) {
      return; // couldn't read prices → keep previous state (never false-close)
    }
    if (!mounted) return;
    _applyMarketStatus(open);
  }

  void _applyMarketStatus(bool open) {
    final wasOpen = _marketOpen;
    _marketOpen = open;
    // Keep the engine flag reconciled with the server every poll (the engine may
    // also set it closed internally via its analysis path).
    _signalEngine.setMarketClosed(!open);

    if (!open) {
      // (Re-)entering closed state. Show dialog once per closed episode.
      if (wasOpen && !_marketClosedDialogShown) {
        _marketClosedDialogShown = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && !_marketClosedDialogOpen) {
            _showMarketClosedDialog(context);
          }
        });
      }
    } else if (!wasOpen) {
      // closed → open: reset guard and dismiss the dialog if it's showing.
      _marketClosedDialogShown = false;
      if (_marketClosedDialogOpen && mounted) {
        Navigator.of(context, rootNavigator: true).pop();
        _marketClosedDialogOpen = false;
      }
    }
  }

  Future<void> _loadUserData() async {
    final prefs = await SharedPreferences.getInstance();
    // No stored account → the neutral sentinel (same as elsewhere), NOT a real
    // account id — otherwise a partial storage wipe would silently inherit that
    // account's role/VIP/device-lock/push.
    final accountId =
        prefs.getString(AppConstants.keyUserAccountId) ?? '----';
    final brokerName = prefs.getString(AppConstants.keyUserBroker) ?? 'Quotex';
    setState(() {
      _userAccountId = accountId;
      _userBroker = brokerName;
    });
    _deviceId = await AppConstants.getDeviceId();
    _signalEngine.setAccountId(accountId);
    _loadTelegramContact();
    _startRoleListener(accountId);
    _startAccountExistenceCheck(accountId);
    _startVipExpiryWatch(accountId);
    _startStrategyListeners();
    _startChartModeListener();
    _startSettingsListeners();
    _startPairsListener();
    _loadBrokerLogo(brokerName);
    setUserBroker(brokerName);
    // Subscribe this device to Web Push for the logged-in account (no-op if
    // unsupported, permission not granted, or VAPID not configured yet).
    PushNotifications.registerForUser(accountId);
    // Delay update check so it doesn't block startup rendering
    Future.delayed(const Duration(seconds: 2), () => _checkForUpdate());
    // Promotional announcement: fetch & decide once, after account id is known.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _maybeShowPromo();
    });
  }

  Future<void> _loadBrokerLogo(String brokerName) async {
    try {
      final rows = await Supabase.instance.client
          .from('brokers')
          .select('logo_url')
          .eq('name', brokerName)
          .limit(1);
      if ((rows as List).isNotEmpty && mounted) {
        final url = rows.first['logo_url'] as String? ?? '';
        if (url.isNotEmpty) setState(() => _brokerLogoUrl = url);
      }
    } catch (_) {}
  }

  void _startRoleListener(String accountId) {
    try {
      _roleListener?.cancel();
      _roleListener = Supabase.instance.client
          .from('users')
          .stream(primaryKey: ['id'])
          .eq('id', accountId)
          .listen(
            (rows) async {
              if (!mounted) return;
              // Account deleted by the admin → the row disappears. Once we've seen
              // the row at least once, an empty emission means deletion → kick the
              // user out to the login screen (auto logout).
              if (rows.isEmpty) {
                if (_userRowSeen) _handleAccountDeleted();
                return;
              }
              _userRowSeen = true;
              final data = rows.first;

              final isBanned = data['is_banned'] as bool? ?? false;
              final banReason = data['ban_reason'] as String? ?? '';
              if (isBanned) {
                _roleListener?.cancel();
                _maintenanceListener?.cancel();
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (mounted) _showBanDialog(banReason);
                });
                return;
              }

              final newRole = data['role'] ?? 'standard';

              // VIP is locked to ONE device. Enforce at runtime (covers sessions
              // that were already open before VIP was activated). Standard accounts
              // are never device-locked — they work everywhere.
              if (newRole == 'vip' && _deviceId.isNotEmpty) {
                final storedDevice = (data['device_id'] as String?) ?? '';
                if (storedDevice.isEmpty) {
                  // First VIP device → claim this device.
                  try {
                    await Supabase.instance.client
                        .from('users')
                        .update({'device_id': _deviceId})
                        .eq('id', accountId);
                  } catch (_) {}
                } else if (storedDevice != _deviceId) {
                  // Another device owns this VIP account → kick this one out.
                  _handleDeviceMismatch();
                  return;
                }
              }

              final vipExpiryStr = data['vip_expiry'] as String?;
              DateTime? newExpiry;
              if (vipExpiryStr != null) {
                newExpiry = DateTime.tryParse(vipExpiryStr);
              }

              final guaranteedWin = data['guaranteed_win'] as bool? ?? false;
              _signalEngine.updateGuaranteedWin(guaranteedWin);

              final prefs = await SharedPreferences.getInstance();
              await prefs.setString('user_role', newRole);
              if (newExpiry != null) {
                await prefs.setString(
                  'vip_expiry',
                  newExpiry.toIso8601String(),
                );
              } else {
                await prefs.remove('vip_expiry');
              }

              _signalEngine.updateUserData(newRole, newExpiry);

              // Re-evaluate VIP expiry whenever the row changes (covers admin
              // edits to role/vip_expiry while the session is open).
              _evaluateVipExpiry(newRole, newExpiry);
            },
            onError: (e) {
              // A transient Supabase blip (503/522, realtime drop) must NOT surface
              // as an uncaught error. Swallow it and re-arm the listener after a
              // short delay so it recovers once the DB is healthy again.
              debugPrint('role listener transient error: $e');
              _roleListener?.cancel();
              _roleListener = null;
              Future.delayed(const Duration(seconds: 5), () {
                if (mounted) _startRoleListener(accountId);
              });
            },
          );
    } catch (_) {}
  }

  // ── VIP expiry handling ────────────────────────────────────────────────────

  /// Reads the telegram contact from configs/social (used in the 24h reminder).
  /// Missing/empty value is fine — the contact line is then omitted.
  Future<void> _loadTelegramContact() async {
    try {
      final row = await Supabase.instance.client
          .from('configs')
          .select('data')
          .eq('id', 'social')
          .maybeSingle();
      if (row == null || !mounted) return;
      final d = row['data'] as Map<String, dynamic>? ?? {};
      final tg = (d['telegramUrl'] as String? ?? '').trim();
      if (tg.isNotEmpty) _telegramContact = tg;
    } catch (_) {}
  }

  /// Periodic re-check so a session that crosses the expiry moment downgrades
  /// without a restart. Reads the engine's current role/expiry each tick.
  void _startVipExpiryWatch(String accountId) {
    _vipExpiryTimer?.cancel();
    // Evaluate immediately on app open, then every 60s.
    _evaluateVipExpiry(_signalEngine.userRole, _signalEngine.vipExpiry);
    _vipExpiryTimer = Timer.periodic(const Duration(seconds: 60), (_) {
      if (!mounted) return;
      _evaluateVipExpiry(_signalEngine.userRole, _signalEngine.vipExpiry);
    });
  }

  /// Central VIP-status evaluation. Compares vip_expiry (parsed as UTC) against
  /// DateTime.now().toUtc(). Handles auto-downgrade (past) and 24h reminder.
  void _evaluateVipExpiry(String role, DateTime? expiry) {
    if (role != 'vip' || expiry == null) return;
    final expiryUtc = expiry.toUtc();
    final nowUtc = DateTime.now().toUtc();
    final remaining = expiryUtc.difference(nowUtc);

    if (remaining.isNegative || remaining == Duration.zero) {
      // Expired → downgrade + dialog once.
      _handleVipExpired();
    } else if (remaining <= const Duration(hours: 24)) {
      // Within the next 24h → informational reminder once per session.
      if (!_vipReminderShown) {
        _vipReminderShown = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _showVipReminderDialog(context);
        });
      }
    }
  }

  /// Auto-downgrade the user to standard in Supabase + locally, then show the
  /// expired dialog once.
  Future<void> _handleVipExpired() async {
    // Reflect locally immediately (engine is the source of truth for role).
    _signalEngine.updateUserData('standard', null);

    if (!_vipDowngradeInFlight) {
      _vipDowngradeInFlight = true;
      try {
        await Supabase.instance.client
            .from('users')
            .update({'role': 'standard', 'vip_expiry': null})
            .eq('id', _userAccountId);
      } catch (_) {}
    }

    if (!_vipExpiredDialogShown) {
      _vipExpiredDialogShown = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _showVipExpiredDialog(context);
      });
    }
  }

  void _startMaintenanceListener() {
    try {
      _maintenanceListener?.cancel();
      _maintenanceListener = _pollConfig('maintenance', (rows) {
        if (rows.isEmpty || !mounted) return;
        final d = rows.first['data'] as Map<String, dynamic>? ?? {};
        final isActive = d['isActive'] as bool? ?? false;
        if (!isActive) return;
        final endsAtStr = d['endsAt'] as String?;
        final endsAt = endsAtStr != null ? DateTime.tryParse(endsAtStr) : null;
        if (endsAt != null && endsAt.isBefore(DateTime.now())) return;
        _roleListener?.cancel();
        _maintenanceListener?.cancel();
        Navigator.of(context).pushReplacement(
          PageRouteBuilder(
            pageBuilder: (context, animation, _) => const MaintenanceScreen(),
            transitionsBuilder: (_, anim, secondary, child) =>
                FadeTransition(opacity: anim, child: child),
            transitionDuration: const Duration(milliseconds: 600),
          ),
        );
      });
    } catch (_) {}
  }

  Future<void> _checkForUpdate() async {
    if (_updateChecked || !mounted) return;
    _updateChecked = true;
    try {
      final row = await Supabase.instance.client
          .from('configs')
          .select('data')
          .eq('id', 'appUpdate')
          .maybeSingle();
      if (row == null || !mounted) return;
      final d = row['data'] as Map<String, dynamic>? ?? {};
      final hasUpdate = d['hasUpdate'] as bool? ?? false;
      if (!hasUpdate) return;
      final version = d['version'] as String? ?? '';
      final link = d['downloadLink'] as String? ?? '';
      final isForced = d['isForced'] as bool? ?? false;
      final features = (d['features'] as List<dynamic>? ?? []).cast<String>();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _showUpdateDialog(version, features, link, isForced);
      });
    } catch (_) {}
  }

  void _showUpdateDialog(
    String version,
    List<String> features,
    String link,
    bool isForced,
  ) {
    showDialog(
      context: context,
      barrierDismissible: !isForced,
      barrierColor: AppConstants.spaceBackground.withAlpha(220),
      builder: (ctx) => Directionality(
        textDirection: LanguageService.direction,
        child: AlertDialog(
          backgroundColor: AppConstants.cardBgColor,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
            side: BorderSide(
              color: AppConstants.accentCyan.withAlpha(100),
              width: 1.5,
            ),
          ),
          title: Row(
            children: [
              Icon(
                Icons.system_update_alt_rounded,
                color: AppConstants.accentCyan,
                size: 22,
              ),
              const SizedBox(width: 10),
              Text(
                tr('تحديث جديد متاح 🚀', 'New update available 🚀'),
                style: GoogleFonts.outfit(
                  color: AppConstants.textPrimary,
                  fontWeight: FontWeight.bold,
                  fontSize: 16,
                ),
              ),
            ],
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                tr('النسخة الجديدة: $version', 'New version: $version'),
                style: GoogleFonts.outfit(
                  color: AppConstants.accentCyan,
                  fontWeight: FontWeight.bold,
                ),
              ),
              if (features.isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(
                  tr('المميزات الجديدة:', 'What\'s new:'),
                  style: GoogleFonts.outfit(
                    color: AppConstants.textPrimary,
                    fontSize: 13,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 6),
                ...features.map(
                  (f) => Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '• ',
                          style: GoogleFonts.outfit(
                            color: AppConstants.callGreen,
                          ),
                        ),
                        Expanded(
                          child: Text(
                            f,
                            style: GoogleFonts.outfit(
                              color: AppConstants.textSecondary,
                              fontSize: 12,
                              height: 1.5,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
              if (isForced) ...[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: AppConstants.putRed.withAlpha(15),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: AppConstants.putRed.withAlpha(60),
                    ),
                  ),
                  child: Text(
                    tr(
                      '⚠️ هذا التحديث إجباري ولا يمكن تخطيه',
                      '⚠️ This update is mandatory and cannot be skipped',
                    ),
                    style: GoogleFonts.outfit(
                      color: AppConstants.putRed,
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ],
          ),
          actions: [
            if (!isForced)
              TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: Text(
                  tr('لاحقاً', 'Later'),
                  style: GoogleFonts.outfit(color: AppConstants.textSecondary),
                ),
              ),
            ElevatedButton.icon(
              onPressed: () {
                Navigator.pop(ctx);
                if (link.isNotEmpty) openBrowserTab(link);
              },
              icon: const Icon(Icons.download_rounded, size: 16),
              label: Text(
                tr('تحميل التحديث', 'Download update'),
                style: GoogleFonts.outfit(fontWeight: FontWeight.bold),
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppConstants.accentCyan,
                foregroundColor: AppConstants.spaceBackground,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _brokerLogoFallback() {
    return Image.asset(
      _userBroker.toLowerCase().contains('quotex')
          ? 'assets/quotex.png'
          : _userBroker.toLowerCase().contains('expert')
          ? 'assets/expert_option.png'
          : 'assets/pocket_option.png',
      fit: BoxFit.contain,
    );
  }

  void _showBanDialog(String reason) {
    showDialog(
      context: context,
      barrierDismissible: false,
      barrierColor: AppConstants.spaceBackground.withAlpha(220),
      builder: (ctx) => Directionality(
        textDirection: LanguageService.direction,
        child: AlertDialog(
          backgroundColor: AppConstants.cardBgColor,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
            side: BorderSide(
              color: AppConstants.putRed.withAlpha(100),
              width: 1.5,
            ),
          ),
          title: Row(
            children: [
              const Icon(
                Icons.block_rounded,
                color: AppConstants.putRed,
                size: 22,
              ),
              const SizedBox(width: 10),
              Text(
                tr('تم حظر حسابك', 'Your account is banned'),
                style: GoogleFonts.outfit(
                  color: AppConstants.textPrimary,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
          ),
          content: Text(
            reason.isNotEmpty
                ? tr(
                    'تم حظر حسابك من قِبَل الإدارة.\nالسبب: $reason',
                    'Your account has been banned by the administration.\nReason: $reason',
                  )
                : tr(
                    'تم حظر حسابك من قِبَل الإدارة.\nللمزيد من المعلومات تواصل مع الدعم.',
                    'Your account has been banned by the administration.\nContact support for more information.',
                  ),
            style: GoogleFonts.outfit(
              color: AppConstants.textSecondary,
              height: 1.6,
            ),
          ),
          actions: [
            ElevatedButton(
              onPressed: () async {
                Navigator.pop(ctx);
                await _logout();
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: AppConstants.putRed,
                foregroundColor: Colors.white,
              ),
              child: Text(
                tr('موافق', 'OK'),
                style: GoogleFonts.outfit(fontWeight: FontWeight.bold),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // Central handler: account was deleted by the admin → auto logout.
  void _handleAccountDeleted() {
    if (_accountDeletedHandled || !mounted) return;
    _accountDeletedHandled = true;
    _roleListener?.cancel();
    _maintenanceListener?.cancel();
    _accountCheckTimer?.cancel();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _showAccountDeletedDialog();
    });
  }

  // DISABLED (Egress): this used to poll the users row every 20s per user. Account
  // deletion / ban / role changes are already delivered by the realtime
  // `_roleListener` (`_startRoleListener`), so the poll was pure duplicate Egress.
  // Realtime-only now.
  void _startAccountExistenceCheck(String accountId) {
    _accountCheckTimer?.cancel();
    _accountCheckTimer = null;
  }

  // VIP account is being used on another device → kick this one out.
  void _handleDeviceMismatch() {
    if (_deviceMismatchHandled || !mounted) return;
    _deviceMismatchHandled = true;
    _roleListener?.cancel();
    _maintenanceListener?.cancel();
    _accountCheckTimer?.cancel();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _showDeviceMismatchDialog();
    });
  }

  void _showDeviceMismatchDialog() {
    showDialog(
      context: context,
      barrierDismissible: false,
      barrierColor: AppConstants.spaceBackground.withAlpha(220),
      builder: (ctx) => Directionality(
        textDirection: LanguageService.direction,
        child: AlertDialog(
          backgroundColor: AppConstants.cardBgColor,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
            side: BorderSide(
              color: AppConstants.warningOrange.withAlpha(120),
              width: 1.5,
            ),
          ),
          title: Row(
            children: [
              const Icon(
                Icons.devices_other_rounded,
                color: AppConstants.warningOrange,
                size: 22,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  tr(
                    'تم فتح الحساب على جهاز آخر',
                    'Account opened on another device',
                  ),
                  style: GoogleFonts.outfit(
                    color: AppConstants.textPrimary,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
          content: Text(
            tr(
              'حساب VIP مسموح له بالعمل على جهاز واحد فقط.\n'
                  'تم تسجيل الدخول بهذا الحساب من جهاز آخر، لذلك تم إنهاء الجلسة هنا.',
              'A VIP account is allowed to run on one device only.\n'
                  'This account was signed in on another device, so the session here has been ended.',
            ),
            style: GoogleFonts.outfit(
              color: AppConstants.textSecondary,
              height: 1.6,
            ),
          ),
          actions: [
            ElevatedButton(
              onPressed: () async {
                Navigator.pop(ctx);
                await _logout();
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: AppConstants.warningOrange,
                foregroundColor: Colors.black,
              ),
              child: Text(
                tr('تسجيل الدخول', 'Sign in'),
                style: GoogleFonts.outfit(fontWeight: FontWeight.bold),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showAccountDeletedDialog() {
    showDialog(
      context: context,
      barrierDismissible: false,
      barrierColor: AppConstants.spaceBackground.withAlpha(220),
      builder: (ctx) => Directionality(
        textDirection: LanguageService.direction,
        child: AlertDialog(
          backgroundColor: AppConstants.cardBgColor,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
            side: BorderSide(
              color: AppConstants.putRed.withAlpha(100),
              width: 1.5,
            ),
          ),
          title: Row(
            children: [
              const Icon(
                Icons.person_off_rounded,
                color: AppConstants.putRed,
                size: 22,
              ),
              const SizedBox(width: 10),
              Text(
                tr('تم حذف حسابك', 'Your account was deleted'),
                style: GoogleFonts.outfit(
                  color: AppConstants.textPrimary,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
          ),
          content: Text(
            tr(
              'تم حذف حسابك من قِبَل الإدارة.\nيرجى تسجيل الدخول مرة أخرى أو التواصل مع الدعم.',
              'Your account has been deleted by the administration.\nPlease sign in again or contact support.',
            ),
            style: GoogleFonts.outfit(
              color: AppConstants.textSecondary,
              height: 1.6,
            ),
          ),
          actions: [
            ElevatedButton(
              onPressed: () async {
                Navigator.pop(ctx);
                await _logout();
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: AppConstants.putRed,
                foregroundColor: Colors.white,
              ),
              child: Text(
                tr('تسجيل الدخول', 'Sign in'),
                style: GoogleFonts.outfit(fontWeight: FontWeight.bold),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _logout() async {
    _roleListener?.cancel();
    _maintenanceListener?.cancel();
    _accountCheckTimer?.cancel();
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
    if (mounted) {
      Navigator.of(context).pushReplacement(
        PageRouteBuilder(
          pageBuilder: (context, animation, _) => const NoticeScreen(),
          transitionsBuilder: (_, anim, secondary, child) =>
              FadeTransition(opacity: anim, child: child),
          transitionDuration: const Duration(milliseconds: 500),
        ),
      );
    }
  }

  void _onSignalEngineUpdate() {
    // A freshly-fired trade (ACTIVE, real direction) → push a notification so
    // the user sees it even if the tab/app is in the background.
    final fired = _signalEngine.activeSignal;
    if (fired != null &&
        fired.status == 'ACTIVE' &&
        fired.direction != 'WAIT' &&
        fired != _lastPushedSignal) {
      _lastPushedSignal = fired;
      _pushSignalNotification(fired);
    }

    if (_signalEngine.vipJustExpired) {
      _signalEngine.clearVipJustExpired();
      // Route through the central handler so Supabase is updated and the dialog
      // is guarded (shown once).
      _handleVipExpired();
    }

    // Market closed (driven by server poll or engine analysis path). Show the
    // dialog once; do NOT clear the flag here — the closed state must persist so
    // the Live Room stays closed. Clearing happens when the poll sees it reopen.
    if (_signalEngine.isMarketClosed && !_marketClosedDialogShown) {
      _marketClosedDialogShown = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _showMarketClosedDialog(context);
      });
    }

    final activeSignal = _signalEngine.activeSignal;
    if (activeSignal != null &&
        (activeSignal.status == 'WIN' ||
            activeSignal.status == 'LOSS' ||
            activeSignal.status == 'TIE') &&
        activeSignal != _lastProcessedSignal) {
      _lastProcessedSignal = activeSignal;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _showTradeReviewDialog(context, activeSignal);
      });
    }
  }

  // Builds a localized title/body for a fired signal and hands it to the push
  // service (which relays through the Edge Function to the browser push).
  void _pushSignalNotification(TradingSignal s) {
    final pair = s.pair.replaceAll(' (OTC)', '');
    final emoji = s.direction == 'CALL' ? '🟢' : '🔴';
    final title = '$pair • ${s.direction} $emoji';
    final t = s.entryTime.toLocal();
    final hh = t.hour.toString().padLeft(2, '0');
    final mm = t.minute.toString().padLeft(2, '0');
    final acc = '${s.confidence.toStringAsFixed(1)}%';
    final body = tr(
      'الدخول $hh:$mm • الدقة $acc • ${s.marketCondition}',
      'Entry $hh:$mm • Accuracy $acc • ${s.marketCondition}',
    );
    PushNotifications.notifyNewSignal(
      userId: _userAccountId,
      title: title,
      body: body,
    );
  }

  void _showVipExpiredDialog(BuildContext context) {
    showDialog(
      context: context,
      barrierDismissible: false,
      barrierColor: AppConstants.spaceBackground.withAlpha(220),
      builder: (BuildContext context) {
        return Directionality(
          textDirection: LanguageService.direction,
          child: AlertDialog(
            backgroundColor: AppConstants.cardBgColor,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(20),
              side: BorderSide(
                color: AppConstants.putRed.withAlpha(100),
                width: 1.5,
              ),
            ),
            title: Row(
              children: [
                const Icon(
                  Icons.warning_amber_rounded,
                  color: AppConstants.putRed,
                  size: 28,
                ),
                const SizedBox(width: 10),
                Text(
                  tr(
                    'انتهت عضويتك VIP ⚠️',
                    'Your VIP membership has expired ⚠️',
                  ),
                  style: GoogleFonts.outfit(
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
              ],
            ),
            content: Text(
              tr(
                'تم تحويل حسابك إلى Standard. يمكنك الترقية مجدداً في أي وقت.',
                'Your account has been switched to Standard. You can upgrade again anytime.',
              ),
              style: GoogleFonts.outfit(
                fontSize: 14,
                color: AppConstants.textSecondary,
                height: 1.5,
              ),
            ),
            actions: [
              TextButton(
                onPressed: () {
                  Navigator.of(context).pop();
                },
                child: Text(
                  tr('موافق', 'OK'),
                  style: GoogleFonts.outfit(
                    color: AppConstants.accentCyan,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  // Informational reminder shown when VIP expires within the next 24h.
  // Non-blocking: a single "حسناً" button (and optional telegram link).
  void _showVipReminderDialog(BuildContext context) {
    final tg = _telegramContact;
    showDialog(
      context: context,
      barrierDismissible: true,
      barrierColor: AppConstants.spaceBackground.withAlpha(220),
      builder: (BuildContext context) {
        return Directionality(
          textDirection: LanguageService.direction,
          child: AlertDialog(
            backgroundColor: AppConstants.cardBgColor,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(20),
              side: BorderSide(
                color: AppConstants.warningOrange.withAlpha(100),
                width: 1.5,
              ),
            ),
            title: Row(
              children: [
                const Icon(
                  Icons.access_time_rounded,
                  color: AppConstants.warningOrange,
                  size: 26,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    tr('تنبيه انتهاء VIP ⏳', 'VIP expiry alert ⏳'),
                    style: GoogleFonts.outfit(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                    ),
                  ),
                ),
              ],
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  tr(
                    'عضويتك VIP ستنتهي خلال أقل من 24 ساعة.',
                    'Your VIP membership will expire in less than 24 hours.',
                  ),
                  style: GoogleFonts.outfit(
                    fontSize: 14,
                    color: AppConstants.textSecondary,
                    height: 1.5,
                  ),
                ),
                if (tg.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Text(
                    tr('للتجديد تواصل معنا: $tg', 'To renew, contact us: $tg'),
                    style: GoogleFonts.outfit(
                      fontSize: 13,
                      color: AppConstants.accentCyan,
                      fontWeight: FontWeight.w600,
                      height: 1.5,
                    ),
                  ),
                ],
              ],
            ),
            actions: [
              if (tg.isNotEmpty)
                TextButton.icon(
                  onPressed: () {
                    Navigator.of(context).pop();
                    openBrowserTab(tg);
                  },
                  icon: Icon(
                    Icons.send_rounded,
                    size: 16,
                    color: AppConstants.accentCyan,
                  ),
                  label: Text(
                    tr('تواصل معنا', 'Contact us'),
                    style: GoogleFonts.outfit(
                      color: AppConstants.accentCyan,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: Text(
                  tr('حسناً', 'OK'),
                  style: GoogleFonts.outfit(
                    color: AppConstants.textSecondary,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _showMarketClosedDialog(BuildContext context) {
    if (_marketClosedDialogOpen) return; // singleton guard
    _marketClosedDialogOpen = true;
    showDialog(
      context: context,
      barrierDismissible: false,
      barrierColor: AppConstants.spaceBackground.withAlpha(230),
      builder: (_) {
        return Dialog(
          backgroundColor: Colors.transparent,
          insetPadding: const EdgeInsets.symmetric(
            horizontal: 20,
            vertical: 40,
          ),
          child: Container(
            decoration: BoxDecoration(
              color: AppConstants.cardBgColor,
              borderRadius: BorderRadius.circular(24),
              border: Border.all(color: AppConstants.borderGlow, width: 1.5),
              boxShadow: [
                BoxShadow(
                  color: const Color(0xFF4A3A7A).withAlpha(60),
                  blurRadius: 40,
                  spreadRadius: 8,
                ),
              ],
            ),
            padding: const EdgeInsets.all(28),
            child: Directionality(
              textDirection: LanguageService.direction,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Icon + glowing circle
                  Container(
                    width: 80,
                    height: 80,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: const Color(0xFF1E1640),
                      border: Border.all(
                        color: AppConstants.warningOrange.withAlpha(100),
                        width: 2,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: AppConstants.warningOrange.withAlpha(40),
                          blurRadius: 24,
                          spreadRadius: 4,
                        ),
                      ],
                    ),
                    child: const Icon(
                      Icons.lock_clock_outlined,
                      color: AppConstants.warningOrange,
                      size: 38,
                    ),
                  ),
                  const SizedBox(height: 18),
                  Text(
                    tr('السوق مغلق مؤقتاً', 'Market temporarily closed'),
                    style: GoogleFonts.outfit(
                      fontSize: 22,
                      fontWeight: FontWeight.bold,
                      color: AppConstants.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    tr(
                      'السعر ثابت أو السوق خارج أوقات التداول الرسمية.\nانتظر حتى يُفتح السوق ثم أعد المحاولة.',
                      'The price is flat or the market is outside official trading hours.\nWait until the market opens, then try again.',
                    ),
                    textAlign: TextAlign.center,
                    style: GoogleFonts.outfit(
                      fontSize: 13,
                      color: AppConstants.textSecondary,
                      height: 1.6,
                    ),
                  ),
                  if (_nextOpenLabel.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 8,
                      ),
                      decoration: BoxDecoration(
                        color: AppConstants.warningOrange.withValues(
                          alpha: 0.12,
                        ),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(
                          color: AppConstants.warningOrange.withValues(
                            alpha: 0.4,
                          ),
                        ),
                      ),
                      child: Text(
                        '🕐 $_nextOpenLabel',
                        textAlign: TextAlign.center,
                        style: GoogleFonts.outfit(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: AppConstants.warningOrange,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 6),
                  Text(
                    tr(
                      '💡 جرب أزواج OTC — متاحة 24/7 حتى في عطلات نهاية الأسبوع',
                      '💡 Try OTC pairs — available 24/7 even on weekends',
                    ),
                    textAlign: TextAlign.center,
                    style: GoogleFonts.outfit(
                      fontSize: 12,
                      color: AppConstants.accentCyan,
                      height: 1.5,
                    ),
                  ),
                  const SizedBox(height: 24),
                  // Status indicator
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 10,
                    ),
                    decoration: BoxDecoration(
                      color: AppConstants.warningOrange.withAlpha(15),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                        color: AppConstants.warningOrange.withAlpha(60),
                      ),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: AppConstants.warningOrange,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          tr('السوق: مغلق', 'Market: Closed'),
                          style: GoogleFonts.outfit(
                            fontSize: 13,
                            fontWeight: FontWeight.bold,
                            color: AppConstants.warningOrange,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: () => Navigator.of(context).pop(),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppConstants.accentBlue,
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                        elevation: 6,
                      ),
                      child: Text(
                        tr('حسناً، سأنتظر', 'OK, I\'ll wait'),
                        style: GoogleFonts.outfit(
                          fontSize: 14,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    ).then((_) {
      // Dialog dismissed (by button, barrier, or programmatic pop on re-open).
      _marketClosedDialogOpen = false;
    });
  }

  Map<String, int> _getVipCountdownParts(DateTime? expiry) {
    if (expiry == null) return {'d': 0, 'h': 0, 'm': 0, 's': 0};
    final diff = expiry.difference(DateTime.now());
    if (diff.isNegative) return {'d': 0, 'h': 0, 'm': 0, 's': 0};
    return {
      'd': diff.inDays,
      'h': diff.inHours % 24,
      'm': diff.inMinutes % 60,
      's': diff.inSeconds % 60,
    };
  }

  void _showTradeReviewDialog(BuildContext context, TradingSignal signal) {
    final isWin = signal.status == 'WIN';
    final isTie = signal.status == 'TIE';
    final isCall = signal.direction == 'CALL';
    final profitColor = isTie
        ? AppConstants.warningOrange
        : (isWin ? AppConstants.callGreen : AppConstants.putRed);
    final exitP = signal.exitPrice ?? signal.currentPrice;

    showDialog(
      context: context,
      barrierDismissible: false,
      barrierColor: AppConstants.spaceBackground.withAlpha(220),
      builder: (BuildContext context) {
        return Dialog(
          backgroundColor: Colors.transparent,
          insetPadding: const EdgeInsets.symmetric(
            horizontal: 16,
            vertical: 24,
          ),
          child: Container(
            width: min(MediaQuery.of(context).size.width, 420),
            decoration: BoxDecoration(
              color: AppConstants.cardBgColor,
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: AppConstants.borderGlow, width: 1.5),
              boxShadow: [
                BoxShadow(
                  color: profitColor.withAlpha(20),
                  blurRadius: 25,
                  spreadRadius: 5,
                ),
              ],
            ),
            padding: const EdgeInsets.all(20),
            child: Directionality(
              textDirection: LanguageService.direction,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // ── Header ──
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        isTie
                            ? Icons.remove_circle_outline
                            : (isWin
                                  ? Icons.check_circle_outline_rounded
                                  : Icons.cancel_outlined),
                        color: profitColor,
                        size: 26,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        tr('مراجعة الصفقة المغلقة', 'Closed trade review'),
                        style: GoogleFonts.outfit(
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                          color: AppConstants.textPrimary,
                        ),
                      ),
                    ],
                  ),
                  const Divider(color: AppConstants.borderGlow, height: 24),

                  // ── Outcome badge ──
                  Container(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    decoration: BoxDecoration(
                      color: profitColor.withAlpha(15),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: profitColor.withAlpha(80),
                        width: 1,
                      ),
                    ),
                    child: Text(
                      isTie
                          ? tr('➖  تعادل', '➖  Tie')
                          : (isWin
                                ? tr('✅  صفقة ناجحة', '✅  Winning trade')
                                : tr('❌  صفقة خاسرة', '❌  Losing trade')),
                      textAlign: TextAlign.center,
                      style: GoogleFonts.outfit(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                        color: profitColor,
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),

                  // ── Mini price chart ──
                  _buildMiniPriceChart(
                    signal,
                    isWin,
                    isTie,
                    isCall,
                    profitColor,
                    exitP,
                  ),
                  const SizedBox(height: 14),

                  // ── Stats table ──
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppConstants.spaceBackground.withAlpha(150),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: AppConstants.borderGlow.withAlpha(120),
                      ),
                    ),
                    child: Column(
                      children: [
                        _buildDialogStatRow(
                          tr('زوج العملات', 'Currency pair'),
                          signal.pair.replaceAll(' (OTC)', ''),
                        ),
                        const Divider(
                          color: AppConstants.borderGlow,
                          height: 16,
                        ),
                        _buildDialogStatRow(
                          tr('الاتجاه', 'Direction'),
                          isCall
                              ? tr('صعود  🟢', 'Up  🟢')
                              : tr('هبوط  🔴', 'Down  🔴'),
                        ),
                        const Divider(
                          color: AppConstants.borderGlow,
                          height: 16,
                        ),
                        _buildDialogStatRow(
                          tr('سعر الدخول', 'Entry price'),
                          AppConstants.formatPrice(signal.entryPrice),
                        ),
                        const Divider(
                          color: AppConstants.borderGlow,
                          height: 16,
                        ),
                        _buildDialogStatRow(
                          tr('سعر الإغلاق', 'Close price'),
                          AppConstants.formatPrice(exitP),
                        ),
                        const Divider(
                          color: AppConstants.borderGlow,
                          height: 16,
                        ),
                        _buildDialogStatRow(
                          tr('المدة', 'Duration'),
                          tr(
                            '${signal.durationMinutes} دقيقة',
                            '${signal.durationMinutes} min',
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),

                  // ── Continue button ──
                  ElevatedButton(
                    onPressed: () {
                      Navigator.of(context).pop();
                      _signalEngine.clearActiveSignal();
                    },
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppConstants.accentBlue,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                      shadowColor: AppConstants.accentBlue.withAlpha(120),
                      elevation: 8,
                    ),
                    child: Text(
                      tr(
                        'متابعة الصفقة التالية 🚀',
                        'Continue to next trade 🚀',
                      ),
                      style: GoogleFonts.outfit(
                        fontSize: 15,
                        fontWeight: FontWeight.bold,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildMiniPriceChart(
    TradingSignal signal,
    bool isWin,
    bool isTie,
    bool isCall,
    Color profitColor,
    double exitP,
  ) {
    final diff = isTie ? 0.0 : exitP - signal.entryPrice;
    final absDiff = diff.abs();
    // Pips for forex (4-decimal): multiply by 10000. For JPY: multiply by 100. Fallback: raw diff.
    final isJpy = signal.pair.toUpperCase().contains('JPY');
    double pipsVal;
    String pipsLabel;
    if (absDiff < 1.0) {
      pipsVal = isJpy ? absDiff * 100 : absDiff * 10000;
      pipsLabel = '${diff >= 0 ? '+' : '-'}${pipsVal.toStringAsFixed(1)} pips';
    } else {
      pipsLabel = '${diff >= 0 ? '+' : ''}${absDiff.toStringAsFixed(5)}';
    }

    // Positions: entry in center, exit above/below based on movement
    // For CALL WIN: exit > entry → exit is on top
    // For CALL LOSS: exit < entry → exit is on bottom
    final exitOnTop = exitP >= signal.entryPrice;

    return Container(
      height: 112,
      decoration: BoxDecoration(
        color: AppConstants.spaceBackground.withAlpha(200),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppConstants.borderGlow.withAlpha(100)),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: Stack(
          children: [
            // Background painted layer (shaded zone + lines)
            Positioned.fill(
              child: CustomPaint(
                painter: _MiniPricePainter(
                  entryPrice: signal.entryPrice,
                  exitPrice: exitP,
                  profitColor: profitColor,
                ),
              ),
            ),
            // Price labels & arrow overlay
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Left column: top price / bottom price labels
                  Column(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        AppConstants.formatPrice(
                          exitOnTop ? exitP : signal.entryPrice,
                        ),
                        style: GoogleFonts.outfit(
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                          color: exitOnTop
                              ? profitColor
                              : AppConstants.textSecondary,
                        ),
                      ),
                      Text(
                        exitOnTop ? tr('إغلاق', 'Close') : tr('دخول', 'Entry'),
                        style: GoogleFonts.outfit(
                          fontSize: 9,
                          color: exitOnTop
                              ? profitColor
                              : AppConstants.textSecondary,
                        ),
                      ),
                      const Spacer(),
                      Text(
                        exitOnTop ? tr('دخول', 'Entry') : tr('إغلاق', 'Close'),
                        style: GoogleFonts.outfit(
                          fontSize: 9,
                          color: exitOnTop
                              ? AppConstants.textSecondary
                              : profitColor,
                        ),
                      ),
                      Text(
                        AppConstants.formatPrice(
                          exitOnTop ? signal.entryPrice : exitP,
                        ),
                        style: GoogleFonts.outfit(
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                          color: exitOnTop
                              ? AppConstants.textSecondary
                              : profitColor,
                        ),
                      ),
                    ],
                  ),
                  // Center: arrow + pips
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          exitOnTop
                              ? Icons.arrow_upward_rounded
                              : Icons.arrow_downward_rounded,
                          color: profitColor,
                          size: 22,
                        ),
                        const SizedBox(height: 4),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 3,
                          ),
                          decoration: BoxDecoration(
                            color: profitColor.withAlpha(25),
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(
                              color: profitColor.withAlpha(80),
                            ),
                          ),
                          child: Text(
                            pipsLabel,
                            style: GoogleFonts.outfit(
                              fontSize: 10,
                              fontWeight: FontWeight.bold,
                              color: profitColor,
                            ),
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          isCall ? '▲ CALL' : '▼ PUT',
                          style: GoogleFonts.outfit(
                            fontSize: 9,
                            color: isCall
                                ? AppConstants.callGreen
                                : AppConstants.putRed,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                  // Right column: mirror labels
                  Column(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        exitOnTop
                            ? tr('سعر الخروج', 'Exit price')
                            : tr('سعر الدخول', 'Entry price'),
                        style: GoogleFonts.outfit(
                          fontSize: 9,
                          color: exitOnTop
                              ? profitColor.withAlpha(180)
                              : AppConstants.textSecondary,
                        ),
                      ),
                      const Spacer(),
                      Text(
                        exitOnTop
                            ? tr('سعر الدخول', 'Entry price')
                            : tr('سعر الخروج', 'Exit price'),
                        style: GoogleFonts.outfit(
                          fontSize: 9,
                          color: exitOnTop
                              ? AppConstants.textSecondary
                              : profitColor.withAlpha(180),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDialogStatRow(String label, String value) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          label,
          style: GoogleFonts.outfit(
            fontSize: 12,
            color: AppConstants.textSecondary,
          ),
        ),
        Text(
          value,
          style: GoogleFonts.outfit(
            fontSize: 13,
            fontWeight: FontWeight.bold,
            color: AppConstants.textPrimary,
          ),
        ),
      ],
    );
  }

  // ── Promotional announcement (admin-controlled) ─────────────────────────────

  /// Fetch the promo config once, evaluate the show-conditions, and display the
  /// ad-style overlay when appropriate. All time math is in UTC.
  Future<void> _maybeShowPromo() async {
    if (_promoChecked) return;
    _promoChecked = true;
    try {
      final row = await Supabase.instance.client
          .from('configs')
          .select('data')
          .eq('id', 'promo')
          .maybeSingle();
      if (row == null || !mounted) return;
      final d = row['data'] as Map<String, dynamic>? ?? {};

      // 1) Must be enabled.
      final enabled = d['enabled'] as bool? ?? false;
      if (!enabled) return;

      // 2) Targeting: 'all' or this user's account id.
      final target = (d['target'] as String? ?? 'all').trim();
      if (target != 'all' && target != _userAccountId) return;

      // 3) Offer not expired: endsAt null OR in the future (UTC).
      final endsAtStr = d['endsAt'] as String?;
      if (endsAtStr != null && endsAtStr.isNotEmpty) {
        final endsAt = DateTime.tryParse(endsAtStr)?.toUtc();
        if (endsAt != null && !endsAt.isAfter(DateTime.now().toUtc())) return;
      }

      // 4) Not already dismissed for this version on this device.
      final version = d['version'] as int? ?? 0;
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getBool('promo_dismissed_v$version') == true) return;

      if (!mounted) return;
      _showPromoDialog(d);
    } catch (_) {}
  }

  void _showPromoDialog(Map<String, dynamic> d) {
    // Analytics: count this impression (how many users the ad was shown to).
    Supabase.instance.client
        .rpc(
          'increment_click',
          params: {'row_id': 'promo', 'field_name': 'views'},
        )
        .catchError((_) {});
    final title = (d['title'] as String? ?? '').trim();
    final message = (d['message'] as String? ?? '').trim();
    final price = (d['price'] as String? ?? '').trim();
    final save = (d['save'] as String? ?? '').trim();
    final ctaText = (d['ctaText'] as String? ?? '').trim().isNotEmpty
        ? (d['ctaText'] as String).trim()
        : tr('تواصل معايا', 'Contact me');
    final version = d['version'] as int? ?? 0;
    final autoCloseSeconds = (d['autoCloseSeconds'] as int? ?? 0).clamp(
      0,
      3600,
    );
    final endsAtStr = d['endsAt'] as String?;
    final endsAtUtc = (endsAtStr != null && endsAtStr.isNotEmpty)
        ? DateTime.tryParse(endsAtStr)?.toUtc()
        : null;

    // Timers owned by the dialog; cancelled when it closes (see .then below).
    Timer? skipTimer; // counts down autoCloseSeconds → enables close (X)
    Timer? offerTimer; // 1s tick for the offer countdown / auto-close at zero
    var canClose = autoCloseSeconds <= 0;
    var skipRemaining = autoCloseSeconds;

    Future<void> persistDismissal() async {
      try {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setBool('promo_dismissed_v$version', true);
      } catch (_) {}
    }

    String fmtCountdown(Duration diff) {
      if (diff.isNegative) diff = Duration.zero;
      final d = diff.inDays;
      final h = diff.inHours % 24;
      final m = diff.inMinutes % 60;
      final s = diff.inSeconds % 60;
      String two(int v) => v.toString().padLeft(2, '0');
      if (d > 0) {
        return tr(
          '$d يوم ${two(h)}:${two(m)}:${two(s)}',
          '${d}d ${two(h)}:${two(m)}:${two(s)}',
        );
      }
      return '${two(h)}:${two(m)}:${two(s)}';
    }

    showDialog(
      context: context,
      barrierDismissible: false,
      barrierColor: AppConstants.spaceBackground.withAlpha(235),
      builder: (dialogCtx) {
        return StatefulBuilder(
          builder: (ctx, setLocal) {
            // Start the skip (auto-close enable) countdown once.
            skipTimer ??= autoCloseSeconds <= 0
                ? null
                : Timer.periodic(const Duration(seconds: 1), (t) {
                    skipRemaining -= 1;
                    if (skipRemaining <= 0) {
                      skipRemaining = 0;
                      canClose = true;
                      t.cancel();
                    }
                    if (ctx.mounted) setLocal(() {});
                  });

            // Start the offer countdown once (if an end time exists).
            if (endsAtUtc != null) {
              offerTimer ??= Timer.periodic(const Duration(seconds: 1), (t) {
                final remaining = endsAtUtc.difference(DateTime.now().toUtc());
                if (remaining.isNegative || remaining == Duration.zero) {
                  // Offer ended → auto-close the ad (persist not required: a
                  // new version/offer will re-show; expired won't re-show).
                  t.cancel();
                  if (Navigator.of(dialogCtx, rootNavigator: true).canPop()) {
                    Navigator.of(dialogCtx, rootNavigator: true).pop();
                  }
                  return;
                }
                if (ctx.mounted) setLocal(() {});
              });
            }

            void closeAd() {
              if (!canClose) return;
              persistDismissal();
              Navigator.of(dialogCtx, rootNavigator: true).pop();
            }

            final offerRemaining = endsAtUtc?.difference(
              DateTime.now().toUtc(),
            );

            return Directionality(
              textDirection: LanguageService.direction,
              child: Dialog(
                backgroundColor: Colors.transparent,
                insetPadding: const EdgeInsets.symmetric(
                  horizontal: 20,
                  vertical: 40,
                ),
                child: Container(
                  width: min(MediaQuery.of(ctx).size.width, 420),
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      begin: Alignment.topRight,
                      end: Alignment.bottomLeft,
                      colors: [Color(0xFF1B1338), AppConstants.cardBgColor],
                    ),
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(
                      color: Colors.amber.withAlpha(120),
                      width: 1.5,
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.amber.withAlpha(50),
                        blurRadius: 40,
                        spreadRadius: 6,
                      ),
                      BoxShadow(
                        color: AppConstants.accentBlue.withAlpha(30),
                        blurRadius: 30,
                        spreadRadius: 2,
                      ),
                    ],
                  ),
                  child: Stack(
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(22, 26, 22, 22),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            // ── Header: gift icon + title ──
                            Row(
                              children: [
                                Container(
                                  width: 46,
                                  height: 46,
                                  decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    gradient: const LinearGradient(
                                      colors: [
                                        Colors.amberAccent,
                                        Colors.orangeAccent,
                                      ],
                                    ),
                                    boxShadow: [
                                      BoxShadow(
                                        color: Colors.amber.withAlpha(110),
                                        blurRadius: 16,
                                        spreadRadius: 1,
                                      ),
                                    ],
                                  ),
                                  child: const Center(
                                    child: Text(
                                      '🎁',
                                      style: TextStyle(fontSize: 24),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Text(
                                    title.isNotEmpty
                                        ? title
                                        : tr('عرض خاص', 'Special offer'),
                                    style: GoogleFonts.outfit(
                                      fontSize: 19,
                                      fontWeight: FontWeight.w800,
                                      color: AppConstants.textPrimary,
                                      height: 1.25,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 16),

                            // ── Message body ──
                            if (message.isNotEmpty)
                              Text(
                                message,
                                style: GoogleFonts.outfit(
                                  fontSize: 14,
                                  color: AppConstants.textSecondary,
                                  height: 1.6,
                                ),
                              ),

                            // ── Price + save highlight ──
                            if (price.isNotEmpty || save.isNotEmpty) ...[
                              const SizedBox(height: 16),
                              Row(
                                children: [
                                  if (price.isNotEmpty)
                                    Expanded(
                                      child: Container(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 12,
                                          vertical: 12,
                                        ),
                                        decoration: BoxDecoration(
                                          color: AppConstants.accentCyan
                                              .withAlpha(20),
                                          borderRadius: BorderRadius.circular(
                                            12,
                                          ),
                                          border: Border.all(
                                            color: AppConstants.accentCyan
                                                .withAlpha(90),
                                          ),
                                        ),
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              tr('السعر', 'Price'),
                                              style: GoogleFonts.outfit(
                                                fontSize: 10,
                                                color:
                                                    AppConstants.textSecondary,
                                              ),
                                            ),
                                            const SizedBox(height: 2),
                                            Text(
                                              price,
                                              style: GoogleFonts.outfit(
                                                fontSize: 16,
                                                fontWeight: FontWeight.w800,
                                                color: AppConstants.accentCyan,
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                    ),
                                  if (price.isNotEmpty && save.isNotEmpty)
                                    const SizedBox(width: 10),
                                  if (save.isNotEmpty)
                                    Container(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 12,
                                        vertical: 10,
                                      ),
                                      decoration: BoxDecoration(
                                        gradient: const LinearGradient(
                                          colors: [
                                            AppConstants.callGreen,
                                            Color(0xFF00C46A),
                                          ],
                                        ),
                                        borderRadius: BorderRadius.circular(12),
                                        boxShadow: [
                                          BoxShadow(
                                            color: AppConstants.callGreen
                                                .withAlpha(80),
                                            blurRadius: 12,
                                          ),
                                        ],
                                      ),
                                      child: Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          const Text(
                                            '🔥',
                                            style: TextStyle(fontSize: 13),
                                          ),
                                          const SizedBox(width: 5),
                                          Text(
                                            save,
                                            style: GoogleFonts.outfit(
                                              fontSize: 13,
                                              fontWeight: FontWeight.w800,
                                              color:
                                                  AppConstants.spaceBackground,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                ],
                              ),
                            ],

                            // ── Live offer countdown ──
                            if (endsAtUtc != null) ...[
                              const SizedBox(height: 16),
                              Container(
                                width: double.infinity,
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 14,
                                  vertical: 10,
                                ),
                                decoration: BoxDecoration(
                                  color: AppConstants.warningOrange.withAlpha(
                                    20,
                                  ),
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(
                                    color: AppConstants.warningOrange.withAlpha(
                                      80,
                                    ),
                                  ),
                                ),
                                child: Row(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    const Icon(
                                      Icons.timer_outlined,
                                      color: AppConstants.warningOrange,
                                      size: 18,
                                    ),
                                    const SizedBox(width: 8),
                                    Text(
                                      tr(
                                        'ينتهي خلال ${fmtCountdown(offerRemaining ?? Duration.zero)}',
                                        'Ends in ${fmtCountdown(offerRemaining ?? Duration.zero)}',
                                      ),
                                      style: GoogleFonts.outfit(
                                        fontSize: 14,
                                        fontWeight: FontWeight.w700,
                                        color: AppConstants.warningOrange,
                                        letterSpacing: 0.5,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],

                            const SizedBox(height: 22),

                            // ── CTA button ──
                            SizedBox(
                              width: double.infinity,
                              child: ElevatedButton.icon(
                                onPressed: () {
                                  // Analytics: count this CTA / link click.
                                  Supabase.instance.client
                                      .rpc(
                                        'increment_click',
                                        params: {
                                          'row_id': 'promo',
                                          'field_name': 'cta',
                                        },
                                      )
                                      .catchError((_) {});
                                  final url = _telegramContact.isNotEmpty
                                      ? _telegramContact
                                      : 'https://t.me/euro_trd1';
                                  openBrowserTab(url);
                                },
                                icon: const Icon(Icons.send_rounded, size: 18),
                                label: Text(
                                  ctaText,
                                  style: GoogleFonts.outfit(
                                    fontSize: 15,
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                                style: ElevatedButton.styleFrom(
                                  backgroundColor: const Color(0xFF229ED9),
                                  foregroundColor: Colors.white,
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 14,
                                  ),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(12),
                                  ),
                                  elevation: 8,
                                  shadowColor: const Color(
                                    0xFF229ED9,
                                  ).withAlpha(150),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),

                      // ── Close (X) — disabled like a skippable ad ──
                      Positioned(
                        top: 8,
                        left: 8,
                        child: canClose
                            ? IconButton(
                                onPressed: closeAd,
                                icon: const Icon(
                                  Icons.close_rounded,
                                  color: AppConstants.textSecondary,
                                  size: 22,
                                ),
                                tooltip: tr('إغلاق', 'Close'),
                              )
                            : Container(
                                margin: const EdgeInsets.all(6),
                                width: 32,
                                height: 32,
                                alignment: Alignment.center,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  color: AppConstants.spaceBackground.withAlpha(
                                    160,
                                  ),
                                  border: Border.all(
                                    color: AppConstants.borderGlow,
                                  ),
                                ),
                                child: Text(
                                  '$skipRemaining',
                                  style: GoogleFonts.outfit(
                                    fontSize: 13,
                                    fontWeight: FontWeight.bold,
                                    color: AppConstants.textSecondary,
                                  ),
                                ),
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        );
      },
    ).then((_) {
      // Dialog closed by any path → cancel timers (no leaks).
      skipTimer?.cancel();
      offerTimer?.cancel();
    });
  }

  // ── App/tab lifecycle → suspend realtime in the background ────────────────
  // Frees the Supabase concurrent-connection slot when the tab/app is hidden.
  // On Flutter Web a tab switch fires `hidden` (then `paused`); returning fires
  // `resumed`. Trading/strategy logic is NOT touched here — only the transport.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    super.didChangeAppLifecycleState(state);
    if (state == AppLifecycleState.resumed) {
      _bgSuspendTimer?.cancel();
      _bgSuspendTimer = null;
      if (_rtBackgrounded) _resumeRealtime();
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      // Debounce: only tear down if STILL hidden after a grace period, so a quick
      // tab-flick (away & back) never causes a needless reconnect.
      _bgSuspendTimer ??= Timer(const Duration(seconds: 8), () {
        _bgSuspendTimer = null;
        _suspendRealtime();
      });
    }
  }

  // Cancel every Realtime subscription + close the shared WebSocket (frees the
  // connection slot) and stop the proxy-poll timers. Idempotent via _rtBackgrounded.
  void _suspendRealtime() {
    if (_rtBackgrounded || !mounted) return;
    _rtBackgrounded = true;
    _roleListener?.cancel();            _roleListener = null;
    _maintenanceListener?.cancel();     _maintenanceListener = null;
    _stdStrategyListener?.cancel();     _stdStrategyListener = null;
    _vipStrategyListener?.cancel();     _vipStrategyListener = null;
    _monStdStrategyListener?.cancel();  _monStdStrategyListener = null;
    _monVipStrategyListener?.cancel();  _monVipStrategyListener = null;
    _chartModeListener?.cancel();       _chartModeListener = null;
    _priceSystemListener?.cancel();     _priceSystemListener = null;
    _displaySourceListener?.cancel();   _displaySourceListener = null;
    _pairsListener?.cancel();           _pairsListener = null;
    _realCandlesTimer?.cancel();        _realCandlesTimer = null;
    _marketStatusTimer?.cancel();       _marketStatusTimer = null;
    // Close the one shared realtime socket → releases the concurrent-connection slot.
    try { Supabase.instance.client.realtime.disconnect(); } catch (_) {}
    debugPrint('[rt] backgrounded → realtime + poll timers suspended');
  }

  // Reopen the socket, re-subscribe every channel (each _start* method cancels-
  // before-subscribe, so double calls are safe), restart the timers, and do one
  // immediate fetch so the UI is fresh at once. Idempotent via _rtBackgrounded.
  void _resumeRealtime() {
    if (!_rtBackgrounded || !mounted) return;
    _rtBackgrounded = false;
    // No explicit realtime.connect() — re-subscribing any channel below reopens
    // the shared socket automatically (connect() is package-internal).
    ServerConfig.startRealtime();       // app-wide proxy_server_url channel
    _startMaintenanceListener();
    _startChartModeListener();
    _startSettingsListeners();
    _startPairsListener();
    _startStrategyListeners();
    if (_userAccountId.isNotEmpty && _userAccountId != '----') {
      _startRoleListener(_userAccountId);
    }
    // Restart the proxy-poll timers (these hit the proxy, NOT Supabase).
    _startMarketStatusPolling();        // immediate poll + 10s timer
    _syncEngineCandles();               // immediate candle refresh
    _realCandlesTimer?.cancel();
    _realCandlesTimer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => _syncEngineCandles(),
    );
    debugPrint('[rt] foregrounded → realtime + poll timers resumed');
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _bgSuspendTimer?.cancel();
    ServerConfig.proxyServerUrl.removeListener(_onProxyUrlChanged);
    _roleListener?.cancel();
    _maintenanceListener?.cancel();
    _stdStrategyListener?.cancel();
    _vipStrategyListener?.cancel();
    _monStdStrategyListener?.cancel();
    _monVipStrategyListener?.cancel();
    _chartModeListener?.cancel();
    _priceSystemListener?.cancel();
    _displaySourceListener?.cancel();
    _pairsListener?.cancel();
    _marketStatusTimer?.cancel();
    _realCandlesTimer?.cancel();
    _accountCheckTimer?.cancel();
    _vipExpiryTimer?.cancel();
    _signalEngine.removeListener(_onSignalEngineUpdate);
    _signalEngine.dispose();
    super.dispose();
  }

  // Subscribe to a single `configs` row via Supabase REALTIME (NOT polling).
  // Realtime sends only the initial snapshot + deltas on change, so a rarely-
  // changing config costs almost no Egress — vs a 30s poll which re-downloaded
  // everything per user and burned ~5.6GB in 2 days. onError swallows a transient
  // blip (the realtime client auto-reconnects) so it can never crash the screen.
  StreamSubscription<List<Map<String, dynamic>>> _pollConfig(
    String id,
    void Function(List<Map<String, dynamic>>) onData,
  ) {
    return Supabase.instance.client
        .from('configs')
        .stream(primaryKey: ['id'])
        .eq('id', id)
        .listen(
          onData,
          onError: (e) =>
              debugPrint('config[$id] realtime error (transient): $e'),
        );
  }

  // Same, for the full `pairs` table (realtime: one snapshot + rare deltas).
  StreamSubscription<List<Map<String, dynamic>>> _pollPairs(
    void Function(List<Map<String, dynamic>>) onData,
  ) {
    return Supabase.instance.client
        .from('pairs')
        .stream(primaryKey: ['id'])
        .listen(
          onData,
          onError: (e) => debugPrint('pairs realtime error (transient): $e'),
        );
  }

  void _startChartModeListener() {
    try {
      _chartModeListener?.cancel();
      _chartModeListener = _pollConfig('chart_settings', (rows) {
        if (rows.isEmpty || !mounted) return;
        final data = rows.first['data'] as Map<String, dynamic>? ?? {};
        final mode = data['mode'] as String? ?? 'sim';
        final resolved = mode == 'sim' ? 'sim' : 'scraping';
        if (resolved != _chartMode) {
          setState(() {
            _chartMode = resolved;
          });
        }
      });
    } catch (_) {}
  }

  // Admin System Settings, live: price system + which source shows to users.
  void _startSettingsListeners() {
    try {
      _priceSystemListener?.cancel();
      _priceSystemListener = _pollConfig('price_system', (rows) {
        if (!mounted) return;
        final v = rows.isNotEmpty
            ? ((rows.first['data'] as Map?)?['value'] as String?)
            : null;
        if (v != _priceSystemRaw) setState(() => _priceSystemRaw = v);
      });
      _displaySourceListener?.cancel();
      _displaySourceListener = _pollConfig('display_source', (rows) {
        if (!mounted) return;
        final v =
            (rows.isNotEmpty
                ? ((rows.first['data'] as Map?)?['value'] as String?)
                : null) ??
            'all';
        if (v != _displaySource) {
          setState(() => _displaySource = v);
          // The active pair may no longer be allowed under the new source →
          // re-pick the first visible pair in the selected category.
          final stillVisible = _visiblePairs.any(
            (p) => p['symbol'] == _signalEngine.activePair,
          );
          if (!stillVisible) {
            _selectFirstVisibleInCategory(_selectedCategory);
          }
        }
      });
    } catch (_) {}
  }

  // Effective price system: an explicit price_system config wins; otherwise fall
  // back to the legacy chart_settings mode.
  String get _effectivePriceSystem =>
      _priceSystemRaw ?? (_chartMode == 'sim' ? 'simulator' : 'scraping');

  // Normalize any legacy category onto the current 5-category taxonomy.
  static String _normCat(String? c) {
    switch (c) {
      case 'forex':
        return 'currencies';
      case 'metals':
        return 'commodities';
      case 'currencies':
      case 'commodities':
      case 'stocks':
      case 'indices':
      case 'crypto':
        return c!;
      default:
        return 'currencies';
    }
  }

  // Enabled pairs the current display_source setting lets the user see.
  List<Map<String, dynamic>> get _visiblePairs =>
      AppConstants.currencyPairs.where((p) {
        if (p['enabled'] == false) return false;
        final src = (p['source'] as String? ?? 'po');
        if (_displaySource == 'po' && src != 'po') return false;
        return true;
      }).toList();

  /// One-shot REST load of pairs so the UI is never empty while waiting for
  /// the Realtime stream (which can be slow or blocked on the free tier).
  Future<void> _loadPairsOnce() async {
    // Guard BEFORE the network call: if the realtime .stream() already delivered
    // the pairs, skip the REST fetch entirely (kills the redundant ~46KB read).
    if (AppConstants.currencyPairs.isNotEmpty) return;
    try {
      final data = await Supabase.instance.client
          .from('pairs')
          // Project only the columns the app actually maps (drops the unused
          // `created_at`) → ~37KB instead of ~46KB for the full row set.
          .select('id,symbol,chart_symbol,category,type,source,is_otc,enabled,order')
          .timeout(const Duration(seconds: 8));
      if (!mounted || (data as List).isEmpty) return;
      // Re-check after the await — the stream may have populated meanwhile.
      if (AppConstants.currencyPairs.isNotEmpty) return;

      final pairs =
          (data as List<dynamic>)
              .map(
                (d) => <String, dynamic>{
                  'id': d['id'],
                  'symbol': d['symbol'] as String? ?? '',
                  'chartSymbol': d['chart_symbol'] as String? ?? '',
                  'category': _normCat(d['category'] as String?),
                  'type': d['type'] as String? ?? '',
                  'source': (d['source'] as String? ?? 'po'),
                  'isOtc': d['is_otc'] == true,
                  'enabled': d['enabled'] != false,
                  'order': d['order'] as int? ?? 0,
                },
              )
              .where(
                (p) =>
                    (p['symbol'] as String).isNotEmpty && p['enabled'] == true,
              )
              .toList()
            ..sort((a, b) => (a['order'] as int).compareTo(b['order'] as int));

      if (pairs.isEmpty || !mounted) return;

      setState(() {
        AppConstants.currencyPairs = pairs;

        final vis = _visiblePairs;
        if (vis.isNotEmpty && !_categoryHasPairs(_selectedCategory)) {
          _selectedCategory = _normCat(vis.first['category'] as String?);
        }
        if (vis.isNotEmpty) {
          final inCat = vis
              .where(
                (p) => _normCat(p['category'] as String?) == _selectedCategory,
              )
              .toList();
          final pick = inCat.isNotEmpty ? inCat.first : vis.first;
          _activeChartSymbol = pick['chartSymbol'] as String? ?? '';
          final s = pick['symbol'] as String? ?? '';
          if (s.isNotEmpty) _signalEngine.selectPair(s);
        }
      });
    } catch (_) {}
  }

  void _startPairsListener() {
    // ── REST is now a DELAYED fallback, not an immediate second fetch ──
    // The .stream() below already delivers the initial snapshot, so firing a
    // REST load at the same time was a redundant ~46KB double-read. We only fall
    // back to REST if the stream is still slow after 2s (it self-skips once the
    // stream has populated the list).
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) _loadPairsOnce();
    });

    try {
      _pairsListener?.cancel();
      _pairsListener = _pollPairs((rows) {
        if (!mounted) return;

        // Capture the active pair + whether it was a Pocket Option pair
        // BEFORE we swap in the new list (to detect "removed while open").
        final oldActive = _signalEngine.activePair;
        final wasPo = AppConstants.currencyPairs.any(
          (p) =>
              p['symbol'] == oldActive &&
              (p['source'] as String? ?? 'po') == 'po',
        );

        // Only ENABLED pairs reach the app; both sources, 5-category taxonomy.
        final pairs =
            rows
                .map(
                  (d) => <String, dynamic>{
                    'id': d['id'],
                    'symbol': d['symbol'] as String? ?? '',
                    'chartSymbol': d['chart_symbol'] as String? ?? '',
                    'category': _normCat(d['category'] as String?),
                    'type': d['type'] as String? ?? '',
                    'source': (d['source'] as String? ?? 'po'),
                    'isOtc': d['is_otc'] == true,
                    'enabled': d['enabled'] != false,
                    'order': d['order'] as int? ?? 0,
                  },
                )
                .where(
                  (p) =>
                      (p['symbol'] as String).isNotEmpty &&
                      p['enabled'] == true,
                )
                .toList()
              ..sort(
                (a, b) => (a['order'] as int).compareTo(b['order'] as int),
              );

        final activeExists = pairs.any((p) => p['symbol'] == oldActive);

        setState(() {
          AppConstants.currencyPairs = pairs;

          // If the selected category now has no visible pairs, switch to the
          // first category that does so the picker isn't stuck empty.
          final vis = _visiblePairs;
          if (vis.isNotEmpty && !_categoryHasPairs(_selectedCategory)) {
            _selectedCategory = _normCat(vis.first['category'] as String?);
          }

          // The pair shown outside the picker must be a VISIBLE one (right
          // source) and, by default, the FIRST pair of the selected category.
          final activeVisible = vis.any((p) => p['symbol'] == oldActive);
          if (!activeVisible && vis.isNotEmpty) {
            final inCat = vis
                .where(
                  (p) =>
                      _normCat(p['category'] as String?) == _selectedCategory,
                )
                .toList();
            final pick = inCat.isNotEmpty ? inCat.first : vis.first;
            _activeChartSymbol = pick['chartSymbol'] as String? ?? '';
            final s = pick['symbol'] as String? ?? '';
            if (s.isNotEmpty) _signalEngine.selectPair(s);
          }

          // No visible pairs at all → stop monitoring (nothing to watch).
          if (vis.isEmpty && _signalEngine.isMonitoring) {
            _signalEngine.stopMonitoring();
          }
        });

        // STATE 9 — the OTC pair the user was viewing got disabled/removed
        // from the library while open. Tell them clearly (we already
        // switched them to another pair above).
        if (!activeExists && wasPo && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                tr(
                  'هذا الزوج لم يعد متاحًا، يرجى اختيار زوج آخر',
                  'This pair is no longer available, please choose another pair',
                ),
                style: GoogleFonts.outfit(),
                textAlign: TextAlign.right,
              ),
              backgroundColor: AppConstants.warningOrange,
              duration: const Duration(seconds: 5),
            ),
          );
        }
      });
    } catch (_) {}
  }

  void _startStrategyListeners() {
    try {
      _stdStrategyListener?.cancel();
      _vipStrategyListener?.cancel();

      _stdStrategyListener = _pollConfig('strategy_standard', (rows) {
        if (rows.isEmpty || !mounted) return;
        final data = rows.first['data'] as Map<String, dynamic>? ?? {};
        if (data.isNotEmpty) _signalEngine.updateStandardStrategy(data);
      });

      _vipStrategyListener = _pollConfig('strategy_vip', (rows) {
        if (rows.isEmpty || !mounted) return;
        final data = rows.first['data'] as Map<String, dynamic>? ?? {};
        if (data.isNotEmpty) _signalEngine.updateVipStrategy(data);
      });

      _monStdStrategyListener?.cancel();
      _monStdStrategyListener = _pollConfig('monitoring_standard', (rows) {
        if (rows.isEmpty || !mounted) return;
        final data = rows.first['data'] as Map<String, dynamic>? ?? {};
        if (data.isNotEmpty) {
          _signalEngine.updateMonitoringStandardStrategy(data);
        }
      });

      _monVipStrategyListener?.cancel();
      _monVipStrategyListener = _pollConfig('monitoring_vip', (rows) {
        if (rows.isEmpty || !mounted) return;
        final data = rows.first['data'] as Map<String, dynamic>? ?? {};
        if (data.isNotEmpty) {
          _signalEngine.updateMonitoringVipStrategy(data);
        }
      });
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;
    final isDesktop = size.width > 950;

    return Scaffold(
      backgroundColor: AppConstants.spaceBackground,
      body: Stack(
        children: [
          // Static background layers — isolated from signal engine rebuilds
          const RepaintBoundary(child: TradingBackground()),
          const BackgroundParticles(),
          Positioned(
            top: -100,
            right: -100,
            child: IgnorePointer(
              child: SizedBox(
                width: 300,
                height: 300,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(
                        color: AppConstants.accentBlue.withAlpha(15),
                        blurRadius: 100,
                        spreadRadius: 20,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),

          // Dynamic content — only this subtree rebuilds when engine notifies
          SafeArea(
            child: AnimatedBuilder(
              animation: _signalEngine,
              builder: (context, child) {
                return Column(
                  children: [
                    _buildHeader(),
                    _buildAssetSelector(),
                    Expanded(
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.all(20),
                        child: isDesktop
                            ? _buildDesktopLayout()
                            : _buildMobileLayout(),
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  // HEADER: VIP User Banner & Log Out
  Widget _buildHeader() {
    final isVip = _signalEngine.userRole == 'vip';
    final size = MediaQuery.of(context).size;
    final isSmall = size.width < 750;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
      decoration: BoxDecoration(
        color: AppConstants.cardBgColor.withAlpha(180),
        border: const Border(
          bottom: BorderSide(color: AppConstants.borderGlow),
        ),
      ),
      child: isSmall
          ? Column(
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Expanded(child: _buildUserInfoSection(isVip)),
                    const SizedBox(width: 8),
                    _buildHeaderActionsRow(),
                  ],
                ),
                const SizedBox(height: 12),
                _buildVipBannerSection(isVip),
              ],
            )
          : Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(child: _buildUserInfoSection(isVip)),
                _buildVipBannerSection(isVip),
                _buildHeaderActionsRow(),
              ],
            ),
    );
  }

  Widget _buildUserInfoSection(bool isVip) {
    return Row(
      children: [
        Container(
          width: 32,
          height: 32,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: AppConstants.accentCyan.withAlpha(100),
              width: 1.2,
            ),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(7),
            child: Image.asset('assets/logo.jpg', fit: BoxFit.cover),
          ),
        ),
        const SizedBox(width: 12),
        Flexible(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Flexible(
                    child: Text(
                      isVip
                          ? 'VIP USER: $_userAccountId'
                          : 'USER: $_userAccountId',
                      overflow: TextOverflow.ellipsis,
                      style: GoogleFonts.outfit(
                        fontSize: 14,
                        fontWeight: FontWeight.bold,
                        color: Colors.white,
                        letterSpacing: 1,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: isVip ? Colors.amber : Colors.grey.shade700,
                      borderRadius: BorderRadius.circular(4),
                      border: Border.all(
                        color: isVip
                            ? Colors.amberAccent
                            : Colors.white.withAlpha(50),
                      ),
                      boxShadow: isVip
                          ? [
                              BoxShadow(
                                color: Colors.amber.withAlpha(80),
                                blurRadius: 4,
                              ),
                            ]
                          : null,
                    ),
                    child: Text(
                      isVip ? 'VIP PREMIUM' : 'STANDARD',
                      style: GoogleFonts.outfit(
                        fontSize: 8,
                        fontWeight: FontWeight.w900,
                        color: isVip ? Colors.black : Colors.white70,
                        letterSpacing: 1,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  Container(
                    width: 18,
                    height: 18,
                    decoration: BoxDecoration(
                      color: Colors.white,
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: AppConstants.borderGlow,
                        width: 1.2,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withAlpha(40),
                          blurRadius: 2,
                        ),
                      ],
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(9),
                      child: Padding(
                        padding: const EdgeInsets.all(1.0),
                        child: _brokerLogoUrl.isNotEmpty
                            ? Image.network(
                                _brokerLogoUrl,
                                fit: BoxFit.contain,
                                errorBuilder: (ctx, err, stack) =>
                                    _brokerLogoFallback(),
                              )
                            : _brokerLogoFallback(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      isVip
                          ? tr(
                              'منصة التداول: $_userBroker VIP',
                              'Trading platform: $_userBroker VIP',
                            )
                          : tr(
                              'منصة التداول: $_userBroker',
                              'Trading platform: $_userBroker',
                            ),
                      overflow: TextOverflow.ellipsis,
                      style: GoogleFonts.outfit(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: AppConstants.accentCyan,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildVipBannerSection(bool isVip) {
    if (isVip) {
      final parts = _getVipCountdownParts(_signalEngine.vipExpiry);
      return Directionality(
        textDirection: LanguageService.direction,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              tr('ينتهي الـ VIP خلال', 'VIP ends in'),
              style: GoogleFonts.outfit(
                fontSize: 9,
                fontWeight: FontWeight.w600,
                color: Colors.amber.withAlpha(180),
                letterSpacing: 1,
              ),
            ),
            const SizedBox(height: 5),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                _buildCountdownBox(parts['d']!, tr('يوم', 'days')),
                _buildCountdownSeparator(),
                _buildCountdownBox(parts['h']!, tr('ساعة', 'hrs')),
                _buildCountdownSeparator(),
                _buildCountdownBox(parts['m']!, tr('دقيقة', 'min')),
                _buildCountdownSeparator(),
                _buildCountdownBox(parts['s']!, tr('ثانية', 'sec')),
              ],
            ),
          ],
        ),
      );
    } else {
      return InkWell(
        onTap: () => openBrowserTab(
          _telegramContact.isNotEmpty
              ? _telegramContact
              : 'https://t.me/euro_trd1',
        ),
        borderRadius: BorderRadius.circular(10),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [Colors.amberAccent, Colors.orangeAccent],
            ),
            borderRadius: BorderRadius.circular(10),
            boxShadow: [
              BoxShadow(
                color: Colors.amber.withAlpha(60),
                blurRadius: 12,
                offset: const Offset(0, 2),
              ),
            ],
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.star_rounded, color: Colors.black, size: 16),
              const SizedBox(width: 6),
              Text(
                tr('ترقية الحساب إلى VIP 👑', 'Upgrade account to VIP 👑'),
                style: GoogleFonts.outfit(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  color: Colors.black,
                ),
              ),
            ],
          ),
        ),
      );
    }
  }

  Widget _buildCountdownBox(int value, String label) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 3),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.amber.withAlpha(20),
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: Colors.amber.withAlpha(100), width: 1),
        boxShadow: [
          BoxShadow(color: Colors.amber.withAlpha(30), blurRadius: 6),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            value.toString().padLeft(2, '0'),
            style: GoogleFonts.outfit(
              fontSize: 16,
              fontWeight: FontWeight.w900,
              color: Colors.amberAccent,
              letterSpacing: 1,
            ),
          ),
          Text(
            label,
            style: GoogleFonts.outfit(
              fontSize: 8,
              fontWeight: FontWeight.w600,
              color: Colors.amber.withAlpha(180),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCountdownSeparator() {
    return Text(
      ':',
      style: GoogleFonts.outfit(
        fontSize: 16,
        fontWeight: FontWeight.bold,
        color: Colors.amber.withAlpha(150),
      ),
    );
  }

  Widget _buildHeaderActionsRow() {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          onPressed: () {
            Navigator.of(
              context,
            ).push(MaterialPageRoute(builder: (_) => const LanguageScreen()));
          },
          icon: Icon(
            Icons.language_rounded,
            color: AppConstants.accentCyan,
            size: 20,
          ),
          tooltip: tr('اللغة', 'Language'),
        ),
        const SizedBox(width: 4),
        IconButton(
          onPressed: () {
            setState(() {
              _soundEnabled = !_soundEnabled;
            });
          },
          icon: Icon(
            _soundEnabled ? Icons.volume_up_rounded : Icons.volume_off_rounded,
            color: _soundEnabled
                ? AppConstants.accentCyan
                : AppConstants.textSecondary,
            size: 20,
          ),
          tooltip: 'Sound Notifications',
        ),
        const SizedBox(width: 8),
        TextButton.icon(
          onPressed: _logout,
          icon: const Icon(
            Icons.logout_rounded,
            color: AppConstants.putRed,
            size: 16,
          ),
          label: Text(
            'EXIT',
            style: GoogleFonts.outfit(
              fontSize: 12,
              fontWeight: FontWeight.bold,
              color: AppConstants.putRed,
            ),
          ),
        ),
      ],
    );
  }

  // Horizontal Categorized Asset/Currency Selector
  Widget _buildAssetSelector() {
    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFF0D0A1B),
        border: Border(bottom: BorderSide(color: AppConstants.borderGlow)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Category Selector Row
          Container(
            height: 88,
            padding: const EdgeInsets.symmetric(vertical: 10),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: Color(0xFF1E1736))),
            ),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  if (_categoryHasPairs('currencies'))
                    _buildCategoryTab(
                      'currencies',
                      tr('عملات', 'Currencies'),
                      Icons.currency_exchange_rounded,
                    ),
                  if (_categoryHasPairs('commodities'))
                    _buildCategoryTab(
                      'commodities',
                      tr('سلع', 'Commodities'),
                      Icons.local_gas_station_rounded,
                    ),
                  if (_categoryHasPairs('stocks'))
                    _buildCategoryTab(
                      'stocks',
                      tr('أسهم', 'Stocks'),
                      Icons.business_rounded,
                    ),
                  if (_categoryHasPairs('indices'))
                    _buildCategoryTab(
                      'indices',
                      tr('مؤشرات', 'Indices'),
                      Icons.show_chart_rounded,
                    ),
                  if (_categoryHasPairs('crypto'))
                    _buildCategoryTab(
                      'crypto',
                      tr('كريبتو', 'Crypto'),
                      Icons.currency_bitcoin_rounded,
                    ),
                ],
              ),
            ),
          ),

          // Dropdown Active Pair Selector Box
          Padding(
            padding: const EdgeInsets.all(12),
            child: InkWell(
              onTap: _showSearchableAssetBottomSheet,
              borderRadius: BorderRadius.circular(12),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 20,
                  vertical: 14,
                ),
                decoration: BoxDecoration(
                  color: AppConstants.cardBgColor,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppConstants.borderGlow),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withAlpha(50),
                      blurRadius: 10,
                      offset: const Offset(0, 4),
                    ),
                  ],
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Icon(
                      Icons.arrow_drop_down_circle_outlined,
                      color: AppConstants.accentCyan,
                      size: 22,
                    ),
                    Builder(
                      builder: (_) {
                        final ap = _effectiveActivePairData();
                        final sym =
                            (ap['symbol'] as String? ??
                                    _signalEngine.activePair)
                                .replaceAll(' (OTC)', '');
                        return Row(
                          children: [
                            Text(
                              sym,
                              style: GoogleFonts.outfit(
                                fontSize: 15,
                                fontWeight: FontWeight.bold,
                                color: Colors.white,
                                letterSpacing: 0.5,
                              ),
                            ),
                            const SizedBox(width: 10),
                            // Source badge: 🎯 Pocket Option
                            const Text('🎯', style: TextStyle(fontSize: 16)),
                          ],
                        );
                      },
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _showSearchableAssetBottomSheet() {
    // Defensive: if the active category has no pairs, jump to the first
    // category that does so the picker doesn't open on an empty list.
    if (!_categoryHasPairs(_selectedCategory)) {
      final vis = _visiblePairs;
      _selectedCategory = vis.isNotEmpty
          ? _normCat(vis.first['category'] as String?)
          : _selectedCategory;
    }

    final screenWidth = MediaQuery.of(context).size.width;
    final dialogWidth = screenWidth * 0.92 < 420 ? screenWidth * 0.92 : 420.0;

    showDialog(
      context: context,
      barrierDismissible: true,
      barrierColor: Colors.black.withAlpha(160),
      builder: (BuildContext context) {
        return StatefulBuilder(
          builder: (BuildContext context, StateSetter setModalState) {
            final sourcePairs = _visiblePairs
                .where(
                  (pair) =>
                      _normCat(pair['category'] as String?) ==
                      _selectedCategory,
                )
                .toList();

            final filteredPairs = sourcePairs.where((pair) {
              if (_searchQuery.isEmpty) return true;
              return (pair['symbol'] as String).toLowerCase().contains(
                _searchQuery.toLowerCase(),
              );
            }).toList();

            return Dialog(
              backgroundColor: Colors.transparent,
              insetPadding: const EdgeInsets.symmetric(
                horizontal: 16,
                vertical: 24,
              ),
              child: ConstrainedBox(
                constraints: BoxConstraints(maxWidth: dialogWidth),
                child: Container(
                  height: MediaQuery.of(context).size.height * 0.75,
                  decoration: BoxDecoration(
                    color: AppConstants.cardBgColor,
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(
                      color: AppConstants.borderGlow,
                      width: 1.5,
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withAlpha(120),
                        blurRadius: 30,
                        offset: const Offset(0, 12),
                      ),
                    ],
                  ),
                  child: Column(
                    children: [
                      // Branded header: logo + brand title + subtitle + close
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 16, 8, 8),
                        child: Row(
                          children: [
                            ClipRRect(
                              borderRadius: BorderRadius.circular(10),
                              child: Image.asset(
                                'assets/logo.jpg',
                                width: 34,
                                height: 34,
                                fit: BoxFit.cover,
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(
                                    'EURO TRADER',
                                    style: GoogleFonts.outfit(
                                      fontSize: 16,
                                      fontWeight: FontWeight.bold,
                                      color: Colors.white,
                                      letterSpacing: 1.5,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    tr(
                                      'اختر الأصل للتداول',
                                      'Choose an asset to trade',
                                    ),
                                    style: GoogleFonts.outfit(
                                      fontSize: 12,
                                      color: AppConstants.textSecondary,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            IconButton(
                              icon: const Icon(
                                Icons.close_rounded,
                                color: Colors.white,
                              ),
                              onPressed: () => Navigator.pop(context),
                            ),
                          ],
                        ),
                      ),

                      // Search input field
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 8,
                        ),
                        child: Container(
                          decoration: BoxDecoration(
                            color: AppConstants.spaceBackground,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: AppConstants.borderGlow),
                          ),
                          child: TextField(
                            style: GoogleFonts.outfit(color: Colors.white),
                            textAlign: TextAlign.right,
                            decoration: InputDecoration(
                              hintText: tr(
                                'البحث عن أصول (مثال: USD)...',
                                'Search assets (e.g. USD)...',
                              ),
                              hintStyle: GoogleFonts.outfit(
                                color: AppConstants.textSecondary,
                                fontSize: 13,
                              ),
                              prefixIcon: Icon(
                                Icons.search_rounded,
                                color: AppConstants.accentCyan,
                              ),
                              border: InputBorder.none,
                              contentPadding: const EdgeInsets.symmetric(
                                horizontal: 16,
                                vertical: 12,
                              ),
                            ),
                            onChanged: (val) {
                              setModalState(() {
                                _searchQuery = val;
                              });
                            },
                          ),
                        ),
                      ),

                      // List of pairs
                      Expanded(
                        child: filteredPairs.isEmpty
                            ? Center(
                                child: Text(
                                  tr(
                                    'لا توجد أصول تطابق البحث',
                                    'No assets match your search',
                                  ),
                                  textAlign: TextAlign.center,
                                  style: GoogleFonts.outfit(
                                    color: AppConstants.textSecondary,
                                    height: 1.5,
                                  ),
                                ),
                              )
                            : ListView.builder(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                  vertical: 8,
                                ),
                                itemCount: filteredPairs.length,
                                itemBuilder: (context, index) {
                                  final pair = filteredPairs[index];
                                  final isSelected =
                                      _signalEngine.activePair ==
                                      pair['symbol'];
                                  final closed = _isPairClosed(pair);

                                  return Padding(
                                    padding: const EdgeInsets.only(bottom: 8),
                                    child: InkWell(
                                      onTap: closed
                                          ? null
                                          : () {
                                        _signalEngine.selectPair(
                                          pair['symbol'],
                                        );
                                        final cs =
                                            pair['chartSymbol'] as String? ??
                                            '';
                                        if (cs.isNotEmpty) {
                                          setState(
                                            () => _activeChartSymbol = cs,
                                          );
                                        }
                                        _syncEngineCandles();
                                        Navigator.pop(context);
                                        // Re-evaluate market status for the new pair right away.
                                        _pollMarketStatus();
                                      },
                                      borderRadius: BorderRadius.circular(12),
                                      child: Container(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 16,
                                          vertical: 14,
                                        ),
                                        decoration: BoxDecoration(
                                          color: isSelected
                                              ? AppConstants.accentBlue
                                                    .withAlpha(25)
                                              : AppConstants.spaceBackground
                                                    .withAlpha(120),
                                          borderRadius: BorderRadius.circular(
                                            12,
                                          ),
                                          border: Border.all(
                                            color: isSelected
                                                ? AppConstants.accentBlue
                                                : AppConstants.borderGlow,
                                            width: 1,
                                          ),
                                        ),
                                        child: Row(
                                          mainAxisAlignment:
                                              MainAxisAlignment.end,
                                          children: [
                                            // Source badge + symbol (no payout %)
                                            Row(
                                              children: [
                                                // Source: 🎯 Pocket Option
                                                const Text(
                                                  '🎯',
                                                  style: TextStyle(
                                                    fontSize: 14,
                                                  ),
                                                ),
                                                if (pair['isOtc'] == true) ...[
                                                  const SizedBox(width: 4),
                                                  Text(
                                                    'OTC',
                                                    style: GoogleFonts.outfit(
                                                      fontSize: 9,
                                                      fontWeight:
                                                          FontWeight.w700,
                                                      color: AppConstants
                                                          .accentCyan,
                                                    ),
                                                  ),
                                                ],
                                                const SizedBox(width: 8),
                                                Text(
                                                  (pair['symbol'] as String)
                                                      .replaceAll(' (OTC)', ''),
                                                  style: GoogleFonts.outfit(
                                                    fontSize: 14,
                                                    fontWeight: FontWeight.bold,
                                                    color: closed
                                                        ? AppConstants
                                                              .textSecondary
                                                        : isSelected
                                                        ? Colors.white
                                                        : AppConstants
                                                              .textPrimary,
                                                  ),
                                                ),
                                                if (closed) ...[
                                                  const SizedBox(width: 8),
                                                  const Icon(
                                                    Icons.lock_rounded,
                                                    size: 14,
                                                    color: AppConstants.putRed,
                                                  ),
                                                  const SizedBox(width: 2),
                                                  Text(
                                                    tr('مغلق', 'Closed'),
                                                    style: GoogleFonts.outfit(
                                                      fontSize: 10,
                                                      fontWeight: FontWeight.w700,
                                                      color: AppConstants.putRed,
                                                    ),
                                                  ),
                                                ],
                                              ],
                                            ),
                                          ],
                                        ),
                                      ),
                                    ),
                                  );
                                },
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        );
      },
    ).then((_) {
      setState(() {
        _searchQuery = '';
      });
    });
  }

  // Returns true if at least one VISIBLE pair (enabled + allowed by the current
  // display_source) belongs to [cat]. Empty categories are hidden by callers.
  bool _categoryHasPairs(String cat) =>
      _visiblePairs.any((p) => _normCat(p['category'] as String?) == cat);

  // Make the FIRST visible pair in [cat] the active pair (the one shown outside
  // the picker). Respects display_source; falls back to the first visible pair.
  void _selectFirstVisibleInCategory(String cat) {
    final vis = _visiblePairs;
    if (vis.isEmpty) return;
    final inCat = vis
        .where((p) => _normCat(p['category'] as String?) == cat)
        .toList();
    final pick = inCat.isNotEmpty ? inCat.first : vis.first;
    final sym = pick['symbol'] as String? ?? '';
    final cs = pick['chartSymbol'] as String? ?? '';
    if (sym.isEmpty) return;
    if (mounted) setState(() => _activeChartSymbol = cs);
    _signalEngine.selectPair(sym);
    _syncEngineCandles(); // load the new pair's real candles into the engine
    _pollMarketStatus(); // refresh market status for the new pair
  }

  // The pair to SHOW outside the picker. If the active pair is no longer visible
  // (deleted from admin, hidden by display_source, category switched…), fall back
  // to the first visible pair of the selected category AND self-heal the engine
  // after this frame — so the collapsed bar never shows a pair that isn't listed.
  Map<String, dynamic> _effectiveActivePairData() {
    final vis = _visiblePairs;
    if (vis.isEmpty) return const <String, dynamic>{};
    final active = vis.firstWhere(
      (p) => p['symbol'] == _signalEngine.activePair,
      orElse: () => const <String, dynamic>{},
    );
    if (active.isNotEmpty) return active;
    final inCat = vis
        .where((p) => _normCat(p['category'] as String?) == _selectedCategory)
        .toList();
    final pick = inCat.isNotEmpty ? inCat.first : vis.first;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _signalEngine.activePair != pick['symbol']) {
        _selectFirstVisibleInCategory(_selectedCategory);
      }
    });
    return pick;
  }

  Widget _buildCategoryTab(String categoryId, String label, IconData icon) {
    final isSelected = _selectedCategory == categoryId;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6),
      child: InkWell(
        onTap: () {
          setState(() => _selectedCategory = categoryId);
          // Switching category → show its FIRST visible pair outside the picker.
          _selectFirstVisibleInCategory(categoryId);
        },
        borderRadius: BorderRadius.circular(12),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 250),
          width: 95,
          height: 64,
          decoration: BoxDecoration(
            color: isSelected
                ? AppConstants.accentCyan.withAlpha(20)
                : AppConstants.cardBgColor.withAlpha(150),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: isSelected
                  ? AppConstants.accentCyan
                  : AppConstants.borderGlow,
              width: 1.5,
            ),
            boxShadow: isSelected
                ? [
                    BoxShadow(
                      color: AppConstants.accentCyan.withAlpha(30),
                      blurRadius: 10,
                      spreadRadius: 1,
                    ),
                  ]
                : [],
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                icon,
                size: 14,
                color: isSelected
                    ? AppConstants.accentCyan
                    : AppConstants.textSecondary,
              ),
              const SizedBox(width: 6),
              Text(
                label,
                style: GoogleFonts.outfit(
                  fontSize: 12,
                  fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                  color: isSelected ? Colors.white : AppConstants.textSecondary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // DESKTOP LAYOUT
  Widget _buildDesktopLayout() {
    return Column(
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              flex: 2,
              child: Column(
                children: [
                  _buildChartCard(),
                  const SizedBox(height: 20),
                  _buildSignalHistoryCard(),
                ],
              ),
            ),
            const SizedBox(width: 20),
            Expanded(flex: 1, child: Column(children: [_buildLiveFeedCard()])),
          ],
        ),
        const SizedBox(height: 20),
        // Social follow footer — always the LAST thing on the signals page.
        _buildSocialCards(),
        const SizedBox(height: 24),
      ],
    );
  }

  // MOBILE LAYOUT
  Widget _buildMobileLayout() {
    return Column(
      children: [
        _buildChartCard(),
        const SizedBox(height: 20),
        _buildSignalHistoryCard(),
        const SizedBox(height: 20),
        _buildLiveFeedCard(),
        const SizedBox(height: 20),
        // Social follow footer — always the LAST thing on the signals page.
        _buildSocialCards(),
        const SizedBox(height: 24),
      ],
    );
  }

  // Small circular "?" help button placed next to a signal button.
  Widget _buildHelpButton({required Color color, required VoidCallback onTap}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 46,
        height: 46,
        decoration: BoxDecoration(
          color: color.withAlpha(20),
          shape: BoxShape.circle,
          border: Border.all(color: color.withAlpha(90)),
        ),
        child: Icon(Icons.question_mark_rounded, color: color, size: 20),
      ),
    );
  }

  void _onMonitorPressed() {
    if (!_marketOpen || _signalEngine.isMarketClosed) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            tr(
              'السوق مغلق حالياً — لا يمكن بدء المراقبة',
              'The market is currently closed — monitoring can\'t start',
            ),
          ),
          backgroundColor: AppConstants.putRed,
        ),
      );
      return;
    }
    if (_isActiveOtc() && _otcUnhealthy) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            tr(
              'جارٍ إعادة الاتصال بمصدر السعر... حاول بعد لحظات',
              'Reconnecting to the price source... try again in a moment',
            ),
          ),
          backgroundColor: AppConstants.warningOrange,
        ),
      );
      return;
    }
    _signalEngine.startMonitoring(
      _selectedMinutes,
      livePriceGetter: _livePriceGetter,
    );
  }

  // The smart-monitoring button (distinct icon + color from the instant button).
  Widget _buildMonitorButton() {
    const c = AppConstants.warningOrange;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: _onMonitorPressed,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            gradient: LinearGradient(
              colors: [c.withAlpha(60), c.withAlpha(25)],
            ),
            border: Border.all(color: c.withAlpha(140)),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.radar_rounded, color: c, size: 20),
              const SizedBox(width: 8),
              Text(
                tr('المراقبة الذكية 🎯', 'Smart monitoring 🎯'),
                style: GoogleFonts.outfit(
                  fontSize: 14,
                  fontWeight: FontWeight.w900,
                  color: Colors.white,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // Panel shown while monitoring is running but no trade has fired yet.
  Widget _buildMonitoringWaitingPanel() {
    const c = AppConstants.warningOrange;
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.radar_rounded, color: c, size: 20),
              const SizedBox(width: 8),
              Text(
                tr('جاري المراقبة...', 'Monitoring...'),
                style: GoogleFonts.outfit(
                  fontSize: 15,
                  fontWeight: FontWeight.w900,
                  color: Colors.white,
                ),
              ),
            ],
          ),
          // Signals fired so far this session — so a user who looked away knows
          // an alert already happened (and how many).
          if (_signalEngine.monitoringSignalsFired > 0) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: AppConstants.callGreen.withAlpha(22),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: AppConstants.callGreen.withAlpha(90)),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('🔔', style: TextStyle(fontSize: 13)),
                  const SizedBox(width: 6),
                  Text(
                    tr(
                      'إشارات صدرت حتى الآن: ${_signalEngine.monitoringSignalsFired}',
                      'Signals fired so far: ${_signalEngine.monitoringSignalsFired}',
                    ),
                    style: GoogleFonts.outfit(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w800,
                      color: AppConstants.callGreen,
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 6),
          Text(
            _signalEngine.monitoringLastCheckFailed
                ? tr(
                    'لم تتوافق شروط الدخول، جاري انتظار الشمعة التالية...',
                    'Entry conditions weren\'t met, waiting for the next candle...',
                  )
                : tr(
                    'يراقب النظام السوق وينتظر أفضل لحظة دخول على بداية الشمعة القادمة.',
                    'The system is watching the market and waiting for the best entry at the start of the next candle.',
                  ),
            textAlign: TextAlign.center,
            style: GoogleFonts.outfit(
              fontSize: 11.5,
              color: _signalEngine.monitoringLastCheckFailed
                  ? c
                  : AppConstants.textSecondary,
              fontWeight: _signalEngine.monitoringLastCheckFailed
                  ? FontWeight.w700
                  : FontWeight.normal,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              // Next candle countdown
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  decoration: BoxDecoration(
                    color: c.withAlpha(18),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: c.withAlpha(70)),
                  ),
                  child: Column(
                    children: [
                      Text(
                        tr('الشمعة القادمة بعد', 'Next candle in'),
                        style: GoogleFonts.outfit(
                          fontSize: 9.5,
                          color: AppConstants.textSecondary,
                          letterSpacing: 0.5,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        _signalEngine.formattedMonitoringCountdown,
                        style: GoogleFonts.robotoMono(
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                          color: c,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),
              // Signals fired count
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  decoration: BoxDecoration(
                    color: AppConstants.callGreen.withAlpha(15),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color: AppConstants.callGreen.withAlpha(60),
                    ),
                  ),
                  child: Column(
                    children: [
                      Text(
                        tr('الصفقات الصادرة', 'Signals fired'),
                        style: GoogleFonts.outfit(
                          fontSize: 9.5,
                          color: AppConstants.textSecondary,
                          letterSpacing: 0.5,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${_signalEngine.monitoringSignalsFired}',
                        style: GoogleFonts.robotoMono(
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                          color: AppConstants.callGreen,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),
              // Total monitoring elapsed (count-up)
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  decoration: BoxDecoration(
                    color: AppConstants.accentCyan.withAlpha(15),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color: AppConstants.accentCyan.withAlpha(60),
                    ),
                  ),
                  child: Column(
                    children: [
                      Text(
                        tr('مدة المراقبة', 'Monitoring time'),
                        style: GoogleFonts.outfit(
                          fontSize: 9.5,
                          color: AppConstants.textSecondary,
                          letterSpacing: 0.5,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        _signalEngine.formattedMonitoringElapsed,
                        style: GoogleFonts.robotoMono(
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                          color: AppConstants.accentCyan,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: () => _signalEngine.stopMonitoring(),
              icon: const Icon(Icons.stop_circle_rounded, size: 18),
              label: Text(tr('إيقاف المراقبة', 'Stop monitoring')),
              style: OutlinedButton.styleFrom(
                foregroundColor: AppConstants.putRed,
                side: const BorderSide(color: AppConstants.putRed),
                padding: const EdgeInsets.symmetric(vertical: 12),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // Signal-strength bar (score ÷ max_score × 100%) for monitoring signals.
  Widget _buildStrengthBar(double pct, Color color) {
    final p = (pct / 100).clamp(0.0, 1.0);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              tr('قوة الإشارة', 'Signal strength'),
              style: GoogleFonts.outfit(
                fontSize: 9,
                color: AppConstants.textSecondary,
                letterSpacing: 1,
              ),
            ),
            Text(
              '${pct.toStringAsFixed(0)}%',
              style: GoogleFonts.outfit(
                fontSize: 11,
                fontWeight: FontWeight.w900,
                color: color,
              ),
            ),
          ],
        ),
        const SizedBox(height: 5),
        ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: LinearProgressIndicator(
            value: p,
            minHeight: 8,
            backgroundColor: AppConstants.borderGlow,
            valueColor: AlwaysStoppedAnimation<Color>(color),
          ),
        ),
      ],
    );
  }

  String _getFriendlyWaitNotice(String rawNotice) {
    if (rawNotice.contains('الفارق بين الاتجاهين') ||
        rawNotice.contains('insufficient_score_gap')) {
      return tr(
        'الإشارات الحالية غير حاسمة (تعارض بين المؤشرات)، ننتظر توافقًا أوضح.',
        'The current signals are inconclusive (conflict between indicators), waiting for a clearer agreement.',
      );
    }
    if (rawNotice.contains('فشل فلتر') ||
        rawNotice.contains('المرحلة الثالثة (الفلاتر)') ||
        rawNotice.contains('low_volatility_filter_blocked')) {
      return tr(
        'السوق هادئ/متذبذب حاليًا، الحركة غير كافية لإصدار إشارة موثوقة الآن.',
        'The market is currently quiet/volatile, movement is insufficient to issue a reliable signal now.',
      );
    }
    if (rawNotice.contains('المرحلة الأولى (الأساس)')) {
      return tr(
        'السوق هادئ/متذبذب حاليًا، الحركة غير كافية لإصدار إشارة موثوقة الآن.',
        'The market is currently quiet/volatile, movement is insufficient to issue a reliable signal now.',
      );
    }
    if (rawNotice.contains('المرحلة الثانية (التأكيد)')) {
      return tr(
        'الإشارات الحالية غير حاسمة (تعارض بين المؤشرات)، ننتظر توافقًا أوضح.',
        'The current signals are inconclusive (conflict between indicators), waiting for a clearer agreement.',
      );
    }
    return tr(
      'لا توجد إشارة موثوقة في الوقت الحالي، يرجى المحاولة بعد قليل.',
      'No reliable signal at the moment, please try again shortly.',
    );
  }

  void _showInstantSignalHelp() {
    _showUsageHelpDialog(
      icon: Icons.bolt_rounded,
      accent: AppConstants.accentCyan,
      title: tr('زر الإشارة الفورية', 'Instant signal button'),
      lines: [
        tr('اضغط الزر في أي وقت.', 'Tap the button anytime.'),
        tr(
          'النظام يحلل السوق فوراً وبعد ثوانٍ قليلة تظهر لك الإشارة.',
          'The system analyzes the market instantly and shows you a signal within a few seconds.',
        ),
        '',
        tr('⚡ سريع وفوري', '⚡ Fast and instant'),
        tr('⏱️ النتيجة في أقل من 5 ثوانٍ', '⏱️ Result in under 5 seconds'),
      ],
    );
  }

  void _showMonitoringHelp() {
    _showUsageHelpDialog(
      icon: Icons.radar_rounded,
      accent: AppConstants.warningOrange,
      title: tr('زر المراقبة الذكية', 'Smart monitoring button'),
      lines: [
        tr('اضغط الزر وسيبه يشتغل.', 'Tap the button and let it run.'),
        tr(
          'النظام يراقب السوق باستمرار وينتظر أفضل لحظة للدخول.',
          'The system continuously watches the market and waits for the best moment to enter.',
        ),
        '',
        tr(
          '⏳ ممكن ياخد وقت (دقائق أو أكثر حسب السوق)',
          '⏳ It may take a while (minutes or more depending on the market)',
        ),
        '',
        tr('لما اللحظة تيجي:', 'When the moment comes:'),
        tr(
          '🔔 هتسمع صوت تنبيه فوراً',
          '🔔 You\'ll hear an alert sound immediately',
        ),
        tr(
          '📊 هتلاقي الإشارة واضحة قدامك',
          '📊 The signal will appear clearly in front of you',
        ),
        tr(
          '⏱️ وعداد الصفقة هيبدأ تلقائياً',
          '⏱️ And the trade timer will start automatically',
        ),
        '',
        tr(
          '💡 نصيحة: فعّل الصوت على جهازك عشان ما تفوتك الإشارة.',
          '💡 Tip: turn on sound on your device so you don\'t miss the signal.',
        ),
      ],
    );
  }

  // Simple, jargon-free usage dialog (no strategy details, no numbers).
  void _showUsageHelpDialog({
    required IconData icon,
    required Color accent,
    required String title,
    required List<String> lines,
  }) {
    showDialog(
      context: context,
      builder: (ctx) => Directionality(
        textDirection: LanguageService.direction,
        child: AlertDialog(
          backgroundColor: const Color(0xFF12102A),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: BorderSide(color: accent.withAlpha(120), width: 1.5),
          ),
          title: Row(
            children: [
              Icon(icon, color: accent, size: 26),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  title,
                  style: GoogleFonts.outfit(
                    color: Colors.white,
                    fontWeight: FontWeight.w900,
                    fontSize: 17,
                  ),
                ),
              ),
            ],
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: lines
                .map(
                  (l) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2.5),
                    child: Text(
                      l,
                      style: GoogleFonts.outfit(
                        color: l.isEmpty ? Colors.transparent : Colors.white70,
                        fontSize: 13.5,
                        height: 1.5,
                        fontWeight:
                            l.startsWith('⚡') ||
                                l.startsWith('🔔') ||
                                l.startsWith('📊') ||
                                l.startsWith('⏱️') ||
                                l.startsWith('⏳') ||
                                l.startsWith('💡')
                            ? FontWeight.w700
                            : FontWeight.normal,
                      ),
                    ),
                  ),
                )
                .toList(),
          ),
          actions: [
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: () => Navigator.pop(ctx),
                style: ElevatedButton.styleFrom(
                  backgroundColor: accent,
                  foregroundColor: Colors.black,
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
                child: Text(
                  tr('فهمت', 'Got it'),
                  style: GoogleFonts.outfit(fontWeight: FontWeight.w900),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // Shown instead of the chart when the admin hasn't enabled any pair.
  Widget _buildNoPairsCard() {
    return _buildGlassCard(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 20),
        child: Column(
          children: [
            Icon(
              Icons.show_chart_rounded,
              color: AppConstants.textSecondary.withAlpha(120),
              size: 54,
            ),
            const SizedBox(height: 16),
            Text(
              tr('لا توجد أزواج متاحة حالياً', 'No pairs available right now'),
              textAlign: TextAlign.center,
              style: GoogleFonts.outfit(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: Colors.white,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              tr(
                'اختر زوجاً من القائمة عند توفره',
                'Choose a pair from the list once available',
              ),
              textAlign: TextAlign.center,
              style: GoogleFonts.outfit(
                fontSize: 12.5,
                color: AppConstants.textSecondary,
              ),
            ),
          ],
        ),
      ),
    );
  }

  // WIDGET: Chart + Signal Panel (combined card)
  Widget _buildChartCard() {
    // No enabled pairs at all → don't show any chart, show a friendly empty state.
    if (_visiblePairs.isEmpty) {
      return _buildNoPairsCard();
    }
    final chartSymbol = _activeChartSymbol.isNotEmpty
        ? _activeChartSymbol
        : AppConstants.chartSymbolFor(_signalEngine.activePair);
    // Chart data source resolution:
    //   • Simulator system → 'sim' (generated data) for every pair.
    //   • Scraping system  → Pocket Option pairs (source 'po') use the
    //     Supabase/proxy-fed 'otc' mode. (App is Pocket-Option-only.)
    final activePairData = AppConstants.currencyPairs.firstWhere(
      (p) => (p['chartSymbol'] as String? ?? '') == chartSymbol,
      orElse: () => const <String, dynamic>{},
    );
    final bool isPo = (activePairData['source'] as String? ?? 'po') == 'po';
    final String effectiveMode = _effectivePriceSystem == 'simulator'
        ? 'sim'
        : (isPo ? 'otc' : 'sim');
    final tf = _signalEngine.chartTimeframe;
    final signal = _signalEngine.activeSignal;
    final isActive = signal?.status == 'ACTIVE';

    final accentColor = signal == null || _signalEngine.isAnalyzing
        ? AppConstants.accentCyan
        : signal.direction == 'WAIT'
        ? AppConstants.warningOrange
        : signal.direction == 'CALL'
        ? AppConstants.callGreen
        : AppConstants.putRed;

    return _buildGlassCard(
      borderColor: isActive ? accentColor.withAlpha(100) : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // ── Chart Header ──
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 10),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(5),
                  decoration: BoxDecoration(
                    color: AppConstants.accentCyan.withAlpha(15),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    Icons.candlestick_chart_rounded,
                    color: AppConstants.accentCyan,
                    size: 16,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'LIVE CHART',
                        style: GoogleFonts.outfit(
                          fontSize: 9,
                          fontWeight: FontWeight.bold,
                          color: AppConstants.textSecondary,
                          letterSpacing: 1.5,
                        ),
                      ),
                      Text(
                        chartSymbol
                            .replaceFirst(RegExp(r'^[A-Z]+:'), '')
                            .replaceAll('_', '/'),
                        overflow: TextOverflow.ellipsis,
                        style: GoogleFonts.outfit(
                          fontSize: 14,
                          fontWeight: FontWeight.w900,
                          color: Colors.white,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      '1m',
                      '5m',
                      '15m',
                      '1h',
                      '1D',
                    ].map(_buildTimeframeButton).toList(),
                  ),
                ),
              ],
            ),
          ),

          // ── Chart ──
          PriceChart(
            symbol: chartSymbol,
            interval: tf,
            mode: effectiveMode,
            guaranteedWin: _signalEngine.isGuaranteedWin,
            signalDirection: isActive ? signal!.direction : null,
            signalEntryPrice: signal?.entryPrice,
            signalDurationMin: signal?.durationMinutes,
            signalSecondsRemaining: isActive
                ? _signalEngine.secondsRemaining
                : null,
            onReady: (getter) => _livePriceGetter = getter,
          ),

          // ── Divider ──
          const Divider(color: AppConstants.borderGlow, height: 1),

          // ── Signal Panel ──
          _buildSignalPanel(),
        ],
      ),
    );
  }

  // WIDGET: Signal Panel (embedded inside chart card)
  Widget _buildSignalPanel() {
    // 1. Analyzing State
    if (_signalEngine.isAnalyzing) {
      return Padding(
        padding: const EdgeInsets.all(12),
        child: SizedBox(
          height: 120,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              SizedBox(
                width: 24,
                height: 24,
                child: CircularProgressIndicator(
                  color: AppConstants.accentCyan,
                  strokeWidth: 2.0,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                'VIP SYSTEM RADAR ANALYSIS',
                style: GoogleFonts.outfit(
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                  color: AppConstants.textSecondary,
                  letterSpacing: 2,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                _signalEngine.analysisStageText,
                textAlign: TextAlign.center,
                style: GoogleFonts.outfit(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: AppConstants.accentCyan,
                ),
              ),
            ],
          ),
        ),
      );
    }

    final signal = _signalEngine.activeSignal;

    // 1.5 Monitoring (waiting for a new candle) — no active trade yet.
    if (_signalEngine.isMonitoring && signal == null) {
      return _buildMonitoringWaitingPanel();
    }

    // 2. Idle State
    if (signal == null) {
      return Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(
                    color: AppConstants.accentCyan.withAlpha(15),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    Icons.psychology_rounded,
                    color: AppConstants.accentCyan,
                    size: 16,
                  ),
                ),
                const SizedBox(width: 8),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'VIP ALGORITHM SENSOR',
                      style: GoogleFonts.outfit(
                        fontSize: 9,
                        fontWeight: FontWeight.bold,
                        color: AppConstants.textSecondary,
                        letterSpacing: 1.5,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      tr('التحليل جاهز للاستخراج', 'Analysis ready to extract'),
                      style: GoogleFonts.outfit(
                        fontSize: 14,
                        fontWeight: FontWeight.w900,
                        color: Colors.white,
                      ),
                    ),
                  ],
                ),
              ],
            ),
            const Divider(color: AppConstants.borderGlow, height: 16),
            Text(
              tr(
                'اضغط أدناه لبدء تحليل شامل للزوج ${_signalEngine.activePair.replaceAll(' (OTC)', '')} بفريم ${_signalEngine.chartTimeframe} واستخراج الصفقة ذات الاحتمالية الأكبر.',
                'Tap below to start a full analysis of ${_signalEngine.activePair.replaceAll(' (OTC)', '')} on the ${_signalEngine.chartTimeframe} timeframe and extract the highest-probability trade.',
              ),
              textAlign: TextAlign.center,
              style: GoogleFonts.outfit(
                fontSize: 11,
                color: AppConstants.textSecondary,
                height: 1.4,
              ),
            ),
            const SizedBox(height: 12),
            // "No opportunity now" banner (instant press that didn't meet the strategy)
            if (_signalEngine.lastWaitNotice.isNotEmpty) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: AppConstants.warningOrange.withAlpha(20),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                    color: AppConstants.warningOrange.withAlpha(90),
                  ),
                ),
                child: Row(
                  children: [
                    const Icon(
                      Icons.hourglass_empty_rounded,
                      color: AppConstants.warningOrange,
                      size: 18,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        (() {
                          final proReason =
                              _signalEngine.lastProResult?['reason_blocked']
                                  as String?;
                          return (proReason != null && proReason.isNotEmpty)
                              ? _getFriendlyWaitNotice(proReason)
                              : _getFriendlyWaitNotice(
                                  _signalEngine.lastWaitNotice,
                                );
                        })(),
                        style: GoogleFonts.outfit(
                          fontSize: 11.5,
                          color: AppConstants.warningOrange,
                          fontWeight: FontWeight.w700,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
            ],
            _buildDurationSelector(),
            const SizedBox(height: 12),
            // Instant signal button + its help "?"
            Row(
              children: [
                Expanded(
                  child: _buildRequestButton(
                    enabled: true,
                    text: tr(
                      'استخراج الإشارة الفورية ⚡',
                      'Extract instant signal ⚡',
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                _buildHelpButton(
                  color: AppConstants.accentCyan,
                  onTap: _showInstantSignalHelp,
                ),
              ],
            ),
            const SizedBox(height: 10),
            // Smart monitoring button + its help "?"
            Row(
              children: [
                Expanded(child: _buildMonitorButton()),
                const SizedBox(width: 8),
                _buildHelpButton(
                  color: AppConstants.warningOrange,
                  onTap: _showMonitoringHelp,
                ),
              ],
            ),
          ],
        ),
      );
    }

    // 3. Active / Outcome State
    final isCall = signal.direction == 'CALL';
    final isWait = signal.direction == 'WAIT';
    final accentColor = isWait
        ? AppConstants.warningOrange
        : (isCall ? AppConstants.callGreen : AppConstants.putRed);
    final isActive = signal.status == 'ACTIVE';

    // While a trade is ACTIVE, everything (direction, entry, remaining time,
    // current price, live result) is shown on the chart card above — so we don't
    // duplicate it here. We only keep the unique signal-strength bar for
    // monitoring signals; instant signals show nothing below the chart.
    if (isActive) {
      if (_signalEngine.isMonitoring && _signalEngine.lastSignalStrength > 0) {
        return Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          child: _buildStrengthBar(
            _signalEngine.lastSignalStrength,
            accentColor,
          ),
        );
      }
      return const SizedBox.shrink();
    }

    return Padding(
      padding: const EdgeInsets.all(14),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                isWait
                    ? 'RECOMMENDED WAIT ⚠️'
                    : (isActive ? 'ACTIVE VIP SIGNAL' : 'SIGNAL COMPLETED'),
                style: GoogleFonts.outfit(
                  fontSize: 10,
                  fontWeight: FontWeight.w600,
                  color: isWait
                      ? AppConstants.warningOrange
                      : (isActive
                            ? AppConstants.textSecondary
                            : (signal.status == 'WIN'
                                  ? AppConstants.callGreen
                                  : (signal.status == 'TIE'
                                        ? AppConstants.warningOrange
                                        : AppConstants.putRed))),
                  letterSpacing: 2,
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: accentColor.withAlpha(25),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: accentColor.withAlpha(80)),
                ),
                child: Row(
                  children: [
                    Icon(
                      isWait
                          ? Icons.hourglass_empty_rounded
                          : (isCall
                                ? Icons.arrow_upward_rounded
                                : Icons.arrow_downward_rounded),
                      color: accentColor,
                      size: 14,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      isWait
                          ? tr('انتظار (WAIT)', 'WAIT')
                          : (isCall
                                ? tr('صعود (CALL)', 'Up (CALL)')
                                : tr('هبوط (PUT)', 'Down (PUT)')),
                      style: GoogleFonts.outfit(
                        fontSize: 11,
                        fontWeight: FontWeight.w900,
                        color: accentColor,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const Divider(color: AppConstants.borderGlow, height: 16),

          // Signal strength bar — only for smart-monitoring signals.
          if (isActive &&
              _signalEngine.isMonitoring &&
              _signalEngine.lastSignalStrength > 0) ...[
            _buildStrengthBar(_signalEngine.lastSignalStrength, accentColor),
            const SizedBox(height: 12),
          ],

          // Grid of signals metrics
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: [
              _buildSignalMetric(
                label: 'STRIKE ACCURACY',
                value: isWait
                    ? 'N/A'
                    : '${signal.confidence.toStringAsFixed(1)}%',
                valueColor: isWait
                    ? AppConstants.textSecondary
                    : AppConstants.accentCyan,
              ),
              _buildSignalMetric(
                label: 'ENTRY PRICE',
                value: isWait
                    ? 'N/A'
                    : AppConstants.formatPrice(signal.entryPrice),
                valueColor: isWait ? AppConstants.textSecondary : Colors.white,
              ),
              _buildSignalMetric(
                label: 'TIMEFRAME',
                value: '${signal.durationMinutes} MIN',
                valueColor: AppConstants.warningOrange,
              ),
            ],
          ),
          const SizedBox(height: 12),

          if (isWait) ...[
            // No transaction progress or result badge
          ] else if (isActive) ...[
            // The remaining-time countdown is shown ONLY on the chart above
            // (single source of truth for both instant + monitoring signals).
            // Here we keep just the contextual note — no duplicate seconds counter.
            Center(
              child: Text(
                _signalEngine.signalChangeNotice.isNotEmpty
                    ? _signalEngine.signalChangeNotice
                    : tr(
                        'ملاحظة: بدأت هذه الصفقة مع بداية الشمعة الحالية',
                        'Note: this trade started at the beginning of the current candle',
                      ),
                textAlign: TextAlign.center,
                style: GoogleFonts.outfit(
                  fontSize: 10,
                  color: _signalEngine.signalChangeNotice.isNotEmpty
                      ? AppConstants.warningOrange
                      : AppConstants.accentCyan,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          ] else ...[
            // Completed Result Badge
            Builder(
              builder: (context) {
                final resultColor = signal.status == 'WIN'
                    ? AppConstants.callGreen
                    : (signal.status == 'TIE'
                          ? AppConstants.warningOrange
                          : AppConstants.putRed);
                final resultText = signal.status == 'WIN'
                    ? 'SUCCESSFUL SIGNAL: WIN 🟢'
                    : (signal.status == 'TIE'
                          ? 'COMPLETED SIGNAL: TIE ➖'
                          : 'COMPLETED SIGNAL: LOSS 🔴');
                return Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  decoration: BoxDecoration(
                    color: resultColor.withAlpha(15),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: resultColor.withAlpha(40)),
                  ),
                  child: Center(
                    child: Text(
                      resultText,
                      style: GoogleFonts.outfit(
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                        color: resultColor,
                      ),
                    ),
                  ),
                );
              },
            ),
          ],

          // Recommendation Card (Market Condition & Action Recommendation)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            margin: const EdgeInsets.only(top: 10),
            decoration: BoxDecoration(
              color: accentColor.withAlpha(15),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: accentColor.withAlpha(40)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      isWait
                          ? Icons.warning_amber_rounded
                          : Icons.gpp_good_rounded,
                      color: accentColor,
                      size: 14,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      isWait
                          ? tr(
                              'حالة السوق: تذبذب وحالة غير آمنة ⚠️',
                              'Market state: choppy and unsafe ⚠️',
                            )
                          : tr(
                              'حالة السوق: دخول آمن ومستقر ✅',
                              'Market state: safe and stable entry ✅',
                            ),
                      style: GoogleFonts.outfit(
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                        color: accentColor,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  signal.marketCondition,
                  style: GoogleFonts.outfit(
                    fontSize: 11,
                    color: AppConstants.textPrimary,
                    height: 1.4,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  tr(
                    'التوصية: ${signal.recommendation}',
                    'Recommendation: ${signal.recommendation}',
                  ),
                  style: GoogleFonts.outfit(
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                    color: isWait
                        ? AppConstants.warningOrange
                        : AppConstants.accentCyan,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),

          const SizedBox(height: 12),
          if (!isActive) ...[
            _buildDurationSelector(),
            const SizedBox(height: 12),
          ],
          _buildRequestButton(
            enabled: !isActive,
            text: isActive
                ? tr('الصفقة جارية حالياً...', 'Trade is currently running...')
                : tr('تحليل الصفقة التالية ⚡', 'Analyze next trade ⚡'),
          ),
        ],
      ),
    );
  }

  Widget _buildDurationSelector() {
    final options = [1, 2, 5, 10];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              tr('مدة الصفقة المستهدفة:', 'Target trade duration:'),
              style: GoogleFonts.outfit(
                fontSize: 11,
                color: AppConstants.textSecondary,
                fontWeight: FontWeight.w600,
              ),
            ),
            Text(
              tr(
                '$_selectedMinutes ${_selectedMinutes >= 5 ? "دقائق" : (_selectedMinutes == 1 ? "دقيقة واحدة" : "دقيقتين")}',
                '$_selectedMinutes ${_selectedMinutes == 1 ? "minute" : "minutes"}',
              ),
              style: GoogleFonts.outfit(
                fontSize: 11.5,
                color: AppConstants.accentCyan,
                fontWeight: FontWeight.bold,
              ),
            ),
          ],
        ),
        const SizedBox(height: 6),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: options.map((minutes) {
            final isSelected = _selectedMinutes == minutes;
            String label = tr('$minutes د', '${minutes}m');
            return InkWell(
              onTap: () {
                setState(() {
                  _selectedMinutes = minutes;
                });
              },
              borderRadius: BorderRadius.circular(8),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                width: 50,
                height: 30,
                decoration: BoxDecoration(
                  color: isSelected
                      ? AppConstants.accentCyan.withAlpha(25)
                      : Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: isSelected
                        ? AppConstants.accentCyan
                        : AppConstants.borderGlow,
                    width: 1.0,
                  ),
                ),
                child: Center(
                  child: Text(
                    label,
                    style: GoogleFonts.outfit(
                      fontSize: 12,
                      fontWeight: isSelected
                          ? FontWeight.bold
                          : FontWeight.normal,
                      color: isSelected
                          ? Colors.white
                          : AppConstants.textSecondary,
                    ),
                  ),
                ),
              ),
            );
          }).toList(),
        ),
      ],
    );
  }

  Widget _buildRequestButton({required bool enabled, required String text}) {
    return SizedBox(
      width: double.infinity,
      height: 40,
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          boxShadow: enabled
              ? [
                  BoxShadow(
                    color: AppConstants.accentCyan.withAlpha(50),
                    blurRadius: 6,
                    offset: const Offset(0, 3),
                  ),
                ]
              : null,
        ),
        child: ElevatedButton(
          onPressed: enabled
              ? () {
                  // Block analysis when the market is closed.
                  if (!_marketOpen || _signalEngine.isMarketClosed) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text(
                          tr(
                            'السوق مغلق الان حاول في وقت لاحق',
                            'The market is closed now, try again later',
                          ),
                          textAlign: TextAlign.center,
                          style: GoogleFonts.outfit(
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        backgroundColor: AppConstants.warningOrange,
                        behavior: SnackBarBehavior.floating,
                      ),
                    );
                    return;
                  }
                  // Block analysis while an OTC pair's data source is recovering
                  // (self-repair / reconnect) — never act on stale/incomplete data.
                  if (_isActiveOtc() && _otcUnhealthy) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text(
                          tr(
                            'النظام بيستعيد الاتصال بمصدر البيانات، استنى لحظات',
                            'The system is reconnecting to the data source, please wait a moment',
                          ),
                          textAlign: TextAlign.center,
                          style: GoogleFonts.outfit(
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        backgroundColor: AppConstants.warningOrange,
                        behavior: SnackBarBehavior.floating,
                      ),
                    );
                    return;
                  }
                  _signalEngine.requestNextSignal(
                    _selectedMinutes,
                    livePriceGetter:
                        _livePriceGetter, // always pass — correct for both sim & TV
                  );
                }
              : null,
          style: ElevatedButton.styleFrom(
            backgroundColor: enabled
                ? AppConstants.accentCyan
                : const Color(0xFF1B1630),
            foregroundColor: enabled
                ? AppConstants.spaceBackground
                : AppConstants.textSecondary,
            disabledBackgroundColor: const Color(0xFF120E22),
            disabledForegroundColor: AppConstants.textSecondary.withAlpha(120),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(10),
              side: BorderSide(
                color: enabled ? Colors.transparent : AppConstants.borderGlow,
                width: 1,
              ),
            ),
            elevation: 0,
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (!enabled &&
                  _signalEngine.activeSignal?.status == 'ACTIVE') ...[
                const SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.5,
                    color: AppConstants.warningOrange,
                  ),
                ),
                const SizedBox(width: 6),
              ],
              Text(
                text,
                style: GoogleFonts.outfit(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 0.5,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSignalMetric({
    required String label,
    required String value,
    required Color valueColor,
  }) {
    return Column(
      children: [
        Text(
          label,
          style: GoogleFonts.outfit(
            fontSize: 9,
            color: AppConstants.textSecondary,
            letterSpacing: 0.8,
            fontWeight: FontWeight.w500,
          ),
        ),
        const SizedBox(height: 3),
        Text(
          value,
          style: GoogleFonts.outfit(
            fontSize: 14,
            fontWeight: FontWeight.w900,
            color: valueColor,
          ),
        ),
      ],
    );
  }

  Widget _buildTimeframeButton(String tf) {
    final isSelected = _signalEngine.chartTimeframe == tf;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 3.0),
      child: InkWell(
        onTap: () {
          setState(() {
            _signalEngine.setChartTimeframe(tf);
          });
          // Load the real candles for the new interval immediately.
          _syncEngineCandles();
        },
        borderRadius: BorderRadius.circular(6),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            color: isSelected
                ? AppConstants.accentCyan.withAlpha(40)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(6),
            border: Border.all(
              color: isSelected
                  ? AppConstants.accentCyan
                  : AppConstants.borderGlow,
            ),
          ),
          child: Text(
            tf,
            style: GoogleFonts.outfit(
              fontSize: 10,
              fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
              color: isSelected ? Colors.white : AppConstants.textSecondary,
            ),
          ),
        ),
      ),
    );
  }

  // WIDGET: AI Signal Sentiment Assistant (Advanced Liquidity-Based)
  Widget _buildAIAnalysisCard() {
    final hasActiveSignal = _signalEngine.activeSignal != null;
    final rsi = _signalEngine.rsiVal;
    final stochK = _signalEngine.stochK;
    final adx = _signalEngine.adxVal;
    final cmf = _signalEngine.cmfVal;
    final volDelta = _signalEngine.volumeDelta;

    String actionRecommendation = 'WAIT';
    Color recommendationColor = AppConstants.warningOrange;
    IconData recommendationIcon = Icons.hourglass_top_rounded;

    if (hasActiveSignal) {
      final isCall = _signalEngine.activeSignal!.direction == 'CALL';
      actionRecommendation = isCall ? 'CALL' : 'PUT';
      recommendationColor = isCall
          ? AppConstants.callGreen
          : AppConstants.putRed;
      recommendationIcon = isCall
          ? Icons.trending_up_rounded
          : Icons.trending_down_rounded;
    }

    return _buildGlassCard(
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // ── Header Row with title and recommendation badge ──
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(5),
                  decoration: BoxDecoration(
                    color: AppConstants.accentCyan.withAlpha(15),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Icon(
                    Icons.psychology_rounded,
                    color: AppConstants.accentCyan,
                    size: 14,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'AI ANALYSIS',
                    style: GoogleFonts.outfit(
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                      letterSpacing: 1.5,
                    ),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: recommendationColor.withAlpha(20),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(
                      color: recommendationColor.withAlpha(80),
                    ),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        recommendationIcon,
                        color: recommendationColor,
                        size: 11,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        actionRecommendation,
                        style: GoogleFonts.outfit(
                          fontSize: 9,
                          fontWeight: FontWeight.w900,
                          color: recommendationColor,
                          letterSpacing: 1,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),

            // ── Compact Indicators Grid (4 circular gauges) ──
            Row(
              children: [
                Expanded(
                  child: _buildMiniIndicator(
                    'RSI',
                    rsi.toStringAsFixed(0),
                    rsi / 100,
                    rsi > 70
                        ? AppConstants.putRed
                        : (rsi < 30
                              ? AppConstants.callGreen
                              : AppConstants.accentCyan),
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: _buildMiniIndicator(
                    'Stoch',
                    stochK.toStringAsFixed(0),
                    stochK / 100,
                    stochK > 80
                        ? AppConstants.putRed
                        : (stochK < 20
                              ? AppConstants.callGreen
                              : AppConstants.accentCyan),
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: _buildMiniIndicator(
                    'ADX',
                    adx.toStringAsFixed(0),
                    adx / 100,
                    adx > 35
                        ? AppConstants.callGreen
                        : (adx > 20
                              ? AppConstants.warningOrange
                              : AppConstants.textSecondary),
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: _buildMiniIndicator(
                    'LIQ',
                    '${_signalEngine.liquidityScore.toStringAsFixed(0)}%',
                    _signalEngine.liquidityScore / 100,
                    _signalEngine.liquidityZone.contains('Demand')
                        ? AppConstants.callGreen
                        : (_signalEngine.liquidityZone.contains('Supply')
                              ? AppConstants.putRed
                              : AppConstants.warningOrange),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),

            // ── Key Metrics Row ──
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
              decoration: BoxDecoration(
                color: AppConstants.spaceBackground.withAlpha(120),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _buildKeyMetric(
                    'VWAP',
                    AppConstants.formatPrice(_signalEngine.vwapVal),
                    _signalEngine.currentPrice > _signalEngine.vwapVal
                        ? AppConstants.callGreen
                        : AppConstants.putRed,
                  ),
                  _buildKeyMetric(
                    'CMF',
                    cmf.toStringAsFixed(3),
                    cmf > 0.05
                        ? AppConstants.callGreen
                        : (cmf < -0.05
                              ? AppConstants.putRed
                              : AppConstants.accentCyan),
                  ),
                  _buildKeyMetric(
                    'Vol\u0394',
                    '${volDelta.toStringAsFixed(0)}%',
                    volDelta > 15
                        ? AppConstants.callGreen
                        : (volDelta < -15
                              ? AppConstants.putRed
                              : AppConstants.warningOrange),
                  ),
                  _buildKeyMetric(
                    'Sent.',
                    _signalEngine.marketSentiment.split(' ').first,
                    _signalEngine.marketSentiment.contains('Bullish') ||
                            _signalEngine.marketSentiment.contains('Buy')
                        ? AppConstants.callGreen
                        : (_signalEngine.marketSentiment.contains('Bearish') ||
                                  _signalEngine.marketSentiment.contains('Sell')
                              ? AppConstants.putRed
                              : AppConstants.warningOrange),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // Mini circular indicator widget for compact display
  Widget _buildMiniIndicator(
    String label,
    String value,
    double progress,
    Color color,
  ) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
      decoration: BoxDecoration(
        color: color.withAlpha(8),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withAlpha(25)),
      ),
      child: Column(
        children: [
          SizedBox(
            width: 28,
            height: 28,
            child: Stack(
              alignment: Alignment.center,
              children: [
                CircularProgressIndicator(
                  value: progress.clamp(0.0, 1.0),
                  strokeWidth: 2.5,
                  backgroundColor: AppConstants.borderGlow,
                  valueColor: AlwaysStoppedAnimation(color),
                ),
                Text(
                  value,
                  style: GoogleFonts.outfit(
                    fontSize: 8,
                    fontWeight: FontWeight.w900,
                    color: color,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 3),
          Text(
            label,
            style: GoogleFonts.outfit(
              fontSize: 8,
              color: AppConstants.textSecondary,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }

  // Compact key metric chip
  Widget _buildKeyMetric(String label, String value, Color color) {
    return Column(
      children: [
        Text(
          value,
          style: GoogleFonts.outfit(
            fontSize: 9,
            fontWeight: FontWeight.bold,
            color: color,
          ),
        ),
        Text(
          label,
          style: GoogleFonts.outfit(
            fontSize: 7,
            color: AppConstants.textSecondary,
          ),
        ),
      ],
    );
  }

  // WIDGET: Social media follow cards
  Widget _buildSocialCards() {
    return StreamBuilder<List<Map<String, dynamic>>>(
      stream: _socialCfgStream,
      builder: (context, snap) {
        final rows = snap.data ?? [];
        final data = rows.isNotEmpty
            ? rows.first['data'] as Map<String, dynamic>? ?? {}
            : <String, dynamic>{};
        final ytUrl =
            data['youtubeUrl'] as String? ??
            'https://www.youtube.com/@euro_trader';
        final tgUrl =
            data['telegramUrl'] as String? ?? 'https://t.me/euro_trd1';

        return Directionality(
          textDirection: LanguageService.direction,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Thin divider separating the footer from the content above.
              Container(
                height: 1,
                margin: const EdgeInsets.symmetric(horizontal: 8),
                color: AppConstants.textSecondary.withAlpha(30),
              ),
              const SizedBox(height: 18),
              // Subtle centered title.
              Center(
                child: Text(
                  tr('تابعنا على', 'Follow us on'),
                  style: GoogleFonts.outfit(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: AppConstants.textSecondary,
                    letterSpacing: 1.0,
                  ),
                ),
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: _socialBtn(
                      icon: Icons.play_circle_fill_rounded,
                      color: Colors.red,
                      label: tr('يوتيوب', 'YouTube'),
                      sublabel: '@euro_trader',
                      url: ytUrl,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _socialBtn(
                      icon: Icons.send_rounded,
                      color: const Color(0xFF29B6F6),
                      label: tr('تليجرام', 'Telegram'),
                      sublabel: '@euro_trd1',
                      url: tgUrl,
                    ),
                  ),
                ],
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _socialBtn({
    required IconData icon,
    required Color color,
    required String label,
    required String sublabel,
    required String url,
  }) {
    return GestureDetector(
      onTap: () => openBrowserTab(url),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12),
        decoration: BoxDecoration(
          color: color.withAlpha(15),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withAlpha(60)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: color, size: 22),
            const SizedBox(height: 5),
            Text(
              label,
              style: GoogleFonts.outfit(
                fontSize: 11,
                fontWeight: FontWeight.bold,
                color: AppConstants.textPrimary,
              ),
            ),
            Text(
              sublabel,
              style: GoogleFonts.outfit(
                fontSize: 9,
                color: AppConstants.textSecondary,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  // WIDGET: Real-time scrolling feed of VIP winners
  Widget _buildLiveFeedCard() {
    final logs = _signalEngine.socialWinLogs;

    // Market closed — show closed room message instead of fake winners
    if (_signalEngine.isWeekendClosed) {
      return _buildGlassCard(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Icon(
                    Icons.lock_clock_rounded,
                    color: AppConstants.textSecondary.withAlpha(120),
                    size: 16,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'VIP LIVE ROOM',
                    style: GoogleFonts.outfit(
                      fontSize: 12,
                      fontWeight: FontWeight.bold,
                      color: AppConstants.textSecondary,
                      letterSpacing: 1.5,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              Icon(
                Icons.schedule_rounded,
                color: AppConstants.putRed.withAlpha(160),
                size: 32,
              ),
              const SizedBox(height: 8),
              Text(
                tr('السوق مغلق حالياً', 'The market is currently closed'),
                textAlign: TextAlign.center,
                style: GoogleFonts.outfit(
                  fontSize: 13,
                  fontWeight: FontWeight.bold,
                  color: AppConstants.putRed.withAlpha(200),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                tr(
                  'الغرفة ستعود للعمل مع فتح الأسواق',
                  'The room will resume when the markets open',
                ),
                textAlign: TextAlign.center,
                style: GoogleFonts.outfit(
                  fontSize: 10,
                  color: AppConstants.textSecondary,
                ),
              ),
            ],
          ),
        ),
      );
    }

    return _buildGlassCard(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // ── Header ──
            Row(
              children: [
                _LivePulseDot(),
                const SizedBox(width: 8),
                Text(
                  'VIP LIVE ROOM',
                  style: GoogleFonts.outfit(
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                    letterSpacing: 1.5,
                  ),
                ),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: AppConstants.callGreen.withAlpha(20),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(
                      color: AppConstants.callGreen.withAlpha(60),
                    ),
                  ),
                  child: Text(
                    '${12 + (logs.length % 8)} ONLINE',
                    style: GoogleFonts.outfit(
                      fontSize: 9,
                      fontWeight: FontWeight.bold,
                      color: AppConstants.callGreen,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            // ── Feed ──
            SizedBox(
              height: 140,
              child: logs.isEmpty
                  ? Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.hourglass_empty_rounded,
                            color: AppConstants.textSecondary.withAlpha(100),
                            size: 24,
                          ),
                          const SizedBox(height: 6),
                          Text(
                            tr(
                              'في انتظار أولى الصفقات...',
                              'Waiting for the first trades...',
                            ),
                            style: GoogleFonts.outfit(
                              color: AppConstants.textSecondary,
                              fontSize: 11,
                            ),
                          ),
                        ],
                      ),
                    )
                  : ListView.separated(
                      itemCount: logs.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 5),
                      padding: EdgeInsets.zero,
                      itemBuilder: (context, index) {
                        return _buildWinCard(logs[index]);
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildWinCard(String log) {
    // Parse: "VIP Name (ID***) won +$profit on ASSET DIR"
    final isCall = log.contains('CALL');
    final dirColor = isCall ? AppConstants.callGreen : AppConstants.putRed;
    final dirIcon = isCall
        ? Icons.arrow_upward_rounded
        : Icons.arrow_downward_rounded;
    // Extract profit amount
    final profitMatch = RegExp(r'\+\$(\d+)').firstMatch(log);
    final profit = profitMatch != null ? profitMatch.group(0)! : '+\$---';
    // Extract name
    final nameMatch = RegExp(r'VIP (\w+) \(').firstMatch(log);
    final name = nameMatch != null ? nameMatch.group(1)! : 'Trader';
    // Extract asset
    final assetMatch = RegExp(r' on (.+?) (CALL|PUT)').firstMatch(log);
    final asset = assetMatch != null ? assetMatch.group(1)! : '---';

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: dirColor.withAlpha(10),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: dirColor.withAlpha(40)),
      ),
      child: Row(
        children: [
          // Avatar circle
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: dirColor.withAlpha(25),
              border: Border.all(color: dirColor.withAlpha(80)),
            ),
            child: Center(
              child: Text(
                name.isNotEmpty ? name[0].toUpperCase() : 'V',
                style: GoogleFonts.outfit(
                  fontSize: 11,
                  fontWeight: FontWeight.bold,
                  color: dirColor,
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          // Name + Asset
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'VIP $name',
                  style: GoogleFonts.outfit(
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
                Text(
                  asset,
                  style: GoogleFonts.outfit(
                    fontSize: 9,
                    color: AppConstants.textSecondary,
                  ),
                ),
              ],
            ),
          ),
          // Direction badge
          Icon(dirIcon, color: dirColor, size: 13),
          const SizedBox(width: 4),
          // Profit
          Text(
            profit,
            style: GoogleFonts.outfit(
              fontSize: 12,
              fontWeight: FontWeight.bold,
              color: dirColor,
            ),
          ),
        ],
      ),
    );
  }

  // WIDGET: Signal History & Statistics Dashboard
  Widget _buildSignalHistoryCard() {
    final history = _signalEngine.signalHistory;

    // Filter history based on current filter type
    final filtered = history.where((sig) {
      if (_historyFilter == 'today') {
        final today = DateTime.now();
        return sig.entryTime.year == today.year &&
            sig.entryTime.month == today.month &&
            sig.entryTime.day == today.day;
      } else if (_historyFilter == 'yesterday') {
        final yesterday = DateTime.now().subtract(const Duration(days: 1));
        return sig.entryTime.year == yesterday.year &&
            sig.entryTime.month == yesterday.month &&
            sig.entryTime.day == yesterday.day;
      } else if (_historyFilter == 'custom') {
        if (_customDateRange == null) return false;
        final start = DateTime(
          _customDateRange!.start.year,
          _customDateRange!.start.month,
          _customDateRange!.start.day,
        );
        final end = DateTime(
          _customDateRange!.end.year,
          _customDateRange!.end.month,
          _customDateRange!.end.day,
          23,
          59,
          59,
        );
        return sig.entryTime.isAfter(start) && sig.entryTime.isBefore(end);
      }
      return true;
    }).toList();

    // Calculate metrics
    final totalCount = filtered.length;
    final winsCount = filtered.where((sig) => sig.status == 'WIN').length;
    final lossesCount = filtered.where((sig) => sig.status == 'LOSS').length;
    final tiesCount = filtered.where((sig) => sig.status == 'TIE').length;
    // Ties don't count for or against the win rate.
    final decidedCount = winsCount + lossesCount;
    final winRate = decidedCount > 0 ? (winsCount / decidedCount * 100) : 0.0;

    return _buildGlassCard(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Directionality(
          textDirection: LanguageService.direction,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Header
              Row(
                children: [
                  Icon(
                    Icons.bar_chart_rounded,
                    color: AppConstants.accentCyan,
                    size: 24,
                  ),
                  const SizedBox(width: 10),
                  Text(
                    tr(
                      'إحصائيات وسجل صفقات الـ VIP',
                      'VIP stats & trade history',
                    ),
                    style: GoogleFonts.outfit(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),

              // Filter Tabs
              Row(
                children: [
                  _buildFilterTab(tr('صفقات اليوم', 'Today'), 'today'),
                  const SizedBox(width: 8),
                  _buildFilterTab(tr('صفقات الأمس', 'Yesterday'), 'yesterday'),
                  const SizedBox(width: 8),
                  _buildFilterTab(
                    tr('فترة مخصصة 🗓️', 'Custom range 🗓️'),
                    'custom',
                  ),
                ],
              ),

              // Custom Date Range Display
              if (_historyFilter == 'custom' && _customDateRange != null) ...[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    color: AppConstants.spaceBackground.withAlpha(120),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppConstants.borderGlow),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        tr('الفترة الزمنية المحددة:', 'Selected date range:'),
                        style: GoogleFonts.outfit(
                          fontSize: 12,
                          color: AppConstants.textSecondary,
                        ),
                      ),
                      Text(
                        '${_customDateRange!.start.year}/${_customDateRange!.start.month.toString().padLeft(2, '0')}/${_customDateRange!.start.day.toString().padLeft(2, '0')}  ${tr('إلى', 'to')}  ${_customDateRange!.end.year}/${_customDateRange!.end.month.toString().padLeft(2, '0')}/${_customDateRange!.end.day.toString().padLeft(2, '0')}',
                        style: GoogleFonts.outfit(
                          fontSize: 12,
                          color: AppConstants.accentCyan,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 20),

              // Summary Stats Widgets
              Row(
                children: [
                  // Win Rate Badge
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppConstants.spaceBackground.withAlpha(120),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppConstants.borderGlow),
                      ),
                      child: Column(
                        children: [
                          Text(
                            tr('نسبة النجاح', 'Win rate'),
                            style: GoogleFonts.outfit(
                              fontSize: 11,
                              color: AppConstants.textSecondary,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '${winRate.toStringAsFixed(1)}%',
                            style: GoogleFonts.outfit(
                              fontSize: 20,
                              fontWeight: FontWeight.w900,
                              color: winRate >= 70
                                  ? AppConstants.callGreen
                                  : AppConstants.putRed,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  // Score Ratio Badge
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppConstants.spaceBackground.withAlpha(120),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppConstants.borderGlow),
                      ),
                      child: Column(
                        children: [
                          Text(
                            tr('إجمالي الصفقات', 'Total trades'),
                            style: GoogleFonts.outfit(
                              fontSize: 11,
                              color: AppConstants.textSecondary,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            tiesCount > 0
                                ? tr(
                                    '$winsCount رابحة / $lossesCount خاسرة / $tiesCount تعادل',
                                    '$winsCount won / $lossesCount lost / $tiesCount tie',
                                  )
                                : tr(
                                    '$winsCount رابحة / $lossesCount خاسرة',
                                    '$winsCount won / $lossesCount lost',
                                  ),
                            style: GoogleFonts.outfit(
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                              color: Colors.white,
                            ),
                          ),
                          Text(
                            tr(
                              '($totalCount صفقات إجمالية)',
                              '($totalCount trades total)',
                            ),
                            style: GoogleFonts.outfit(
                              fontSize: 9,
                              color: AppConstants.textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),

              // Log details list
              filtered.isEmpty
                  ? Container(
                      height: 120,
                      decoration: BoxDecoration(
                        color: AppConstants.spaceBackground.withAlpha(100),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: AppConstants.borderGlow.withAlpha(100),
                        ),
                      ),
                      child: Center(
                        child: Text(
                          tr(
                            'لا توجد صفقات مسجلة في هذه الفترة.',
                            'No trades recorded in this period.',
                          ),
                          style: GoogleFonts.outfit(
                            color: AppConstants.textSecondary,
                            fontSize: 13,
                          ),
                        ),
                      ),
                    )
                  : SizedBox(
                      height: 200,
                      child: ListView.builder(
                        shrinkWrap: false,
                        physics: const AlwaysScrollableScrollPhysics(),
                        itemCount: filtered.length,
                        itemBuilder: (context, index) {
                          final sig = filtered[index];
                          final isWin = sig.status == 'WIN';
                          final isTie = sig.status == 'TIE';
                          final outcomeColor = isTie
                              ? AppConstants.warningOrange
                              : (isWin
                                    ? AppConstants.callGreen
                                    : AppConstants.putRed);
                          final directionText = sig.direction == 'CALL'
                              ? tr('صعود', 'Up')
                              : tr('هبوط', 'Down');

                          final dateStr =
                              "${sig.entryTime.hour.toString().padLeft(2, '0')}:${sig.entryTime.minute.toString().padLeft(2, '0')}";

                          return Container(
                            margin: const EdgeInsets.only(bottom: 6),
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 8,
                            ),
                            decoration: BoxDecoration(
                              color: AppConstants.spaceBackground.withAlpha(
                                150,
                              ),
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(
                                color: outcomeColor.withAlpha(80),
                                width: 1.0,
                              ),
                            ),
                            child: Row(
                              children: [
                                // Status Pill
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 8,
                                    vertical: 4,
                                  ),
                                  decoration: BoxDecoration(
                                    color: outcomeColor.withAlpha(20),
                                    borderRadius: BorderRadius.circular(6),
                                    border: Border.all(
                                      color: outcomeColor.withAlpha(80),
                                    ),
                                  ),
                                  child: Text(
                                    isTie
                                        ? tr('➖ تعادل', '➖ Tie')
                                        : (isWin
                                              ? tr('✓ كسب', '✓ Win')
                                              : tr('✗ خسارة', '✗ Loss')),
                                    style: GoogleFonts.outfit(
                                      fontSize: 10,
                                      color: outcomeColor,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 10),
                                // Details Area
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        children: [
                                          Text(
                                            sig.pair.replaceAll(' (OTC)', ''),
                                            style: GoogleFonts.outfit(
                                              fontSize: 13,
                                              fontWeight: FontWeight.bold,
                                              color: Colors.white,
                                            ),
                                          ),
                                          const SizedBox(width: 8),
                                          Container(
                                            padding: const EdgeInsets.symmetric(
                                              horizontal: 4,
                                              vertical: 1,
                                            ),
                                            decoration: BoxDecoration(
                                              color: sig.direction == 'CALL'
                                                  ? AppConstants.callGreen
                                                        .withAlpha(30)
                                                  : AppConstants.putRed
                                                        .withAlpha(30),
                                              borderRadius:
                                                  BorderRadius.circular(4),
                                            ),
                                            child: Text(
                                              directionText,
                                              style: GoogleFonts.outfit(
                                                fontSize: 9,
                                                fontWeight: FontWeight.bold,
                                                color: sig.direction == 'CALL'
                                                    ? AppConstants.callGreen
                                                    : AppConstants.putRed,
                                              ),
                                            ),
                                          ),
                                          const SizedBox(width: 6),
                                          // Origin badge: instant ⚡ vs monitoring 🎯
                                          Builder(
                                            builder: (_) {
                                              final isMon =
                                                  sig.origin == 'monitoring';
                                              final oColor = isMon
                                                  ? AppConstants.warningOrange
                                                  : AppConstants.accentCyan;
                                              return Container(
                                                padding:
                                                    const EdgeInsets.symmetric(
                                                      horizontal: 5,
                                                      vertical: 1,
                                                    ),
                                                decoration: BoxDecoration(
                                                  color: oColor.withAlpha(28),
                                                  borderRadius:
                                                      BorderRadius.circular(4),
                                                  border: Border.all(
                                                    color: oColor.withAlpha(90),
                                                  ),
                                                ),
                                                child: Text(
                                                  isMon
                                                      ? tr(
                                                          '🎯 مراقبة',
                                                          '🎯 Monitor',
                                                        )
                                                      : tr(
                                                          '⚡ فوري',
                                                          '⚡ Instant',
                                                        ),
                                                  style: GoogleFonts.outfit(
                                                    fontSize: 9,
                                                    fontWeight: FontWeight.bold,
                                                    color: oColor,
                                                  ),
                                                ),
                                              );
                                            },
                                          ),
                                        ],
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        tr(
                                          'دخول: ${AppConstants.formatPrice(sig.entryPrice)} | إغلاق: ${AppConstants.formatPrice(sig.exitPrice ?? sig.currentPrice)}',
                                          'Entry: ${AppConstants.formatPrice(sig.entryPrice)} | Close: ${AppConstants.formatPrice(sig.exitPrice ?? sig.currentPrice)}',
                                        ),
                                        style: GoogleFonts.outfit(
                                          fontSize: 10,
                                          color: AppConstants.textSecondary,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                // Date / Time
                                Text(
                                  dateStr,
                                  style: GoogleFonts.outfit(
                                    fontSize: 11,
                                    color: AppConstants.textSecondary,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                              ],
                            ),
                          );
                        },
                      ),
                    ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildFilterTab(String label, String value) {
    final isSelected = _historyFilter == value;
    return Expanded(
      child: GestureDetector(
        onTap: () {
          if (value == 'custom') {
            _selectCustomDateRange();
          } else {
            setState(() {
              _historyFilter = value;
            });
          }
        },
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: isSelected
                ? AppConstants.accentCyan.withAlpha(40)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: isSelected
                  ? AppConstants.accentCyan
                  : AppConstants.borderGlow,
              width: 1,
            ),
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: GoogleFonts.outfit(
              fontSize: 12,
              fontWeight: FontWeight.bold,
              color: isSelected ? Colors.white : AppConstants.textSecondary,
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _selectCustomDateRange() async {
    final DateTimeRange? picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2026),
      lastDate: DateTime(2027),
      initialDateRange:
          _customDateRange ??
          DateTimeRange(
            start: DateTime.now().subtract(const Duration(days: 7)),
            end: DateTime.now(),
          ),
      builder: (context, child) {
        return Theme(
          data: ThemeData.dark().copyWith(
            colorScheme: ColorScheme.dark(
              primary: AppConstants.accentCyan,
              onPrimary: AppConstants.spaceBackground,
              surface: AppConstants.cardBgColor,
              onSurface: Colors.white,
            ),
            dialogTheme: DialogThemeData(
              backgroundColor: AppConstants.spaceBackground,
            ),
          ),
          child: child!,
        );
      },
    );
    if (picked != null) {
      setState(() {
        _customDateRange = picked;
        _historyFilter = 'custom';
      });
    }
  }

  // GLASSMORPHISM CARD DECORATION UTILITY
  Widget _buildGlassCard({required Widget child, Color? borderColor}) {
    return Container(
      decoration: BoxDecoration(
        color: AppConstants.cardBgColor.withAlpha(200),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: borderColor ?? AppConstants.borderGlow,
          width: 1.2,
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withAlpha(80),
            blurRadius: 15,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: ClipRRect(borderRadius: BorderRadius.circular(16), child: child),
    );
  }
}

// ── Live pulse dot (animated) ─────────────────────────────────────────────────

class _LivePulseDot extends StatefulWidget {
  @override
  State<_LivePulseDot> createState() => _LivePulseDotState();
}

class _LivePulseDotState extends State<_LivePulseDot>
    with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  late Animation<double> _anim;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat(reverse: true);
    _anim = Tween<double>(
      begin: 0.4,
      end: 1.0,
    ).animate(CurvedAnimation(parent: _ctrl, curve: Curves.easeInOut));
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _anim,
      builder: (_, _) => Container(
        width: 8,
        height: 8,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: AppConstants.callGreen.withValues(alpha: _anim.value),
          boxShadow: [
            BoxShadow(
              color: AppConstants.callGreen.withValues(
                alpha: _anim.value * 0.5,
              ),
              blurRadius: 6,
              spreadRadius: 1,
            ),
          ],
        ),
      ),
    );
  }
}

// ── Mini price chart painter ──────────────────────────────────────────────────

class _MiniPricePainter extends CustomPainter {
  final double entryPrice;
  final double exitPrice;
  final Color profitColor;

  const _MiniPricePainter({
    required this.entryPrice,
    required this.exitPrice,
    required this.profitColor,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final higher = entryPrice > exitPrice ? entryPrice : exitPrice;
    final lower = entryPrice < exitPrice ? entryPrice : exitPrice;
    final range = higher - lower;
    const vPad = 18.0;

    double entryY, exitY;
    if (range == 0) {
      entryY = size.height * 0.5;
      exitY = size.height * 0.5;
    } else {
      final scale = (size.height - 2 * vPad) / range;
      entryY = vPad + (higher - entryPrice) * scale;
      exitY = vPad + (higher - exitPrice) * scale;
    }

    // Shaded zone between entry and exit
    final top = exitY < entryY ? exitY : entryY;
    final bottom = exitY > entryY ? exitY : entryY;
    final shadeH = (bottom - top).clamp(4.0, size.height);
    canvas.drawRect(
      Rect.fromLTWH(0, top, size.width, shadeH),
      Paint()..color = profitColor.withAlpha(22),
    );

    // Dashed entry line (neutral)
    _dashedLine(
      canvas,
      size.width,
      entryY,
      const Color(0xFF8899AA),
      dashed: true,
    );
    // Solid exit line (colored)
    _dashedLine(canvas, size.width, exitY, profitColor);

    // Dots
    canvas.drawCircle(
      Offset(size.width / 2, entryY),
      3.5,
      Paint()..color = const Color(0xFF8899AA),
    );
    canvas.drawCircle(
      Offset(size.width / 2, exitY),
      4.5,
      Paint()..color = profitColor,
    );
  }

  void _dashedLine(
    Canvas canvas,
    double width,
    double y,
    Color color, {
    bool dashed = false,
  }) {
    final p = Paint()
      ..color = color.withAlpha(dashed ? 120 : 200)
      ..strokeWidth = dashed ? 1.0 : 1.5;
    if (!dashed) {
      canvas.drawLine(Offset(0, y), Offset(width, y), p);
      return;
    }
    double x = 0;
    while (x < width) {
      canvas.drawLine(Offset(x, y), Offset((x + 5).clamp(0, width), y), p);
      x += 10;
    }
  }

  @override
  bool shouldRepaint(_MiniPricePainter old) =>
      old.entryPrice != entryPrice || old.exitPrice != exitPrice;
}
