-- ════════════════════════════════════════════════════════════════════════════
-- إحصائيات بدون نسخة استراتيجية
--
-- طبقة الإحصائيات كلها اتكتبت وكل إشارة ليها `strategy_version_id`، لأن كل
-- إشارة ساعتها كانت جاية من ملف قواعد منشور. المحرك دلوقتي بيشغّل برنامج
-- مترجم جوّاه، والبرنامج مالوش نسخة منشورة — فالعمود بيتكتب NULL.
--
-- تلات حتت في السلسلة بتفترض العكس، والنتيجة إن صفحة الإحصائيات **مش شايفة
-- ولا إشارة** من الاستراتيجية الشغالة:
--
--   1. `signal_daily.strategy_version_id` معرّف NOT NULL وجوّه المفتاح الأساسي.
--   2. `refresh_signal_daily` فيها `WHERE strategy_version_id IS NOT NULL`.
--   3. `signal_stats` بتعمل JOIN على `strategy_versions`.
--
-- وقت كتابة ده: `signals` فيها 132 صف النهاردة، و`signal_stats` على النهاردة
-- بترجّع `[]`.
--
-- ── وعطلين اتكشفوا وإحنا بنصلّح ────────────────────────────────────────────
--
-- **الـslot مش في المفتاح.** المفتاح كان (يوم، نسخة، رمز، فريم) والتجميع
-- بيعمل GROUP BY على الخمسة بما فيهم الـslot، فأربع خانات بيتصادموا على مفتاح
-- واحد و`DO UPDATE SET slot=EXCLUDED.slot` بيخلي آخر واحد يكسح اللي قبله.
-- الجدول فيه 312 مفتاح، ولا واحد فيهم ليه أكتر من slot، وكلهم `instant_free`.
-- يعني تقسيمة الخانات مش ناقصة وخلاص — الأرقام الباقية بتاعة خانة واحدة
-- لابسة اسم خانة اتقرر بالصدفة.
--
-- **والتقليم بيمسح غير المجمَّع.** `prune_signals` بيندّه التجميع لأسبوع
-- وبعدين بيمسح كل صف أقدم من 30 يوم من غير ما يتأكد إن الصف اتجمّع فعلاً.
-- وبما إن صفوف الاستراتيجية الحالية مبتتجمّعش، كانت هتتمسح خلاص بعد 30 يوم
-- ومايفضلش منها ولا رقم. أقدم صف منها عمره يوم، فالفتيل لسه مولّعش.
--
-- الترحيل ده بيصلّح الأربعة، وبيعيد بناء `signal_daily` من الخام لأن اللي
-- فيه اتبنى بالقواعد الغلط.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. الجدول: النسخة تبقى اختيارية، والـslot يدخل المفتاح ─────────────────
--
-- المفتاح الأساسي في Postgres مبيقبلش NULL، فهو بيتشال ومكانه فهرس فريد على
-- تعبير بيحوّل الـNULL لصفر UUID. ده بيشتغل على أي إصدار، على عكس
-- `NULLS NOT DISTINCT` اللي محتاجة 15 فما فوق.
ALTER TABLE public.signal_daily DROP CONSTRAINT IF EXISTS signal_daily_pkey;
ALTER TABLE public.signal_daily ALTER COLUMN strategy_version_id DROP NOT NULL;

-- الصفوف اللي جوّه اتبنوا بمفتاح ناقص الـslot، فتلاتة من كل أربعة اتكتبوا فوق
-- بعض. مفيش حاجة تتنقذ منهم — بيتعاد بناؤهم من `signals` تحت.
DELETE FROM public.signal_daily;

CREATE UNIQUE INDEX IF NOT EXISTS signal_daily_key
  ON public.signal_daily (
    day,
    COALESCE(strategy_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
    symbol, timeframe, slot
  );

-- ── 2. التجميع: يقرا الاتنين، ويحترم الـslot ──────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_signal_daily(p_from date, p_to date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  WITH agg AS (
    SELECT (created_at AT TIME ZONE 'utc')::date AS day,
           strategy_version_id, symbol, timeframe, slot,
           count(*)::int AS signals,
           count(*) FILTER (WHERE outcome='win'        AND NOT forced)::int AS wins,
           count(*) FILTER (WHERE outcome='loss'       AND NOT forced)::int AS losses,
           count(*) FILTER (WHERE outcome='tie'        AND NOT forced)::int AS ties,
           count(*) FILTER (WHERE outcome='unresolved')::int                AS unresolved,
           count(*) FILTER (WHERE outcome='pending')::int                   AS pending,
           count(*) FILTER (WHERE forced)::int                              AS forced
      FROM public.signals
     -- كان هنا `AND strategy_version_id IS NOT NULL`. ده اللي كان بيخلي
     -- الاستراتيجية الشغالة مش موجودة في أي رقم على الشاشة.
     WHERE (created_at AT TIME ZONE 'utc')::date BETWEEN p_from AND p_to
     GROUP BY 1,2,3,4,5
  ), done AS (
    INSERT INTO public.signal_daily AS d
      (day, strategy_version_id, symbol, timeframe, slot,
       signals, wins, losses, ties, unresolved, pending, forced)
    SELECT * FROM agg
    ON CONFLICT (day,
                 COALESCE(strategy_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 symbol, timeframe, slot)
    DO UPDATE SET
      signals=EXCLUDED.signals, wins=EXCLUDED.wins, losses=EXCLUDED.losses,
      ties=EXCLUDED.ties, unresolved=EXCLUDED.unresolved,
      pending=EXCLUDED.pending, forced=EXCLUDED.forced
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM done;
  RETURN v_n;
END $$;

-- ── 3. القراءة: LEFT JOIN، وخانة باسم للي مالوش نسخة ──────────────────────
CREATE OR REPLACE FUNCTION public.signal_stats(
  p_from      date,
  p_to        date,
  p_group_by  text DEFAULT 'total',
  p_slot      text DEFAULT NULL,
  p_version   uuid DEFAULT NULL,
  p_symbol    text DEFAULT NULL
) RETURNS TABLE (
  bucket text, signals int, wins int, losses int, ties int,
  unresolved int, pending int, forced int, win_rate numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH src AS (
    SELECT d.day, d.symbol, d.slot, d.strategy_version_id,
           d.signals AS n_signals, d.wins AS n_wins, d.losses AS n_losses,
           d.ties AS n_ties, d.unresolved AS n_unresolved,
           d.pending AS n_pending, d.forced AS n_forced
      FROM public.signal_daily d
      -- LEFT، مش INNER. الـINNER كان بيرمي كل صف نسخته NULL — يعني كل صف
      -- من الاستراتيجية الشغالة.
      LEFT JOIN public.strategy_versions v ON v.id = d.strategy_version_id
     WHERE d.day BETWEEN p_from AND p_to
       AND (p_slot    IS NULL OR d.slot = p_slot)
       AND (p_version IS NULL OR d.strategy_version_id = p_version)
       AND (p_symbol  IS NULL OR d.symbol = p_symbol)
  ), grouped AS (
    SELECT CASE p_group_by
             WHEN 'day'     THEN r.day::text
             WHEN 'symbol'  THEN r.symbol
             WHEN 'slot'    THEN r.slot
             -- اسم بدل NULL: الخانة دي بتتقري في JSON، و`null` كمفتاح بيتلبس
             -- مع "مفيش نتيجة".
             WHEN 'version' THEN COALESCE(r.strategy_version_id::text, 'current')
             ELSE 'total'
           END AS bucket,
           sum(r.n_signals)::int    AS g_signals, sum(r.n_wins)::int   AS g_wins,
           sum(r.n_losses)::int     AS g_losses,  sum(r.n_ties)::int   AS g_ties,
           sum(r.n_unresolved)::int AS g_unresolved,
           sum(r.n_pending)::int    AS g_pending, sum(r.n_forced)::int AS g_forced
      FROM src r GROUP BY 1
  )
  SELECT g.bucket, g.g_signals, g.g_wins, g.g_losses, g.g_ties,
         g.g_unresolved, g.g_pending, g.g_forced,
         CASE WHEN g.g_wins + g.g_losses >= 30
              THEN round((g.g_wins::numeric / (g.g_wins + g.g_losses)) * 100, 1)
              ELSE NULL END
    FROM grouped g
   ORDER BY g.bucket;
END $$;

-- ── 4. التقليم: ميمسحش اللي لسه متجمّعش ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.prune_signals(p_keep_days integer DEFAULT 30)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cut date := ((now() AT TIME ZONE 'utc')::date - p_keep_days);
  v_n   integer;
BEGIN
  PERFORM public.refresh_signal_daily(v_cut - 7, v_cut);

  WITH done AS (
    DELETE FROM public.signals s
     WHERE (s.created_at AT TIME ZONE 'utc')::date <= v_cut
       AND s.outcome <> 'pending'
       -- الشرط ده جديد. من غيره الحذف بيثق إن التجميع نجح، وده اللي كان
       -- هيمسح تاريخ الاستراتيجية الحالية بالكامل: صفوفها مكانتش بتتجمّع
       -- خالص، فمكانش هيفضل منها لا خام ولا مجمَّع.
       AND EXISTS (
         SELECT 1 FROM public.signal_daily d
          WHERE d.day = (s.created_at AT TIME ZONE 'utc')::date
            AND d.symbol = s.symbol
            AND d.timeframe = s.timeframe
            AND d.slot = s.slot
            AND d.strategy_version_id IS NOT DISTINCT FROM s.strategy_version_id
       )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM done;
  RETURN v_n;
END $$;

-- ── 5. الصلاحيات ──
--
-- `CREATE OR REPLACE` بتحافظ على الصلاحيات، بس بتتكتب هنا صريحة عشان الحالة
-- تبقى مقروءة من الملف نفسه مش من تاريخ الترحيلات.
REVOKE ALL ON FUNCTION public.refresh_signal_daily(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_signals(integer)           FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_signal_daily(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_signals(integer)           TO service_role;
GRANT EXECUTE ON FUNCTION public.signal_stats(date, date, text, text, uuid, text)
  TO anon, authenticated, service_role;

COMMIT;


-- ============================================================================
-- إعادة البناء — شغّلها بعد الترحيل، جملة واحدة
--
-- خارج الـtransaction عن قصد: بتمشي على كل التاريخ وممكن تاخد وقت، ومفيش
-- سبب تقفل الجدول طول الوقت ده. آمنة تتكرر.
-- ============================================================================

SELECT public.refresh_signal_daily(
  (SELECT min((created_at AT TIME ZONE 'utc')::date) FROM public.signals),
  (SELECT max((created_at AT TIME ZONE 'utc')::date) FROM public.signals)
) AS rows_aggregated;
