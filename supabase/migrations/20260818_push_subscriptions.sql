-- ============================================================================
-- اشتراكات الإشعارات — التعديل على الجدول الموجود
--
-- الملف ده كان بيعمل `CREATE TABLE IF NOT EXISTS`، وده كان غلط: الجدول موجود
-- بالفعل من نظام إشعارات قديم، فالإنشاء اتخطّى بصمت والفهرس بعده وقع على
-- عمود مش موجود. الشكل اللي هناك فعلاً:
--
--   id uuid · user_id text · endpoint text · subscription jsonb
--   · created_at · updated_at
--
-- وفيه ٣ اشتراكات حقيقية. فالترحيل ده بيتعامل مع اللي موجود بدل ما يفرض شكل
-- تاني: بيضيف اللي ناقص بس، وبيسيب البيانات مكانها.
--
-- ── 🔴 والأهم: الجدول ده كان مقروء من أي حد ─────────────────────────────────
--
-- `select=*` بمفتاح anon — اللي موجود في كود المتصفح لأي زائر — كان بيرجّع كل
-- صف بمفاتيح التشفير بتاعته (`p256dh` و `auth`) وبالـendpoint وبالـuser_id.
-- دي بيانات تعريف أجهزة مربوطة بحسابات، ومفيش سبب واحد تكون مقروءة من
-- المتصفح: مفيش كود في التطبيق بيقرا الجدول ده أصلاً. البروكسي بس، بمفتاح
-- service_role. اتقفل تحت.
-- ============================================================================

BEGIN;

-- لو مش موجود أصلاً (قاعدة بيانات نضيفة) يتعمل بالشكل القديم بالظبط، عشان
-- يفضل مسار واحد للاتنين بدل ما الكود يتعامل مع شكلين.
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text,
  endpoint     text NOT NULL,
  -- الاشتراك كامل زي ما المتصفح بيدّيه: { endpoint, keys: { p256dh, auth } }.
  -- متخزّن كـJSON لأن ده اللي الـWeb Push API بيطلبه وقت الإرسال حرفياً،
  -- وتفكيكه لأعمدة معناه تركيبه تاني في كل بعتة.
  subscription jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ── الناقص ────────────────────────────────────────────────────────────────

-- الأزواج اللي المستخدم عايز إشعارات منها.
--
-- NULL معناها «كل الأزواج» — مش صفيفة فاضية. الفرق مش شكلي: الصفيفة الفاضية
-- معناها «مفيش ولا زوج»، وهي حالة صالحة لو حد شال كل اختياراته، والاتنين لازم
-- يفضلوا متفرّقين وإلا هيوصل إشعارات لواحد قافلها.
ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS symbols text[];

-- 'free' | 'paid' وقت الاشتراك. بيتحدّث كل مرة يفتح التطبيق.
ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS plan text;

-- محاولات إرسال فشلت ورا بعض.
--
-- بيترجّع لصفر مع أول نجاح، والصف بيتشال لما يوصل حد معيّن. ده اللي بينضّف
-- الاشتراكات القديمة اللي اتعملت بمفتاح VAPID تاني — الإرسال ليها بيرجّع 403
-- للأبد، وهي مش «ميتة» بالمعنى اللي بيدّي 404، فلولا العدّاد ده هتفضل تتحاول
-- كل دقيقة إلى الأبد.
ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS failures integer NOT NULL DEFAULT 0;

-- ── مفتاح فريد على الـendpoint ─────────────────────────────────────────────
--
-- الـendpoint هو اللي بيحدد الجهاز فعلاً؛ الـid بيتولّد. من غير القيد ده
-- الـupsert مايعرفش على إيه يتصادم، وكل مرة المستخدم يفتح التطبيق يتكتب صف
-- جديد لنفس الجهاز ويوصله الإشعار مرتين وتلاتة.
--
-- بيتشال المكرر الأول، وبيتساب الأحدث: التكرار — لو موجود — يبقى نفس الجهاز
-- اتسجّل أكتر من مرة، وآخر تسجيل هو اللي مفاتيحه صالحة.
DELETE FROM public.push_subscriptions a
 USING public.push_subscriptions b
 WHERE a.endpoint = b.endpoint
   AND a.created_at < b.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint
  ON public.push_subscriptions (endpoint);

CREATE INDEX IF NOT EXISTS push_subscriptions_user
  ON public.push_subscriptions (user_id);

-- ── الصلاحيات ─────────────────────────────────────────────────────────────
--
-- مفيش سطر واحد في التطبيق بيقرا الجدول ده أو بيكتب فيه — الاشتراك بيروح
-- للبروكسي وهو اللي بيخزّنه. فالـanon مالوش أي لزمة هنا، وكان معاه كل حاجة.
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_subscriptions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;

COMMIT;

-- ── للتأكد بعد التشغيل ─────────────────────────────────────────────────────
--
-- لازم ترجّع صفر:
--
--   SELECT count(*) FROM information_schema.role_table_grants
--    WHERE table_name = 'push_subscriptions' AND grantee IN ('anon','authenticated');
