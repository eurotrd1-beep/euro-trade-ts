-- ════════════════════════════════════════════════════════════════════════════
-- تحقّق — شغّله في Supabase SQL Editor بعد 20260818_unified_settlement.sql
--
-- مش ترحيل. ملف تحقّق بيثبت أربع حاجات بالتنفيذ الفعلي مش بالقراءة، وبيمسح
-- وراه كل حاجة عمَلها. آمن على بيانات الإنتاج: بيشتغل جوه transaction
-- بينتهي بـ ROLLBACK، فولا صف بيتغيّر.
--
-- كل استعلام بيطبع سطر واحد: ✅ أو ❌ ومعاه السبب.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ١. الدالة بطّلت تحسب النتيجة من الأسعار ────────────────────────────────
--
-- الدليل من تعريف الدالة نفسه: لازم تكون بتقرا `i.outcome`، ولازم ما يكونش
-- فيها أي مقارنة بين سعر الخروج وسعر الدخول.
SELECT
  CASE
    WHEN pg_get_functiondef(p.oid) LIKE '%i.outcome IN%'
     AND pg_get_functiondef(p.oid) NOT LIKE '%i.price > s.entry_price%'
     AND pg_get_functiondef(p.oid) NOT LIKE '%i.price = s.entry_price%'
    THEN '✅ ١. resolve_signals بتخزّن النتيجة ومبتحسبهاش'
    ELSE '❌ ١. الدالة لسه بتحسب من الأسعار — الترحيل مااتطبّقش'
  END AS check_1
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'resolve_signals';


-- ── ٢. إغلاق جوه هامش التعادل بيتسجّل tie ──────────────────────────────────
--
-- الهامش في المحرك: |إغلاق − دخول| ≤ |دخول| × 0.000005
-- بندخل صف بسعر دخول 1.09700، وبنسوّيه بسعر جوه الهامش بنص الهامش بالظبط،
-- والنتيجة اللي المحرك بيبعتها في الحالة دي هي 'tie'.
--
-- التعريف القديم (مساواة تامة) كان هيسجّلها win لأن السعر مش مساوي تمامًا.
WITH inserted AS (
  INSERT INTO public.signals
    (symbol, timeframe, direction, bar_time, slot, entry_price, expiry_seconds, outcome)
  VALUES
    ('__VERIFY__', '1m', 'CALL', now(), 'instant_free', 1.09700, 60, 'pending')
  RETURNING id, entry_price
), resolved AS (
  SELECT
    i.id,
    -- نص الهامش فوق سعر الدخول: مش مساوي، وجوّه الهامش.
    i.entry_price + (i.entry_price * 0.000005) / 2 AS inside_band
  FROM inserted i
), applied AS (
  SELECT public.resolve_signals(
    jsonb_build_array(
      jsonb_build_object('id', r.id, 'price', r.inside_band, 'outcome', 'tie')
    )
  ) AS n
  FROM resolved r
)
SELECT
  CASE
    WHEN s.outcome = 'tie'
    THEN '✅ ٢. إغلاق جوه الهامش اتسجّل tie · السعر ' || s.outcome_price
    ELSE '❌ ٢. اتسجّل ' || s.outcome || ' بدل tie'
  END AS check_2
FROM applied a
JOIN public.signals s ON s.symbol = '__VERIFY__'
WHERE a.n = 1;


-- ── ٣. نتيجة مش معروفة مبتتخزّنش تعادل ─────────────────────────────────────
--
-- «مفيش سعر» حالة رابعة. لو اتخزّنت tie، التعادلات بتتضخّم ومحدش يعرف ليه.
WITH inserted AS (
  INSERT INTO public.signals
    (symbol, timeframe, direction, bar_time, slot, entry_price, expiry_seconds, outcome)
  VALUES
    ('__VERIFY_NULL__', '1m', 'PUT', now(), 'instant_free', 1.09700, 60, 'pending')
  RETURNING id
), applied AS (
  SELECT public.resolve_signals(
    jsonb_build_array(jsonb_build_object('id', i.id, 'price', NULL, 'outcome', NULL))
  ) AS n
  FROM inserted i
)
SELECT
  CASE
    WHEN s.outcome = 'unresolved' THEN '✅ ٣. سعر مفقود اتسجّل unresolved مش tie'
    ELSE '❌ ٣. اتسجّل ' || s.outcome
  END AS check_3
FROM applied a
JOIN public.signals s ON s.symbol = '__VERIFY_NULL__'
WHERE a.n = 1;


-- ── ٤. مفيش أي مسار SQL تاني بيقرر نتيجة ───────────────────────────────────
--
-- بيدوّر في كل دوال السكيما على أي واحدة بتكتب في `outcome` وفيها مقارنة
-- أسعار. المفروض تطلع فاضية.
SELECT
  CASE
    WHEN count(*) = 0 THEN '✅ ٤. مفيش دالة تانية بتحسب outcome من الأسعار'
    ELSE '❌ ٤. فيه ' || count(*) || ' دالة: ' || string_agg(p.proname, ', ')
  END AS check_4
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND pg_get_functiondef(p.oid) LIKE '%outcome%'
  AND pg_get_functiondef(p.oid) LIKE '%entry_price%'
  AND pg_get_functiondef(p.oid) LIKE '%CASE%'
  AND p.proname <> 'resolve_signals';


-- ── ٥. صلاحيات التنفيذ اتقفلت فعلًا ────────────────────────────────────────
--
-- الاختبار الحقيقي مش وجود REVOKE في الملف — هو `has_function_privilege`.
-- الترحيل القديم كان فيه REVOKE وanon كان لسه بينفّذ.
SELECT
  CASE
    WHEN bool_or(has_function_privilege('anon', p.oid, 'EXECUTE'))
    THEN '❌ ٥. anon لسه بيقدر ينفّذ: ' || string_agg(
           p.proname, ', ') FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE'))
    ELSE '✅ ٥. anon مالوش EXECUTE على ولا واحدة'
  END AS check_5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('resolve_signals', 'record_signals', 'pending_signals',
                    'prune_signals', 'refresh_signal_daily');


-- ── ٦. المولّد لسه بيقدر يشتغل ─────────────────────────────────────────────
SELECT
  CASE
    WHEN bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))
    THEN '✅ ٦. service_role بينفّذ الخمسة — المولّد شغّال'
    ELSE '❌ ٦. service_role اتحرم من دالة — المولّد هيقف'
  END AS check_6
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('resolve_signals', 'record_signals', 'pending_signals',
                    'prune_signals', 'refresh_signal_daily');


-- ── ٧. السقف اتحدّث ────────────────────────────────────────────────────────
SELECT
  CASE
    WHEN min(max_rows) >= 20000 THEN '✅ ٧. سقف الكتابة ' || min(max_rows)
    ELSE '❌ ٧. السقف لسه ' || min(max_rows)
  END AS check_7
FROM public.signal_write_budget;


-- كل اللي فوق اتعمل جوه transaction. الصفوف التجريبية بتختفي هنا.
ROLLBACK;
