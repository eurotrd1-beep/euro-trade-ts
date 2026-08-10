# EURO TRADE

مشروع واحد بـ TypeScript، بديل التلات مشاريع القديمة (`euro_trade` + `euro_trade_admin` + `euroapp`).

```
apps/
  web/       تطبيق المستخدم + لوحة التحكم  (Next.js)
  mobile/    قشرة الموبايل                (Capacitor — بديل euroapp)
  worker/    كاش Cloudflare
packages/
  engine/    محرك الإشارات — 359 مؤشر + الهرم
  shared/    أنواع الداتابيز + Supabase + اللغة + الثوابت
tools/
  golden-dart/  مسجّل مرجع التطابق من محرك Dart الأصلي
```

## التشغيل

```bash
npm install
npm --workspace @euro/web run dev     # http://localhost:3000
```

| المسار | |
|---|---|
| `/` | البداية |
| `/app` | شاشة التداول |
| `/admin` | لوحة التحكم |

## ⭐ أهم حاجة: بوابة التطابق

المحرك هو الحتة اللي بتقرر CALL/PUT. أي فرق فيه = إشارات مختلفة للعملاء.

```bash
npm --workspace @euro/engine run test
```

**405 اختبار** بيقارنوا كل قيمة بالقيمة اللي محرك Dart الأصلي طلّعها فعليًا:

- 359 مؤشر
- منطق الهرم (8 سيناريوهات: كل مسارات القبول والرفض)
- المسجّل البارامتري V2 (4 إعدادات)
- الثقة و WIN/LOSS/TIE

الاختبارات دي **لازم تفضل خضرا**. لو واحد بقى أحمر، يبقى الإشارات اتغيّرت.

### تجديد المرجع

```bash
cd tools/golden-dart && flutter test test/generate_golden_test.dart
```

### فحص على السوق الحقيقي

```bash
npm --workspace @euro/engine run live-check
```

بيجيب شموع حقيقية من البروكسي ويشغّل الـ359 مؤشر عليها.

## النشر

`.github/workflows/deploy.yml` — **يدوي بالنية**: Actions → Deploy to GitHub Pages → Run workflow.

بيشغّل اختبارات التطابق الأول، وبيفشل قبل النشر لو أي واحد أحمر.

## الموبايل

```bash
npx cap add android
npm --workspace @euro/mobile run sync
```

التفاصيل في [apps/mobile/README.md](apps/mobile/README.md).

## ⚠️ اقرأ ده

[docs/security.md](docs/security.md) — سياسات RLS مفتوحة بالكامل على قاعدة البيانات. الحالة دي **موجودة في النسخة القديمة** ومنقولة كما هي؛ الملف بيشرح المشكلة والحل، و[supabase/migrations/](supabase/migrations/) فيه الإصلاح جاهز.
