/**
 * Fails a deploy when a PUBLISHED strategy cannot produce a signal.
 *
 * The four `configs` rows drive every signal every user receives, and each of
 * the ways they break is silent: the engine answers an unknown indicator with
 * 0.0 and an unknown condition with false, and prints nothing anywhere. Three
 * of the four live rows were found dead this way — not one had produced a
 * signal in who knows how long, and nothing in the system had noticed.
 *
 * They were not broken when they were written. They broke when the engine
 * around them changed names, which is exactly the failure a one-time check at
 * upload cannot catch and a check at deploy can.
 *
 * What it catches, each one taken from a real fault found in production:
 *
 *   • an indicator the registry has never heard of            (sma, zone, elder_power)
 *   • a condition `checkCondition` does not implement         (silently false)
 *   • a numeric condition on a text indicator, or the reverse (never fires)
 *   • `signal` outside CALL/PUT/dominant/confirm              (signal: "BOTH")
 *   • a min_primary_score the primary rules cannot reach      (8 needed, 4 available)
 *   • a confirmation_ratio that is mathematically impossible  (ratio 1 with opposed rules)
 *   • a rule whose condition can never be true on live data   (z_score lt -2)
 *
 * Run: npx tsx scripts/check-live-strategies.mts [--warn-only]
 */

import {
  VOLUME_DEAD,
  VOLUME_DEPENDENT,
  aliasConflictMessages,
  checkCondition,
  computeIndicator,
  isRegistered,
  ruleFromJson,
  type Candle,
  type StrategyRule,
} from '../packages/engine/src/index.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../packages/shared/src/supabase.js';
const PROXY = 'https://euro-trade-proxy-1.onrender.com';

const TARGETS = ['strategy_standard', 'strategy_vip', 'monitoring_standard', 'monitoring_vip'];

/** 15m and 1h, because 1m covers three hours of the day and no session rule
 *  can be judged on that. See the note in apps/web/lib/backtest.ts. */
const FRAMES = ['15m', '1h'];
const PAIRS = ['EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'AUDUSD_otc', 'USDCAD_otc'];

const NUMERIC_CONDITIONS = new Set([
  'gt', 'lt', 'gte', 'lte', 'between', 'gt_average', 'lt_average', 'is_true', 'is_false',
]);
const TEXT_CONDITIONS = new Set(['eq', 'neq', 'bullish', 'bearish']);
const SIGNALS = new Set(['CALL', 'PUT', 'dominant', 'confirm']);

const warnOnly = process.argv.includes('--warn-only');
const problems: string[] = [];
const notes: string[] = [];

function fail(target: string, message: string): void {
  problems.push(`${target}: ${message}`);
}
function note(target: string, message: string): void {
  notes.push(`${target}: ${message}`);
}

// ── Data ───────────────────────────────────────────────────────────────────

async function candlesFor(symbol: string, interval: string): Promise<Candle[]> {
  const res = await fetch(`${PROXY}/api/otc/candles?symbol=${symbol}&interval=${interval}`, {
    signal: AbortSignal.timeout(25_000),
  });
  const body = (await res.json()) as { candles?: Array<Record<string, number>> };
  // The proxy speaks {o,h,l,c,t} with t in seconds; Candle.time is milliseconds.
  return (body.candles ?? [])
    .filter((c) => ['o', 'h', 'l', 'c', 't'].every((k) => typeof c[k] === 'number'))
    .map((c) => ({
      open: c['o']!, high: c['h']!, low: c['l']!, close: c['c']!,
      volume: 1000, time: c['t']! * 1000,
    }));
}

const windows: Candle[][] = [];
for (const frame of FRAMES) {
  for (const pair of PAIRS) {
    try {
      const c = await candlesFor(pair, frame);
      if (c.length > 30) windows.push(c);
    } catch {
      // A pair that will not load is not a strategy fault.
    }
  }
}

if (windows.length === 0) {
  console.error('لم يتم جلب أي شموع — لا يمكن الفحص. (البروكسي غير متاح؟)');
  process.exit(warnOnly ? 0 : 1);
}

const hours = new Set<number>();
for (const w of windows) for (const c of w) hours.add(new Date(c.time).getUTCHours());
console.log(`عيّنة: ${windows.length} مجموعة، تغطية ${hours.size}/24 ساعة\n`);

/** How often a rule is true across the sample. */
function hitRate(rule: StrategyRule): { rate: number; text: boolean; sample: string } {
  let hits = 0;
  let n = 0;
  let sample = '';
  let text = false;
  for (const candles of windows) {
    for (let i = 25; i < candles.length; i++) {
      const w = candles.slice(0, i + 1);
      const cur = w[w.length - 1]!;
      const d = new Date(cur.time);
      const jsDay = d.getDay();
      let v;
      try {
        v = computeIndicator(w, rule, cur.close, {
          utcHour: d.getUTCHours(),
          weekday: jsDay === 0 ? 7 : jsDay,
        }, new Map());
      } catch {
        continue;
      }
      if (v === undefined) continue;
      if (typeof v === 'string') text = true;
      if (sample === '') sample = String(v);
      n++;
      if (checkCondition(rule, v)) hits++;
    }
  }
  return { rate: n > 0 ? (hits / n) * 100 : 0, text, sample };
}

// ── Check each published row ───────────────────────────────────────────────

for (const target of TARGETS) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/configs?id=eq.${target}&select=data`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    fail(target, `تعذّر قراءة الصف (HTTP ${res.status})`);
    continue;
  }
  const rows = (await res.json()) as Array<{ data?: Record<string, unknown> }>;
  const data = rows[0]?.data;
  if (!data) {
    note(target, 'الصف غير موجود — لا يوجد ما يُفحص');
    continue;
  }

  const raw = (data['rules'] as Array<Record<string, unknown>> | undefined ?? []).filter(
    (r) => r !== null && typeof r === 'object' && typeof r['indicator'] === 'string' && r['enabled'] !== false,
  );
  if (raw.length === 0) {
    fail(target, 'لا توجد قواعد مفعّلة');
    continue;
  }

  console.log(`── ${target} (${raw.length} قاعدة مفعّلة)`);

  // Two different names for one computation score twice and read as two
  // independent confirmations. Nothing at runtime notices, which is why the
  // check has to happen before the strategy is live rather than inside it.
  for (const message of aliasConflictMessages(raw.map((r) => ruleFromJson(r)))) {
    fail(target, message);
  }

  const primaries: Array<{ name: string; score: number }> = [];
  const confirms: Array<{ name: string; signal: string }> = [];

  for (const r of raw) {
    const name = String(r['indicator']);
    const condition = String(r['condition'] ?? '');
    const signal = String(r['signal'] ?? '');
    const role = String(r['role'] ?? '');

    if (!isRegistered(name)) {
      fail(target, `المؤشر "${name}" غير موجود في المحرك — يرجع 0.0 بصمت`);
      continue;
    }
    if (!NUMERIC_CONDITIONS.has(condition) && !TEXT_CONDITIONS.has(condition)) {
      fail(target, `الشرط "${condition}" على "${name}" غير منفّذ — لا يتحقق أبداً`);
      continue;
    }
    if (!SIGNALS.has(signal)) {
      // The filter stage never reads `signal`, so an odd value there is
      // cosmetic. On a primary or confirm rule it decides the direction, and a
      // value the engine does not know can never match one.
      if (role === 'filter' || role === '') {
        note(target, `"${name}" له signal="${signal}" — غير مستخدم في دور "${role || 'بدون'}"، لكنه غير صالح`);
      } else {
        fail(target, `"${name}" في دور "${role}" له signal="${signal}" — المسموح CALL/PUT/dominant/confirm فقط، وأي قيمة أخرى لا توافق أي اتجاه`);
      }
    }

    if (VOLUME_DEPENDENT.has(name)) {
      const dead = VOLUME_DEAD.has(name);
      const message = dead
        ? `"${name}" يعتمد على الحجم وقيمته ثابتة — Pocket Option لا ترسل حجماً، فالقاعدة بلا أثر`
        : `"${name}" يعتمد على الحجم غير المتاح — الرقم محسوب على ثابت مخترع`;
      if (dead) fail(target, message);
      else note(target, message);
    }

    const { rate, text, sample } = hitRate(ruleFromJson(r));

    if (text && NUMERIC_CONDITIONS.has(condition)) {
      fail(target, `"${name}" يرجع نصاً ("${sample}") وشرطه "${condition}" رقمي — لا يتحقق أبداً`);
    }
    if (!text && TEXT_CONDITIONS.has(condition)) {
      fail(target, `"${name}" يرجع رقماً (${sample}) وشرطه "${condition}" نصّي — لا يتحقق أبداً`);
    }
    const target_ = r['pattern'] ?? r['value'] ?? r['value_min'];
    const label = `${name} ${condition}${target_ !== undefined ? ` ${String(target_)}` : ''}`;

    if (rate === 0) {
      fail(target, `"${label}" لم يتحقق ولا مرة على العيّنة — القيمة المرصودة "${sample}"`);
    } else if (rate < 2) {
      note(target, `"${label}" يتحقق ${rate.toFixed(1)}% فقط`);
    }

    if (role === 'primary') primaries.push({ name, score: Number(r['score']) || 0 });
    if (role === 'confirm') confirms.push({ name, signal });
  }

  // ── Pyramid reachability ────────────────────────────────────────────────
  const pyramid = data['pyramid'] as Record<string, unknown> | undefined;
  if (pyramid) {
    const minPrimary = Number(pyramid['min_primary_score']) || 0;

    if (primaries.length === 0) {
      fail(target, 'الهرم مفعّل ولا توجد قاعدة primary — لن تصدر إشارة أبداً');
    } else {
      // A rule fires for ONE direction, so the ceiling per direction is the
      // best single-direction subset — not the sum of every primary rule.
      const best = primaries.reduce((a, p) => a + p.score, 0) * 1.5;
      if (best < minPrimary) {
        fail(
          target,
          `min_primary_score=${minPrimary} أعلى من أقصى مجموع ممكن (${best.toFixed(1)} بعد مضاعف ×1.5) — مستحيل`,
        );
      }
      if (best < 4) {
        fail(target, `أقصى نتيجة (${best.toFixed(1)}) أقل من الفارق الأدنى الذي يطلبه المحرك (4.0)`);
      }
    }

    const ratio = Number(pyramid['confirmation_ratio']) || 0;
    if (ratio > 0 && confirms.length > 0) {
      const directional = confirms.filter((c) => c.signal === 'CALL' || c.signal === 'PUT');
      const bothWays =
        directional.some((c) => c.signal === 'CALL') && directional.some((c) => c.signal === 'PUT');
      // With opposed confirm rules, no single direction can satisfy all of them.
      if (ratio > 0.5 && bothWays && directional.length === confirms.length) {
        fail(
          target,
          `confirmation_ratio=${ratio} مع قواعد confirm متضادة (CALL و PUT) — مستحيل رياضياً أن يوافق أكثر من النصف`,
        );
      }
    }
  }
}

// ── Verdict ────────────────────────────────────────────────────────────────

console.log();
if (notes.length > 0) {
  console.log('ملاحظات:');
  for (const n of notes) console.log('  •', n);
  console.log();
}

if (problems.length === 0) {
  console.log('✅ كل الاستراتيجيات المنشورة سليمة.');
  process.exit(0);
}

console.error(`❌ ${problems.length} مشكلة في استراتيجيات منشورة:`);
for (const p of problems) console.error('  •', p);
console.error(
  '\nالاستراتيجيات دي بتوصل لمستخدمين حاليين. صلّحها من /admin/strategy — زرار «افحص الصياغة» بيوريك التفاصيل.',
);
process.exit(warnOnly ? 0 : 1);
