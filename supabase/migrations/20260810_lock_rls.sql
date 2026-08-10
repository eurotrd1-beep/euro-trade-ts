-- ════════════════════════════════════════════════════════════════════════════
-- تشديد سياسات RLS
--
-- ⚠️  لا تشغّل الملف ده قبل ما تقرا الشروط تحت. فيه خطوة بتكسر الأدمن لو
--     اتطبّقت لوحدها.
--
-- الوضع الحالي: كل جدول عليه  FOR ALL USING (true) WITH CHECK (true)
-- يعني مفتاح anon المشحون في كل نسخة من التطبيق بيقرا ويكتب كل حاجة.
-- التفاصيل في docs/security.md
-- ════════════════════════════════════════════════════════════════════════════


-- ── المرحلة ١ — آمنة تمامًا، مبتكسرش أي حاجة ──────────────────────────────
--
-- تطبيق المستخدم بيقرا من configs / pairs / brokers ومبيكتبش فيهم أبدًا.
-- (اتفحص: كل عمليات الكتابة في التطبيق محصورة في users و push_subscriptions)
-- الأدمن هو الوحيد اللي بيكتب فيهم — وعشان كده المرحلة دي بتكسر الأدمن
-- لو اتطبّقت قبل ما ينتقل لمسار service_role.
--
-- شغّل المرحلة دي **بعد** ما الأدمن يبقى بيكتب عبر Edge Function.

BEGIN;

-- configs — أخطر جدول: صف واحد فيه (proxy_server_url) بيحوّل كل
-- المستخدمين لأي سيرفر تاني.
DROP POLICY IF EXISTS "allow all" ON configs;
CREATE POLICY "public read" ON configs
  FOR SELECT USING (true);

-- pairs — قائمة الأزواج، قراءة فقط للعميل.
DROP POLICY IF EXISTS "allow all" ON pairs;
CREATE POLICY "public read" ON pairs
  FOR SELECT USING (true);

-- brokers — قائمة المنصات، قراءة فقط للعميل.
DROP POLICY IF EXISTS "allow all" ON brokers;
CREATE POLICY "public read" ON brokers
  FOR SELECT USING (true);

-- candles — بيكتبها السكرابر بمفتاح الخدمة، والعميل بيقراها بس.
ALTER TABLE candles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow all" ON candles;
CREATE POLICY "public read" ON candles
  FOR SELECT USING (true);

COMMIT;


-- ── المرحلة ٢ — بتكسر تسجيل الدخول لو اتطبّقت لوحدها ─────────────────────
--
-- جدول users محتاج كتابة من التطبيق (تسجيل الدخول، ربط الجهاز).
-- شغّل المرحلة دي **بعد** ما تسجيل الدخول يبقى عبر Edge Function
-- بمفتاح service_role.
--
-- مفكوكة التعليق عن قصد — لازم قرار واعي.
--
-- BEGIN;
--
-- -- users — لا قراءة عامة (فيها معرفات الحسابات والأجهزة ومواعيد VIP)
-- -- ولا كتابة عامة (منع رفع النفس لـ VIP أو تفعيل guaranteed_win).
-- DROP POLICY IF EXISTS "allow all" ON users;
-- -- مفيش سياسة = مفيش وصول لـ anon إطلاقًا. service_role بيتخطى RLS.
--
-- -- push_subscriptions — نفس الحالة، بتتكتب من التطبيق دلوقتي.
-- DROP POLICY IF EXISTS "allow all" ON push_subscriptions;
--
-- COMMIT;


-- ── المرحلة ٣أ — تقوية دالة العدّاد — آمنة تمامًا ────────────────────────
--
-- increment_click دلوقتي دالة عادية بتشتغل بصلاحية المستدعي، فمحتاجة صلاحية
-- كتابة على clicks. تحويلها لـ SECURITY DEFINER بيخليها تشتغل بصلاحية مالكها،
-- فتفضل شغالة حتى بعد ما نقفل الجدول في مرحلة ٣ب.
--
-- ⚠️ تصحيح: كنت كتبت قبل كده إن إسقاط سياسة clinks آمن. **ده كان غلط.**
--    الأدمن بيقرا clicks في 3 اشتراكات realtime وبيكتب فيه upsert واحد
--    (admin_dashboard.dart: 2242، 2711، 3851، 6835، 6843).
--    إسقاط السياسة كان هيكسر لوحة التحليلات عنده.
--    عشان كده المرحلة اتقسمت: ٣أ آمنة فعلًا، و٣ب مستنية انتقال الأدمن.
--
-- المرحلة دي مبتغيّرش أي سياسة — بتقوّي الدالة بس. تقدر تشغّلها دلوقتي.

BEGIN;

CREATE OR REPLACE FUNCTION increment_click(row_id TEXT, field_name TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
-- search_path مثبّت عشان مايتخطفش من schema تاني — شرط أساسي مع SECURITY DEFINER.
SET search_path = public
AS $$
BEGIN
  INSERT INTO clicks (id, data)
    VALUES (row_id, jsonb_build_object(field_name, 1))
  ON CONFLICT (id) DO UPDATE
    SET data = jsonb_set(
      clicks.data,
      ARRAY[field_name],
      to_jsonb(COALESCE((clicks.data->>field_name)::int, 0) + 1)
    );
END;
$$;

COMMIT;


-- ── المرحلة ٣ب — قفل جدول العدّادات ──────────────────────────────────────
--
-- بتمنع أي حد من التلاعب بالعدّادات مباشرة؛ الدالة وحدها اللي بتكتب.
-- بتكسر upsert الأدمن على صف 'promo' (admin_dashboard.dart:6843)، فمحتاجة
-- الأدمن ينتقل لمسار service_role الأول.
--
-- مفكوكة التعليق عن قصد.
--
-- BEGIN;
-- DROP POLICY IF EXISTS "allow all" ON clicks;
-- -- القراءة تفضل شغالة للوحة التحليلات، والكتابة للدالة بس.
-- CREATE POLICY "public read" ON clicks FOR SELECT USING (true);
-- COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- التراجع — يرجّع كل حاجة لحالتها الحالية بالظبط
-- ════════════════════════════════════════════════════════════════════════════
--
-- BEGIN;
-- DROP POLICY IF EXISTS "public read" ON configs;
-- DROP POLICY IF EXISTS "public read" ON pairs;
-- DROP POLICY IF EXISTS "public read" ON brokers;
-- DROP POLICY IF EXISTS "public read" ON candles;
-- CREATE POLICY "allow all" ON configs FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow all" ON pairs   FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow all" ON brokers FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow all" ON candles FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow all" ON clicks  FOR ALL USING (true) WITH CHECK (true);
-- COMMIT;
