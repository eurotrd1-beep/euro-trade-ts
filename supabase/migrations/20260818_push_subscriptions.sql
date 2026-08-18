-- ============================================================================
-- اشتراكات الإشعارات
--
-- صف لكل متصفح فعّل الإشعارات. الـendpoint هو المفتاح لأنه هو اللي بيحدد
-- الجهاز فعلاً — المتصفح بيولّده لكل تثبيت، وبيتغيّر لو المستخدم مسح البيانات
-- أو ألغى التفعيل ورجّعه، فالتخزين عليه بيمنع تكرار نفس الجهاز.
--
-- محدش بيقرا الجدول ده غير البروكسي بمفتاح service_role: هو اللي بيستقبل
-- الاشتراك وهو اللي بيبعت. الـanon مالوش أي صلاحية عليه — الاشتراك نفسه فيه
-- مفاتيح تشفير، ولو حد قدر يقراها يبقى يقدر يبعت إشعارات لكل مستخدمي التطبيق.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  -- عنوان الدفع اللي المتصفح بيديه. طويل، وفريد لكل جهاز.
  endpoint    text PRIMARY KEY,
  -- مفتاحي التشفير اللي الرسالة بتتقفل بيهم. من غيرهم مفيش إرسال.
  p256dh      text NOT NULL,
  auth        text NOT NULL,

  -- مين ده. اختياري: المستخدم ممكن يفعّل الإشعارات قبل ما يسجّل دخول.
  account_id  text,
  -- 'free' | 'paid' وقت الاشتراك. بيتحدّث كل مرة يفتح التطبيق.
  plan        text,

  -- الأزواج اللي المستخدم عايز إشعارات منها.
  --
  -- NULL معناها «كل الأزواج» — مش صفيفة فاضية. الفرق مش شكلي: الصفيفة
  -- الفاضية معناها «مفيش ولا زوج»، وهي حالة صالحة لو حد شال كل اختياراته،
  -- والاتنين لازم يفضلوا متفرّقين وإلا هيوصل إشعارات لواحد قافلها.
  symbols     text[],

  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),

  -- محاولات إرسال فشلت ورا بعض. الاشتراك بيتشال عند 404/410 على طول،
  -- والعدّاد ده للأعطال المؤقتة اللي بتتكرر.
  failures     integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_subscriptions_account
  ON public.push_subscriptions (account_id);

-- الجدول ده مالوش أي علاقة بالمتصفح. البروكسي بس.
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_subscriptions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;

COMMIT;
