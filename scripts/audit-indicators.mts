/**
 * Full audit of all 359 indicators against a sample wide enough to judge them.
 *
 * Written after two wrong calls made from too little data: kill_zone was
 * declared dead on a window covering three hours of the day, and the strategy
 * reference recorded "observed values: none" for indicators that simply never
 * fired on the fixture. So every verdict here carries the coverage it was made
 * on, and anything the sample cannot speak to is reported as SUSPECT rather
 * than dead.
 *
 * Run: npx tsx scripts/audit-indicators.mts
 */

import { readFileSync, readdirSync } from 'node:fs';
import {
  computeIndicator,
  makeRule,
  registeredNames,
  type Candle,
} from '../packages/engine/src/index.js';

const PROXY = 'https://euro-trade-proxy-1.onrender.com';
/** 1m spans three hours of the day; these span a day and a month. */
const FRAMES = ['15m', '1h'];
const PAIRS = [
  'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'AUDUSD_otc', 'USDCAD_otc',
  'USDCHF_otc', 'NZDUSD_otc', 'EURGBP_otc', 'EURJPY_otc', 'GBPJPY_otc',
];

async function candlesFor(symbol: string, interval: string): Promise<Candle[]> {
  const res = await fetch(`${PROXY}/api/otc/candles?symbol=${symbol}&interval=${interval}`, {
    signal: AbortSignal.timeout(25_000),
  });
  const body = (await res.json()) as { candles?: Array<Record<string, number>> };
  return (body.candles ?? [])
    .filter((c) => ['o', 'h', 'l', 'c', 't'].every((k) => typeof c[k] === 'number'))
    .map((c) => ({
      open: c['o']!, high: c['h']!, low: c['l']!, close: c['c']!,
      // The feed carries no volume — Pocket Option streams prices only. The app
      // substitutes a constant, so this mirrors what the engine really sees.
      volume: 1000,
      time: c['t']! * 1000,
    }));
}

const windows: Array<{ label: string; candles: Candle[] }> = [];
for (const frame of FRAMES) {
  for (const pair of PAIRS) {
    try {
      const c = await candlesFor(pair, frame);
      if (c.length > 30) windows.push({ label: `${pair}/${frame}`, candles: c });
    } catch {
      // Unavailable pair, not an indicator fault.
    }
  }
}

const hours = new Set<number>();
const days = new Set<string>();
let candleCount = 0;
for (const w of windows) {
  for (const c of w.candles) {
    const d = new Date(c.time);
    hours.add(d.getUTCHours());
    days.add(d.toISOString().slice(0, 10));
    candleCount++;
  }
}

console.log('═══════════ العيّنة ═══════════');
console.log(`${windows.length} مجموعة (${FRAMES.join(' + ')} × ${PAIRS.length} أزواج) = ${candleCount} شمعة`);
console.log(`تغطية: ${hours.size}/24 ساعة UTC · ${days.size} يوم\n`);

const clockFor = (c: Candle) => {
  const d = new Date(c.time);
  const jsDay = d.getDay();
  return { utcHour: d.getUTCHours(), weekday: jsDay === 0 ? 7 : jsDay };
};

// ── Probe every indicator ──────────────────────────────────────────────────

interface Result {
  values: Map<string, number>;
  evaluations: number;
  nan: number;
  undef: number;
  threw: number;
  /** Does its answer move when volume does? */
  volumeSensitive: boolean;
}

const results = new Map<string, Result>();

for (const name of registeredNames()) {
  const rule = makeRule({ indicator: name, condition: 'eq', signal: 'CALL', score: 1 });
  const values = new Map<string, number>();
  let evaluations = 0, nan = 0, undef = 0, threw = 0;

  for (const w of windows) {
    for (let i = 25; i < w.candles.length; i++) {
      const slice = w.candles.slice(0, i + 1);
      const cur = slice[slice.length - 1]!;
      try {
        const v = computeIndicator(slice, rule, cur.close, clockFor(cur), new Map());
        evaluations++;
        if (v === undefined) { undef++; continue; }
        if (typeof v === 'number' && !Number.isFinite(v)) { nan++; continue; }
        const key = typeof v === 'number' ? String(Number(v.toFixed(6))) : v;
        values.set(key, (values.get(key) ?? 0) + 1);
      } catch {
        threw++;
      }
    }
  }

  // Volume sensitivity, measured rather than grepped: a helper the indicator
  // delegates to would not show up in a source scan.
  let volumeSensitive = false;
  const base = windows[0]!.candles;
  const varied = base.map((c, i) => ({ ...c, volume: 500 + ((i * 97) % 3000) }));
  const price = base[base.length - 1]!.close;
  const clock = clockFor(base[base.length - 1]!);
  try {
    const a = computeIndicator(base, rule, price, clock, new Map());
    const b = computeIndicator(varied, rule, price, clock, new Map());
    volumeSensitive = String(a) !== String(b);
  } catch {
    // Leave false.
  }

  results.set(name, { values, evaluations, nan, undef, threw, volumeSensitive });
}

// ── 1 + 4. Constant indicators, split by whether the sample can judge them ──

const CLOCK_DEPENDENT = new Set([
  'day_of_week', 'judas_swing', 'kill_zone', 'session', 'session_overlap', 'time_analysis',
]);

const reference = JSON.parse(readFileSync('docs/strategy-reference.json', 'utf8')) as {
  rules: Array<Record<string, unknown>>;
};
const refNoneOnly = new Set(
  reference.rules
    .filter((r) => typeof r['indicator'] === 'string' && String(r['_note'] ?? '').includes('observed values: none.'))
    .map((r) => String(r['indicator'])),
);

const constant: Array<{ name: string; value: string; volumeSensitive: boolean }> = [];
const moving: string[] = [];

for (const [name, r] of results) {
  if (r.values.size === 1) {
    constant.push({ name, value: [...r.values.keys()][0]!, volumeSensitive: r.volumeSensitive });
  } else if (r.values.size > 1) {
    moving.push(name);
  }
}

console.log('═══════════ 1. مؤشرات بترجّع قيمة واحدة في 100% من التقييمات ═══════════');
console.log(`العدد: ${constant.length} من ${results.size}\n`);
for (const c of constant.sort((a, b) => a.name.localeCompare(b.name))) {
  const why = c.volumeSensitive ? '  ← يقرا الحجم (ثابت في الداتا)' : '';
  console.log(`  ${c.name.padEnd(34)} = ${c.value}${why}`);
}

// ── 2. Broken ──────────────────────────────────────────────────────────────

console.log('\n═══════════ 2. مؤشرات بترمي أو ترجّع NaN / undefined ═══════════');
const broken = [...results].filter(([, r]) => r.nan > 0 || r.undef > 0 || r.threw > 0);
if (broken.length === 0) console.log('  لا شيء ✅');
for (const [name, r] of broken) {
  const parts: string[] = [];
  if (r.nan) parts.push(`NaN ×${r.nan}`);
  if (r.undef) parts.push(`undefined ×${r.undef}`);
  if (r.threw) parts.push(`exception ×${r.threw}`);
  const pct = ((r.nan + r.undef + r.threw) / (r.evaluations || 1)) * 100;
  console.log(`  ${name.padEnd(34)} ${parts.join(', ')}  (${pct.toFixed(1)}% من التقييمات)`);
}

// ── 3. Written but never registered ────────────────────────────────────────

console.log('\n═══════════ 3. دوال مكتوبة ومش متسجّلة ═══════════');
const dir = 'packages/engine/src/indicators';
const exported = new Map<string, string>();
const registeredIn = new Set<string>();

for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(`${dir}/${file}`, 'utf8');
  for (const m of src.matchAll(/export function ([a-zA-Z0-9_]+)/g)) exported.set(m[1]!, file);
  // Anything named inside a register(...) call is reachable.
  for (const m of src.matchAll(/register\((?:\[([^\]]*)\]|'([^']*)')/g)) {
    const names = (m[1] ?? m[2] ?? '').split(',').map((s) => s.trim().replace(/['"]/g, ''));
    for (const n of names) if (n) registeredIn.add(n);
  }
  // A helper used by another indicator is reachable too, just not directly.
  for (const m of src.matchAll(/=>\s*([a-zA-Z0-9_]+)\(/g)) registeredIn.add(m[1]!);
  for (const m of src.matchAll(/\bm\.([a-zA-Z0-9_]+)\(/g)) registeredIn.add(m[1]!);
  for (const m of src.matchAll(/\b([a-zA-Z0-9_]+)\(candles/g)) registeredIn.add(m[1]!);
}

const orphans = [...exported].filter(([fn]) => !registeredIn.has(fn));
if (orphans.length === 0) console.log('  لا شيء ✅');
for (const [fn, file] of orphans) console.log(`  ${fn.padEnd(34)} في ${file}`);

// ── 4. Reference "none"-only, re-checked ───────────────────────────────────

console.log('\n═══════════ 4. مؤشرات المرجع كتب لها "none" فقط ═══════════');
console.log(`العدد في المرجع: ${refNoneOnly.size}\n`);
const revived: string[] = [];
const stillNone: string[] = [];
for (const name of [...refNoneOnly].sort()) {
  const r = results.get(name);
  if (!r) continue;
  if (r.values.size > 1) revived.push(`${name} → ${[...r.values.keys()].slice(0, 4).join(' | ')}`);
  else stillNone.push(name);
}
console.log(`اتحرّكوا على العيّنة الواسعة (${revived.length}):`);
for (const r of revived) console.log('  ✅', r);
console.log(`\nفضلوا ثابتين (${stillNone.length}):`);
console.log('  ', stillNone.join(', ') || 'لا شيء');

// ── 6. Depends on data the feed does not carry ─────────────────────────────

console.log('\n═══════════ 6. مؤشرات بتقرا الحجم ═══════════');
const volumeReaders = [...results].filter(([, r]) => r.volumeSensitive).map(([n]) => n);
console.log(`العدد: ${volumeReaders.length}\n`);
for (const n of volumeReaders.sort()) {
  const r = results.get(n)!;
  const state = r.values.size === 1 ? `ثابت على "${[...r.values.keys()][0]}"` : `${r.values.size} قيم مختلفة`;
  console.log(`  ${n.padEnd(34)} ${state}`);
}

// ── Verdict buckets ────────────────────────────────────────────────────────

console.log('\n═══════════ الخلاصة ═══════════');
const suspect = constant.filter((c) => CLOCK_DEPENDENT.has(c.name));
const deadByVolume = constant.filter((c) => c.volumeSensitive);
const deadOther = constant.filter((c) => !c.volumeSensitive && !CLOCK_DEPENDENT.has(c.name));

console.log(`سليم (بيتحرّك)          : ${moving.length}`);
console.log(`ميت بسبب الحجم المفقود  : ${deadByVolume.length}`);
console.log(`ثابت لأسباب تانية       : ${deadOther.length}`);
console.log(`مشكوك فيه (زمني)        : ${suspect.length}`);
console.log(`مكسور (NaN/exception)   : ${broken.length}`);
console.log(`\nالحكم اتبنى على تغطية ${hours.size}/24 ساعة على ${days.size} يوم، ${candleCount} شمعة.`);
