# تنبيه أمني — سياسات RLS مفتوحة بالكامل

> **الحالة:** موجودة في النظام الحالي (Dart)، ومنقولة كما هي.
> **لم يتم تغييرها** — تغييرها يعدّل السلوك، والهجرة شرطها التطابق.
> **تحتاج قرارًا منفصلًا.**

---

## المشكلة

في [`supabase_schema.sql`](../../euro_trade/supabase_schema.sql) كل الجداول عليها نفس السياسة:

```sql
CREATE POLICY "allow all" ON users FOR ALL USING (true) WITH CHECK (true);
```

`USING (true)` = **أي حد يقرأ**.
`WITH CHECK (true)` = **أي حد يكتب**.

ومفتاح `anon` بيتشحن جوه كل نسخة من التطبيق (ده تصميمه الطبيعي — المفتاح مش سر). الأمان المفروض ييجي من RLS، وهي مفتوحة.

## إثبات عملي

فحص قراءة فقط بالمفتاح العام، من غير أي تسجيل دخول:

```
206  users      rows visible to anon: 12
206  configs    rows visible to anon: 25
206  pairs      rows visible to anon: 183
206  candles    rows visible to anon: 920
206  clicks     rows visible to anon: 2
200  brokers    rows visible to anon: 1
```

أي شخص يفتح DevTools في التطبيق، ياخد المفتاح، ويعمل نفس الطلبات.

## اللي ممكن يحصل

الكتابة مفتوحة زي القراءة بالظبط. يعني أي شخص يقدر:

| العملية | النتيجة |
|---|---|
| `UPDATE users SET role='vip', vip_expiry='2099-01-01'` | **VIP مجاني مدى الحياة** لنفسه أو لأي حد |
| `UPDATE users SET guaranteed_win=true` | كل صفقاته تظهر رابحة |
| `UPDATE configs SET data='{"url":"https://attacker/"}' WHERE id='proxy_server_url'` | **يحوّل كل المستخدمين لسيرفره** |
| `UPDATE configs WHERE id LIKE 'strategy_%'` | يغيّر إشارات كل العملاء |
| `UPDATE users SET is_banned=true` | يحظر أي مستخدم |
| `SELECT * FROM users` | يقرأ كل الحسابات وأجهزتها ومواعيد VIP |

أخطرهم `proxy_server_url` — سطر واحد يحوّل مصدر بيانات التطبيق كله.

## ليه مصلحتهاش

1. **بتكسر الأدمن.** لوحة التحكم بتستخدم **نفس مفتاح anon**. أول ما أقفل الكتابة، الأدمن يبطل يشتغل خالص.
2. **بتكسر التطبيق.** المستخدم بيكتب في `users` عند تسجيل الدخول (`login_count`, `device_id`, `fcm_token`).
3. **مش تطابق.** الخط الأحمر إن الناتج يطلع زي الأصل — ودي تغيّر السلوك جذريًا.

## الحل الصح

**مش تشديد RLS لوحده** — لازم فصل المفاتيح الأول:

### ١. الأدمن ينتقل لمفتاح خدمة (service_role)

الأدمن مايكلّمش Supabase مباشرة. يكلّم **Edge Function** بتتحقق من هويته وبتستخدم `service_role` من السيرفر:

```
admin UI → Edge Function (تتحقق) → service_role → DB
```

المفتاح ده **مايوصلش للمتصفح أبدًا**.

### ٢. سياسات محكمة لتطبيق المستخدم

```sql
-- قراءة فقط للجداول العامة
DROP POLICY "allow all" ON pairs;
CREATE POLICY "public read" ON pairs FOR SELECT USING (true);

DROP POLICY "allow all" ON brokers;
CREATE POLICY "public read" ON brokers FOR SELECT USING (true);

-- configs: قراءة عامة، والكتابة للخدمة بس
DROP POLICY "allow all" ON configs;
CREATE POLICY "public read" ON configs FOR SELECT USING (true);

-- users: لا قراءة عامة ولا كتابة عامة إطلاقًا
DROP POLICY "allow all" ON users;
-- كل عمليات المستخدمين تعدّي على Edge Function
```

### ٣. تسجيل الدخول يبقى عبر Edge Function

دلوقتي التطبيق بيكتب في `users` مباشرة. يتحول لـ function واحدة بتعمل التحقق والكتابة بصلاحية الخدمة.

## الترتيب المقترح

| # | الخطوة | ليه الأول |
|---|---|---|
| 1 | Edge Function لتسجيل الدخول | لازم تشتغل قبل ما نقفل كتابة `users` |
| 2 | Edge Function للأدمن + مصادقة حقيقية | لازم تشتغل قبل ما نقفل باقي الكتابة |
| 3 | تشديد RLS جدول جدول | آخر خطوة، بعد ما البدائل جاهزة |
| 4 | تدوير مفتاح anon | المفتاح الحالي مكشوف من زمان |

**مهم:** الترتيب ده مش اختياري. لو قفلت RLS قبل خطوة 1 و2، التطبيق والأدمن الاتنين هيقفوا.

## الوضع دلوقتي

منقول كما هو. النسخة الجديدة **مش أقل أمانًا** من الحالية ولا أكتر — نفس السلوك بالظبط.

الشغلانة دي مشروع منفصل عن الهجرة، ومحتاجة قرار صريح لأنها بتغيّر سلوك حقيقي.
