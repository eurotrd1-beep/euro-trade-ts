-- ════════════════════════════════════════════════════════════════════════════
-- تجميد الكتابة على Supabase — مش حذف بيانات
--
-- ⚠️  متشغّلش الملف ده غير بعد ما:
--       ١. تاخد pg_dump كامل وتتحقق منه بـ scripts/verify-backup.mjs
--       ٢. تتأكد إن D1 فيها نفس عدد الصفوف في كل جدول
--       ٣. التطبيق يبقى شغّال على mode = 'd1' ومستقر
--
-- الملف ده **مبيمسحش صف واحد**. البيانات كلها بتفضل مكانها بالظبط، والقراءة
-- بتفضل شغالة. اللي بيقف هو الكتابة بس — عشان الرجوع يفضل ممكن في أي لحظة،
-- ومن غير ما التطبيق يفضل يكتب في داتابيز مبقاش حد بيقرا منها.
--
-- ── ليه التجميد أهم من المسح ──────────────────────────────────────────────
--
-- لو Supabase فضلت تقبل كتابة بعد ما التطبيق انتقل، بيحصل أسوأ شكل ممكن:
-- **الاتنين بيتغيّروا**. بعد أسبوع محدش يقدر يقول أنهي نسخة هي الصح — ولا
-- الاتنين يقدروا يقولوا. التجميد بيمنع ده من أول ثانية.
--
-- ولو البيانات اتمسحت، الرجوع بيبقى "رجّع من نسخة احتياطية عمرها يومين"
-- بدل "غيّر صف في configs". الفرق بينهم هو الفرق بين تراجع وكارثة.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ١. القراءة تفضل مفتوحة، الكتابة تتقفل ────────────────────────────────
--
-- كل سياسة FOR ALL بتتشال ومكانها SELECT بس. مفيش سياسة كتابة خالص، يعني
-- anon و authenticated مش هيقدروا يكتبوا. service_role بيتخطى RLS أصلاً،
-- فأي سكربت إصلاح لسه شغّال لو احتجته.

DROP POLICY IF EXISTS "allow all" ON public.configs;
DROP POLICY IF EXISTS "public read" ON public.configs;
CREATE POLICY "read only" ON public.configs FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow all" ON public.pairs;
DROP POLICY IF EXISTS "public read" ON public.pairs;
CREATE POLICY "read only" ON public.pairs FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow all" ON public.brokers;
DROP POLICY IF EXISTS "public read" ON public.brokers;
CREATE POLICY "read only" ON public.brokers FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow all" ON public.candles;
DROP POLICY IF EXISTS "public read" ON public.candles;
CREATE POLICY "read only" ON public.candles FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow all" ON public.otc_pairs;
CREATE POLICY "read only" ON public.otc_pairs FOR SELECT USING (true);

DROP POLICY IF EXISTS "allow all" ON public.clicks;
CREATE POLICY "read only" ON public.clicks FOR SELECT USING (true);

-- ── ٢. الجدولين اللي كانوا مفتوحين على الآخر ─────────────────────────────
--
-- signal_history و users كان عليهم "allow all": أي حد معاه المفتاح العام كان
-- يقدر **يقرا ويكتب فوق** سجل أي حساب، ويدّي نفسه VIP، ويحظر أي حد.
-- التجميد بيقفل الكتابة دي نهائياً. القراءة بتتقفل كمان — مفيش سبب يخلّي
-- حساب مقروء للعالم بعد ما التطبيق مبقاش بيقرا من هنا.

DROP POLICY IF EXISTS "allow all" ON public.signal_history;
-- مفيش سياسة = مفيش وصول لـ anon. service_role بس.

DROP POLICY IF EXISTS "allow all" ON public.users;
-- نفس الحاجة. ودي أول لحظة في عمر المشروع بيبقى فيها جدول users مقفول.

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- التراجع — بيرجّع كل حاجة زي ما كانت بالظبط
--
-- لو حصل أي حاجة وحشة بعد الانتقال: غيّر configs.data_source.mode لـ
-- 'supabase' الأول (ده لوحده بيرجّع التطبيق فوراً)، وبعدين شغّل ده لو
-- محتاج الكتابة ترجع.
--
-- ⚠️ ملاحظة مهمة: الصفوف اللي اتكتبت في D1 بعد التجميد **مش موجودة هنا**.
--    الرجوع معناه الرجوع لحالة لحظة التجميد. عشان كده التجميد بيتعمل بعد ما
--    D1 تثبت إنها شغالة، مش قبلها.
-- ════════════════════════════════════════════════════════════════════════════
--
-- BEGIN;
-- DROP POLICY IF EXISTS "read only" ON public.configs;
-- DROP POLICY IF EXISTS "read only" ON public.pairs;
-- DROP POLICY IF EXISTS "read only" ON public.brokers;
-- DROP POLICY IF EXISTS "read only" ON public.candles;
-- DROP POLICY IF EXISTS "read only" ON public.otc_pairs;
-- DROP POLICY IF EXISTS "read only" ON public.clicks;
-- CREATE POLICY "allow all" ON public.configs        FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow all" ON public.pairs          FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow all" ON public.brokers        FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow all" ON public.candles        FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow all" ON public.otc_pairs      FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow all" ON public.clicks         FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow all" ON public.signal_history FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow all" ON public.users          FOR ALL USING (true) WITH CHECK (true);
-- COMMIT;
