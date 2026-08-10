import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:google_fonts/google_fonts.dart';
import '../utils/web_utils.dart';
import '../constants.dart';
import '../services/language_service.dart';
import '../widgets/particles.dart';
import '../widgets/trading_background.dart';
import 'main_screen.dart';
import 'notice_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final TextEditingController _idController = TextEditingController();
  final TextEditingController _promoController = TextEditingController();
  String _selectedBroker = ''; // no default — the user MUST pick a platform
  String _selectedBrokerKey = '';
  String _selectedBrokerPromo =
      ''; // admin promo code required for this platform
  bool _isVerifying = false;
  String _verificationStepText = '';
  double _verificationProgress = 0.0;
  String? _errorMessage;

  // Admin-controlled social links (with safe fallbacks)
  String _youtubeUrl = 'https://www.youtube.com/@euro_trader';
  String _telegramUrl = 'https://t.me/euro_trd1';

  @override
  void initState() {
    super.initState();
    _loadSocialLinks();
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _maybeShowSubscriptionDialog(),
    );
  }

  Future<void> _loadSocialLinks() async {
    try {
      final row = await Supabase.instance.client
          .from('configs')
          .select('data')
          .eq('id', 'social')
          .maybeSingle();
      if (!mounted) return;
      final data = row?['data'] as Map<String, dynamic>? ?? {};
      final yt = (data['youtubeUrl'] as String?)?.trim();
      final tg = (data['telegramUrl'] as String?)?.trim();
      setState(() {
        if (yt != null && yt.isNotEmpty) _youtubeUrl = yt;
        if (tg != null && tg.isNotEmpty) _telegramUrl = tg;
      });
    } catch (_) {}
  }

  Future<void> _maybeShowSubscriptionDialog() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final done = prefs.getBool('subscription_confirmed') ?? false;
      if (done || !mounted) return;
      _showSubscriptionDialog();
    } catch (_) {}
  }

  void _showSubscriptionDialog() {
    bool ytDone = false;
    bool tgDone = false;

    showDialog(
      context: context,
      barrierDismissible: false,
      barrierColor: AppConstants.spaceBackground.withAlpha(240),
      builder: (_) {
        return StatefulBuilder(
          builder: (ctx, setS) {
            final bothDone = ytDone && tgDone;
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
                  border: Border.all(
                    color: AppConstants.borderGlow,
                    width: 1.5,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: AppConstants.accentCyan.withAlpha(25),
                      blurRadius: 40,
                      spreadRadius: 5,
                    ),
                  ],
                ),
                padding: const EdgeInsets.all(24),
                child: Directionality(
                  textDirection: LanguageService.direction,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      // Icon
                      Container(
                        width: 72,
                        height: 72,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          gradient: const LinearGradient(
                            colors: [Color(0xFF1A1240), Color(0xFF0A0714)],
                          ),
                          border: Border.all(
                            color: AppConstants.accentCyan.withAlpha(100),
                            width: 2,
                          ),
                          boxShadow: [
                            BoxShadow(
                              color: AppConstants.accentCyan.withAlpha(40),
                              blurRadius: 20,
                            ),
                          ],
                        ),
                        child: Icon(
                          Icons.verified_rounded,
                          color: AppConstants.accentCyan,
                          size: 34,
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(
                        tr(
                          'مرحباً بك في Euro Trade! 🎯',
                          'Welcome to Euro Trade! 🎯',
                        ),
                        textAlign: TextAlign.center,
                        style: GoogleFonts.outfit(
                          fontSize: 19,
                          fontWeight: FontWeight.bold,
                          color: AppConstants.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        tr(
                          'للوصول إلى المنصة يرجى متابعة قناتنا\nعلى يوتيوب وتليجرام للحصول على آخر التحديثات والإشارات.',
                          'To access the platform, please follow our\nYouTube and Telegram channels for the latest updates and signals.',
                        ),
                        textAlign: TextAlign.center,
                        style: GoogleFonts.outfit(
                          fontSize: 12,
                          color: AppConstants.textSecondary,
                          height: 1.6,
                        ),
                      ),
                      const SizedBox(height: 20),
                      // YouTube button
                      _SubscribeButton(
                        icon: Icons.play_circle_fill_rounded,
                        iconColor: Colors.red,
                        label: tr(
                          'اشترك في قناة يوتيوب',
                          'Subscribe to the YouTube channel',
                        ),
                        sublabel: '@euro_trader',
                        done: ytDone,
                        onTap: () {
                          openBrowserTab(_youtubeUrl);
                          Future.delayed(const Duration(seconds: 2), () {
                            if (ctx.mounted) setS(() => ytDone = true);
                          });
                        },
                      ),
                      const SizedBox(height: 10),
                      // Telegram button
                      _SubscribeButton(
                        icon: Icons.send_rounded,
                        iconColor: const Color(0xFF29B6F6),
                        label: tr(
                          'انضم لقناة تليجرام',
                          'Join the Telegram channel',
                        ),
                        sublabel: '@euro_trd1',
                        done: tgDone,
                        onTap: () {
                          openBrowserTab(_telegramUrl);
                          Future.delayed(const Duration(seconds: 2), () {
                            if (ctx.mounted) setS(() => tgDone = true);
                          });
                        },
                      ),
                      const SizedBox(height: 20),
                      // Progress bar
                      ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: LinearProgressIndicator(
                          value: (ytDone ? 0.5 : 0) + (tgDone ? 0.5 : 0),
                          minHeight: 4,
                          backgroundColor: AppConstants.borderGlow,
                          valueColor: AlwaysStoppedAnimation<Color>(
                            AppConstants.accentCyan,
                          ),
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        bothDone
                            ? tr(
                                'تم التحقق ✅ يمكنك الدخول الآن',
                                'Verified ✅ You can enter now',
                              )
                            : tr(
                                'يرجى الضغط على الزرين أعلاه أولاً',
                                'Please tap both buttons above first',
                              ),
                        textAlign: TextAlign.center,
                        style: GoogleFonts.outfit(
                          fontSize: 11,
                          color: bothDone
                              ? AppConstants.callGreen
                              : AppConstants.textSecondary,
                        ),
                      ),
                      const SizedBox(height: 16),
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton(
                          onPressed: bothDone
                              ? () async {
                                  final prefs =
                                      await SharedPreferences.getInstance();
                                  await prefs.setBool(
                                    'subscription_confirmed',
                                    true,
                                  );
                                  if (ctx.mounted) Navigator.of(ctx).pop();
                                }
                              : null,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: bothDone
                                ? AppConstants.accentBlue
                                : AppConstants.borderGlow,
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 14),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                            elevation: bothDone ? 6 : 0,
                          ),
                          child: Text(
                            tr('دخول المنصة 🚀', 'Enter the platform 🚀'),
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
        );
      },
    );
  }

  // Generate or retrieve persistent device ID
  Future<String> _getDeviceId() async {
    final prefs = await SharedPreferences.getInstance();
    String? deviceId = prefs.getString('device_id');
    if (deviceId == null || deviceId.isEmpty) {
      // Generate a unique device fingerprint
      final rng = Random.secure();
      final bytes = List<int>.generate(16, (_) => rng.nextInt(256));
      deviceId = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
      await prefs.setString('device_id', deviceId);
    }
    return deviceId;
  }

  // Execute verification handshake simulation
  void _showPromoRequiredDialog() {
    showDialog(
      context: context,
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
                Icons.local_offer_rounded,
                color: AppConstants.warningOrange,
                size: 22,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  tr('كود البرومو غير صحيح', 'Invalid promo code'),
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
              'للدخول عبر منصة $_selectedBroker يجب إنشاء حساب جديد على هذه المنصة '
                  'باستخدام كود البرومو الخاص بنا، ثم إدخال الكود في خانة البرومو مع '
                  'معرّف الحساب.\n\nالكود اللي أدخلته غير مطابق — تأكد منه وحاول مرة أخرى.',
              'To sign in via $_selectedBroker you must create a new account on this platform '
                  'using our promo code, then enter the code in the promo field along with '
                  'your Account ID.\n\nThe code you entered does not match — double-check it and try again.',
            ),
            style: GoogleFonts.outfit(
              color: AppConstants.textSecondary,
              height: 1.7,
              fontSize: 13.5,
            ),
          ),
          actions: [
            ElevatedButton(
              onPressed: () => Navigator.pop(ctx),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppConstants.warningOrange,
                foregroundColor: Colors.black,
              ),
              child: Text(
                tr('حسناً', 'OK'),
                style: GoogleFonts.outfit(fontWeight: FontWeight.bold),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _startVerification() {
    final accountId = _idController.text.trim();
    if (accountId.isEmpty) {
      setState(() {
        _errorMessage = tr(
          'يرجى إدخال معرف حساب صحيح',
          'Please enter a valid Account ID',
        );
      });
      return;
    }

    // Simulate simple checks on ID length/characters
    if (accountId.length < 5) {
      setState(() {
        _errorMessage = tr(
          'يجب أن يتكون معرف الحساب من 5 أرقام على الأقل',
          'The Account ID must be at least 5 digits',
        );
      });
      return;
    }

    // Platform is MANDATORY — its name is shown across the app + tracked per user.
    if (_selectedBroker.trim().isEmpty) {
      setState(() {
        _errorMessage = tr(
          'اختر منصة التداول أولاً (الخطوة 1)',
          'Choose your trading platform first (Step 1)',
        );
      });
      return;
    }

    // Promo gate: if the selected platform has an admin promo code, the user must
    // enter it and it must match exactly (case-insensitive). Otherwise → dialog.
    if (_selectedBrokerPromo.trim().isNotEmpty) {
      final entered = _promoController.text.trim();
      if (entered.toLowerCase() != _selectedBrokerPromo.trim().toLowerCase()) {
        _showPromoRequiredDialog();
        return;
      }
    }

    setState(() {
      _isVerifying = true;
      _errorMessage = null;
      _verificationProgress = 0.0;
    });

    // Supabase Lookup query - started in parallel
    String role = 'standard';
    DateTime? vipExpiry;
    String? deviceMismatchError;
    Future<void> firestoreLookupFuture = Future(() async {
      try {
        final prefs = await SharedPreferences.getInstance();
        final sb = Supabase.instance.client;
        final deviceId = await _getDeviceId();
        final row = await sb
            .from('users')
            .select()
            .eq('id', accountId)
            .maybeSingle();
        if (row != null) {
          role = row['role'] ?? 'standard';
          final vipExpiryStr = row['vip_expiry'] as String?;
          if (vipExpiryStr != null) {
            vipExpiry = DateTime.tryParse(vipExpiryStr)?.toUtc();
          }

          final storedDeviceId = row['device_id'] as String?;
          final storedClickedBroker = row['clicked_broker'] as String?;

          if (role == 'vip' &&
              storedDeviceId != null &&
              storedDeviceId != '' &&
              storedDeviceId != deviceId) {
            deviceMismatchError = tr(
              'هذا الحساب VIP مرتبط بجهاز آخر. لا يمكن تسجيل الدخول من هذا الجهاز.',
              'This VIP account is linked to another device. You cannot sign in from this device.',
            );
            return;
          }

          final Map<String, dynamic> updates = {};
          if (role == 'standard' && storedDeviceId != deviceId) {
            updates['device_id'] = deviceId;
          } else if (storedDeviceId == null || storedDeviceId == '') {
            updates['device_id'] = deviceId;
          }
          if (row['broker'] != _selectedBroker) {
            updates['broker'] = _selectedBroker;
          }
          if (storedClickedBroker == null) {
            updates['clicked_broker'] =
                prefs.getString('last_clicked_broker') ?? '';
          }
          if (updates.isNotEmpty) {
            await sb.from('users').update(updates).eq('id', accountId);
          }
        } else {
          final lastClickedBroker =
              prefs.getString('last_clicked_broker') ?? '';

          // Check globalVip config — new users inherit VIP if it's active
          String newRole = 'standard';
          String? newVipExpiry;
          try {
            final gvRow = await sb
                .from('configs')
                .select('data')
                .eq('id', 'globalVip')
                .maybeSingle();
            if (gvRow != null) {
              final gd = gvRow['data'] as Map<String, dynamic>? ?? {};
              if (gd['enabled'] == true) {
                final expiryStr = gd['expiry'] as String?;
                if (expiryStr != null) {
                  final expiry = DateTime.tryParse(expiryStr)?.toUtc();
                  if (expiry != null &&
                      expiry.isAfter(DateTime.now().toUtc())) {
                    newRole = 'vip';
                    newVipExpiry = expiryStr;
                    vipExpiry = expiry;
                  }
                }
              }
            }
          } catch (_) {}

          role = newRole;
          await sb.from('users').upsert({
            'id': accountId,
            'broker': _selectedBroker,
            'role': newRole,
            'vip_expiry': newVipExpiry,
            'device_id': deviceId,
            'clicked_broker': lastClickedBroker,
            'created_at': DateTime.now().toIso8601String(),
          });

          final loginKey = _selectedBrokerKey.isNotEmpty
              ? _selectedBrokerKey
              : _selectedBroker.toLowerCase().contains('quotex')
              ? 'quotex'
              : _selectedBroker.toLowerCase().contains('expert')
              ? 'expert_option'
              : 'pocket_option';
          await sb.rpc(
            'increment_click',
            params: {'row_id': 'brokers', 'field_name': '${loginKey}Logins'},
          );

          if (lastClickedBroker.isNotEmpty) {
            final savedKey = prefs.getString('last_clicked_broker_key') ?? '';
            final clickField = savedKey.isNotEmpty
                ? savedKey
                : lastClickedBroker == 'Quotex'
                ? 'quotex'
                : lastClickedBroker == 'Expert Option'
                ? 'expert_option'
                : 'pocket_option';
            await sb.rpc(
              'increment_click',
              params: {'row_id': 'brokers', 'field_name': clickField},
            );
          }
        }
      } catch (e) {
        debugPrint('Supabase lookup error: $e');
        role = 'standard';
      }
    });

    final steps = [
      {
        'text': tr(
          'جاري الاتصال بخوادم منصة $_selectedBroker الآمنة...',
          'Connecting to $_selectedBroker secure servers...',
        ),
        'progress': 0.15,
      },
      {
        'text': tr(
          'جاري الاستعلام عن سجلات الإحالة النشطة للشركاء...',
          'Querying active partner referral records...',
        ),
        'progress': 0.40,
      },
      {
        'text': tr(
          'جاري مطابقة معرف الحساب في شبكة VIP المعتمدة...',
          'Matching the Account ID in the certified VIP network...',
        ),
        'progress': 0.65,
      },
      {
        'text': tr(
          'تفعيل عضوية غرفة VIP الخاصة بحسابك...',
          'Activating your account\'s VIP Room membership...',
        ),
        'progress': 0.85,
      },
      {
        'text': tr(
          'تم تأكيد التفعيل بنجاح! جاري الانتقال لمنصة إشارات VIP...',
          'Activation confirmed successfully! Redirecting to the VIP signals platform...',
        ),
        'progress': 1.0,
      },
    ];

    int currentStep = 0;
    Timer.periodic(const Duration(milliseconds: 900), (timer) async {
      if (currentStep < steps.length) {
        setState(() {
          _verificationStepText = steps[currentStep]['text'] as String;
          _verificationProgress = steps[currentStep]['progress'] as double;
        });
        currentStep++;
      } else {
        timer.cancel();
        try {
          // Wait for Firestore lookup — max 6s then continue anyway
          await firestoreLookupFuture.timeout(
            const Duration(seconds: 6),
            onTimeout: () {},
          );
        } catch (_) {}

        if (!mounted) return;

        // Device mismatch check - VIP only works on registered device
        if (deviceMismatchError != null) {
          setState(() {
            _isVerifying = false;
            _errorMessage = deviceMismatchError;
            _verificationProgress = 0.0;
            _verificationStepText = '';
          });
          return;
        }

        // Save verified status in Shared Preferences
        try {
          final prefs = await SharedPreferences.getInstance();
          await prefs.setBool(AppConstants.keyUserVerified, true);
          await prefs.setString(AppConstants.keyUserAccountId, accountId);
          await prefs.setString(AppConstants.keyUserBroker, _selectedBroker);
          await prefs.setString('user_role', role);
          if (vipExpiry != null) {
            await prefs.setString(
              'vip_expiry',
              vipExpiry!.toUtc().toIso8601String(),
            );
          } else {
            await prefs.remove('vip_expiry');
          }
        } catch (_) {}

        if (!mounted) return;

        try {
          evalJs(
            "var ctx = new AudioContext(); var osc = ctx.createOscillator(); var g = ctx.createGain(); osc.type='sine'; osc.frequency.setValueAtTime(523, ctx.currentTime); osc.frequency.setValueAtTime(659, ctx.currentTime+0.1); osc.frequency.setValueAtTime(880, ctx.currentTime+0.2); g.gain.setValueAtTime(0.1, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.5); osc.connect(g); g.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime+0.5);",
          );
        } catch (_) {}

        // VIP welcome dialog on first VIP login
        if (role == 'vip' && vipExpiry != null && mounted) {
          try {
            final prefs2 = await SharedPreferences.getInstance();
            final welcomed = prefs2.getBool('vip_welcomed_$accountId') ?? false;
            if (!welcomed) {
              await prefs2.setBool('vip_welcomed_$accountId', true);
              if (mounted) await _showVipWelcomeDialog(vipExpiry!);
            }
          } catch (_) {}
        }

        if (!mounted) return;
        Navigator.of(context).pushReplacement(
          PageRouteBuilder(
            pageBuilder: (context, animation, secondaryAnimation) =>
                const MainScreen(),
            transitionsBuilder:
                (context, animation, secondaryAnimation, child) =>
                    FadeTransition(opacity: animation, child: child),
            transitionDuration: const Duration(milliseconds: 600),
          ),
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;
    final isDesktop = size.width > 700;

    return Scaffold(
      backgroundColor: AppConstants.spaceBackground,
      body: Stack(
        children: [
          const RepaintBoundary(child: TradingBackground()),
          const BackgroundParticles(),

          // Outer Glow
          Positioned(
            top: size.height * 0.1,
            left: size.width * 0.1,
            child: Container(
              width: 400,
              height: 400,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                boxShadow: [
                  BoxShadow(
                    color: AppConstants.accentCyan.withAlpha(15),
                    blurRadius: 150,
                    spreadRadius: 20,
                  ),
                ],
              ),
            ),
          ),

          Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 40),
              child: AnimatedCrossFade(
                crossFadeState: _isVerifying
                    ? CrossFadeState.showSecond
                    : CrossFadeState.showFirst,
                duration: const Duration(milliseconds: 400),
                firstChild: _buildLoginForm(isDesktop),
                secondChild: _buildVerificationHandshake(),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // First View: Login & Registration Instructions
  Widget _buildLoginForm(bool isDesktop) {
    return Container(
      width: isDesktop ? 550 : double.infinity,
      padding: const EdgeInsets.all(32),
      decoration: BoxDecoration(
        color: AppConstants.cardBgColor.withAlpha(220),
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: AppConstants.borderGlow, width: 1.5),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withAlpha(150),
            blurRadius: 40,
            offset: const Offset(0, 20),
          ),
        ],
      ),
      child: Directionality(
        textDirection: LanguageService.direction,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Logo
            Center(
              child: Container(
                width: 90,
                height: 90,
                margin: const EdgeInsets.only(bottom: 24),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(
                    color: AppConstants.accentCyan.withAlpha(80),
                    width: 1.5,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: AppConstants.accentCyan.withAlpha(20),
                      blurRadius: 15,
                    ),
                  ],
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(14),
                  child: Image.asset('assets/logo.jpg', fit: BoxFit.cover),
                ),
              ),
            ),
            // Title
            Center(
              child: Column(
                children: [
                  Text(
                    tr('تسجيل الدخول للـ VIP', 'VIP Login'),
                    style: GoogleFonts.outfit(
                      fontSize: 26,
                      fontWeight: FontWeight.bold,
                      color: AppConstants.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    tr(
                      'أدخل معرف حساب التداول الخاص بك للتحقق وتفعيل الإشارات',
                      'Enter your trading Account ID to verify and activate signals',
                    ),
                    textAlign: TextAlign.center,
                    style: GoogleFonts.outfit(
                      fontSize: 12,
                      color: AppConstants.textSecondary,
                      height: 1.5,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 30),

            // Step 1: Select Broker
            Text(
              tr(
                '1. اختر منصة التداول المسجّل بها',
                '1. Choose the platform you registered on',
              ),
              style: GoogleFonts.outfit(
                fontSize: 14,
                fontWeight: FontWeight.bold,
                color: AppConstants.accentCyan,
              ),
            ),
            const SizedBox(height: 12),
            StreamBuilder<List<Map<String, dynamic>>>(
              stream: Supabase.instance.client
                  .from('brokers')
                  .stream(primaryKey: ['id'])
                  .order('order'),
              builder: (context, snap) {
                final allDocs = snap.data ?? [];
                final docs = allDocs
                    .where((d) => d['is_active'] as bool? ?? true)
                    .toList();
                if (docs.isEmpty) {
                  return Center(
                    child: Text(
                      tr('جاري تحميل المنصات...', 'Loading platforms...'),
                      style: GoogleFonts.outfit(
                        color: AppConstants.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                  );
                }
                return LayoutBuilder(
                  builder: (context, constraints) {
                    const spacing = 10.0;
                    final cardWidth =
                        (constraints.maxWidth - spacing * (docs.length - 1)) /
                        docs.length;
                    return Row(
                      children: docs.asMap().entries.expand((entry) {
                        final i = entry.key;
                        final d = entry.value;
                        final name = d['name'] as String? ?? '';
                        final logoUrl = d['logo_url'] as String? ?? '';
                        final clickKey =
                            d['click_key'] as String? ??
                            name.toLowerCase().replaceAll(' ', '_');
                        final promoCode = d['promo_code'] as String? ?? '';
                        return [
                          if (i > 0) const SizedBox(width: spacing),
                          SizedBox(
                            width: cardWidth,
                            child: _buildBrokerSelectionCard(
                              name: name,
                              logoUrl: logoUrl,
                              clickKey: clickKey,
                              promoCode: promoCode,
                              isSelected: _selectedBroker == name,
                            ),
                          ),
                        ];
                      }).toList(),
                    );
                  },
                );
              },
            ),
            const SizedBox(height: 25),

            // Step 2: Enter account ID
            Text(
              tr('2. أدخل معرف حسابك (Account ID)', '2. Enter your Account ID'),
              style: GoogleFonts.outfit(
                fontSize: 14,
                fontWeight: FontWeight.bold,
                color: AppConstants.accentCyan,
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _idController,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              style: GoogleFonts.outfit(color: Colors.white, fontSize: 16),
              decoration: InputDecoration(
                hintText: tr('مثال: 58392019', 'Example: 58392019'),
                hintStyle: GoogleFonts.outfit(
                  color: AppConstants.textSecondary.withAlpha(100),
                ),
                filled: true,
                fillColor: AppConstants.spaceBackground.withAlpha(180),
                prefixIcon: const Icon(
                  Icons.vpn_key_rounded,
                  color: AppConstants.textSecondary,
                  size: 18,
                ),
                errorText: _errorMessage,
                errorStyle: GoogleFonts.outfit(color: AppConstants.putRed),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: AppConstants.borderGlow),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide(color: AppConstants.accentCyan),
                ),
              ),
            ),

            // Step 3: Promo code — shown ONLY when the selected platform has a
            // promo code set by the admin (then it's mandatory + must match).
            if (_selectedBrokerPromo.trim().isNotEmpty) ...[
              const SizedBox(height: 25),
              Text(
                tr(
                  '3. أدخل كود البرومو (إجباري لمنصة $_selectedBroker)',
                  '3. Enter the promo code (required for $_selectedBroker)',
                ),
                style: GoogleFonts.outfit(
                  fontSize: 14,
                  fontWeight: FontWeight.bold,
                  color: AppConstants.accentCyan,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _promoController,
                style: GoogleFonts.outfit(color: Colors.white, fontSize: 16),
                textCapitalization: TextCapitalization.characters,
                decoration: InputDecoration(
                  hintText: tr(
                    'أدخل كود البرومو الخاص بالمنصة',
                    'Enter the platform\'s promo code',
                  ),
                  hintStyle: GoogleFonts.outfit(
                    color: AppConstants.textSecondary.withAlpha(100),
                  ),
                  filled: true,
                  fillColor: AppConstants.spaceBackground.withAlpha(180),
                  prefixIcon: const Icon(
                    Icons.local_offer_rounded,
                    color: AppConstants.textSecondary,
                    size: 18,
                  ),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: const BorderSide(
                      color: AppConstants.borderGlow,
                    ),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: BorderSide(color: AppConstants.accentCyan),
                  ),
                ),
              ),
            ],
            const SizedBox(height: 35),

            // Verify Button
            InkWell(
              onTap: _startVerification,
              borderRadius: BorderRadius.circular(16),
              child: Container(
                height: 55,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(16),
                  gradient: LinearGradient(
                    colors: [AppConstants.accentCyan, AppConstants.accentBlue],
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: AppConstants.accentCyan.withAlpha(80),
                      blurRadius: 15,
                      offset: const Offset(0, 5),
                    ),
                  ],
                ),
                child: Center(
                  child: Text(
                    tr(
                      'التحقق وتنشيط الإشارات ⟵',
                      'Verify & activate signals ⟵',
                    ),
                    style: GoogleFonts.outfit(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: AppConstants.spaceBackground,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 20),

            // Redirection link back to NoticeScreen instructions
            TextButton(
              onPressed: () {
                Navigator.of(context).pushReplacement(
                  PageRouteBuilder(
                    pageBuilder: (context, animation, secondaryAnimation) =>
                        const NoticeScreen(),
                    transitionsBuilder:
                        (context, animation, secondaryAnimation, child) {
                          return FadeTransition(
                            opacity: animation,
                            child: child,
                          );
                        },
                    transitionDuration: const Duration(milliseconds: 600),
                  ),
                );
              },
              child: Text(
                tr(
                  'الرجوع لتعليمات تفعيل العضوية والتسجيل',
                  'Back to membership activation & registration instructions',
                ),
                style: GoogleFonts.outfit(
                  color: AppConstants.accentCyan,
                  fontSize: 13,
                  fontWeight: FontWeight.bold,
                  decoration: TextDecoration.underline,
                ),
              ),
            ),
            const SizedBox(height: 6),
            // Social follow card
            Center(child: _buildSocialCard()),
          ],
        ),
      ),
    );
  }

  // Compact social follow card
  Widget _buildSocialCard() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: AppConstants.cardBgColor,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppConstants.borderGlow),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            tr('تابعنا', 'Follow us'),
            style: GoogleFonts.outfit(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: AppConstants.textSecondary,
            ),
          ),
          const SizedBox(width: 10),
          _socialIconButton(
            icon: Icons.smart_display_rounded,
            color: const Color(0xFFFF0000),
            onTap: () => openBrowserTab(_youtubeUrl),
          ),
          const SizedBox(width: 8),
          _socialIconButton(
            icon: Icons.send_rounded,
            color: const Color(0xFF229ED9),
            onTap: () => openBrowserTab(_telegramUrl),
          ),
        ],
      ),
    );
  }

  Widget _socialIconButton({
    required IconData icon,
    required Color color,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(20),
      child: Container(
        width: 34,
        height: 34,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: color.withAlpha(28),
          border: Border.all(color: color.withAlpha(110)),
        ),
        child: Icon(icon, color: color, size: 18),
      ),
    );
  }

  // Selectable Broker Cards
  Widget _buildBrokerSelectionCard({
    required String name,
    required String logoUrl,
    required String clickKey,
    required String promoCode,
    required bool isSelected,
  }) {
    return InkWell(
      onTap: () => setState(() {
        _selectedBroker = name;
        _selectedBrokerKey = clickKey;
        _selectedBrokerPromo = promoCode;
        _promoController.clear(); // reset the promo field when platform changes
      }),
      borderRadius: BorderRadius.circular(10),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(vertical: 7, horizontal: 6),
        decoration: BoxDecoration(
          gradient: isSelected
              ? LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    AppConstants.accentCyan.withAlpha(35),
                    AppConstants.accentBlue.withAlpha(22),
                  ],
                )
              : null,
          color: isSelected
              ? null
              : AppConstants.spaceBackground.withAlpha(120),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: isSelected
                ? AppConstants.accentCyan
                : AppConstants.borderGlow,
            width: isSelected ? 1.5 : 1.0,
          ),
          boxShadow: isSelected
              ? [
                  BoxShadow(
                    color: AppConstants.accentCyan.withAlpha(40),
                    blurRadius: 10,
                  ),
                ]
              : null,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 32,
              height: 32,
              decoration: BoxDecoration(
                color: Colors.white,
                shape: BoxShape.circle,
                border: Border.all(
                  color: isSelected
                      ? AppConstants.accentCyan
                      : Colors.white.withAlpha(50),
                  width: 1.2,
                ),
                boxShadow: [
                  BoxShadow(
                    color: isSelected
                        ? AppConstants.accentCyan.withAlpha(60)
                        : Colors.black.withAlpha(40),
                    blurRadius: isSelected ? 8 : 3,
                  ),
                ],
              ),
              child: ClipOval(
                child: Padding(
                  padding: const EdgeInsets.all(4),
                  child: _buildLogoImage(logoUrl, fallbackSize: 16),
                ),
              ),
            ),
            const SizedBox(height: 5),
            Text(
              name,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: GoogleFonts.outfit(
                fontSize: 9.5,
                fontWeight: FontWeight.bold,
                color: isSelected ? Colors.white : AppConstants.textSecondary,
              ),
            ),
            const SizedBox(height: 3),
            AnimatedOpacity(
              opacity: isSelected ? 1.0 : 0.0,
              duration: const Duration(milliseconds: 200),
              child: Icon(
                Icons.check_circle_rounded,
                color: AppConstants.accentCyan,
                size: 11,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildLogoImage(String logoUrl, {double fallbackSize = 30}) {
    if (logoUrl.isEmpty) {
      return Icon(
        Icons.storefront_rounded,
        color: Colors.grey,
        size: fallbackSize,
      );
    }
    if (logoUrl.startsWith('http') || logoUrl.startsWith('data:')) {
      return Image.network(
        logoUrl,
        fit: BoxFit.contain,
        errorBuilder: (ctx, err, stack) => Icon(
          Icons.storefront_rounded,
          color: Colors.grey,
          size: fallbackSize,
        ),
      );
    }
    return Image.asset(logoUrl, fit: BoxFit.contain);
  }

  // Second View: Verification Progress Handshake Screen
  Widget _buildVerificationHandshake() {
    return Container(
      width: 450,
      padding: const EdgeInsets.all(40),
      decoration: BoxDecoration(
        color: AppConstants.cardBgColor.withAlpha(220),
        borderRadius: BorderRadius.circular(24),
        border: Border.all(
          color: AppConstants.accentCyan.withAlpha(100),
          width: 1.5,
        ),
        boxShadow: [
          BoxShadow(
            color: AppConstants.accentCyan.withAlpha(20),
            blurRadius: 30,
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 80,
            height: 80,
            child: CircularProgressIndicator(
              color: AppConstants.accentCyan,
              strokeWidth: 5,
            ),
          ),
          const SizedBox(height: 40),
          Text(
            tr('جاري الاتصال والتحقق', 'Connecting & verifying'),
            style: GoogleFonts.outfit(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: Colors.white,
            ),
          ),
          const SizedBox(height: 12),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 300),
            child: Text(
              _verificationStepText,
              key: ValueKey<String>(_verificationStepText),
              textAlign: centerText(),
              style: GoogleFonts.outfit(
                fontSize: 14,
                color: AppConstants.textSecondary,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          const SizedBox(height: 30),
          // Progress bar
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: LinearProgressIndicator(
              value: _verificationProgress,
              color: AppConstants.accentCyan,
              backgroundColor: AppConstants.borderGlow,
              minHeight: 8,
            ),
          ),
          const SizedBox(height: 15),
          Text(
            tr(
              'تمت المزامنة بنسبة ${(_verificationProgress * 100).toInt()}%',
              'Synced ${(_verificationProgress * 100).toInt()}%',
            ),
            style: GoogleFonts.outfit(
              fontSize: 11,
              color: AppConstants.accentCyan,
              fontWeight: FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }

  TextAlign centerText() => TextAlign.center;

  Future<void> _showVipWelcomeDialog(DateTime expiry) async {
    final diff = expiry.difference(DateTime.now());
    final days = diff.inDays;
    final hours = diff.inHours % 24;

    await showDialog(
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
              border: Border.all(
                color: Colors.amber.withAlpha(120),
                width: 1.5,
              ),
              boxShadow: [
                BoxShadow(
                  color: Colors.amber.withAlpha(30),
                  blurRadius: 40,
                  spreadRadius: 6,
                ),
              ],
            ),
            padding: const EdgeInsets.all(26),
            child: Directionality(
              textDirection: LanguageService.direction,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Crown icon
                  Container(
                    width: 76,
                    height: 76,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: const LinearGradient(
                        colors: [Color(0xFF3A2800), Color(0xFF1A1240)],
                      ),
                      border: Border.all(
                        color: Colors.amber.withAlpha(150),
                        width: 2,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.amber.withAlpha(60),
                          blurRadius: 24,
                        ),
                      ],
                    ),
                    child: const Icon(
                      Icons.workspace_premium_rounded,
                      color: Colors.amber,
                      size: 38,
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    tr(
                      'مبروك! أنت الآن VIP 👑',
                      'Congratulations! You are now VIP 👑',
                    ),
                    textAlign: TextAlign.center,
                    style: GoogleFonts.outfit(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      color: AppConstants.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    tr(
                      'تم تفعيل عضويتك بنجاح!\nاستمتع بإشارات VIP الحصرية وتحليلات البروفيشنال.',
                      'Your membership was activated successfully!\nEnjoy exclusive VIP signals and professional analysis.',
                    ),
                    textAlign: TextAlign.center,
                    style: GoogleFonts.outfit(
                      fontSize: 12,
                      color: AppConstants.textSecondary,
                      height: 1.6,
                    ),
                  ),
                  const SizedBox(height: 18),
                  // Expiry countdown
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: Colors.amber.withAlpha(12),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: Colors.amber.withAlpha(60)),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                      children: [
                        _countdownBlock(
                          days.toString(),
                          tr('يوم', 'days'),
                          Colors.amber,
                        ),
                        Container(
                          width: 1,
                          height: 36,
                          color: Colors.amber.withAlpha(40),
                        ),
                        _countdownBlock(
                          hours.toString(),
                          tr('ساعة', 'hours'),
                          Colors.amber,
                        ),
                        Container(
                          width: 1,
                          height: 36,
                          color: Colors.amber.withAlpha(40),
                        ),
                        Column(
                          children: [
                            Text(
                              tr('ينتهي في', 'Expires on'),
                              style: GoogleFonts.outfit(
                                fontSize: 9,
                                color: Colors.amber.withAlpha(160),
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              '${expiry.day}/${expiry.month}/${expiry.year}',
                              style: GoogleFonts.outfit(
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                                color: Colors.amber,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    tr(
                      '💬 للتجديد تواصل مع المطور عبر تليجرام',
                      '💬 To renew, contact the developer on Telegram',
                    ),
                    textAlign: TextAlign.center,
                    style: GoogleFonts.outfit(
                      fontSize: 12,
                      color: AppConstants.textSecondary,
                    ),
                  ),
                  const SizedBox(height: 12),
                  // Telegram button
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton.icon(
                      onPressed: () => openBrowserTab(_telegramUrl),
                      icon: const Icon(Icons.send_rounded, size: 16),
                      label: Text(
                        tr('@euro_trd — تواصل الآن', '@euro_trd — Contact now'),
                        style: GoogleFonts.outfit(
                          fontSize: 13,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF29B6F6),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: Text(
                      tr('في وقت لاحق', 'Later'),
                      style: GoogleFonts.outfit(
                        fontSize: 12,
                        color: AppConstants.textSecondary,
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

  Widget _countdownBlock(String value, String label, Color color) {
    return Column(
      children: [
        Text(
          value,
          style: GoogleFonts.outfit(
            fontSize: 22,
            fontWeight: FontWeight.bold,
            color: color,
          ),
        ),
        Text(
          label,
          style: GoogleFonts.outfit(fontSize: 9, color: color.withAlpha(160)),
        ),
      ],
    );
  }
}

// ── Subscribe button widget ───────────────────────────────────────────────────

class _SubscribeButton extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String label;
  final String sublabel;
  final bool done;
  final VoidCallback onTap;

  const _SubscribeButton({
    required this.icon,
    required this.iconColor,
    required this.label,
    required this.sublabel,
    required this.done,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: done ? null : onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: done
              ? AppConstants.callGreen.withAlpha(15)
              : iconColor.withAlpha(12),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: done
                ? AppConstants.callGreen.withAlpha(80)
                : iconColor.withAlpha(60),
          ),
        ),
        child: Row(
          children: [
            Icon(
              done ? Icons.check_circle_rounded : icon,
              color: done ? AppConstants.callGreen : iconColor,
              size: 22,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: GoogleFonts.outfit(
                      fontSize: 12,
                      fontWeight: FontWeight.bold,
                      color: done
                          ? AppConstants.callGreen
                          : AppConstants.textPrimary,
                    ),
                  ),
                  Text(
                    sublabel,
                    style: GoogleFonts.outfit(
                      fontSize: 10,
                      color: AppConstants.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
            if (!done)
              Icon(
                Icons.open_in_new_rounded,
                color: iconColor.withAlpha(150),
                size: 16,
              ),
            if (done)
              Text(
                tr('تم ✓', 'Done ✓'),
                style: GoogleFonts.outfit(
                  fontSize: 10,
                  color: AppConstants.callGreen,
                  fontWeight: FontWeight.bold,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
