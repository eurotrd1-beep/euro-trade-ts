-- ════════════════════════════════════════════════════════════════════════════
-- تعريف واحد للنتيجة، وسقف كتابة يناسب التشغيل الحقيقي
--
-- حاجتين اتكشفوا وإحنا بنحوّل مولّد الإشارات للاستراتيجية الجديدة.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ١. النتيجة بتتحسب في مكان واحد بس ──────────────────────────────────────
--
-- المشكلة: كان في تعريفين للتعادل.
--
--   المحرك      : |إغلاق − دخول| ≤ |دخول| × 0.000005  (tieEpsilon)
--   الدالة دي   : إغلاق = دخول بالظبط
--
-- يعني إغلاق جوه الهامش كان **تعادل** عند الاستراتيجية — فمفيش مضاعفة —
-- و**ربح أو خسارة** في الإحصائيات. نفس الصفقة، إجابتين. وده مش فرق نظري:
-- على زوج بخمس خانات عشرية الهامش ≈ 0.05 نقطة، والإغلاق بيقع فيه فعلًا.
--
-- الحل مش إني أنسخ المعادلة هنا كمان — ده تلات نسخ بدل اتنين، وهيختلفوا
-- تاني. الحل إن الدالة **بطّلت تحسب**: المحرك بيقرر، والدالة بتخزّن قراره.
-- المولّد بيبعت `outcome` مع السعر، والقرار ده هو نفسه اللي قرّر المضاعفة.
--
-- `price IS NULL` أو `outcome` ناقص = unresolved. ودي حالة رابعة مقصودة:
-- «مفيش سعر» مش تعادل، ومستبعدة من كل نسبة.
CREATE OR REPLACE FUNCTION public.resolve_signals(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  WITH incoming AS (
    SELECT * FROM jsonb_to_recordset(p_rows)
      AS x(id bigint, price double precision, outcome text)
  ), done AS (
    UPDATE public.signals s SET
      outcome_price = i.price,
      outcome_at    = now(),
      outcome = CASE
        WHEN i.price IS NULL THEN 'unresolved'
        WHEN i.outcome IN ('win', 'loss', 'tie') THEN i.outcome
        -- نتيجة مش مفهومة متتخزّنش كأنها تعادل. الصف بيفضل «بدون نتيجة»
        -- وبيبان في الإحصائيات على حقيقته.
        ELSE 'unresolved'
      END
    FROM incoming i
    WHERE s.id = i.id AND s.outcome = 'pending'
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM done;
  RETURN v_n;
END $$;

COMMENT ON FUNCTION public.resolve_signals(jsonb) IS
  'بتخزّن النتيجة اللي المحرك قرّرها — مبتحسبش. التعريف الوحيد في outcomeFor.';


-- ── ١.ب صلاحيات التنفيذ — إصلاح REVOKE كان بيبان شغّال وهو مش شغّال ────────
--
-- الترحيل القديم كتب:
--
--   REVOKE EXECUTE ON FUNCTION ... FROM anon, authenticated;
--
-- ودي **مبتعملش حاجة**. بوستجريس بيمنح EXECUTE لـPUBLIC تلقائيًا على أي دالة
-- جديدة، وanon عضو في PUBLIC — فسحب المنحة من anon بيسيب منحة PUBLIC مكانها.
-- اتقاس فعليًا بمفتاح anon (المشحون في كل نسخة من التطبيق):
--
--   resolve_signals  → 200، الدالة اتنفّذت
--   prune_signals    → 200  ← دي بتمسح صفوف
--   pending_signals  → 200
--
-- وده بقى أخطر بعد التغيير فوق: الدالة بقت بتاخد `outcome` جاهزة، فأي حد
-- معاه المفتاح كان يقدر يكتب أرباح وخسائر وهمية في الإحصائيات مباشرة.
--
-- السحب من PUBLIC هو اللي بيقفلها. والمنح الصريح لـservice_role بعده مقصود:
-- المولّد بيشتغل بالمفتاح ده، والاعتماد على وراثة منحة PUBLIC هو اللي وقعنا
-- فيه من الأول.
REVOKE EXECUTE ON FUNCTION public.resolve_signals(jsonb)           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_signals(jsonb)            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pending_signals()                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prune_signals(integer)           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_signal_daily(date, date) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.resolve_signals(jsonb)           TO service_role;
GRANT EXECUTE ON FUNCTION public.record_signals(jsonb)            TO service_role;
GRANT EXECUTE ON FUNCTION public.pending_signals()                TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_signals(integer)           TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_signal_daily(date, date) TO service_role;


-- ── ٢. سقف الكتابة اليومي ──────────────────────────────────────────────────
--
-- السقف القديم 5,000 كان متحسِّب على «703 صف/يوم من 15 دقيقة × 183 زوج».
-- التشغيل الحالي مختلف تمامًا:
--
--   فريم دقيقة  → 1,440 شمعة/يوم للزوج الواحد بدل 96
--   89 زوج      → بدل 183
--   خطتين       → كل خطة بتتقيّم لوحدها (النهاردة نفس البرنامج، وبكرة لأ)
--
-- المقاس الفعلي من الباك تست: صفقة كل ~48 تقييم. يعني ~30 صفقة/يوم للزوج،
-- × 89 زوج × خطتين ≈ **5,400 صف/يوم** — فوق السقف القديم، والدفعة بترفض
-- بالكامل لما يتخطى.
--
-- 20,000 = تقريبًا 3.7 أضعاف المتوقّع. مش رقم عشوائي: هو مساحة تكفي يوم
-- متقلّب جدًا أو زيادة أزواج، وفي نفس الوقت **لسه سقف حقيقي** يوقف عطل
-- بيكتب في حلقة. سقف عالي أوي = مفيش سقف.
--
-- ⚠️ حسبة المساحة قبل ما ترفعه أكتر: الصف ≈ 500 بايت (25 رقم للشموع +
-- تفاصيل الإشارة)، والاحتفاظ 30 يوم. يعني عند المتوقّع ≈ 80 ميجا، وعند
-- السقف الكامل ≈ 300 ميجا. لو الخطة عندك 500 ميجا، الرقم ده هو الحد
-- المعقول — والمفتاح التاني هو مدة الاحتفاظ (KEEP_DAYS في المولّد).
UPDATE public.signal_write_budget SET max_rows = 20000 WHERE max_rows = 5000;

ALTER TABLE public.signal_write_budget ALTER COLUMN max_rows SET DEFAULT 20000;

COMMIT;
