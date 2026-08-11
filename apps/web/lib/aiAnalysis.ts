'use client';

/**
 * The Gemini period analysis: builds the prompt, parses the answer.
 *
 * It SUGGESTS. It never publishes — the returned JSON goes into the strategy
 * editor for a human to read, test and upload, and there is no code path from
 * here to `publish_strategy_version`. That separation is the point: a model
 * looking at a month of losses will always have an opinion, and an opinion that
 * can deploy itself is not a suggestion.
 *
 * Below 30 decided trades it refuses to conclude anything. Not because the
 * model would decline, but because it would not — it would find a pattern in
 * eleven trades and describe it confidently, and that answer is worse than no
 * answer because it looks like one.
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
  versionJson: Array<{ name: string; version: number; slot: string; json: Record<string, unknown> }>;
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

function rulesOf(row: SignalRow): string {
  return (row.rules_matched ?? [])
    .map((r) => `${r.i}[${r.r}]=${r.v ?? '—'}${r.ok ? '✓' : '✗'}`)
    .join(' ');
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
              `  ${r.symbol} ${r.direction} ${r.created_at.slice(0, 16)} ` +
              `دخول ${r.entry_price} خروج ${r.outcome_price ?? '—'}\n` +
              `    شموع: ${candlesOf(r)}\n` +
              `    قواعد: ${rulesOf(r)}`,
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

# النسخ المستخدمة في الفترة
${a.versions.map((v) => `${v.name} (slot ${v.slot}, نسخة ${v.version_number}): ${v.signals} إشارة، ${v.wins}ر/${v.losses}خ`).join('\n') || '—'}

# JSON النسخ
${a.versionJson.map((v) => `## ${v.name} — ${v.slot} نسخة ${v.version}\n${JSON.stringify(v.json)}`).join('\n\n') || '—'}

# عيّنة الإشارات
${sample(a.losers, 'خاسرة')}

${sample(a.winners, 'رابحة')}

# المطلوب
ردّ بالعربي، منظّم بالعناوين دي بالظبط:

## أنماط الخسارة
هل الخسائر متركزة في زوج/ساعة/يوم معيّن؟ قول الرقم اللي بيثبت كده، ولو مفيش نمط واضح قول كده صراحة.

## أضعف قاعدة
من "قواعد" في العيّنات: أنهي قاعدة أقل ارتباط بالنجاح؟ يعني بتتحقق في الخاسرة زي الرابحة أو أكتر.
لو العيّنة أصغر من إن تجاوب، قول كده.

## تعديل مقترح
تعديل **واحد** محدد، وقول ليه بالرقم.

## JSON
النسخة المعدّلة كاملة في كتلة \`\`\`json. نفس أسماء المؤشرات بالظبط — أي اسم المحرك ميعرفوش بيرجّع 0.0 بصمت.
ممنوع تحط اسمين من نفس مجموعة المرادفات (زي doji و harami) — دي حسبة واحدة بتتعدّ مرتين.

## تحذير
سطر واحد: إيه اللي ممكن يكون التحليل ده غلط فيه.`;
}

/** Gemini wraps JSON in a fence however firmly it is told not to. */
export function extractStrategyJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (!fenced?.[1]) return null;
  try {
    const parsed = JSON.parse(fenced[1].trim()) as Record<string, unknown>;
    return Array.isArray(parsed['rules']) ? parsed : null;
  } catch {
    return null;
  }
}
