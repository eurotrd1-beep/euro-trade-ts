/**
 * Writes docs/unavailable-indicators.md from the audit, so the record of what
 * was disabled and why cannot drift from the evidence that disabled it.
 *
 * Run: npx tsx scripts/build-unavailable-doc.mts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { registeredNames } from '../packages/engine/src/index.js';

interface Verdict {
  name: string;
  grade: 'A' | 'B' | 'alive';
  reasons: string[];
  distinctValues: number;
  values: string[];
  evaluations: number;
  movementRate: number;
}

const audit = JSON.parse(readFileSync('docs/liveness.json', 'utf8')) as {
  coverage: Record<string, unknown>;
  verdicts: Verdict[];
};

const registered = new Set(registeredNames());

/**
 * Everything the Dart engine has that this one no longer registers.
 *
 * Taken from the golden fixture rather than from the audit: the audit only ever
 * describes what is still registered, so after the last round it reports no
 * removals at all. The fixture is the full original vocabulary, and anything in
 * it that is not in the registry now was disabled.
 */
const fixture = JSON.parse(
  readFileSync('packages/engine/golden/engine-golden.json', 'utf8'),
) as { results: Record<string, unknown> };

const byName = new Map(audit.verdicts.map((v) => [v.name, v]));
const removed: Verdict[] = Object.keys(fixture.results)
  .filter((n) => !registered.has(n))
  .map((n) => byName.get(n) ?? {
    name: n, grade: 'A' as const, reasons: [], distinctValues: 1,
    values: [], evaluations: 0, movementRate: 0,
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/** No indicator is held back any more; the section stays so its absence is explicit. */
const waiting: Verdict[] = [];

// ── School ─────────────────────────────────────────────────────────────────

const SCHOOL_RULES: Array<[RegExp, string]> = [
  [/^(mvrv|sopr|nupl|hash_rate|mining_difficulty|stock_to_flow|exchange_|on_chain|whale_|realized_pnl|pi_cycle)/, 'أون-تشين'],
  [/^(neural_network|lstm|transformer|xgboost|random_forest|gradient_boosting|svm_|cnn_|tcn|wavenet|autoencoder|som|ica|pca|deep_learning|reinforcement|bayesian|hidden_markov|gaussian_process|clustering|quantitative_factor|market_regime_class)/, 'تعلّم آلي'],
  [/^(vix|dxy|us10y|yield_curve|cot_report|commitment_of_traders|put_call|advance_decline|mcclellan|arms_index|trin|tick|nhnl|new_highs|breadth|bpi|bullish_percent|zweig|market_breadth|sector_rotation|rrg|relative_rotation|intermarket|macro_|economic_calendar|risk_on_off|gold_ratio|seasonality|lunar|astro|news_sentiment|social_sentiment|cross_asset|dealer_positioning)/, 'بيانات خارجية'],
  [/^(dom|footprint|iceberg|spoofing|smt_divergence|smart_tape|microstructure|latency|liquidity_heatmap|liquidation_heatmap|hidden_liquidity|max_pain|gamma_exposure|delta_exposure|options_open_interest|funding_rate|long_short_ratio|statistical_arbitrage|cointegration|risk_parity|kelly)/, 'تدفّق أوامر ومشتقات'],
  [/(volume|vol_|obv|cmf|mfi|pvt|klinger|nvi|pvi|emv|ease_of_movement|cvd|elder_force|liquidity_score)/, 'حجم'],
  [/^wyckoff|^(accumulation|distribution|expansion|manipulation|reaccumulation|redistribution)$/, 'وايكوف'],
  [/^(order_block|fair_value|fvg|bos|choch|break_of_structure|change_of_character|breaker|mitigation|inducement|dealing_range|premium|discount|ote|judas|silver_bullet|po3|power_of_three|amd_cycle|market_maker|turtle_soup|cisd|liquidity|eqh|eql|equal_)/, 'ICT'],
  [/^(kalman|z_score|hurst|entropy|monte_carlo|spectral|wavelet|fractal_dimension|anomaly|regime)/, 'إحصائي'],
];

function school(name: string): string {
  for (const [re, label] of SCHOOL_RULES) if (re.test(name)) return label;
  return 'كلاسيكي';
}

// ── Purpose and alternative ────────────────────────────────────────────────
//
// Written by hand for the names an operator is realistically going to miss.
// Everything else falls back to its school, and the alternative column says
// "لا يوجد" rather than inventing a substitute to fill the cell.

const NOTES: Record<string, { what: string; alt: string }> = {
  volume: { what: 'حجم الشمعة مقارنةً بمتوسطه', alt: 'لا يوجد — لا بديل سعري عن الحجم' },
  vol_ratio: { what: 'نسبة الحجم الحالي للمتوسط', alt: 'لا يوجد' },
  volume_oscillator: { what: 'الفرق بين متوسطي حجم سريع وبطيء', alt: 'لا يوجد' },
  nvi: { what: 'مؤشر الحجم السالب — تتبّع «المال الذكي» في أيام الحجم المنخفض', alt: 'لا يوجد' },
  pvi: { what: 'مؤشر الحجم الموجب — تتبّع «مال الجمهور»', alt: 'لا يوجد' },
  obv: { what: 'الحجم التراكمي حسب اتجاه الإغلاق', alt: 'لا يوجد' },
  pvt: { what: 'الحجم مرجّحاً بنسبة تغيّر السعر', alt: 'لا يوجد' },
  mfi: { what: 'مؤشر تدفّق الأموال — RSI مرجّح بالحجم (0-100)', alt: 'rsi — نفس فكرة التشبّع بدون ترجيح' },
  cmf: { what: 'تدفّق أموال تشايكن — ضغط الشراء مقابل البيع (-1..1)', alt: 'bop — ميزان القوة من موقع الإغلاق داخل الشمعة' },
  vol_delta: { what: 'الفرق بين حجم الشراء والبيع', alt: 'لا يوجد' },
  cvd: { what: 'دلتا الحجم التراكمية', alt: 'لا يوجد' },
  cumulative_volume_delta: { what: 'دلتا الحجم التراكمية', alt: 'لا يوجد' },
  klinger: { what: 'مذبذب كلينجر — اتجاه الحجم طويل المدى', alt: 'لا يوجد' },
  klinger_oscillator: { what: 'مذبذب كلينجر', alt: 'لا يوجد' },
  emv: { what: 'سهولة الحركة — كم حجم لزم لتحريك السعر', alt: 'atr — مدى الحركة بدون الحجم' },
  ease_of_movement: { what: 'سهولة الحركة', alt: 'atr' },
  elder_force_index: { what: 'قوة إلدر — التغيّر السعري × الحجم', alt: 'bull_power / bear_power — نفس مدرسة إلدر بدون حجم' },
  liquidity_score: { what: 'درجة السيولة عند المستوى الحالي', alt: 'sr_support / sr_resistance' },
  volume_profile: { what: 'تصنيف العقدة السعرية حسب كثافة الحجم', alt: 'market_profile — نفس الفكرة من التوزيع الزمني' },
  wyckoff_phase: { what: 'مرحلة دورة وايكوف (ps · sc · ar · st · sos · lps · bc · utad)', alt: 'wyckoff_spring · wyckoff_upthrust · accumulation · distribution — أجزاء المرحلة كلٌ على حدة، وكلها سعرية' },
  kelly_criterion: { what: 'نسبة كيلي لحجم المخاطرة من تاريخ نتائج الصفقات', alt: 'لا يوجد — يحتاج تاريخ حساب لا يصل للمؤشر' },
};

const STUB_ALT: Record<string, string> = {
  'أون-تشين': 'لا يوجد — بيانات بلوكتشين، لا علاقة لها بشموع الفوركس',
  'تعلّم آلي': 'لا يوجد — يحتاج نموذجاً مدرَّباً ونقطة استدلال',
  'بيانات خارجية': 'لا يوجد — يحتاج مزوّد بيانات سوق منفصل',
  'تدفّق أوامر ومشتقات': 'لا يوجد — يحتاج دفتر أوامر أو بيانات مشتقات',
};

const REENABLE: Record<string, string> = {
  حجم: 'أن يوفّر مصدر الشموع حجماً حقيقياً',
  'أون-تشين': 'ربط مفهرس بلوكتشين',
  'تعلّم آلي': 'نموذج مدرَّب + نقطة استدلال',
  'بيانات خارجية': 'اشتراك في مزوّد بيانات سوق',
  'تدفّق أوامر ومشتقات': 'دفتر أوامر أو تغذية مشتقات',
};

// ── Render ─────────────────────────────────────────────────────────────────

const c = audit.coverage;
const lines: string[] = [];

lines.push('# المؤشرات المعطّلة');
lines.push('');
lines.push(`> وُلِّد بـ \`scripts/build-unavailable-doc.mts\` من \`docs/liveness.json\`. لا تحرّره بالإيد.`);
lines.push('');
lines.push(`**${removed.length}** مؤشراً عُطِّل من أصل **359**. المتبقّي في المحرك: **${registered.size}**.`);
lines.push('');
lines.push('التنفيذ لم يُحذف. الملفات تحت `packages/engine/src/indicators/unavailable/` وغير مستوردة من `index.ts`، فالاسم وحده هو ما اختفى من الريجستري. أي واحد منها يعود للعمل بمجرد إعادة سطر الاستيراد ووجود البيانات.');
lines.push('');
lines.push('## العيّنة التي بُني عليها الحكم');
lines.push('');
lines.push('| | |');
lines.push('|---|---|');
lines.push(`| الرموز | ${c['symbolsInSystem']} |`);
lines.push(`| القطع المتصلة | ${c['contiguousSegments']} من ${c['windowsFetched']} نافذة |`);
lines.push(`| الشموع | ${c['barsUsed']} |`);
lines.push(`| التقييمات لكل مؤشر | ${c['evaluationsPerIndicator']} |`);
lines.push(`| تغطية الساعات | ${c['hoursCovered']} |`);
lines.push(`| أيام مختلفة | ${c['distinctDays']} |`);
lines.push(`| فجوات وُجدت | ${c['gapsFound']} |`);
lines.push(`| شموع أُهملت (قطع قصيرة) | ${c['barsDiscardedAsTooShort']} |`);
lines.push('');
lines.push(`> ${c['contiguousDaysNote']}`);
lines.push('');
lines.push('## المعايير');
lines.push('');
lines.push('| # | المعيار |');
lines.push('|---|---|');
lines.push('| 1 | قيمة واحدة في 100% من التقييمات |');
lines.push('| 2 | NaN / undefined / exception ولو مرة |');
lines.push('| 3 | يقرأ مدخلاً غير موجود في البيانات |');
lines.push('| 4 | تنفيذ ثابت مكتوب في الكود |');
lines.push('');

// Grouped by school
const bySchool = new Map<string, Verdict[]>();
for (const v of removed) {
  const s = school(v.name);
  bySchool.set(s, [...(bySchool.get(s) ?? []), v]);
}

lines.push('## المعطَّل، حسب المدرسة');
lines.push('');
for (const [name, list] of [...bySchool].sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`### ${name} — ${list.length}`);
  lines.push('');
  lines.push('| المؤشر | يقيس | سبب السقوط | البديل |');
  lines.push('|---|---|---|---|');
  for (const v of list.sort((a, b) => a.name.localeCompare(b.name))) {
    const note = NOTES[v.name];
    const what = note?.what ?? '—';
    const alt = note?.alt ?? STUB_ALT[name] ?? 'لا يوجد';
    const why = v.reasons
      .map((r) => r.replace(/^معيار (\d): /, '**$1** '))
      .join(' · ');
    lines.push(`| \`${v.name}\` | ${what} | ${why} | ${alt} |`);
  }
  lines.push('');
  lines.push(`**شرط العودة:** ${REENABLE[name] ?? 'توفّر البيانات التي يحتاجها'}`);
  lines.push('');
}

lines.push('## مرشَّح — بانتظار داتا أوسع');
lines.push('');
lines.push(`**${waiting.length}** مؤشراً سقط بالمعيار 1 وحده، ولم يُشَل.`);
lines.push('');
lines.push('العيّنة تغطي 24/24 ساعة لكن ~3.2 يوم متصلة فقط. هذا يكفي للحكم على مؤشر زخم أو اتجاه، ولا يكفي لنمط يظهر مرة في الشهر ولا لمرشّح جلسات. الحكم عليها مؤجَّل حتى يتراكم تاريخ أطول.');
lines.push('');
lines.push('| المؤشر | المدرسة | القيمة الوحيدة المرصودة |');
lines.push('|---|---|---|');
for (const v of waiting.sort((a, b) => a.name.localeCompare(b.name))) {
  lines.push(`| \`${v.name}\` | ${school(v.name)} | \`${v.values[0] ?? '—'}\` |`);
}
lines.push('');
lines.push('## الباقي في المحرك');
lines.push('');
lines.push(`**${registered.size}** مؤشراً أنتج قيمتين مختلفتين على الأقل من حساب حقيقي.`);
lines.push('');
lines.push('`vwap` و `price_vs_vwap` استُثنيا من الشيل رغم قراءتهما للحجم: الحجم الثابت يُختصر من `Σ(typical × V) / ΣV` تماماً فيتبقّى متوسط السعر النموذجي — مُتحقَّق منه حتى 1e-12 في `test/volume-meta.test.ts`. حساب صحيح باسم مضلِّل، لا رقم فاسد.');
lines.push('');

writeFileSync('docs/unavailable-indicators.md', `${lines.join('\n')}\n`);

console.log(`معطّل: ${removed.length} · مرشّح: ${waiting.length} · باقٍ: ${registered.size}`);
console.log('المدارس:', [...bySchool].map(([k, v]) => `${k}=${v.length}`).join(' · '));
console.log('كُتب: docs/unavailable-indicators.md');
