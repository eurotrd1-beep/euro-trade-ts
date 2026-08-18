-- ════════════════════════════════════════════════════════════════════════════
-- تحقّق — شغّله في Supabase SQL Editor بعد 20260818_unified_settlement.sql
--
-- مش ترحيل. بيثبت بالتنفيذ الفعلي — مش بقراءة الملفات — إن التسوية بقى ليها
-- تعريف واحد، وإن الصلاحيات اتقفلت فعلًا.
--
-- آمن على الإنتاج: كله جوه transaction بينتهي بـ ROLLBACK. الصفوف التجريبية
-- بتتكتب وبتختفي، ومفيش صف حقيقي بيتلمس.
--
-- شغّل الملف كله مرة واحدة. النتيجة جدول واحد في الآخر، سطر لكل فحص.
--
-- ── ليه الشكل ده بالذات ────────────────────────────────────────────────────
--
-- النسخة الأولى كانت بتحط الفحوصات في جُمَل منفصلة وبتعمل INSERT وresolve في
-- نفس الجملة. الاتنين غلط:
--
--   • محرر Supabase بيعرض نتيجة آخر جملة بس، فست فحوصات كانت هتختفي.
--   • الصف اللي بيتدخل في CTE **مش موجود** بالنسبة لدالة بتتنادى في نفس
--     الجملة — نفس اللقطة الزمنية. فالتسوية كانت هتشتغل على لا شيء وترجع 0
--     من غير ما تفشل، وده أسوأ من خطأ صريح.
--
-- عشان كده: جدول مؤقت بيتجمّع فيه النتايج، وDO blocks عشان الترتيب يبقى
-- إجرائي والصف يبقى مرئي للخطوة اللي بعده.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE _verify (step int PRIMARY KEY, result text);


-- ── ١. الدالة بطّلت تحسب النتيجة من الأسعار ────────────────────────────────
INSERT INTO _verify
SELECT 1, CASE
  WHEN def LIKE '%i.outcome IN%'
   AND def NOT LIKE '%i.price > s.entry_price%'
   AND def NOT LIKE '%i.price = s.entry_price%'
  THEN '✅ resolve_signals بتخزّن النتيجة ومبتحسبهاش'
  ELSE '❌ الدالة لسه بتحسب من الأسعار — الترحيل مااتطبّقش'
END
FROM (
  SELECT pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'resolve_signals'
  LIMIT 1
) x;


-- ── ٢. إغلاق جوه هامش التعادل بيتسجّل tie ──────────────────────────────────
--
-- هامش المحرك: |إغلاق − دخول| ≤ |دخول| × 0.000005
-- بندخل صفقة CALL بدخول 1.09700، وبنسوّيها بسعر أعلى بنص الهامش: مش مساوي
-- للدخول، وجوّه الهامش. التعريف القديم (مساواة تامة) كان هيسجّلها WIN.
DO $$
DECLARE
  v_id     bigint;
  v_entry  double precision := 1.09700;
  v_inside double precision;
  v_out    text;
BEGIN
  v_inside := v_entry + (v_entry * 0.000005) / 2;

  INSERT INTO public.signals
    (symbol, timeframe, direction, bar_time, slot, entry_price, expiry_seconds, outcome)
  VALUES
    ('__VERIFY_TIE__', '1m', 'CALL', now(), 'instant_free', v_entry, 60, 'pending')
  RETURNING id INTO v_id;

  PERFORM public.resolve_signals(
    jsonb_build_array(jsonb_build_object('id', v_id, 'price', v_inside, 'outcome', 'tie'))
  );

  SELECT outcome INTO v_out FROM public.signals WHERE id = v_id;

  INSERT INTO _verify VALUES (2, CASE
    WHEN v_out = 'tie'
    THEN '✅ إغلاق جوه الهامش اتسجّل tie (فرق ' ||
         to_char(v_inside - v_entry, 'FM0.0000000000') || ')'
    ELSE '❌ اتسجّل ' || coalesce(v_out, 'NULL') || ' بدل tie'
  END);
END $$;


-- ── ٣. «مفيش سعر» مبيتسجّلش تعادل ──────────────────────────────────────────
DO $$
DECLARE
  v_id  bigint;
  v_out text;
BEGIN
  INSERT INTO public.signals
    (symbol, timeframe, direction, bar_time, slot, entry_price, expiry_seconds, outcome)
  VALUES
    ('__VERIFY_NULL__', '1m', 'PUT', now(), 'instant_free', 1.09700, 60, 'pending')
  RETURNING id INTO v_id;

  PERFORM public.resolve_signals(
    jsonb_build_array(jsonb_build_object('id', v_id, 'price', NULL, 'outcome', NULL))
  );

  SELECT outcome INTO v_out FROM public.signals WHERE id = v_id;

  INSERT INTO _verify VALUES (3, CASE
    WHEN v_out = 'unresolved' THEN '✅ سعر مفقود اتسجّل unresolved مش tie'
    ELSE '❌ اتسجّل ' || coalesce(v_out, 'NULL')
  END);
END $$;


-- ── ٤. مفيش أي دالة تانية بتقرر نتيجة من الأسعار ───────────────────────────
INSERT INTO _verify
SELECT 4, CASE
  WHEN n = 0 THEN '✅ مفيش دالة تانية بتحسب outcome من الأسعار'
  ELSE '❌ فيه ' || n || ' دالة: ' || names
END
FROM (
  SELECT count(*) AS n, coalesce(string_agg(p.proname::text, ', '), '') AS names
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.proname::text <> 'resolve_signals'
    AND pg_get_functiondef(p.oid) LIKE '%entry_price%'
    AND pg_get_functiondef(p.oid) LIKE '%outcome%'
    AND pg_get_functiondef(p.oid) LIKE '%CASE%'
) x;


-- ── ٥. anon مالوش تنفيذ — الاختبار بالصلاحية نفسها مش بنص الملف ────────────
INSERT INTO _verify
SELECT 5, CASE
  WHEN n = 0 THEN '✅ anon مالوش EXECUTE على ولا واحدة من الخمسة'
  ELSE '❌ anon لسه بينفّذ: ' || names
END
FROM (
  SELECT count(*) AS n, coalesce(string_agg(p.proname::text, ', '), '') AS names
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.proname::text IN ('resolve_signals', 'record_signals', 'pending_signals',
                            'prune_signals', 'refresh_signal_daily')
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
) x;


-- ── ٦. المولّد لسه بيقدر يشتغل ─────────────────────────────────────────────
INSERT INTO _verify
SELECT 6, CASE
  WHEN missing = 0 THEN '✅ service_role بينفّذ الكل — المولّد شغّال'
  ELSE '❌ service_role اتحرم من ' || missing || ' دالة — المولّد هيقف'
END
FROM (
  SELECT count(*) AS missing
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.proname::text IN ('resolve_signals', 'record_signals', 'pending_signals',
                            'prune_signals', 'refresh_signal_daily')
    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
) x;


-- ── ٧. سقف الكتابة اليومي ──────────────────────────────────────────────────
INSERT INTO _verify
SELECT 7, CASE
  WHEN cap IS NULL THEN '⚠️ مفيش صف في signal_write_budget لسه — السقف هيتاخد من الـdefault'
  WHEN cap >= 20000 THEN '✅ سقف الكتابة ' || cap
  ELSE '❌ السقف لسه ' || cap
END
FROM (SELECT min(max_rows) AS cap FROM public.signal_write_budget) x;


-- ── النتيجة ────────────────────────────────────────────────────────────────
SELECT step AS "الفحص", result AS "النتيجة" FROM _verify ORDER BY step;

ROLLBACK;
