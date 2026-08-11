/**
 * Decides, per indicator, whether it computes anything at all.
 *
 * Four criteria, applied mechanically — no judgement, no opinion:
 *
 *   1. returned one single value across every evaluation
 *   2. returned NaN / undefined, or threw, even once
 *   3. reads an input the feed does not carry (volume)
 *   4. its implementation is a hardcoded constant
 *
 * Anything that produced two different values from a real calculation survives,
 * however seldom it moved. Rare is not dead: a pattern firing three times in a
 * month is working, and its frequency is recorded rather than held against it.
 *
 * ── THREE THINGS THIS HAD TO GET RIGHT ────────────────────────────────────
 *
 * WALK THE WINDOW. Evaluating only the last bar of a series misses every
 * pattern that formed and resolved inside it. That mistake alone had 57 working
 * indicators recorded as dead.
 *
 * PAIRS AND HOURS ARE DIFFERENT AXES. Every pair is sampled at the same
 * wall-clock moments, so adding pairs multiplies market CONDITIONS and does
 * nothing for clock COVERAGE. 183 pairs give a sample big enough for any
 * statistical call; they still only span 3.2 contiguous days. Both numbers are
 * reported, never conflated.
 *
 * DO NOT GLUE ACROSS GAPS. The scraper only stores while it is running, so a
 * pair's 77 hourly bars are scattered over 34 days with 15 holes in them. Read
 * as one series, each hole is a phantom jump — a gap of days looks like one
 * violent candle. Every window is therefore split into contiguous runs and each
 * is evaluated on its own, and a run shorter than the indicator's lookback is
 * skipped rather than fed a window it cannot fill.
 *
 * Writes docs/liveness.json.
 *
 * Run: npx tsx scripts/audit-liveness.mts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  VOLUME_DEPENDENT,
  computeIndicator,
  makeRule,
  registeredNames,
  type Candle,
} from '../packages/engine/src/index.js';

const PROXY = 'https://euro-trade-proxy-1.onrender.com';

/** Seconds between bars, per frame — used to spot a gap. */
const FRAMES: Array<{ name: string; step: number }> = [
  { name: '1h', step: 3600 },
  { name: '15m', step: 900 },
  { name: '5m', step: 300 },
];

const STRIDE = 2;
const WARMUP = 30;
/** A run shorter than this cannot fill any indicator's lookback. */
const MIN_SEGMENT = 35;

/**
 * Judgement is withheld from these when they fail criterion 1 alone: the sample
 * is too narrow to convict them, and a wrong removal is worse than a delay.
 */
const CLOCK_DEPENDENT = new Set([
  'day_of_week', 'judas_swing', 'kill_zone', 'session', 'session_overlap', 'time_analysis',
  'silver_bullet',
]);

/** Patterns that legitimately appear once or twice a month. */
const INHERENTLY_RARE = new Set([
  'bear_flag', 'bull_flag', 'cup_and_handle', 'island_reversal', 'liquidity',
  'market_maker_buy_model', 'no_demand', 'no_supply', 'reaccumulation', 'redistribution',
  'rounding_bottom', 'rounding_top', 'three_drives', 'vcp', 'vsa',
]);

async function allSymbols(): Promise<string[]> {
  const res = await fetch(`${PROXY}/api/otc/status`, { signal: AbortSignal.timeout(30_000) });
  const rows = (await res.json()) as Array<{ id: string; data?: Record<string, unknown> }>;
  return Object.keys(rows.find((r) => r.id === 'otc_prices')?.data ?? {});
}

async function candlesFor(symbol: string, interval: string): Promise<Candle[]> {
  const res = await fetch(
    `${PROXY}/api/otc/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  const body = (await res.json()) as { candles?: Array<Record<string, number>> };
  return (body.candles ?? [])
    .filter((c) => ['o', 'h', 'l', 'c', 't'].every((k) => typeof c[k] === 'number'))
    .map((c) => ({
      open: c['o']!, high: c['h']!, low: c['l']!, close: c['c']!,
      // The feed has no volume field; the app substitutes a constant, so this
      // is exactly what the engine sees in production.
      volume: 1000,
      time: c['t']! * 1000,
    }));
}

/** Splits a series wherever the spacing jumps, so no window straddles a hole. */
function contiguousRuns(candles: Candle[], stepSeconds: number): Candle[][] {
  const runs: Candle[][] = [];
  let run: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i > 0) {
      const delta = (candles[i]!.time - candles[i - 1]!.time) / 1000;
      if (delta > stepSeconds * 1.5) {
        if (run.length >= MIN_SEGMENT) runs.push(run);
        run = [];
      }
    }
    run.push(candles[i]!);
  }
  if (run.length >= MIN_SEGMENT) runs.push(run);
  return runs;
}

// ── Sample ─────────────────────────────────────────────────────────────────

const pairs = await allSymbols();
console.log(`الرموز في النظام: ${pairs.length}`);

/** Segmented — the sample every verdict is made on. */
const segments: Candle[][] = [];
/** Whole windows, kept only to measure what the segmentation changed. */
const gluedHourly: Candle[][] = [];

const hours = new Set<number>();
const days = new Set<string>();
let bars = 0;
let gapsFound = 0;
let discardedShort = 0;
let fetched = 0;

for (const frame of FRAMES) {
  for (const pair of pairs) {
    let candles: Candle[];
    try {
      candles = await candlesFor(pair, frame.name);
    } catch {
      continue;
    }
    if (candles.length < MIN_SEGMENT) continue;
    fetched++;

    const runs = contiguousRuns(candles, frame.step);
    // Anything the segmentation threw away, counted rather than ignored.
    const kept = runs.reduce((n, r) => n + r.length, 0);
    if (kept < candles.length) discardedShort += candles.length - kept;
    gapsFound += Math.max(0, runs.length - 1);

    for (const run of runs) {
      segments.push(run);
      bars += run.length;
      for (const c of run) {
        const d = new Date(c.time);
        hours.add(d.getUTCHours());
        days.add(d.toISOString().slice(0, 10));
      }
    }
    if (frame.name === '1h') gluedHourly.push(candles);
  }
  console.log(`  ${frame.name}: ${segments.length} قطعة متصلة حتى الآن`);
}

const evaluationsPer = segments.reduce(
  (n, s) => n + Math.max(0, Math.ceil((s.length - WARMUP) / STRIDE)),
  0,
);

const coverage = {
  symbolsInSystem: pairs.length,
  windowsFetched: fetched,
  contiguousSegments: segments.length,
  gapsFound,
  barsDiscardedAsTooShort: discardedShort,
  barsUsed: bars,
  hoursCovered: `${hours.size}/24`,
  distinctDays: days.size,
  contiguousDaysNote:
    'أطول امتداد متصل ~3.2 يوم. عدد التقييمات كبير، لكن التغطية الزمنية ليست كذلك — كل الأزواج تُسجَّل في نفس اللحظات.',
  evaluationsPerIndicator: evaluationsPer,
};

console.log('\n═══ العيّنة ═══');
console.log(`${segments.length} قطعة متصلة من ${fetched} نافذة · ${bars} شمعة`);
console.log(`${gapsFound} فجوة · ${discardedShort} شمعة اتشالت (قطع أقصر من ${MIN_SEGMENT})`);
console.log(`تغطية ${hours.size}/24 ساعة · ${days.size} يوم · ${evaluationsPer} تقييم لكل مؤشر\n`);

// ── Criterion 4 ────────────────────────────────────────────────────────────

const HARDCODED = new Set(
  [...readFileSync('packages/engine/src/indicators/placeholders.ts', 'utf8')
    .matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!),
);

// ── Probe ──────────────────────────────────────────────────────────────────

interface Probe { counts: Map<string, number>; nan: number; undef: number; threw: number }

function probe(name: string, windows: Candle[][]): Probe {
  const rule = makeRule({ indicator: name, condition: 'eq', signal: 'CALL', score: 1 });
  const counts = new Map<string, number>();
  let nan = 0, undef = 0, threw = 0;

  for (const w of windows) {
    for (let i = WARMUP; i < w.length; i += STRIDE) {
      const slice = w.slice(0, i + 1);
      const cur = slice[slice.length - 1]!;
      const d = new Date(cur.time);
      const jsDay = d.getDay();
      try {
        const v = computeIndicator(slice, rule, cur.close, {
          utcHour: d.getUTCHours(),
          weekday: jsDay === 0 ? 7 : jsDay,
        }, new Map());
        if (v === undefined) { undef++; continue; }
        if (typeof v === 'number' && !Number.isFinite(v)) { nan++; continue; }
        const key = typeof v === 'number' ? String(Number(v.toFixed(8))) : v;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      } catch {
        threw++;
      }
    }
  }
  return { counts, nan, undef, threw };
}

export type Grade = 'A' | 'B' | 'alive';

const verdicts: Array<{
  name: string;
  grade: Grade;
  reasons: string[];
  distinctValues: number;
  values: string[];
  evaluations: number;
  movementRate: number;
  nan: number; undef: number; threw: number;
  changedBySegmentation: boolean;
}> = [];

const names = registeredNames();

for (const [index, name] of names.entries()) {
  if (index % 30 === 0) console.log(`  ${index}/${names.length}…`);

  const p = probe(name, segments);
  const total = [...p.counts.values()].reduce((a, b) => a + b, 0);
  const commonest = Math.max(0, ...p.counts.values());

  // Gaps only exist on the hourly frame in any number, so the comparison is
  // run there — cheap, and it answers the question exactly.
  const glued = probe(name, gluedHourly);
  const changedBySegmentation =
    [...p.counts.keys()].sort().join('|') !== [...glued.counts.keys()].sort().join('|');

  const reasons: string[] = [];
  if (p.counts.size <= 1) {
    reasons.push(`معيار 1: قيمة واحدة (${[...p.counts.keys()][0] ?? 'لا شيء'}) في ${total} تقييم`);
  }
  if (p.nan || p.undef || p.threw) {
    const parts: string[] = [];
    if (p.nan) parts.push(`NaN ×${p.nan}`);
    if (p.undef) parts.push(`undefined ×${p.undef}`);
    if (p.threw) parts.push(`exception ×${p.threw}`);
    reasons.push(`معيار 2: ${parts.join('، ')}`);
  }
  if (VOLUME_DEPENDENT.has(name)) reasons.push('معيار 3: يقرأ الحجم وهو غير موجود في البيانات');
  if (HARDCODED.has(name)) reasons.push('معيار 4: تنفيذ ثابت مكتوب في الكود');

  let grade: Grade = 'alive';
  if (reasons.length > 0) {
    const onlyCriterion1 = reasons.length === 1 && reasons[0]!.startsWith('معيار 1');
    // Criterion 1 alone is not enough to convict something the sample cannot
    // observe: 3.2 contiguous days cannot judge a session filter, and five days
    // cannot judge a pattern that appears monthly.
    grade = onlyCriterion1 && (CLOCK_DEPENDENT.has(name) || INHERENTLY_RARE.has(name)) ? 'B' : 'A';
  }

  verdicts.push({
    name, grade, reasons,
    distinctValues: p.counts.size,
    values: [...p.counts.keys()].slice(0, 8),
    evaluations: total,
    movementRate: total > 0 ? ((total - commonest) / total) * 100 : 0,
    nan: p.nan, undef: p.undef, threw: p.threw,
    changedBySegmentation,
  });
}

writeFileSync('docs/liveness.json', `${JSON.stringify({ coverage, verdicts }, null, 2)}\n`);

const a = verdicts.filter((v) => v.grade === 'A');
const b = verdicts.filter((v) => v.grade === 'B');
const alive = verdicts.filter((v) => v.grade === 'alive');
const changed = verdicts.filter((v) => v.changedBySegmentation);

console.log('\n═══ النتيجة ═══');
console.log(`حي              : ${alive.length}`);
console.log(`درجة أ (يتشال)  : ${a.length}`);
console.log(`درجة ب (ينتظر)  : ${b.length}  →  ${b.map((v) => v.name).join(', ')}`);
console.log(`\nاتغيرت نتيجتهم بتقسيم الفجوات: ${changed.length}`);
if (changed.length > 0 && changed.length <= 40) {
  console.log(`  ${changed.map((v) => v.name).join(', ')}`);
}
for (const c of [1, 2, 3, 4]) {
  console.log(`معيار ${c}: ${verdicts.filter((v) => v.reasons.some((r) => r.startsWith(`معيار ${c}`))).length}`);
}
console.log('\nكُتب: docs/liveness.json');
