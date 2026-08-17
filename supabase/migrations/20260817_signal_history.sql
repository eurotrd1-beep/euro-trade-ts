-- ════════════════════════════════════════════════════════════════════════════
-- سجل الصفقات — يتبع الحساب، مش الجهاز
--
-- المشكلة: السجل كان متخزّن في localStorage وبس، تحت `signals_<رقم_الحساب>`.
-- ده بيشتغل تمام لحد ما المخزن يتصفّر — و`lib/session.ts` نفسه بيوصف إمتى
-- بيتصفّر: iOS بيمسحه تحت ضغط المساحة، ومتصفحات الـin-app والـCapacitor
-- WebView بيصفّروه بين التشغيلات، وأي مسح لبيانات التطبيق بياخده معاه.
-- الجلسة اتصلحت وقتها بإنها بقت بتتكتب في كوكي كمان؛ السجل مااتصلحش،
-- فالمستخدم بيدخل على نفس الحساب ويلاقي السجل فاضي — وده اللي حصل فعلًا.
--
-- ليه جدول لوحده ومش صف في configs:
--   • configs معمول لعشرين صف مفردة (إعدادات المشرف)، مش لصف لكل حساب.
--   • المرحلة الأولى في 20260810_lock_rls.sql بتحوّل configs لقراءة فقط
--     للعميل. لو السجل عايش هناك، أول ما التشديد ده يتطبّق السجل يتوقف عن
--     الحفظ — بصمت.
--   • صحة الاشتراكات: realtime بيراقب configs بفلتر لكل صف بالاسم، فصف
--     لكل حساب مش هيتبثّ لكن هيخلّي الجدول حاجة تانية غير اللي الملفات
--     بتوصفها.
--
-- صف واحد لكل حساب فيه القائمة كلها، مش صف لكل صفقة: القائمة محدودة بخمسين
-- ودايمًا بتتقرا وتتكتب كوحدة واحدة، فده استعلام واحد بلا ترقيم صفحات وبلا
-- تنظيف دوري.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.signal_history (
  -- رقم حساب البروكر زي ما المستخدم كتبه. مفيش REFERENCES على users عن قصد:
  -- verifyAccount بيرجّع نجاحًا كـ standard لو الاستعلام نفسه فشل، فساعتها
  -- الجلسة موجودة والصف في users مش موجود — ومفتاح أجنبي هنا كان معناه إن
  -- السجل يتوقف عن الحفظ في الحالة دي بدون أي رسالة.
  account_id  text PRIMARY KEY,

  -- أحدث أولًا، بنفس شكل TradingSignal اللي المحرك بيقراه.
  signals     jsonb NOT NULL DEFAULT '[]'::jsonb,

  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- سقف أمان مش سقف المنتج: التطبيق بيقصّ على خمسين، والرقم ده موجود عشان
  -- عميل مخرّب ميقدرش يحوّل الصف لميجابايتات. لو السقف في التطبيق زاد،
  -- الرقم ده لازم يزيد قبله.
  CONSTRAINT signal_history_sane_size CHECK (jsonb_array_length(signals) <= 200)
);

COMMENT ON TABLE  public.signal_history IS
  'سجل صفقات المستخدم، صف لكل حساب. بديل دائم لـlocalStorage اللي كان بيتصفّر.';
COMMENT ON COLUMN public.signal_history.signals IS
  'مصفوفة TradingSignal، أحدث أولًا، محدودة بخمسين من ناحية التطبيق.';

-- updated_at بيتحدّد على السيرفر، مش من العميل: الوقت اللي العميل بيبعته
-- ممكن يكون غلط أو مضروب، والعمود ده بيُستخدم للتشخيص.
CREATE OR REPLACE FUNCTION public.touch_signal_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS signal_history_touch ON public.signal_history;
CREATE TRIGGER signal_history_touch
  BEFORE INSERT OR UPDATE ON public.signal_history
  FOR EACH ROW EXECUTE FUNCTION public.touch_signal_history();

-- ── RLS ────────────────────────────────────────────────────────────────────
--
-- ⚠️ اقرا ده. السياسة دي مفتوحة، والسبب إن مفيش مصادقة حقيقية في النظام
-- أصلًا: المستخدم بيثبت ملكيته بإنه بيكتب رقم حساب البروكر، ومفيش JWT فيه
-- هوية نقدر نقيّد بيها الصف. فأي حد عنده مفتاح anon (وهو مشحون في كل نسخة
-- من التطبيق) ويعرف رقم حساب، يقدر يقرا ويكتب سجل الحساب ده.
--
-- اللي في الصف: زوج العملة، الاتجاه، السعر، الثقة، والنتيجة. مفيش بيانات
-- دخول ولا بيانات دفع. لكن ده مش تبرير — هي نفس الحالة الموصوفة في
-- docs/security.md، والإصلاح الحقيقي واحد لكل الجداول: تسجيل الدخول يبقى عبر
-- Edge Function بمفتاح service_role، وبعدها السياسة دي تتحوّل لـ
-- `USING (account_id = auth.jwt() ->> 'sub')`. لحد ساعتها، ده مش أسوأ من
-- جدول users اللي جانبه.
ALTER TABLE public.signal_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow all" ON public.signal_history;
CREATE POLICY "allow all" ON public.signal_history
  FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.signal_history TO anon, authenticated;

COMMIT;

-- ── لما تسجيل الدخول ينتقل لـservice_role، شغّل ده ─────────────────────────
--
-- BEGIN;
-- DROP POLICY IF EXISTS "allow all" ON public.signal_history;
-- CREATE POLICY "own history" ON public.signal_history
--   FOR ALL USING (account_id = auth.jwt() ->> 'sub')
--        WITH CHECK (account_id = auth.jwt() ->> 'sub');
-- COMMIT;
