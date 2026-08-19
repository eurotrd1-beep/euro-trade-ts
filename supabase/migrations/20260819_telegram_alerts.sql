-- ════════════════════════════════════════════════════════════════════════════
-- رسالة تيليجرام واحدة لكل حدث — حتى لو الخدمة اتعاد تشغيلها
--
-- تلات أنواع بس بتتبعت: فتح إشارة، نتيجة صفقة، وملخص اليوم. كل واحد منهم
-- بيحصل مرة واحدة، والمفتاح الأساسي على `event_key` هو كل آلية المنع: الإدخال
-- إما بياخد الصف أو بيقع على اللي موجود، والوقوع معناه "اتبعت خلاص". مفيش
-- SELECT-ثم-INSERT، وبالتالي مفيش سباق لو الحلقة اتنفّذت مرتين في نفس اللحظة.
--
-- شكل المفتاح — والسبب إنه مركّب كده:
--
--   signal:{symbol}:{entryTime}:{stage}   فتح صفقة
--   result:{symbol}:{entryTime}:{stage}   نتيجتها
--   daily:{YYYY-MM-DD}                    ملخص اليوم
--
-- `entryTime` هو وقت الشمعة اللي الصفقة اشتغلت عليها، و`stage` بيفصل الصفقة
-- الأساسية عن المضاعفة. يعني صفقتين مفتوحتين في نفس الثانية على زوجين
-- مختلفين ليهم مفتاحين مختلفين حتمًا، ونتيجة كل واحدة بتترتبط بصفقتها هي —
-- وده كان أهم شرط: النتايج متختلطش لما أكتر من صفقة تقفل مع بعض.
--
-- الوقت مشتق من الشمعة مش من الساعة، فهو نفس المفتاح قبل وبعد أي restart.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.telegram_alerts (
  event_key text        PRIMARY KEY,
  kind      text        NOT NULL CHECK (kind IN ('signal', 'result', 'daily')),
  sent_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.telegram_alerts IS
  'حدث تيليجرام اتبعت. المفتاح الأساسي هو منع التكرار نفسه.';

CREATE INDEX IF NOT EXISTS telegram_alerts_sent_at ON public.telegram_alerts (sent_at);

-- التنظيف: الصف مفيد لطول عمر الصفقة بس. أسبوع سقف واسع ومقصود — بيسيب
-- ملخصات الأيام السابقة موجودة كفاية عشان مايتبعتوش تاني لو الخدمة اتوقفت يوم.
CREATE OR REPLACE FUNCTION public.prune_telegram_alerts()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  WITH gone AS (
    DELETE FROM public.telegram_alerts WHERE sent_at < now() - interval '7 days' RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM gone;
  RETURN v_n;
END $$;

-- ── الصلاحيات ──────────────────────────────────────────────────────────────
--
-- المولّد بيكتب بمفتاح service_role. العميل مالوش شغل هنا: الكتابة بتخلي أي حد
-- يقدر **يكتم** رسالة بإنه يحجز مفتاحها قبل الخدمة. RLS مفعّلة من غير أي
-- policy — ممنوع تمامًا على anon و authenticated — وservice key بيتخطاها.
ALTER TABLE public.telegram_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.telegram_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.telegram_alerts TO service_role;

REVOKE EXECUTE ON FUNCTION public.prune_telegram_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_telegram_alerts() TO service_role;

-- ── مفتاح التشغيل ──────────────────────────────────────────────────────────
--
-- في `configs` مع باقي إعدادات الأدمن، مش في المتصفح: عشان يفضل بعد قفل اللاب،
-- وبعد restart للخدمة، ويظهر بنفس القيمة لو فتحت الأدمن من جهاز تاني.
--
-- الافتراضي **مقفول**. حاجة بتبعت لقناة عامة متشتغلش لوحدها بمجرد إن الترحيل
-- اتطبّق.
-- `minDepthBps` هو حد النشر: انشر الإشارات اللي عمقها (‹A11›) أكبر من أو
-- بيساوي الرقم ده. صفر = انشر كل حاجة. القرار بيتاخد **قبل** ما نتيجة الصفقة
-- تظهر — فكل إشارة بتتنشر بتفضل تنبؤ حقيقي، واللي بيتغير هو عدد اللي بيتنشر
-- مش نتيجته.
INSERT INTO public.configs (id, data)
VALUES ('telegram', '{"enabled": false, "minDepthBps": 0}'::jsonb)
ON CONFLICT (id) DO NOTHING;

COMMIT;
