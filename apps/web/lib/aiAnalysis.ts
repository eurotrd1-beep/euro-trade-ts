'use client';

/**
 * The Gemini period analysis: builds the prompt.
 *
 * Below 30 decided trades it refuses to conclude anything. Not because the
 * model would decline, but because it would not — it would find a pattern in
 * eleven trades and describe it confidently, and that answer is worse than no
 * answer because it looks like one.
 *
 * -- WHAT IT USED TO ASK FOR, AND WHY THAT HAD TO GO ------------------------
 *
 * It ended by asking Gemini for "the full edited version in a ```json block",
 * with rules about indicator names and alias groups, and the screen offered a
 * button to copy that JSON with a note saying to open it in the strategies
 * page, test it, and upload it.
 *
 * None of those things exist. The strategies page has no editor, no validator
 * and no upload — strategies are programs compiled into the engine now, and
 * changing one is a code change. So the button copied a rule file that no
 * running code could read, to a screen with nowhere to paste it.
 *
 * It also asked which RULE correlated least with winning, from `rules_matched`
 * on the sampled signals. The generator writes no rules and `score: 0`,
 * because a touch either happened or it did not. That section could only ever
 * come back empty or invented.
 *
 * What remains is the half that still has data under it: where the losses sit
 * — which pair, which hour, which day — whether the recovery trade earns its
 * place, and whether waiting for a setup beats taking the first one. Those are
 * answerable from what the rows actually carry, and none of them needs a file
 * nobody can publish.
 */

import type { Bucket, SignalRow, VersionStats } from './signalStats';
import { MIN_TRADES, BREAKEVEN_LOW, BREAKEVEN_HIGH, wilson } from './signalStats';

export interface AnalysisInput {
  rangeLabel: string;
  from: string;
  to: string;
  slotLabel: string;
  total: Bucket | null;
  bySymbol: Bucket[];
  byDay: Bucket[];
  byHour: Array<{ hour: number; wins: number; losses: number }>;
  versions: VersionStats[];
  losers: SignalRow[];
  winners: SignalRow[];
}

/** Five candles as [o,h,l,c,t]×5 → something readable in a prompt. */
function candlesOf(row: SignalRow): string {
  const s = row.candle_snapshot;
  if (!s || s.length < 5) return '—';
  const out: string[] = [];
  for (let i = 0; i + 4 < s.length; i += 5) {
    out.push(`o${s[i]} h${s[i + 1]} l${s[i + 2]} c${s[i + 3]}`);
  }
  return out.join(' | ');
}

export function buildAnalysisPrompt(a: AnalysisInput): string {
  const decided = (a.total?.wins ?? 0) + (a.total?.losses ?? 0);
  const ci = wilson(a.total?.wins ?? 0, decided);

  const sample = (rows: SignalRow[], label: string) =>
    rows.length === 0
      ? `${label}: لا يوجد`
      : `${label} (${rows.length}):\n` +
        rows
          .map(
            (r) =>
              `  ${r.symbol} ${r.direction} ${r.slot} ${r.created_at.slice(0, 16)} ` +
              `دخول ${r.entry_price} خروج ${r.outcome_price ?? '—'}\n` +
              `    شموع: ${candlesOf(r)}\n`,
          )
          .join('\n');

  return `أنت محلل أداء استراتيجيات تداول. اقرأ الأرقام دي وردّ **بالعربي**.

# قاعدة أولى — لا تتجاوزها
عدد الصفقات المحسومة في الفترة دي: ${decided}.
${decided < MIN_TRADES
  ? `ده أقل من ${MIN_TRADES}. **قول "عيّنة غير كافية" ولا تستنتج أي نمط ولا تقترح أي تعديل.** انتهى.`
  : `ده كافي للتحليل. لكن افتكر: مجال الثقة 95% هو ${ci ? `${ci.low.toFixed(1)}%–${ci.high.toFixed(1)}%` : '—'}، ` +
    `وأي استنتاج لازم يكون متسق مع اتساع المجال ده.`}

# نقطة التعادل — مش 50%
بعائد 80–90%، الاستراتيجية محتاجة ${BREAKEVEN_LOW}%–${BREAKEVEN_HIGH}% عشان ترجّع رأس المال بس.
أي نسبة تحت ${BREAKEVEN_HIGH}% هي خاسرة أو متعادلة، حتى لو فوق 50%. متوصفهاش بإنها "كويسة".

# الفترة
${a.rangeLabel} (${a.from} → ${a.to}) · ${a.slotLabel}

# الإجمالي
إشارات ${a.total?.signals ?? 0} · ربح ${a.total?.wins ?? 0} · خسارة ${a.total?.losses ?? 0} · تعادل ${a.total?.ties ?? 0}
بدون سعر (unresolved) ${a.total?.unresolved ?? 0} · معلّق ${a.total?.pending ?? 0} · مفروضة (guaranteed_win) ${a.total?.forced ?? 0}
ملاحظة: التعادل و"بدون سعر" والمفروضة **مستبعدة** من النسبة. النسبة من الربح والخسارة فقط.

# التوزيع بالزوج (أعلى 25)
${a.bySymbol.slice(0, 25).map((b) => `${b.bucket}: ${b.wins}ر/${b.losses}خ`).join(' · ') || '—'}

# التوزيع باليوم
${a.byDay.map((b) => `${b.bucket}: ${b.wins}ر/${b.losses}خ`).join(' · ') || '—'}

# التوزيع بالساعة (UTC)
${a.byHour.map((h) => `${h.hour}: ${h.wins}ر/${h.losses}خ`).join(' · ') || '—'}

# التوزيع بالخانة
كل صفقة مكتوبة في خانة: "instant" يعني اتفتحت على أول شمعة بعد الضغط،
و"monitoring" يعني الاستراتيجية استنّت لحد ما لقت الإعداد. الفرق بينهم مش تفصيلة —
هو الفرق بين إعداد كان موجود وإعداد اتستنّى.
${a.versions.map((v) => `${v.slot}: ${v.signals} إشارة، ${v.wins}ر/${v.losses}خ`).join(' · ') || '—'}

# عيّنة الإشارات
${sample(a.losers, 'خاسرة')}

${sample(a.winners, 'رابحة')}

# الاستراتيجية اللي بتحلّلها
واحدة، ومش قابلة للتعديل من هنا: المحرك بيرسم فيبوناتشي بين آخر قمة وقاع مؤكدين،
وبيفتح صفقة دقيقة واحدة لما السعر يرجع يلمس مستوى 0.236 — CALL لو الساق صاعدة و PUT
لو هابطة. لو الصفقة خسرت، فيه فرصة تعويض واحدة بس على نفس المستوى.
مفيش قواعد ولا سكور ولا مؤشرات تانية. **متقترحش قواعد ولا ملفات JSON ولا مؤشرات** —
مفيش حاجة تقرا الكلام ده، والاستراتيجية بتتغيّر بتعديل كود مش برفع ملف.

# المطلوب
ردّ بالعربي، منظّم بالعناوين دي بالظبط:

## أنماط الخسارة
هل الخسائر متركزة في زوج/ساعة/يوم معيّن؟ قول الرقم اللي بيثبت كده، ولو مفيش نمط واضح قول كده صراحة.

## التعويض
من التوزيع بالخانة: صفقات التعويض بترجّع الخسارة فعلاً ولا بتضاعفها؟ قارن بالأرقام.

## الانتظار
"monitoring" أحسن من "instant" ولا أوحش؟ ولو الفرق أصغر من إن يتقاس على العيّنة دي، قول كده.

## التوصية
حاجة **واحدة** قابلة للتنفيذ: زوج يتشال، ساعة تتجنّب، أو "مفيش، العيّنة لسه صغيرة".
قول ليه بالرقم.

## تحذير
سطر واحد: إيه اللي ممكن يكون التحليل ده غلط فيه.`;
}
