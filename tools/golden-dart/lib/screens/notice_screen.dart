import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import '../constants.dart';
import '../services/language_service.dart';
import '../utils/web_utils.dart';
import '../widgets/particles.dart';
import '../widgets/trading_background.dart';
import 'login_screen.dart';

class NoticeScreen extends StatefulWidget {
  const NoticeScreen({super.key});

  @override
  State<NoticeScreen> createState() => _NoticeScreenState();
}

class _NoticeScreenState extends State<NoticeScreen> {
  Future<void> _openBrokerSignUp(String brokerName, String registrationLink, String clickKey) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('last_clicked_broker', brokerName);
      await prefs.setString('last_clicked_broker_key', clickKey);
    } catch (e) {
      debugPrint('Error saving clicked broker: $e');
    }
    try {
      openBrowserTab(registrationLink);
    } catch (e) {
      debugPrint('Error opening link: $e');
    }
  }

  void _copyPromoCode(String code) {
    Clipboard.setData(ClipboardData(text: code));
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        backgroundColor: AppConstants.cardBgColor,
        duration: const Duration(seconds: 2),
        content: Row(
          children: [
            const Icon(Icons.check_circle_outline, color: AppConstants.callGreen),
            const SizedBox(width: 10),
            Text(tr('تم نسخ البروموكود $code إلى الحافظة!', 'Promo code $code copied to clipboard!'),
                style: GoogleFonts.outfit(color: AppConstants.textPrimary)),
          ],
        ),
      ),
    );
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

          // Diagonal Neon Ambient Glow
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
              child: Container(
                width: isDesktop ? 550 : double.infinity,
                padding: const EdgeInsets.all(28),
                decoration: BoxDecoration(
                  color: AppConstants.cardBgColor.withAlpha(220),
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(
                    color: AppConstants.borderGlow,
                    width: 1.5,
                  ),
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
                          width: 80,
                          height: 80,
                          margin: const EdgeInsets.only(bottom: 20),
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
                            child: Image.asset(
                              'assets/logo.jpg',
                              fit: BoxFit.cover,
                            ),
                          ),
                        ),
                      ),

                      // Title
                      Text(
                        tr('تنويه هام وتفعيل العضوية', 'Important Notice & Membership Activation'),
                        textAlign: TextAlign.center,
                        style: GoogleFonts.outfit(
                          fontSize: 22,
                          fontWeight: FontWeight.bold,
                          color: Colors.white,
                        ),
                      ),
                      const SizedBox(height: 10),

                      Text(
                        tr('للحصول على إشارات التحليل الفني والذكاء الاصطناعي المجانية، يجب تسجيل حساب جديد من خلال روابط الشراكة أدناه لتوثيق عضويتك بالفيب (VIP Room).', 'To receive free technical-analysis and AI signals, you must register a new account through the partner links below to verify your VIP Room membership.'),
                        textAlign: TextAlign.center,
                        style: GoogleFonts.outfit(
                          fontSize: 13,
                          color: AppConstants.textSecondary,
                          height: 1.6,
                        ),
                      ),
                      const SizedBox(height: 16),

                      // Warning: signals only work with bot registration
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: AppConstants.putRed.withAlpha(10),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: AppConstants.putRed.withAlpha(60),
                          ),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Icon(
                                Icons.warning_amber_rounded,
                                color: AppConstants.putRed.withAlpha(200),
                                size: 18,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                tr('⚠️ تنبيه: الإشارات لن تعمل إلا إذا قمت بالتسجيل من خلال الروابط الموجودة هنا. أي حساب مسجل من خارج البوت لن يتم تفعيله.', '⚠️ Warning: Signals will only work if you register through the links here. Any account registered outside the bot will not be activated.'),
                                style: GoogleFonts.outfit(
                                  fontSize: 11,
                                  color: AppConstants.putRed.withAlpha(220),
                                  height: 1.5,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 20),

                      // Dynamic broker cards from Supabase
                      StreamBuilder<List<Map<String, dynamic>>>(
                        stream: Supabase.instance.client
                            .from('brokers')
                            .stream(primaryKey: ['id'])
                            .order('order'),
                        builder: (context, snap) {
                          final docs = snap.data ?? [];
                          if (docs.isEmpty) {
                            return Center(
                              child: Padding(
                                padding: const EdgeInsets.symmetric(vertical: 24),
                                child: Text(
                                  tr('جاري تحميل المنصات المتاحة...', 'Loading available platforms...'),
                                  style: GoogleFonts.outfit(color: AppConstants.textSecondary, fontSize: 13),
                                ),
                              ),
                            );
                          }
                          final activeDocs = docs.where((d) => d['is_active'] as bool? ?? true).toList();
                          return Column(
                            children: activeDocs.asMap().entries.map((entry) {
                              final i = entry.key;
                              final d = entry.value;
                              final name       = d['name']              as String? ?? '';
                              final logoUrl    = d['logo_url']          as String? ?? '';
                              final link       = d['registration_link'] as String? ?? '';
                              final clickKey   = d['click_key']         as String? ?? name.toLowerCase().replaceAll(' ', '_');
                              final isRec      = d['is_recommended']    as bool?   ?? false;
                              final promoCode  = d['promo_code']        as String? ?? '';
                              final bonusPct   = d['bonus_percent']     as int?    ?? 0;
                              final minDep     = d['min_deposit']       as int?    ?? 0;
                              return Column(children: [
                                if (i > 0) const SizedBox(height: 16),
                                _buildBrokerCard(
                                  name: name,
                                  desc: d['desc'] as String? ?? '',
                                  logoUrl: logoUrl,
                                  onTap: () => _openBrokerSignUp(name, link, clickKey),
                                  btnText: tr('سجل حساب في $name 📈', 'Register an account on $name 📈'),
                                  isRecommended: isRec,
                                  promoWidget: promoCode.isNotEmpty
                                      ? _buildPromoCodeSection(promoCode, bonusPct, minDep)
                                      : null,
                                ),
                              ]);
                            }).toList(),
                          );
                        },
                      ),
                      const SizedBox(height: 30),

                      // Redirect Action Button
                      ElevatedButton(
                        onPressed: () {
                          Navigator.of(context).pushReplacement(
                            PageRouteBuilder(
                              pageBuilder:
                                  (context, animation, secondaryAnimation) =>
                                      const LoginScreen(),
                              transitionsBuilder:
                                  (
                                    context,
                                    animation,
                                    secondaryAnimation,
                                    child,
                                  ) {
                                    return FadeTransition(
                                      opacity: animation,
                                      child: child,
                                    );
                                  },
                              transitionDuration: const Duration(
                                milliseconds: 600,
                              ),
                            ),
                          );
                        },
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppConstants.accentBlue,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 15),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                          shadowColor: AppConstants.accentBlue.withAlpha(120),
                          elevation: 8,
                        ),
                        child: Text(
                          tr('سجلت حساباً بالفعل؟ انقلني لتسجيل الدخول ⟵', 'Already registered? Take me to login ⟵'),
                          style: GoogleFonts.outfit(
                            fontSize: 14,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPromoCodeSection(String promoCode, int bonusPercent, int minDeposit) {
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppConstants.callGreen.withAlpha(10),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppConstants.callGreen.withAlpha(60)),
      ),
      child: Column(
        children: [
          Row(
            children: [
              const Icon(
                Icons.card_giftcard_rounded,
                color: AppConstants.callGreen,
                size: 16,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  minDeposit > 0 && bonusPercent > 0
                      ? tr('أودع $minDeposit\$ حد أدنى واحصل على $bonusPercent% بونص!', 'Deposit a minimum of $minDeposit\$ and get a $bonusPercent% bonus!')
                      : tr('استخدم البروموكود للحصول على مكافأة!', 'Use the promo code to get a bonus!'),
                  style: GoogleFonts.outfit(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: AppConstants.callGreen,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: AppConstants.spaceBackground,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppConstants.borderGlow),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        tr('البروموكود:', 'Promo code:'),
                        style: GoogleFonts.outfit(
                          fontSize: 10,
                          color: AppConstants.textSecondary,
                        ),
                      ),
                      Text(
                        promoCode,
                        style: GoogleFonts.outfit(
                          fontSize: 14,
                          fontWeight: FontWeight.w900,
                          color: Colors.white,
                          letterSpacing: 1.5,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                height: 36,
                child: ElevatedButton.icon(
                  onPressed: () => _copyPromoCode(promoCode),
                  icon: const Icon(Icons.copy_rounded, size: 14),
                  label: Text(
                    tr('نسخ', 'Copy'),
                    style: GoogleFonts.outfit(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppConstants.callGreen.withAlpha(40),
                    foregroundColor: AppConstants.callGreen,
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                    side: BorderSide(
                      color: AppConstants.callGreen.withAlpha(100),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildBrokerCard({
    required String name,
    required String desc,
    required String logoUrl,
    required VoidCallback onTap,
    required String btnText,
    bool isRecommended = false,
    Widget? promoWidget,
  }) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppConstants.spaceBackground.withAlpha(150),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: isRecommended ? AppConstants.callGreen.withAlpha(160) : AppConstants.borderGlow,
          width: isRecommended ? 1.5 : 1.0,
        ),
        boxShadow: isRecommended
            ? [BoxShadow(color: AppConstants.callGreen.withAlpha(18), blurRadius: 14)]
            : [BoxShadow(color: Colors.black.withAlpha(50), blurRadius: 8)],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header row: logo + name + recommended badge
          Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: Colors.white,
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: isRecommended
                        ? AppConstants.callGreen.withAlpha(160)
                        : AppConstants.accentCyan.withAlpha(120),
                    width: 1.5,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: isRecommended
                          ? AppConstants.callGreen.withAlpha(50)
                          : AppConstants.accentCyan.withAlpha(40),
                      blurRadius: 10,
                    ),
                  ],
                ),
                child: ClipOval(
                  child: Padding(
                    padding: const EdgeInsets.all(6),
                    child: _buildLogoImage(logoUrl, fallbackSize: 24),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      style: GoogleFonts.outfit(
                        fontSize: 15,
                        fontWeight: FontWeight.w800,
                        color: Colors.white,
                      ),
                    ),
                    if (isRecommended)
                      Row(
                        children: [
                          const Icon(Icons.workspace_premium_rounded, color: AppConstants.callGreen, size: 12),
                          const SizedBox(width: 4),
                          Text(tr('الأفضل والمُرشحة', 'Best & recommended'),
                              style: GoogleFonts.outfit(fontSize: 10, color: AppConstants.callGreen, fontWeight: FontWeight.bold)),
                        ],
                      )
                    else if (desc.isNotEmpty)
                      Text(desc,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: GoogleFonts.outfit(fontSize: 10, color: AppConstants.textSecondary)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          ElevatedButton(
            onPressed: onTap,
            style: ElevatedButton.styleFrom(
              backgroundColor: isRecommended ? AppConstants.callGreen : AppConstants.accentCyan,
              foregroundColor: AppConstants.spaceBackground,
              padding: const EdgeInsets.symmetric(vertical: 10),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              elevation: 4,
            ),
            child: Text(btnText, style: GoogleFonts.outfit(fontSize: 12, fontWeight: FontWeight.bold)),
          ),
          ?promoWidget,
        ],
      ),
    );
  }

  Widget _buildLogoImage(String logoUrl, {double fallbackSize = 30}) {
    if (logoUrl.isEmpty) return Icon(Icons.storefront_rounded, color: Colors.grey, size: fallbackSize);
    if (logoUrl.startsWith('http') || logoUrl.startsWith('data:')) {
      return Image.network(logoUrl, fit: BoxFit.contain,
          errorBuilder: (ctx, err, stack) => Icon(Icons.storefront_rounded, color: Colors.grey, size: fallbackSize));
    }
    return Image.asset(logoUrl, fit: BoxFit.contain);
  }
}
