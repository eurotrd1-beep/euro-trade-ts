# @euro/mobile — قشرة الموبايل

بديل مشروع **`euroapp`** بالكامل.

## اللي اتشال

`euroapp` كان مشروع Flutter كامل (Android + iOS + Gradle + Xcode + pubspec) وظيفته الوحيدة إنه يعرض موقع في WebView. اللي كان بيعمله بإيد، وبقى مجاني دلوقتي:

| كان في Flutter | بقى فين |
|---|---|
| ديالوج تحميل لحد ما المحتوى يظهر | splash التطبيق نفسه |
| حقن CSS لإخفاء شريط التمرير | `globals.css` |
| جسر JS لحدث `flutter-first-frame` | مش محتاجينه — مفيش WebView وسيط |
| زر الرجوع يتصفّح للخلف | `initBackButton()` |
| منع الوميض الأبيض | `backgroundColor` في الإعداد |
| شاشة خطأ عند انقطاع النت | `initNetworkWatch()` |
| أيقونة مولّدة من اللوجو | `cap assets` |

المشروع كله بقى **ملف إعداد واحد** + `lib/native.ts`.

## التشغيل

```bash
# أول مرة فقط
npm --workspace @euro/mobile install
npx cap add android
npx cap add ios        # على macOS فقط

# كل مرة بعد تعديل
npm --workspace @euro/mobile run sync
npm --workspace @euro/mobile run open:android
```

`sync` بيبني الموقع كملفات ثابتة وينسخه جوه المشروع الأصلي.

## قرار محتاج انتباهك: مضمّن ولا بعيد؟

**الوضع الحالي (مضمّن)** — الموقع بيتحزم جوه التطبيق:
- ✅ يفتح فورًا، مفيش وميض أبيض، القشرة شغالة من غير نت
- ❌ أي تعديل في الواجهة محتاج إصدار جديد على المتجر

**النسخة القديمة كانت بعيدة** — كانت بتحمّل الموقع من GitHub Pages، يعني تعديلاتك كانت بتوصل للناس **فورًا بدون مراجعة متجر**. لو ده مهم لشغلك، فكّ التعليق عن بلوك `server` في [capacitor.config.ts](./capacitor.config.ts):

```ts
server: {
  url: 'https://eurotrd1-beep.github.io/euro_trade/',
  cleartext: false,
},
```

**ليه المضمّن هو الافتراضي:** تطبيق تداول بيوقف تمامًا لما الاستضافة تتعثّر — ده فشل أسوأ. الإشارات والأسعار جاية من Supabase والبروكسي في الحالتين، فالاتنين محتاجين نت عشان التطبيق **يفيد**. الفرق في القشرة بس: المضمّن بيفتح ويقولك "مفيش نت"، والبعيد بيديك شاشة بيضا.

القرار قرارك — سطرين وبيتغيّر.

## الأيقونات

```bash
npx @capacitor/assets generate --iconBackgroundColor '#0A0714' --splashBackgroundColor '#0A0714'
```

حط `assets/icon.png` و`assets/splash.png` قبلها. اللوجو الأصلي في `euro_trade/assets/logo.jpg`.
