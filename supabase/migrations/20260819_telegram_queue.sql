-- ════════════════════════════════════════════════════════════════════════════
-- النشر اليدوي — الرسالة تستنّى قرار قبل ما تروح القناة
--
-- في الوضع التلقائي المولّد بيبعت على طول، زي ما هو دلوقتي. في الوضع اليدوي
-- بيكتب الرسالة هنا بدل ما يبعتها، وتظهر في الأدمن (صفحة «نشر تيليجرام»)،
-- والأدمن هو اللي بيقول انشر ولا تجاهل.
--
-- `telegram.mode` في `configs` هو اللي بيختار: auto | manual. غيابه معناه
-- **تلقائي** — مولّد لسه ماعرفش الحقل ده يفضل شغال زي ما كان، وحقل ناقص
-- مايوقفش حاجة كانت شغالة.
--
-- ── الطابور ده آخر بوابة، مش أولها ─────────────────────────────────────────
--
-- اللي بيوصل هنا هو بالظبط اللي كان هيتبعت تلقائي: حد العمق (`minDepthBps`)
-- وسويتش الملخص (`daily`) واختيار النوع (`publish`) كلهم بيتطبّقوا **قبل** ما
-- الصف يتكتب. اليدوي بيقلّل اللي بيتنشر، عمره ما بيزوّده. و«الإيقاف» في
-- `enabled` بيوقف كل حاجة — مفيش صفوف بتتكتب أصلًا.
--
-- ── مرة واحدة، حتى مع restart ──────────────────────────────────────────────
--
-- `event_key` هو نفس المفتاح بالظبط اللي في `telegram_alerts` (بنفس الشكل
-- `signal:{symbol}:{entryTime}:{stage}`)، وبنفس الحيلة: الإدخال إما بياخد الصف
-- أو بيقع على اللي موجود، والوقوع معناه «الحدث ده اتعرض على الأدمن خلاص» —
-- سواء لسه مستنّي، أو اتنشر، أو اترفض. يعني إعادة تشغيل في نص صفقة مابتعرضش
-- نفس الرسالة تاني، ومفيش SELECT-ثم-INSERT يخلّي تكّتين في نفس اللحظة يعملوا
-- صفّين.
--
-- و`telegram_alerts` بيفضل هو ضمانة «مرة واحدة» وقت الإرسال الفعلي. الطابور ده
-- سطح قرار، مش سجل إرسال.
--
-- ── العقد مع المولّد (الكود ده على Render، مش في الريبو ده) ────────────────
--
-- عند فتح صفقة / نتيجة / ملخص، وبعد ما كل الفلاتر القديمة تعدّي:
--
--   mode = auto    → زي ما هو: احجز `telegram_alerts` وابعت.
--   mode = manual  → INSERT في `telegram_queue` بالمفتاح نفسه والنص المكتوب
--                    جاهز، status = 'pending'، و`expires_at` = آخر لحظة تنفع
--                    الرسالة تتبعت فيها (للإشارة: وقت انتهاء الصفقة. للنتيجة
--                    والملخص: NULL، النتيجة مبتبوظش بالوقت).
--                    ON CONFLICT DO NOTHING — الوقوع معناه اتعرض قبل كده.
--
-- وفي كل تكّة:
--
--   0. أي صف `pending` أو `approved` عدّى `expires_at` → علّمه 'rejected' من
--      غير ما تبعت. الإشارة اللي فات وقتها مش رأي متأخر، هي غلط — والصف اللي
--      محدش رد عليه لازم يتقفل لوحده، مايفضلش مستنّي للأبد.
--   1. احجز `telegram_alerts` بنفس `event_key` (INSERT) لكل صف 'approved' لسه
--      في وقته. لو وقع → الرسالة اتبعتت خلاص من تكّة تانية؛ علّم الصف 'sent'
--      وكمّل.
--   2. ابعت. نجح → UPDATE status = 'sent'.
--      فشل → امسح حجز الـalert وسيب الصف 'approved' عشان التكّة الجاية تعيد
--      المحاولة. (نفس سلوك الوضع التلقائي: البعت الفاشل بيرجّع الحجز.)
--
-- صف الأهلية `elig:` بيتكتب وقت الفتح زي ما هو، في الوضعين. هو بيقول إن
-- الصفقة عدّت حد النشر، مش إن رسالتها اتبعتت — والرفض اليدوي مايغيّرش ده.
--
-- ولو الأدمن رفض **افتتاح** صفقة، الأنضف إن المولّد ما يعرضش نتيجتها: قبل ما
-- تكتب صف `result:{...}`، بصّ لو فيه `signal:{...}` بنفس اللاحقة و status =
-- 'rejected' وسيبها. ده قرار بني آدم قديم مش سباق، فالقراءة قبل الكتابة هنا
-- مش مشكلة. ولو المولّد ماعملش كده، الصفحة في الأدمن بتعلّم النتيجة دي
-- بتحذير إن افتتاحها اترفض، فالقرار بيفضل ظاهر لواحد شايفه.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.telegram_queue (
  -- نفس مفتاح `telegram_alerts` بالحرف.
  event_key  text        PRIMARY KEY,
  -- `eligible` مش هنا: ده صف دفاتر مش رسالة، ومحدش بيوافق عليه.
  kind       text        NOT NULL CHECK (kind IN ('signal', 'result', 'daily')),
  symbol     text,
  -- عمق الإشارة (‹A11›) وقت الفتح — عشان الأدمن يرتّب قراره على نفس الرقم
  -- اللي الحد بيترسم بيه، مش على تقدير تاني.
  depth_bps  numeric,
  -- نص الرسالة كاملًا زي ما هيتبعت. المولّد بيكتبه، والأدمن بيقراه قبل ما
  -- يوافق: الموافقة على حاجة مش مكتوبة قدامك مش موافقة.
  body       text        NOT NULL,
  status     text        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'approved', 'sent', 'rejected')),
  -- آخر لحظة تنفع الرسالة تتبعت فيها. NULL = مالهاش تاريخ صلاحية.
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- بيتحطّ من التريجر تحت، مش من المتصفح: ساعة الجهاز مش مرجع.
  decided_at timestamptz
);

COMMENT ON TABLE public.telegram_queue IS
  'رسايل تيليجرام مستنية قرار الأدمن في الوضع اليدوي. المفتاح الأساسي هو منع التكرار.';

-- الاستعلام الوحيد اللي بيتكرر: المستنّي، الأقدم الأول — اللي بقاله أكتر هو
-- اللي وقته بيخلص الأول.
CREATE INDEX IF NOT EXISTS telegram_queue_pending
  ON public.telegram_queue (created_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS telegram_queue_created_at
  ON public.telegram_queue (created_at);

-- ── وقت القرار ─────────────────────────────────────────────────────────────
--
-- المتصفح بيكتب `status` بس. الوقت بيتختم هنا عشان مايبقاش رهن ساعة الجهاز
-- اللي ضغط الزرار — والفرق ده بيبان لما تبص على صف وتسأل «ده اتنشر امتى».
CREATE OR REPLACE FUNCTION public.telegram_queue_stamp()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.decided_at := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS telegram_queue_stamp ON public.telegram_queue;
CREATE TRIGGER telegram_queue_stamp
  BEFORE UPDATE ON public.telegram_queue
  FOR EACH ROW EXECUTE FUNCTION public.telegram_queue_stamp();

-- التنظيف: الطابور سطح قرار مش أرشيف. اللي اتقرر خلاص بيفضل أسبوع عشان تقدر
-- تبص ورا، وبعدين بيروح. `telegram_alerts` هو اللي بيفضل مسؤول عن «اتبعت».
CREATE OR REPLACE FUNCTION public.prune_telegram_queue()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  WITH gone AS (
    DELETE FROM public.telegram_queue WHERE created_at < now() - interval '7 days' RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM gone;
  RETURN v_n;
END $$;

-- ── الصلاحيات ──────────────────────────────────────────────────────────────
--
-- ده الجدول الوحيد في منظومة تيليجرام اللي المتصفح بيلمسه، لأنه لازم: الأدمن
-- بيشتغل بمفتاح anon زي التطبيق (docs/security.md)، وبدون كده الصفحة
-- مش هتشوف حاجة.
--
-- فالوصول متقطّع لأصغر حاجة تخلّي الصفحة تشتغل:
--   • قراءة — عشان تعرض المستنّي.
--   • UPDATE على عمود `status` **بس**، ومن صف `pending` **بس**، ولقيمة
--     `approved` أو `rejected` **بس**. يعني محدش يقدر يرجّع رسالة اتبعتت
--     لـ pending عشان تتبعت تاني.
--   • مفيش INSERT خالص — الحاجة الوحيدة الخطيرة فعلًا هي كتابة نص جديد،
--     وده حق المولّد وحده. أسوأ حاجة ممكنة من بره هي الموافقة على رسالة
--     المولّد كتبها بنفسه، أو رفضها.
--   • مفيش DELETE — المسح بيخفي القرار.
ALTER TABLE public.telegram_queue ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.telegram_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.telegram_queue TO anon, authenticated;
GRANT UPDATE (status) ON public.telegram_queue TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_queue TO service_role;

DROP POLICY IF EXISTS "admin reads queue" ON public.telegram_queue;
CREATE POLICY "admin reads queue" ON public.telegram_queue
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "admin decides pending" ON public.telegram_queue;
CREATE POLICY "admin decides pending" ON public.telegram_queue
  FOR UPDATE
  USING (status = 'pending')
  WITH CHECK (status IN ('approved', 'rejected'));

REVOKE EXECUTE ON FUNCTION public.prune_telegram_queue() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_telegram_queue() TO service_role;

-- ── Realtime ───────────────────────────────────────────────────────────────
--
-- الصفحة بتفضل مفتوحة والرسايل بتيجي وهي مفتوحة. من غير النشر ده، الأدمن
-- مش هيعرف إن فيه حاجة مستنية غير لما يعمل refresh — وإشارة عمرها خمس دقايق
-- مش بتستنى refresh.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.telegram_queue;
EXCEPTION
  WHEN duplicate_object THEN NULL;      -- مضاف قبل كده
  WHEN undefined_object THEN NULL;      -- مفيش publication بالاسم ده هنا
  -- لو المستخدم اللي بيشغّل الترحيل مش مالك الـpublication: الترحيل بيكمّل،
  -- والصفحة بتشتغل — بس محتاجة refresh عشان تشوف الجديد. أضف الجدول من
  -- Database ← Replication في لوحة Supabase بعدين.
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'telegram_queue: مش متضاف لـ supabase_realtime — ضيفه يدوي';
END $$;

-- ── مفتاح الوضع ────────────────────────────────────────────────────────────
--
-- الصف موجود من ترحيل `telegram_alerts`؛ ده بيضيف المفتاح الناقص من غير ما
-- يلمس أي قيمة تانية. الافتراضي `auto` — الترحيل مايغيّرش سلوك شغّال.
UPDATE public.configs
   SET data = jsonb_set(data, '{mode}', '"auto"')
 WHERE id = 'telegram' AND NOT (data ? 'mode');

COMMIT;
