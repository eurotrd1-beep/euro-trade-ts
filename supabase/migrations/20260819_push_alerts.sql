-- ════════════════════════════════════════════════════════════════════════════
-- إشعار واحد لكل مرحلة لكل فرصة — حتى لو المولّد اتعاد تشغيله
--
-- نظام الإشعارات فيه تلات مراحل لكل setup: 96 و98 و100. الذاكرة جوّه المولّد
-- بتكفي للتكرار العادي — نفس الشمعة بتتقرا مرتين، polling، إعادة حساب — لكن
-- **مبتكفيش للـrestart**: العملية بتبني كل الإعدادات من الشموع تاني خلال قفلتين،
-- فنشر جديد في نص فرصة كان هيبعت نفس الإشعار مرة تانية.
--
-- المفتاح الأساسي هو كل آلية منع التكرار: الإدخال إما بياخد الصف أو بيقع على
-- الصف اللي موجود، والوقوع ده معناه "حد تاني بعته". مفيش SELECT-ثم-INSERT،
-- وبالتالي مفيش سباق بين تكّتين.
--
-- ليه `setup_key` نص وليس مفتاح أجنبي: ده `originTime:endTime` — وقتين شمعتين
-- الساق واقعة بينهم. مشتق من السوق نفسه مش من العملية، فهو نفس النص قبل وبعد
-- الـrestart، وسوينج جديد فعلًا = نص مختلف فعلًا. وده اللي بيخلي فرصة جديدة على
-- نفس الزوج تبدأ سلّم إشعارات جديد.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.push_alerts (
  symbol     text        NOT NULL,
  -- `originTime:endTime` من المحرك.
  setup_key  text        NOT NULL,
  -- 96 · 98 · 100. مقيّدة عشان خطأ في الاستدعاء ميعملش صف بمرحلة مش موجودة.
  stage      smallint    NOT NULL CHECK (stage IN (96, 98, 100)),
  sent_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (symbol, setup_key, stage)
);

COMMENT ON TABLE public.push_alerts IS
  'مرحلة إشعار اتبعتت لفرصة واحدة. المفتاح الأساسي هو منع التكرار نفسه.';

-- التنظيف: الصف بيقى مفيد لطول عمر الفرصة بس، وده دقايق. اليوم سقف واسع جدًا
-- ومقصود — أرخص من إننا نحسب اللحظة اللي الفرصة ماتت فيها.
CREATE INDEX IF NOT EXISTS push_alerts_sent_at ON public.push_alerts (sent_at);

CREATE OR REPLACE FUNCTION public.prune_push_alerts()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  WITH gone AS (
    DELETE FROM public.push_alerts WHERE sent_at < now() - interval '1 day' RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM gone;
  RETURN v_n;
END $$;

-- ── الصلاحيات ──────────────────────────────────────────────────────────────
--
-- المولّد بيشتغل بمفتاح service_role. العميل مالوش أي شغل بالجدول ده: قراءته
-- بتكشف مين قرب على إيه، وكتابته بتخلي أي حد يقدر **يكتم** إشعار عن مستخدم
-- بإنه يحجز الصف قبل المولّد. عشان كده RLS مفعّلة من غير أي policy — يعني
-- ممنوع تمامًا على anon و authenticated — وService key بيتخطاها.
ALTER TABLE public.push_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.push_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.push_alerts TO service_role;

REVOKE EXECUTE ON FUNCTION public.prune_push_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_push_alerts() TO service_role;

COMMIT;
