-- ════════════════════════════════════════════════════════════════════════════
-- سياسة الأصول — 89 أصل بدل 183
--
-- المطلوب: الأسهم والمؤشرات تتشال بالكامل، والسلع يفضل فيها الدهب والفضة بس،
-- والكريبتو يفضل فيه بيتكوين وإيثيريوم وسولانا OTC بس. والعملات زي ما هي.
-- واللي يتشال ميتعملّوش سكرابنج ولا يتخزن — كإنه مش موجود في الكتالوج أصلًا.
--
-- المنع الحقيقي مكانه السكرابر (po-scraper.js → isAllowedAsset): هو اللي
-- بيشترك في الرمز وبيبني شموعه وبيكتبها. الملف ده بيعمل النص التاني من الشغل:
-- بيمسح اللي اتخزن بالفعل قبل السياسة. من غيره الجداول هتفضل شايلة بيانات
-- 94 أصل محدش هيقراها تاني.
--
-- ليه DELETE مش enabled = false: الهدف المعلن هو توفير المساحة. صف متعطّل
-- في otc_pairs مساحته مش مشكلة، لكن سلسلة الشموع بتاعته هي المشكلة —
-- candles فيها 920 صف، كل صف مصفوفة 100 شمعة، لـ367 رمز.
--
-- الدالة تحت هي نفس شرط isAllowedAsset مكتوب بـSQL. الاتنين لازم يفضلوا
-- متطابقين؛ لو اتغيّرت قائمة في مكان، تتغيّر في التاني. السكرابر هو المرجع
-- وقت التشغيل، والدالة دي موجودة عشان التنضيف يتعمل بنفس المنطق بالظبط بدل
-- ما يتكتب بالإيد قائمة رموز تانية تختلف عنه بصمت.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.asset_allowed(sym text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- التسعة اللي مش عملات، برموز Pocket Option بالظبط.
    -- الدهب والفضة مقابل الدولار بس؛ XAUEUR و XAGEUR أسواق تانية ماتطلبتش.
    WHEN sym IN (
      'XAUUSD', 'XAUUSD_otc',
      'XAGUSD', 'XAGUSD_otc',
      'BTCUSD', 'BTCUSD_otc',
      'ETHUSD', 'ETHUSD_otc',
      'SOL-USD_otc'
    ) THEN true

    -- زوج عملات = ست حروف (وممكن _otc)، وكل نصّ فيهم كود عملة حقيقي.
    -- اختبار الشكل لوحده مش كفاية: BCHEUR و BCHGBP و BCHJPY ستة حروف وهم
    -- بيتكوين كاش. مقارنة الأكواد هي اللي بتمنعهم.
    WHEN sym ~* '^[a-z]{6}(_otc)?$' THEN
      upper(left(regexp_replace(sym, '_otc$', '', 'i'), 3)) IN (
        'AED','ARS','AUD','BDT','BHD','BRL','CAD','CHF','CLP','CNH','CNY',
        'COP','DZD','EGP','EUR','GBP','HUF','IDR','INR','IRR','JOD','JPY',
        'KES','LBP','MAD','MXN','MYR','NGN','NOK','NZD','OMR','PHP','PKR',
        'QAR','RUB','SAR','SGD','SYP','THB','TND','TRY','UAH','USD','VND',
        'YER','ZAR')
      AND upper(right(regexp_replace(sym, '_otc$', '', 'i'), 3)) IN (
        'AED','ARS','AUD','BDT','BHD','BRL','CAD','CHF','CLP','CNH','CNY',
        'COP','DZD','EGP','EUR','GBP','HUF','IDR','INR','IRR','JOD','JPY',
        'KES','LBP','MAD','MXN','MYR','NGN','NOK','NZD','OMR','PHP','PKR',
        'QAR','RUB','SAR','SGD','SYP','THB','TND','TRY','UAH','USD','VND',
        'YER','ZAR')

    ELSE false
  END;
$$;

COMMENT ON FUNCTION public.asset_allowed(text) IS
  'الأصول المسموح بيها: كل العملات + دهب وفضة + BTC/ETH/SOL. نسخة SQL من isAllowedAsset في po-scraper.js.';

-- ── الشموع: ده اللي بياخد المساحة فعلًا ────────────────────────────────────
--
-- المفتاح شكله `<رمز>_<فريم>`، والفريم واحد من الخمسة تحت. بيتشال الأول
-- عشان لو حاجة وقعت بعد كده، الجداول الصغيرة تفضل زي ما هي وتتقرا بسهولة.
-- الشرط بيشيل كمان أي مفتاح مالوش لاحقة فريم معروفة (زي 'OANDA:EURUSD'
-- المتسرّب من مستمع TradingView) — مفيش حاجة بتقراه.
DELETE FROM public.candles
 WHERE key !~ '_(1m|5m|15m|30m|1h|1D)$'
    OR NOT public.asset_allowed(regexp_replace(key, '_(1m|5m|15m|30m|1h|1D)$', ''));

-- ── مكتبة الرموز اللي السكرابر بيكتشفها ────────────────────────────────────
DELETE FROM public.otc_pairs
 WHERE NOT public.asset_allowed(symbol);

-- ── القايمة اللي التطبيق بيعرضها ───────────────────────────────────────────
DELETE FROM public.pairs
 WHERE NOT public.asset_allowed(chart_symbol);

-- ── لقطة الأسعار ───────────────────────────────────────────────────────────
--
-- صف واحد فيه JSON لكل رمز. السكرابر بيعيد كتابته كل 20 ثانية من الرموز
-- المفعّلة، فهو هيتنضّف لوحده بعد أول كتابة — بس التنضيف هنا معناه إن أول
-- تشغيل بارد بعد الترحيل ميقراش أسعار أصول مابقتش موجودة.
UPDATE public.price_snapshot
   SET data = (
     SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
       FROM jsonb_each(data) AS e(k, v)
      WHERE public.asset_allowed(k)
   )
 WHERE id = 'otc_prices'
   AND jsonb_typeof(data) = 'object';

COMMIT;

-- ── بعد الترحيل ────────────────────────────────────────────────────────────
--
-- الأرقام المتوقّعة وقت الكتابة: otc_pairs من 183 لـ89، وpairs بنفس النسبة،
-- وcandles من 920 صف لحوالي 445. للتأكد:
--
--   SELECT count(*) FILTER (WHERE public.asset_allowed(symbol)) AS باقي,
--          count(*)                                            AS الكل
--     FROM public.otc_pairs;
--
-- المساحة اللي اتفضت مش بترجع للقرص لوحدها في Postgres — الصفوف بتتعلّم
-- ميتة والمساحة بتتعاد استخدامها. لو المطلوب ترجيعها فعلًا للنظام:
--
--   VACUUM FULL public.candles;   -- بياخد قفل على الجدول، شغّله وقت هدوء
