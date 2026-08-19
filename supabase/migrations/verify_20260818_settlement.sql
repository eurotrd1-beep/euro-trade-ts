-- ════════════════════════════════════════════════════════════════════════════
-- تحقّق — بعد تطبيق 20260818_unified_settlement.sql
--
-- جزئين، كل واحد **يتنسخ ويتشغّل لوحده** في Supabase SQL Editor.
--
-- ── ليه جزئين، وليه بالشكل الغريب ده ───────────────────────────────────────
--
-- الملف ده اتكتب تلات مرات قبل كده وكل مرة بيقع في مكان مختلف، والسبب دايمًا
-- إن محرر Supabase مش terminal:
--
--   • بيعرض نتيجة آخر جملة بس — فالفحوصات المتفرّقة بتختفي.
--   • الجلسة مش مضمون تفضل هي هي بين الجُمل، فأي `CREATE TEMP TABLE` بيتبخّر
--     وبيرمي "relation _verify does not exist".
--   • الصف اللي بيتكتب في CTE مش مرئي لدالة بتتنادى في نفس الجملة.
--
-- فالجزء الأول بقى **جملة واحدة** بترجّع كل الفحوصات اللي بتتقري من غير ما
-- تكتب حاجة. والجزء التاني **بلوك واحد** بيكتب ويقرا ويبلّغ النتيجة عن طريق
-- خطأ مقصود — والخطأ ده هو اللي بيضمن إن ولا صف تجريبي فضل في الجدول.
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- الجزء الأول — الفحوصات اللي بتتقري. انسخ من هنا لحد نهاية الجملة وشغّله.
-- بيرجّع 5 أسطر. مبيكتبش أي حاجة.
-- ════════════════════════════════════════════════════════════════════════════

WITH plain_functions AS MATERIALIZED (
  -- `prokind = 'f'` مش زيادة: `pg_get_functiondef` بترمي
  -- «array_agg is an aggregate function» لو وقعت على aggregate، والمخطِّط حر
  -- ينفّذها على صفوف قبل ما يطبّق فلتر الـschema. والـMATERIALIZED بتضمن إن
  -- الفلترة تخلص الأول.
  SELECT p.oid, p.proname::text AS name
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.prokind = 'f'
),
target AS (
  SELECT coalesce(
    (SELECT pg_get_functiondef(oid) FROM plain_functions WHERE name = 'resolve_signals' LIMIT 1),
    ''
  ) AS def
),
others AS (
  SELECT coalesce(string_agg(name, ', '), '') AS names, count(*) AS n
  FROM plain_functions
  WHERE name <> 'resolve_signals'
    AND pg_get_functiondef(oid) LIKE '%entry_price%'
    AND pg_get_functiondef(oid) LIKE '%outcome%'
    AND pg_get_functiondef(oid) LIKE '%CASE%'
),
guarded AS (
  SELECT
    coalesce(string_agg(name, ', ') FILTER (WHERE anon_can), '') AS anon_names,
    count(*) FILTER (WHERE anon_can) AS anon_n,
    count(*) FILTER (WHERE NOT svc_can) AS svc_missing
  FROM (
    SELECT
      name,
      has_function_privilege('anon', oid, 'EXECUTE') AS anon_can,
      has_function_privilege('service_role', oid, 'EXECUTE') AS svc_can
    FROM plain_functions
    WHERE name IN ('resolve_signals', 'record_signals', 'pending_signals',
                   'prune_signals', 'refresh_signal_daily')
  ) p
),
budget AS (SELECT min(max_rows) AS cap FROM public.signal_write_budget)

SELECT 1 AS "#", CASE
  WHEN t.def = '' THEN '❌ resolve_signals مش موجودة أصلاً'
  WHEN t.def LIKE '%i.outcome IN%'
   AND t.def NOT LIKE '%i.price > s.entry_price%'
   AND t.def NOT LIKE '%i.price = s.entry_price%'
  THEN '✅ resolve_signals بتخزّن النتيجة ومبتحسبهاش'
  ELSE '❌ الدالة لسه بتحسب من الأسعار — الترحيل مااتطبّقش'
END AS "النتيجة" FROM target t
UNION ALL
SELECT 4, CASE
  WHEN o.n = 0 THEN '✅ مفيش دالة تانية بتحسب outcome من الأسعار'
  ELSE '❌ فيه ' || o.n || ' دالة: ' || o.names
END FROM others o
UNION ALL
SELECT 5, CASE
  WHEN g.anon_n = 0 THEN '✅ anon مالوش EXECUTE على ولا واحدة من الخمسة'
  ELSE '❌ anon لسه بينفّذ: ' || g.anon_names
END FROM guarded g
UNION ALL
SELECT 6, CASE
  WHEN g.svc_missing = 0 THEN '✅ service_role بينفّذ الكل — المولّد شغّال'
  ELSE '❌ service_role اتحرم من ' || g.svc_missing || ' دالة — المولّد هيقف'
END FROM guarded g
UNION ALL
SELECT 7, CASE
  WHEN b.cap IS NULL THEN '⚠️ signal_write_budget فاضي — السقف هيتاخد من الـdefault'
  WHEN b.cap >= 20000 THEN '✅ سقف الكتابة ' || b.cap
  ELSE '❌ السقف لسه ' || b.cap
END FROM budget b
ORDER BY 1;


-- ════════════════════════════════════════════════════════════════════════════
-- الجزء التاني — اختبار التعادل الحقيقي. انسخ البلوك ده لوحده وشغّله.
--
-- ⚠️ النتيجة هتظهرلك كـ **ERROR**. ده مقصود ومش عطل.
--
-- البلوك بيدخل صفقتين تجريبيتين، بيسوّيهم بالدالة الحقيقية، بيقرا النتيجة،
-- وبعدين بيرمي خطأ فيه النتيجة. الخطأ هو اللي **بيلغي الكتابة كلها** — يعني
-- مستحيل يفضل صف تجريبي في `signals` حتى لو الاتصال اتقطع في النص. ضمانة
-- أقوى من ROLLBACK في آخر السطر.
--
-- المطلوب تشوفه في رسالة الخطأ:
--
--   ✅ داخل الهامش = tie   ·   ✅ بدون سعر = unresolved
--   ✅ إغلاق = دخول = tie   ·   ✅ الدالة بتخزّن ومبتحسبش
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_entry  double precision := 1.09700;
  v_inside double precision;
  v_tie_id bigint;
  v_nul_id bigint;
  v_eq_id  bigint;
  v_raw_id bigint;
  v_tie    text;
  v_nul    text;
  v_eq     text;
  v_raw    text;
BEGIN
  -- نص الهامش فوق سعر الدخول: مش مساوي للدخول، وجوّه هامش المحرك
  -- (|إغلاق − دخول| ≤ |دخول| × 0.000005). التعريف القديم كان هيسجّلها WIN.
  v_inside := v_entry + (v_entry * 0.000005) / 2;

  INSERT INTO public.signals
    (symbol, timeframe, direction, bar_time, slot, entry_price, expiry_seconds, outcome)
  VALUES ('__VERIFY_TIE__', '1m', 'CALL', now(), 'instant_free', v_entry, 60, 'pending')
  RETURNING id INTO v_tie_id;

  INSERT INTO public.signals
    (symbol, timeframe, direction, bar_time, slot, entry_price, expiry_seconds, outcome)
  VALUES ('__VERIFY_NULL__', '1m', 'PUT', now(), 'instant_free', v_entry, 60, 'pending')
  RETURNING id INTO v_nul_id;

  -- إغلاق = دخول بالظبط. المحرك بيقول tie، والدالة لازم تخزّنه زي ما هو.
  INSERT INTO public.signals
    (symbol, timeframe, direction, bar_time, slot, entry_price, expiry_seconds, outcome)
  VALUES ('__VERIFY_EQ__', '1m', 'CALL', now(), 'instant_free', v_entry, 60, 'pending')
  RETURNING id INTO v_eq_id;

  -- والاختبار المعكوس، وهو الأهم: نفس السعرين بالظبط، بس المحرك باعت `win`.
  -- لو الدالة رجّعت tie هنا يبقى هي **لسه بتحسب** — وده بالظبط العطل
  -- اللي الترحيل قفله. النتيجة الصح إنها تخزّن اللي اتبعتلها.
  INSERT INTO public.signals
    (symbol, timeframe, direction, bar_time, slot, entry_price, expiry_seconds, outcome)
  VALUES ('__VERIFY_RAW__', '1m', 'CALL', now(), 'instant_free', v_entry, 60, 'pending')
  RETURNING id INTO v_raw_id;

  PERFORM public.resolve_signals(jsonb_build_array(
    jsonb_build_object('id', v_tie_id, 'price', v_inside, 'outcome', 'tie'),
    jsonb_build_object('id', v_nul_id, 'price', NULL,     'outcome', NULL),
    jsonb_build_object('id', v_eq_id,  'price', v_entry,  'outcome', 'tie'),
    jsonb_build_object('id', v_raw_id, 'price', v_entry,  'outcome', 'win')
  ));

  SELECT outcome INTO v_tie FROM public.signals WHERE id = v_tie_id;
  SELECT outcome INTO v_nul FROM public.signals WHERE id = v_nul_id;
  SELECT outcome INTO v_eq  FROM public.signals WHERE id = v_eq_id;
  SELECT outcome INTO v_raw FROM public.signals WHERE id = v_raw_id;

  RAISE EXCEPTION E'

%
%
%
%

(الخطأ ده مقصود — هو اللي بيلغي الصفوف التجريبية)',
    CASE WHEN v_tie = 'tie'
      THEN '✅ ٢. إغلاق جوه الهامش اتسجّل tie · الفرق ' || (v_inside - v_entry)
      ELSE '❌ ٢. اتسجّل ' || coalesce(v_tie, 'NULL') || ' بدل tie' END,
    CASE WHEN v_nul = 'unresolved'
      THEN '✅ ٣. سعر مفقود اتسجّل unresolved مش tie'
      ELSE '❌ ٣. اتسجّل ' || coalesce(v_nul, 'NULL') || ' بدل unresolved' END,
    CASE WHEN v_eq = 'tie'
      THEN '✅ ٤. إغلاق = دخول بالظبط اتسجّل tie'
      ELSE '❌ ٤. اتسجّل ' || coalesce(v_eq, 'NULL') || ' بدل tie' END,
    CASE WHEN v_raw = 'win'
      THEN '✅ ٥. الدالة بتخزّن قرار المحرك ومبتحسبش — نفس السعرين اتسجّلوا win'
      ELSE '❌ ٥. اتسجّل ' || coalesce(v_raw, 'NULL') || ' بدل win — الدالة لسه بتحسب' END;
END $$;
