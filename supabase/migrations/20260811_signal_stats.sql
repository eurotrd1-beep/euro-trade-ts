-- ════════════════════════════════════════════════════════════════════════════
-- إحصائيات الإشارات — نسخ الاستراتيجيات + الإشارات + التجميع + الحراسة
--
-- المشكلة اللي الملف ده بيحلها: الاستراتيجية بتتغيّر لما نرفع نسخة تحت نفس
-- الاسم. لو الإحصائيات مربوطة بالاسم، إشارات النسخة القديمة بتتحسب على
-- الجديدة ومحدش بيلاحظ. الحل إن كل إشارة تمسك مفتاح نسخة **ثابتة لا تتغيّر**،
-- مش reference لصف بيتكتب فوقه.
--
-- شغّله مرة واحدة في Supabase → SQL Editor. آمن للإعادة (كله IF NOT EXISTS
-- أو CREATE OR REPLACE) ما عدا الجداول نفسها.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. نسخ الاستراتيجيات ───────────────────────────────────────────────────
--
-- جدول append-only. الصف اللي اتكتب مبيتغيّرش تاني إلا في خانة is_active،
-- وده مفروض بـ trigger مش بالاتفاق.

CREATE TABLE IF NOT EXISTS public.strategy_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot            text NOT NULL CHECK (slot IN
                    ('instant_free', 'instant_paid', 'monitoring_free', 'monitoring_paid')),
  version_number  integer NOT NULL,
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  uploaded_by     text,
  name            text NOT NULL,

  -- النسخة كاملة كما رُفعت. jsonb بيخزّن المفاتيح مرتّبة، فـ ::text بتاعها
  -- شكل واحد مهما كان ترتيب الإدخال — وده اللي بيخلّي الهاش تحت مستقر.
  strategy_json   jsonb NOT NULL,
  json_hash       text NOT NULL,

  is_active       boolean NOT NULL DEFAULT false,

  UNIQUE (slot, version_number)
);

-- نسخة نشطة واحدة لكل slot — مفروضة بفهرس جزئي، مش بمنطق في التطبيق.
CREATE UNIQUE INDEX IF NOT EXISTS strategy_versions_one_active
  ON public.strategy_versions (slot) WHERE is_active;

CREATE INDEX IF NOT EXISTS strategy_versions_slot_uploaded
  ON public.strategy_versions (slot, uploaded_at DESC);

-- "مفيش UPDATE ولا DELETE" لازم يبقى قيد، مش قاعدة مكتوبة في ملف.
CREATE OR REPLACE FUNCTION public.strategy_versions_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'strategy_versions سجل دائم — الحذف ممنوع';
  END IF;
  -- خانة is_active هي الوحيدة اللي بتتحرك، والنشر بيحرّكها.
  IF ROW(NEW.id, NEW.slot, NEW.version_number, NEW.uploaded_at, NEW.uploaded_by,
         NEW.name, NEW.strategy_json, NEW.json_hash)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.slot, OLD.version_number, OLD.uploaded_at, OLD.uploaded_by,
         OLD.name, OLD.strategy_json, OLD.json_hash)
  THEN
    RAISE EXCEPTION 'strategy_versions سجل دائم — تعديل is_active فقط مسموح';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS strategy_versions_no_edit ON public.strategy_versions;
CREATE TRIGGER strategy_versions_no_edit
  BEFORE UPDATE OR DELETE ON public.strategy_versions
  FOR EACH ROW EXECUTE FUNCTION public.strategy_versions_immutable();


-- ── 2. الإشارات ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.signals (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at          timestamptz NOT NULL DEFAULT now(),

  symbol              text NOT NULL,
  timeframe           text NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('CALL', 'PUT')),

  -- وقت إغلاق الشمعة اللي اتولدت عليها الإشارة. مش تجميلي: هو اللي بيمنع
  -- التكرار لما البروكسي يعيد التشغيل ويعيد تقييم نفس الشمعة.
  bar_time            timestamptz NOT NULL,

  -- NULL معناها "نسخة غير معروفة" ولا حاجة تانية. المولّد عمره ما بيكتب NULL:
  -- لو مفيش نسخة نشطة للـ slot، مفيش إشارة أصلاً.
  strategy_version_id uuid REFERENCES public.strategy_versions(id) ON DELETE RESTRICT,
  -- منسوخ وقت الإنشاء عن قصد. الفلترة بالـ slot بتحصل في كل استعلام،
  -- و JOIN على كل صف عشان خانة مبتتغيّرش هدر.
  slot                text NOT NULL,

  confidence          real,
  score               real,

  -- [{"i":"rsi","r":"confirm","v":34.2,"ok":true}, …]
  rules_matched       jsonb,

  -- آخر 5 شموع كأرقام خام: [o,h,l,c,t] × 5 = 25 رقم.
  -- double precision مش real: الوقت 1.78e9 مش بيتخزّن بالظبط في float32،
  -- وأسعار الين (150.12345) على حافة دقّته. ~224 بايت مقابل ~300 لو JSONB.
  candle_snapshot     double precision[],

  entry_price         double precision NOT NULL,
  expiry_seconds      integer NOT NULL,

  -- unresolved ≠ tie. "السعر مش متاح" مينفعش يتقيّد تعادل — ده بيضخّم
  -- التعادلات ومحدش يعرف ليه. الاتنين مستبعدين من نسبة النجاح.
  outcome             text NOT NULL DEFAULT 'pending'
                      CHECK (outcome IN ('pending', 'win', 'loss', 'tie', 'unresolved')),
  outcome_price       double precision,
  outcome_at          timestamptz,

  -- إشارة guaranteed_win المفروضة من الأدمن. مستبعدة من كل حسبة، ومعروضة
  -- في خانة لوحدها — لو اتسجّلت من غير علامة، النسبة كلها مزوّرة.
  forced              boolean NOT NULL DEFAULT false,

  -- نفس النسخة + نفس الزوج + نفس الشمعة = إشارة واحدة، مهما اتنفّذ التقييم
  -- كام مرة. ده اللي بيخلّي إعادة تشغيل البروكسي آمنة.
  UNIQUE (strategy_version_id, symbol, timeframe, bar_time)
);

CREATE INDEX IF NOT EXISTS signals_created      ON public.signals (created_at DESC);
CREATE INDEX IF NOT EXISTS signals_version_time ON public.signals (strategy_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS signals_slot_time    ON public.signals (slot, created_at DESC);
-- فهرس جزئي صغير: اللي بيقفل النتايج بيدوّر على المعلّق بس.
CREATE INDEX IF NOT EXISTS signals_pending      ON public.signals (created_at)
  WHERE outcome = 'pending';


-- ── 3. التجميع اليومي — هو اللي بتقراه الصفحة ─────────────────────────────
--
-- الصفوف الخام بتتمسح بعد 30 يوم. الجدول ده بيفضل للأبد، وهو اللي بيخلّي
-- "النسخة اللي رفعتها يوم كذا حققت 58% على 340 إشارة" جملة ممكنة بعد سنة.
-- 183 زوج × 4 slots × 365 يوم ≈ 24 ميجا في السنة.

CREATE TABLE IF NOT EXISTS public.signal_daily (
  day                 date NOT NULL,
  strategy_version_id uuid NOT NULL REFERENCES public.strategy_versions(id) ON DELETE RESTRICT,
  symbol              text NOT NULL,
  timeframe           text NOT NULL,
  slot                text NOT NULL,

  signals             integer NOT NULL DEFAULT 0,
  wins                integer NOT NULL DEFAULT 0,
  losses              integer NOT NULL DEFAULT 0,
  ties                integer NOT NULL DEFAULT 0,
  unresolved          integer NOT NULL DEFAULT 0,
  pending             integer NOT NULL DEFAULT 0,
  forced              integer NOT NULL DEFAULT 0,

  PRIMARY KEY (day, strategy_version_id, symbol, timeframe)
);

CREATE INDEX IF NOT EXISTS signal_daily_version ON public.signal_daily (strategy_version_id, day);
CREATE INDEX IF NOT EXISTS signal_daily_day     ON public.signal_daily (day);


-- ── 4. ميزانية الكتابة اليومية ─────────────────────────────────────────────
--
-- الحارس الحقيقي. لو اتحط في البروكسي بس، أول باج في المولّد بيعدّي من فوقه.
-- الفحص بيحصل في دالة الإدخال المجمّعة — نداء واحد كل دقيقة، مش صف صف.

CREATE TABLE IF NOT EXISTS public.signal_write_budget (
  day      date PRIMARY KEY,
  written  integer NOT NULL DEFAULT 0,
  capped   boolean NOT NULL DEFAULT false,
  -- المتوقّع 703/يوم على 15د × 183 زوج. السقف ×7 من ده.
  max_rows integer NOT NULL DEFAULT 5000
);

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- الدوال
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── نشر نسخة ───────────────────────────────────────────────────────────────
--
-- الجدولين في معاملة واحدة. التطبيق بيقرا `configs`، والإحصائيات بتقرا
-- `strategy_versions` — لو الاتنين اتكتبوا في نداءين، أول فشل في النص
-- بيخلّيهم يقولوا حاجتين مختلفين والفرق ده مش هيبان.

CREATE OR REPLACE FUNCTION public.publish_strategy_version(
  p_slot text,
  p_name text,
  p_json jsonb,
  p_by   text DEFAULT NULL
) RETURNS TABLE (version_id uuid, version_number integer, created boolean, message text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hash    text;
  v_last    public.strategy_versions%ROWTYPE;
  v_next    integer;
  v_id      uuid;
  v_config  text;
BEGIN
  IF p_slot NOT IN ('instant_free','instant_paid','monitoring_free','monitoring_paid') THEN
    RAISE EXCEPTION 'slot غير معروف: %', p_slot;
  END IF;
  IF p_json IS NULL OR jsonb_typeof(p_json->'rules') <> 'array' THEN
    RAISE EXCEPTION 'الاستراتيجية لازم يكون فيها مصفوفة rules';
  END IF;

  -- أسماء الـ slots الجديدة مش نفس صفوف configs القديمة. التحويل مكتوب
  -- صريح هنا بدل ما يتفترض في مكانين.
  v_config := CASE p_slot
    WHEN 'instant_free'     THEN 'strategy_standard'
    WHEN 'instant_paid'     THEN 'strategy_vip'
    WHEN 'monitoring_free'  THEN 'monitoring_standard'
    WHEN 'monitoring_paid'  THEN 'monitoring_vip'
  END;

  -- jsonb بيرتّب المفاتيح، فالهاش بيتغيّر مع المحتوى بس — مش مع ترتيب الكتابة.
  -- md5 هنا بيجاوب على "نفس المحتوى؟" مش بيقاوم تزوير.
  v_hash := md5(p_json::text);

  -- الأعمدة مؤهَّلة بالجدول عن قصد: `version_number` كمان اسم مخرَج من الدالة
  -- (RETURNS TABLE)، فـ plpgsql بيشوفه متغيّر واسم عمود في نفس الوقت ويرفض
  -- الاستعلام بـ "column reference is ambiguous" وقت التنفيذ مش وقت الإنشاء.
  SELECT * INTO v_last FROM public.strategy_versions sv
   WHERE sv.slot = p_slot ORDER BY sv.version_number DESC LIMIT 1;

  IF v_last.id IS NOT NULL AND v_last.json_hash = v_hash THEN
    RETURN QUERY SELECT v_last.id, v_last.version_number, false,
      format('نفس محتوى النسخة %s بالظبط — مفيش نسخة جديدة', v_last.version_number);
    RETURN;
  END IF;

  v_next := COALESCE(v_last.version_number, 0) + 1;

  UPDATE public.strategy_versions SET is_active = false
   WHERE slot = p_slot AND is_active;

  INSERT INTO public.strategy_versions
    (slot, version_number, uploaded_by, name, strategy_json, json_hash, is_active)
  VALUES (p_slot, v_next, p_by, p_name, p_json, v_hash, true)
  RETURNING id INTO v_id;

  -- مسار قراءة التطبيق. نفس المعاملة.
  INSERT INTO public.configs (id, data) VALUES (v_config, p_json)
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data;

  RETURN QUERY SELECT v_id, v_next, true, format('اتنشرت النسخة %s', v_next);
END $$;


-- ── تسجيل دفعة إشارات ─────────────────────────────────────────────────────
--
-- نداء واحد كل دقيقة من البروكسي. بيرجّع عدد اللي اتكتب — والفرق بينه وبين
-- حجم الدفعة هو المكرر اللي الـ UNIQUE منعه، وده رقم يستاهل التسجيل.

-- `ids` بترجع مفاتيح الصفوف اللي اتكتبت فعلاً مع لحظة انتهائها. من غيرها
-- المولّد كان هيحتاج يقرا من Supabase كل دقيقة عشان يعرف إيه اللي مستنّي
-- نتيجة — ودي القراءة اللي المفروض متحصلش.
CREATE OR REPLACE FUNCTION public.record_signals(p_rows jsonb)
RETURNS TABLE (inserted integer, skipped integer, capped boolean, remaining integer, ids jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n     integer := COALESCE(jsonb_array_length(p_rows), 0);
  v_day   date := (now() AT TIME ZONE 'utc')::date;
  v_b     public.signal_write_budget%ROWTYPE;
  v_ids   jsonb;
  v_ins   integer := 0;
BEGIN
  IF v_n = 0 THEN
    RETURN QUERY SELECT 0, 0, false, 0, '[]'::jsonb;
    RETURN;
  END IF;

  INSERT INTO public.signal_write_budget (day) VALUES (v_day) ON CONFLICT (day) DO NOTHING;
  SELECT * INTO v_b FROM public.signal_write_budget WHERE day = v_day FOR UPDATE;

  IF v_b.written + v_n > v_b.max_rows THEN
    UPDATE public.signal_write_budget SET capped = true WHERE day = v_day;
    -- بترفض الدفعة كاملة عن قصد: نص دفعة مكتوب أسوأ من دفعة مرفوضة، لأنه
    -- بيسيب فجوة محدش يعرف حجمها.
    RETURN QUERY SELECT 0, v_n, true, GREATEST(0, v_b.max_rows - v_b.written), '[]'::jsonb;
    RETURN;
  END IF;

  WITH incoming AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS x(
      symbol text, timeframe text, direction text, bar_time timestamptz,
      strategy_version_id uuid, slot text, confidence real, score real,
      rules_matched jsonb, candle_snapshot double precision[],
      entry_price double precision, expiry_seconds integer, forced boolean
    )
  ), done AS (
    INSERT INTO public.signals
      (symbol, timeframe, direction, bar_time, strategy_version_id, slot,
       confidence, score, rules_matched, candle_snapshot, entry_price,
       expiry_seconds, forced)
    SELECT symbol, timeframe, direction, bar_time, strategy_version_id, slot,
           confidence, score, rules_matched, candle_snapshot, entry_price,
           expiry_seconds, COALESCE(forced, false)
      FROM incoming
    ON CONFLICT (strategy_version_id, symbol, timeframe, bar_time) DO NOTHING
    RETURNING id, symbol, entry_price, expiry_seconds, created_at
  )
  SELECT count(*)::int,
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', d.id, 'symbol', d.symbol, 'entry_price', d.entry_price,
           'expires_at', d.created_at + make_interval(secs => d.expiry_seconds))), '[]'::jsonb)
    INTO v_ins, v_ids
    FROM done d;

  UPDATE public.signal_write_budget SET written = written + v_ins WHERE day = v_day;
  RETURN QUERY SELECT v_ins, v_n - v_ins, false, v_b.max_rows - v_b.written - v_ins, v_ids;
END $$;

/**
 * الإشارات اللي لسه مستنّية نتيجة — تُقرأ مرة واحدة عند إقلاع البروكسي.
 *
 * المولّد بيمسك المعلّق في الذاكرة، فمحتاجش يسأل قاعدة البيانات في الوضع
 * العادي. اللي بيكسر ده هو إعادة التشغيل: الصفوف اللي كانت مستنّية بتفضل
 * pending للأبد لو محدش فكّر البروكسي بيها. نداء واحد لكل إقلاع، مش كل دقيقة.
 */
CREATE OR REPLACE FUNCTION public.pending_signals()
RETURNS TABLE (id bigint, symbol text, entry_price double precision, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.symbol, s.entry_price,
         s.created_at + make_interval(secs => s.expiry_seconds)
    FROM public.signals s
   WHERE s.outcome = 'pending'
   ORDER BY s.created_at
   LIMIT 5000;
$$;


-- ── قفل النتايج ────────────────────────────────────────────────────────────
--
-- السعر جاي من البروكسي. مفيش تقدير هنا ولا في أي مكان: لو المولّد بعت
-- NULL، الصف بيتقفل unresolved ويخرج من كل حسبة نسبة.

CREATE OR REPLACE FUNCTION public.resolve_signals(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  WITH incoming AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS x(id bigint, price double precision)
  ), done AS (
    UPDATE public.signals s SET
      outcome_price = i.price,
      outcome_at    = now(),
      outcome = CASE
        WHEN i.price IS NULL THEN 'unresolved'
        WHEN i.price = s.entry_price THEN 'tie'
        WHEN s.direction = 'CALL' THEN CASE WHEN i.price > s.entry_price THEN 'win' ELSE 'loss' END
        ELSE CASE WHEN i.price < s.entry_price THEN 'win' ELSE 'loss' END
      END
    FROM incoming i
    WHERE s.id = i.id AND s.outcome = 'pending'
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM done;
  RETURN v_n;
END $$;


-- ── التجميع والتقليم ───────────────────────────────────────────────────────
--
-- التجميع بيتعاد للنطاق كله في كل مرة (idempotent)، عشان تعديل نتيجة متأخرة
-- يتصحّح لوحده. الصفحة بتقرا من signal_daily دايمًا — حتى النهاردة.

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
     WHERE strategy_version_id IS NOT NULL
       AND (created_at AT TIME ZONE 'utc')::date BETWEEN p_from AND p_to
     GROUP BY 1,2,3,4,5
  ), done AS (
    INSERT INTO public.signal_daily AS d
      (day, strategy_version_id, symbol, timeframe, slot,
       signals, wins, losses, ties, unresolved, pending, forced)
    SELECT * FROM agg
    ON CONFLICT (day, strategy_version_id, symbol, timeframe) DO UPDATE SET
      slot=EXCLUDED.slot,
      signals=EXCLUDED.signals, wins=EXCLUDED.wins, losses=EXCLUDED.losses,
      ties=EXCLUDED.ties, unresolved=EXCLUDED.unresolved,
      pending=EXCLUDED.pending, forced=EXCLUDED.forced
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM done;
  RETURN v_n;
END $$;

-- بيمسح الخام بس بعد ما يتأكد إن اليوم اتجمّع، ومش بيمسح حاجة لسه معلّقة.
CREATE OR REPLACE FUNCTION public.prune_signals(p_keep_days integer DEFAULT 30)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cut date := ((now() AT TIME ZONE 'utc')::date - p_keep_days);
  v_n   integer;
BEGIN
  PERFORM public.refresh_signal_daily(v_cut - 7, v_cut);
  WITH done AS (
    DELETE FROM public.signals
     WHERE (created_at AT TIME ZONE 'utc')::date <= v_cut
       AND outcome <> 'pending'
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM done;
  RETURN v_n;
END $$;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- ما تقراه الصفحة، والصلاحيات
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- صف واحد لكل نسخة بدل 21 ألف صف خام في الشهر. ده الفرق بين استعلام
-- بكيلوبايتات واستعلام بـ 19 ميجا في كل فتحة.
CREATE OR REPLACE VIEW public.strategy_version_stats AS
SELECT v.id, v.slot, v.version_number, v.name, v.uploaded_at, v.uploaded_by,
       v.is_active, v.json_hash,
       COALESCE(sum(d.signals), 0)::int    AS signals,
       COALESCE(sum(d.wins), 0)::int       AS wins,
       COALESCE(sum(d.losses), 0)::int     AS losses,
       COALESCE(sum(d.ties), 0)::int       AS ties,
       COALESCE(sum(d.unresolved), 0)::int AS unresolved,
       COALESCE(sum(d.pending), 0)::int    AS pending,
       COALESCE(sum(d.forced), 0)::int     AS forced,
       -- النسبة NULL تحت 30 صفقة محسومة. لا تُحسب ثم تُخفى في الواجهة —
       -- الرقم اللي بيتحسب بيتسرّب لحد ما حد يشوفه.
       CASE WHEN COALESCE(sum(d.wins + d.losses), 0) >= 30
            THEN round(100.0 * sum(d.wins) / NULLIF(sum(d.wins + d.losses), 0), 2)
       END AS win_rate
  FROM public.strategy_versions v
  LEFT JOIN public.signal_daily d ON d.strategy_version_id = v.id
 GROUP BY v.id;

/**
 * إحصائيات فترة، مجمّعة في Postgres.
 *
 * الصفحة بتنادي دي بدل ما تسحب الصفوف الخام. `p_group_by` بيحدد التقسيم:
 * 'total' صف واحد · 'day' · 'symbol' · 'slot' · 'version' · 'hour'.
 * أوسع رد ممكن ~183 صف، مقابل 21 ألف صف لو الصفحة جمّعت بنفسها.
 */
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
  -- كل عمود مؤهَّل بمصدره: أسماء المخرَجات (signals, wins, …) متغيّرات في
  -- plpgsql وأسماء أعمدة في نفس الوقت، وأي إشارة غير مؤهَّلة بتفشل وقت
  -- التنفيذ. و`src` مش `rows` لأن ROWS كلمة محجوزة جزئيًا.
  RETURN QUERY
  WITH src AS (
    SELECT d.day, d.symbol, d.slot, d.strategy_version_id,
           d.signals AS n_signals, d.wins AS n_wins, d.losses AS n_losses,
           d.ties AS n_ties, d.unresolved AS n_unresolved,
           d.pending AS n_pending, d.forced AS n_forced
      FROM public.signal_daily d
      JOIN public.strategy_versions v ON v.id = d.strategy_version_id
     WHERE d.day BETWEEN p_from AND p_to
       AND (p_slot    IS NULL OR d.slot = p_slot)
       AND (p_version IS NULL OR d.strategy_version_id = p_version)
       AND (p_symbol  IS NULL OR d.symbol = p_symbol)
  ), grouped AS (
    SELECT CASE p_group_by
             WHEN 'day'     THEN r.day::text
             WHEN 'symbol'  THEN r.symbol
             WHEN 'slot'    THEN r.slot
             WHEN 'version' THEN r.strategy_version_id::text
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
         -- النسبة NULL تحت 30 صفقة محسومة. لا تُحسب ثم تُخفى في الواجهة.
         CASE WHEN g.g_wins + g.g_losses >= 30
              THEN round(100.0 * g.g_wins / NULLIF(g.g_wins + g.g_losses, 0), 2)
         END
    FROM grouped g ORDER BY g.bucket;
END $$;


-- ── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.strategy_versions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signals             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_daily        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signal_write_budget ENABLE ROW LEVEL SECURITY;

-- قراءة فقط. مفيش سياسة INSERT/UPDATE/DELETE خالص — يعني anon مالوش
-- طريق للكتابة أصلاً. service_role بيتخطى RLS، فالبروكسي بيكتب عادي.
DROP POLICY IF EXISTS "read" ON public.strategy_versions;
DROP POLICY IF EXISTS "read" ON public.signals;
DROP POLICY IF EXISTS "read" ON public.signal_daily;
DROP POLICY IF EXISTS "read" ON public.signal_write_budget;
CREATE POLICY "read" ON public.strategy_versions   FOR SELECT USING (true);
CREATE POLICY "read" ON public.signals             FOR SELECT USING (true);
CREATE POLICY "read" ON public.signal_daily        FOR SELECT USING (true);
CREATE POLICY "read" ON public.signal_write_budget FOR SELECT USING (true);

REVOKE INSERT, UPDATE, DELETE ON
  public.strategy_versions, public.signals,
  public.signal_daily, public.signal_write_budget FROM anon, authenticated;

-- الأدمن بيشتغل بالمفتاح العام من المتصفح، فالنشر لازم يعدّي من anon.
-- الدالة هي الطريق الوحيد، وهي بتعمل حاجة واحدة: تضيف نسخة. مفيش تعديل
-- ولا حذف ولا كتابة حرة — وده أضيق من الـ upsert المفتوح الموجود دلوقتي.
GRANT EXECUTE ON FUNCTION public.publish_strategy_version(text, text, jsonb, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signal_stats(date, date, text, text, uuid, text) TO anon, authenticated;

-- دي للبروكسي بمفتاح الخدمة بس.
REVOKE EXECUTE ON FUNCTION public.record_signals(jsonb)            FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pending_signals()                FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_signals(jsonb)           FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_signal_daily(date, date) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prune_signals(integer)           FROM anon, authenticated;

COMMIT;


-- ── اختياري: جدولة داخل Postgres بدل البروكسي ─────────────────────────────
--
-- البروكسي بينادي refresh_signal_daily و prune_signals بنفسه (signal-generator.js)
-- فده مش لازم. لو فضّلت الجدولة تبقى في قاعدة البيانات ومستقلة عن البروكسي،
-- فكّ التعليق — pg_cron متاحة على خطة Pro.
--
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('signal-rollup', '*/10 * * * *',
--   $$SELECT public.refresh_signal_daily((now() at time zone 'utc')::date - 2,
--                                        (now() at time zone 'utc')::date)$$);
-- SELECT cron.schedule('signal-prune', '17 3 * * *',
--   $$SELECT public.prune_signals(30)$$);
