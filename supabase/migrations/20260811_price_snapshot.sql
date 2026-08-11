-- ════════════════════════════════════════════════════════════════════════════
-- نقل otc_prices بره configs — وبره بث الـ Realtime
--
-- ── المشكلة، بالأرقام ──────────────────────────────────────────────────────
--
-- البروكسي بيكتب صف configs/otc_prices كل 20 ثانية، والصف حجمه 16.6 كيلوبايت.
-- والتطبيق مشترك في postgres_changes على جدول `configs` **كله من غير فلتر**،
-- فكل كتابة بتتبعت لكل مستخدم فاتح التطبيق:
--
--     3 رسايل/دقيقة × 16.6KB = 2.99 ميجا في الساعة  لكل مستخدم
--
-- والتطبيق **مش بيقرا الصف ده أصلاً**. الأسعار بتيجي من البروكسي
-- (/api/otc/status)، و watchConfig مسجّلة على 9 صفوف مش فيهم otc_prices —
-- فالرسالة بتوصل وتترمي. 100% هدر.
--
-- عند 100 مستخدم × 8 ساعات/يوم ده 4.32 مليون رسالة في الشهر من سقف 5 مليون
-- في خطة Pro. يعني السقف بيتكسر عند ~116 مستخدم، على داتا محدش بيقراها.
--
-- ── الحل ───────────────────────────────────────────────────────────────────
--
-- نفس الشكل بالظبط (صف واحد، JSONB فيه كل الرموز) بس في جدول **مش داخل نشر
-- الـ Realtime**. نمط الكتابة ما اتغيّرش — upsert واحد كل 20 ثانية — والفرق
-- إن مفيش حد بيتبلّغ بيه.
--
-- شغّله في Supabase → SQL Editor. الخطوة 3 (حذف الصف القديم) **متشغّلهاش
-- غير بعد ما البروكسي الجديد يبقى شغّال** — لحد ساعتها هو لسه بيقرا منه في
-- البداية الباردة.
-- ════════════════════════════════════════════════════════════════════════════

-- ── الخطوة 1: الجدول ───────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.price_snapshot (
  -- مفتاح ثابت 'otc_prices'. الجدول مصمّم لصف واحد، والعمود موجود عشان لو
  -- بقى فيه أكتر من مصدر أسعار بعدين ميحتاجش هجرة تانية.
  id         text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.price_snapshot IS
  'لقطة أسعار OTC — احتياطي البداية الباردة للبروكسي فقط. التطبيق بيقرا الأسعار من /api/otc/status مش من هنا. ممنوع ضم الجدول ده لنشر supabase_realtime: بيتكتب كل 20 ثانية بـ 16.6KB، وضمّه بيرجّع نفس مشكلة الـ Egress اللي اتعملت الهجرة دي عشانها.';

-- الجداول الجديدة مش بتتضاف لنشر الـ Realtime تلقائيًا، بس الاعتماد على ده
-- ضمنيًا هو بالظبط اللي بيخلّي حد يضيفه من الداشبورد بعد سنة وميعرفش ليه
-- الفاتورة طلعت. الشيل هنا صريح ومكتوب.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public' AND tablename = 'price_snapshot'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.price_snapshot;
  END IF;
END $$;

-- مفيش سياسة قراءة ولا كتابة: البروكسي بس بيلمسه، وهو بيشتغل بمفتاح الخدمة
-- اللي بيتخطّى RLS. anon مالوش أي وصول — وده أضيق من الصف القديم اللي كان
-- مقروء للكل في configs.
ALTER TABLE public.price_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.price_snapshot FROM anon, authenticated;

-- صريح عن قصد. service_role بيتخطّى RLS لكنه لسه محتاج صلاحية على الجدول،
-- ومشروعات Supabase بتمنحها افتراضيًا للجداول الجديدة — الاعتماد على ده
-- ضمنيًا معناه إن كل الهجرة دي تفشل عند أول كتابة من البروكسي.
GRANT ALL ON public.price_snapshot TO service_role;

-- نقل آخر قيمة معروفة، عشان أول إقلاع للبروكسي الجديد ميلاقيش الجدول فاضي.
INSERT INTO public.price_snapshot (id, data)
SELECT 'otc_prices', c.data FROM public.configs c WHERE c.id = 'otc_prices'
ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now();

COMMIT;


-- ── الخطوة 2: تحقّق ────────────────────────────────────────────────────────
--
-- شغّل ده بعد الخطوة 1. المفروض يرجّع صف واحد فيه عدد الرموز، و false.
--
-- SELECT (SELECT count(*) FROM jsonb_object_keys(data)) AS symbols,
--        EXISTS (SELECT 1 FROM pg_publication_tables
--                 WHERE pubname='supabase_realtime' AND tablename='price_snapshot') AS in_realtime
--   FROM public.price_snapshot WHERE id='otc_prices';


-- ── الخطوة 3: بعد نشر البروكسي الجديد فقط ─────────────────────────────────
--
-- لحد ما البروكسي الجديد يشتغل، هو لسه بيقرا configs/otc_prices لو الذاكرة
-- فاضية. امسحه بعد ما تتأكد إن الجديد شغّال — ومن ساعتها بس بتوقف الرسايل.
--
-- الحذف نفسه بيبعت رسالة realtime واحدة أخيرة لكل مستخدم متصل. دي آخر واحدة.
--
-- DELETE FROM public.configs WHERE id = 'otc_prices';
