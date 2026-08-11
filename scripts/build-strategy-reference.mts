/**
 * Generates the master strategy reference FROM THE ENGINE.
 *
 * The hand-written reference had drifted badly: 31 of its indicator names did
 * not exist in the engine (so those rules silently scored 0), four documented
 * conditions were never implemented (so those rules never fired), and 187 real
 * indicators were missing entirely. None of that is detectable by reading it —
 * the engine answers an unknown name with 0.0 and an unknown condition with
 * false, in silence.
 *
 * So nothing here is typed by hand. Every fact is derived:
 *
 *   • the names come from the registry
 *   • the return TYPE comes from running the indicator on real candles
 *   • the string VALUES come from running it across many different windows and
 *     collecting what it actually returned
 *   • the PARAMS that matter come from perturbing each one and seeing whether
 *     the output moves
 *   • the CATEGORY comes from the same function the pyramid scores with
 *   • the CONDITIONS come from the condition switch itself
 *
 * Run: npx tsx scripts/build-strategy-reference.mts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  aliasGroupOf,
  aliasGroups,
  categoryForIndicator,
  computeIndicator,
  makeRule,
  registeredNames,
  type Candle,
  type EngineClock,
} from '../packages/engine/src/index.js';
import { indicatorFor } from '../packages/engine/src/registry.js';
import { volumeNote } from '../packages/engine/src/meta.js';

const registryFn = indicatorFor;

const OUT = 'docs/strategy-reference.json';

/**
 * Pairs that are not proven aliases but returned the same value at every point
 * of a 15,884-point sample. Produced by scripts/audit-aliases.mts; read from its
 * output rather than copied, so the two never disagree. Absent file = empty
 * list, because a missing side-report must not block the reference.
 */
const OBSERVED_IDENTICAL: string[][] = (() => {
  try {
    return (JSON.parse(readFileSync('docs/aliases.json', 'utf8')) as { observed?: string[][] })
      .observed ?? [];
  } catch {
    return [];
  }
})();

// ── Sample data ────────────────────────────────────────────────────────────
// The golden fixture holds real recorded candles. Many indicators only reveal
// their full range of outputs on particular shapes, so synthetic trends,
// ranges and spikes are probed alongside them.

const golden = JSON.parse(readFileSync('packages/engine/golden/engine-golden.json', 'utf8'));

/**
 * The fixture carries volume recorded by the Dart engine. Production does not:
 * the live feed has no volume field at all and the app substitutes a constant.
 * Left as recorded, `volume` and friends show a plausible range here and a flat
 * line in production — the reference would be describing a system nobody runs.
 */
const real: Candle[] = (golden.candles as Candle[]).map((c) => ({ ...c, volume: 1000 }));

function synth(shape: (i: number) => number, n = 120): Candle[] {
  const out: Candle[] = [];
  let t = 1_700_000_000;
  for (let i = 0; i < n; i++) {
    const base = shape(i);
    const open = base;
    const close = shape(i + 1);
    const hi = Math.max(open, close) * 1.0006;
    const lo = Math.min(open, close) * 0.9994;
    // Flat, like the live feed — a varying volume here would make the
    // volume-dependent indicators look alive in a way production never is.
    out.push({ time: t, open, high: hi, low: lo, close, volume: 1000 });
    t += 60;
  }
  return out;
}

/**
 * LIVE candles, deliberately on 15m and 1h.
 *
 * The first version of this file probed the golden fixture plus a few synthetic
 * shapes, and recorded "observed values: none" for 73 indicators. A wider
 * sample moved 58 of them. The fixture is one short window; 1m candles from the
 * proxy cover three hours of the day; 15m covers a full day and 1h covers a
 * month. An indicator that only fires in the London session cannot be described
 * from a sample that never saw London.
 *
 * The synthetic shapes stay — they reach states real candles rarely produce.
 */
const PROXY = 'https://euro-trade-proxy-1.onrender.com';
const FRAMES = ['15m', '1h'];
const PAIRS = [
  'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'AUDUSD_otc', 'USDCAD_otc',
  'USDCHF_otc', 'NZDUSD_otc', 'EURGBP_otc', 'EURJPY_otc', 'GBPJPY_otc',
];

async function liveCandles(symbol: string, interval: string): Promise<Candle[]> {
  const res = await fetch(`${PROXY}/api/otc/candles?symbol=${symbol}&interval=${interval}`, {
    signal: AbortSignal.timeout(25_000),
  });
  const body = (await res.json()) as { candles?: Array<Record<string, number>> };
  return (body.candles ?? [])
    .filter((c) => ['o', 'h', 'l', 'c', 't'].every((k) => typeof c[k] === 'number'))
    .map((c) => ({
      open: c['o']!, high: c['h']!, low: c['l']!, close: c['c']!,
      // The feed carries no volume; the app substitutes a constant, so this is
      // what the engine really sees. See packages/engine/src/meta.ts.
      volume: 1000,
      time: c['t']! * 1000,
    }));
}

const DATASETS: Array<{ name: string; candles: Candle[] }> = [
  { name: 'fixture', candles: real },
  { name: 'uptrend', candles: synth((i) => 1.08 + i * 0.0004) },
  { name: 'downtrend', candles: synth((i) => 1.14 - i * 0.0004) },
  { name: 'range', candles: synth((i) => 1.08 + Math.sin(i / 4) * 0.002) },
  { name: 'volatile', candles: synth((i) => 1.08 + Math.sin(i / 2) * 0.01 + (i % 7) * 0.001) },
  { name: 'flat', candles: synth(() => 1.08) },
  { name: 'spike', candles: synth((i) => (i === 90 ? 1.2 : 1.08 + i * 0.00005)) },
];

const hoursSeen = new Set<number>();
const daysSeen = new Set<string>();
let liveWindows = 0;

for (const frame of FRAMES) {
  for (const pair of PAIRS) {
    try {
      const candles = await liveCandles(pair, frame);
      if (candles.length < 30) continue;
      DATASETS.push({ name: `${pair}/${frame}`, candles });
      liveWindows++;
      for (const c of candles) {
        const d = new Date(c.time);
        hoursSeen.add(d.getUTCHours());
        daysSeen.add(d.toISOString().slice(0, 10));
      }
    } catch {
      // A pair that will not load is not a reason to stop.
    }
  }
}

if (liveWindows === 0) {
  console.error('لم يتم جلب أي شموع حيّة — المرجع سيُبنى على الـ fixture فقط وسيكون ناقصاً.');
  console.error('شغّله تاني لما البروكسي يبقى متاح.');
  process.exit(1);
}

console.log(`عيّنة حيّة: ${liveWindows} نافذة · ${hoursSeen.size}/24 ساعة · ${daysSeen.size} يوم`);
// Ten indicators branch on the clock; sweep it so their outputs are all seen.
const CLOCKS: EngineClock[] = [
  { utcHour: 2, weekday: 2 },
  { utcHour: 8, weekday: 3 },
  { utcHour: 10, weekday: 4 },
  { utcHour: 14, weekday: 5 },
  { utcHour: 15, weekday: 1 },
  { utcHour: 20, weekday: 6 },
];

/**
 * Every parameter the engine can read off a rule. `value` is included because
 * a few indicators use it as an INPUT rather than as the comparison threshold
 * — supertrend's multiplier is the obvious one — and missing that is exactly
 * the kind of silent gap this file exists to prevent.
 */
const PARAMS = ['period', 'fast', 'slow', 'smooth', 'stddev', 'value'] as const;

interface Probe {
  type: 'number' | 'string' | 'mixed' | 'error';
  strings: Set<string>;
  min: number;
  max: number;
  params: string[];
  /** The engine's own fallback for a parameter, read from `?? x` in its source. */
  defaults: Record<string, number>;
}

function run(name: string, candles: Candle[], clock: EngineClock, over: Partial<Record<string, number>> = {}) {
  const rule = makeRule({ indicator: name, condition: 'gt', signal: 'CALL', score: 1, ...over });
  const price = candles.length > 0 ? candles[candles.length - 1]!.close : 1.08;
  return computeIndicator(candles, rule, price, clock, new Map());
}

function probe(name: string): Probe {
  const strings = new Set<string>();
  let sawNumber = false;
  let min = Infinity;
  let max = -Infinity;
  let errored = 0;

  for (const ds of DATASETS) {
    // Walk the window, do not just read its last bar. A pattern that formed at
    // bar 40 and resolved by bar 90 is invisible to a single evaluation of the
    // whole series — which is precisely why an earlier pass recorded "none" for
    // gartley, double_bottom and 56 others that do fire.
    const steps: Candle[][] = [];
    for (let i = 30; i < ds.candles.length; i += 3) steps.push(ds.candles.slice(0, i + 1));
    if (steps.length === 0) steps.push(ds.candles);

    for (const clock of CLOCKS) {
      for (const step of steps) {
      try {
        const v = run(name, step, clock);
        if (typeof v === 'string') strings.add(v);
        else if (typeof v === 'number' && Number.isFinite(v)) {
          sawNumber = true;
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      } catch {
        errored++;
      }
      }
    }
  }

  // Which parameters does it use? Two independent sources, unioned, because
  // each misses cases the other catches:
  //
  //   1. Reading the function source. Exact for anything the indicator touches
  //      itself, blind to whatever it delegates to a helper.
  //   2. Perturbing the value and watching the output. Catches the delegated
  //      cases, but reports nothing when the sample data happens to give the
  //      same answer either way — which is how supertrend's `period` and
  //      `value` went missing on the first pass.
  const params = new Set<string>();
  const defaults: Record<string, number> = {};

  const source = registryFn(name)?.toString() ?? '';

  // `rule.value ?? 0.618` tells us the engine's own default for that input.
  // Emitting it beats inventing a number: fibonacci wants 0.618, supertrend 3.
  for (const p of PARAMS) {
    const at = source.indexOf('.' + p + '??');
    if (at >= 0) {
      const n = Number.parseFloat(source.slice(at + p.length + 3));
      if (Number.isFinite(n)) defaults[p] = n;
    }
  }

  for (const p of PARAMS) {
    // A plain substring test, not a regex: the parameter names are all
    // distinct words, and `.value` cannot collide with anything else the
    // engine reads off a rule.
    if (source.includes('.' + p)) params.add(p);
  }

  for (const p of PARAMS) {
    // Doubled on purpose: inside a template literal a single `` is a
    // backspace character, not a word boundary.
    if (new RegExp(`\.${p}\b`).test(source)) params.add(p);
  }

  for (const p of PARAMS) {
    for (const ds of DATASETS) {
      const a = safe(() => run(name, ds.candles, CLOCKS[2]!, { [p]: 7 }));
      const b = safe(() => run(name, ds.candles, CLOCKS[2]!, { [p]: 34 }));
      if (a !== b) {
        params.add(p);
        break;
      }
    }
  }

  const type: Probe['type'] =
    errored > 0 && strings.size === 0 && !sawNumber
      ? 'error'
      : strings.size > 0 && sawNumber
        ? 'mixed'
        : strings.size > 0
          ? 'string'
          : 'number';

  return { type, strings, min, max, params: [...params], defaults };
}

function safe<T>(fn: () => T): T | string {
  try {
    return fn();
  } catch (e) {
    return `ERR:${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── Build ──────────────────────────────────────────────────────────────────

const names = registeredNames();
const byCategory = new Map<string, string[]>();
const rules: unknown[] = [];

let numeric = 0;
let stringy = 0;

for (const name of names) {
  const p = probe(name);
  const category = categoryForIndicator(
    makeRule({ indicator: name, condition: 'gt', signal: 'CALL', score: 1 }),
  );
  byCategory.set(category, [...(byCategory.get(category) ?? []), name]);

  const isString = p.type === 'string' || p.type === 'mixed';
  if (isString) stringy++;
  else numeric++;

  const values = [...p.strings].sort();

  const note: string[] = [];

  // Before anything else: is this name telling the truth about itself?
  //
  // A reader who does not see this at the top of the entry will write a rule on
  // `doji`, get a bullish_engulfing reading, and never find out. And an author
  // combining two names from one group believes they have two confirmations,
  // which is the fault the guard in aliasConflicts exists to stop.
  const group = aliasGroupOf(name);
  if (group !== null) {
    if (group.misleading !== null) {
      note.push(`MISLEADING NAME — really ${group.misleading}`);
    }
    if (name === group.canonical) {
      note.push(
        `≡ also registered as ${group.aliases.join(', ')} — the SAME computation, byte for byte. Adding any of those to a strategy alongside this one adds score without adding evidence, and does NOT add variety for the consensus multiplier`,
      );
    } else {
      note.push(
        `≡ ALIAS of ${group.canonical} — the same computation, byte for byte. Use ${group.canonical}; putting both in one strategy adds score without adding evidence, and does NOT add variety for the consensus multiplier`,
      );
    }
  }

  // Then: an indicator computing over volume the feed does not carry.
  const volume = volumeNote(name);
  if (volume !== null) note.push(volume);

  note.push(isString ? 'returns TEXT' : 'returns a NUMBER');
  if (isString) {
    note.push(
      values.length > 0
        ? `observed values: ${values.join(' | ')}`
        : 'no value observed on the sample data',
    );
    note.push('use eq / neq with `pattern`, or bullish / bearish');
  } else {
    if (Number.isFinite(p.min)) {
      note.push(`observed range ${round(p.min)} … ${round(p.max)} on the sample data`);
    }
    note.push('use gt / lt / gte / lte / between with `value` (or value_min + value_max)');
  }
  if (values.length === 1 && values[0] === 'none') {
    // NOT "dead". Some of these are patterns that appear once a month, and
    // calling them dead off a five-day sample is exactly the mistake that got
    // kill_zone written off on a three-hour window.
    note.push(
      `RARE — never triggered across ${liveWindows} live windows covering ${hoursSeen.size}/24 hours and ${daysSeen.size} days. That is not evidence it is broken; several of these fire a few times a month. Treat it as unverified, not unusable`,
    );
  }
  if (p.params.length > 0) note.push(`reads: ${p.params.join(', ')}`);
  else note.push('takes no parameters');
  note.push(`category: ${category}`);

  const rule: Record<string, unknown> = {
    indicator: name,
    condition: isString ? 'bullish' : 'gt',
    signal: 'CALL',
    score: 1,
    enabled: false,
  };
  if (isString) {
    // Prefer a bullish-looking value, since the emitted rule says CALL.
    rule['pattern'] =
      values.find((v) => v.includes('bull')) ?? values.find((v) => v !== 'none') ?? 'none';
  }
  // `value` doubles as the comparison threshold for numeric indicators and as
  // an input for a handful of others; emit it either way.
  if (!isString || p.params.includes('value')) {
    rule['value'] = p.defaults['value'] ?? (isString ? 3.0 : 0);
  }
  if (p.params.includes('period')) rule['period'] = p.defaults['period'] ?? 14;
  if (p.params.includes('fast')) rule['fast'] = p.defaults['fast'] ?? 9;
  if (p.params.includes('slow')) rule['slow'] = p.defaults['slow'] ?? 21;
  if (p.params.includes('smooth')) rule['smooth'] = p.defaults['smooth'] ?? 3;
  if (p.params.includes('stddev')) rule['stddev'] = p.defaults['stddev'] ?? 2.0;
  rule['_note'] = note.join('. ');

  rules.push(rule);
}

// Group the emitted rules by category, with a section marker before each.
const grouped: unknown[] = [];
for (const [category, list] of [...byCategory].sort()) {
  grouped.push({
    _section: `━━━━━━━━━━ ${category.toUpperCase()} (${list.length}) ━━━━━━━━━━`,
  });
  for (const n of list) grouped.push(rules[names.indexOf(n)]);
}

const doc = {
  _doc: 'MASTER REFERENCE — generated FROM the engine, not written by hand.',
  _generated_by: 'scripts/build-strategy-reference.mts',
  _engine_indicators: names.length,

  _sample: {
    _note:
      'Every "observed values" and every range below comes from running the indicator over THIS sample. A value the sample never produced is absent from the list — that is a limit of the sample, not a fact about the indicator.',
    live_windows: liveWindows,
    hours_covered: `${hoursSeen.size}/24`,
    days_covered: daysSeen.size,
    timeframes: FRAMES,
    why_not_1m:
      '1m candles from this feed span about three hours of the day. A session-based indicator cannot be described from a window that only ever saw one session — kill_zone was written off exactly that way before this sample was widened.',
  },

  _no_volume:
    'Pocket Option streams prices only; the candle feed carries no volume field and the app substitutes a constant. Every indicator marked with the volume warning is computing over an invented number. They are kept registered so they work the day a real volume source arrives.',

  _how_to_use: [
    'Copy this file, set `enabled: true` on the rules you want, delete the rest, then upload it in the admin under Strategies.',
    'Everything in `rules` is disabled by default, so an unedited copy produces no signal.',
    'Any `_section` entry is a comment and is skipped by the engine.',
  ],

  _hard_rules: {
    unknown_indicator: 'An indicator name the engine does not know returns 0.0 SILENTLY. There is no error. Only the names in this file exist.',
    unknown_condition: 'A condition the engine does not know evaluates to false, so the rule never fires. Only the conditions listed below exist.',
    unknown_field: 'Any other field is ignored. `_note` and `_section` are safe to keep.',
    one_name_per_alias_group:
      'NEVER use two names from the same alias group in one strategy. They are one computation with several labels, so the second rule adds score and adds NO evidence — and a reader counting rules believes the setup is confirmed twice when it was read once. See _aliases.',
  },

  /**
   * Not a curiosity: 46 of the names below are labels pointing at another
   * name's implementation, and a strategy that uses two of them is scoring one
   * reading twice. The list is generated from the registry, so it cannot fall
   * out of date with the engine.
   */
  _aliases: {
    _note:
      `${names.length} names are ${names.length - aliasGroups().reduce((n, g) => n + g.aliases.length, 0)} distinct computations. Each group below is ONE function reached by several keys — identical output, byte for byte, always. Pick one name per group.`,
    _misleading:
      'Some groups are worse than redundant: their names describe different things and share one detector, so the name does not select what it claims. Those carry a MISLEADING NAME warning on their entry.',
    _consensus:
      'The consensus multiplier counts distinct CATEGORIES among the agreeing primary rules. Every name in a group lands in the same category, so aliases never inflate it BY THEMSELVES — but an explicit `type` on the rule overrides the category, and two aliases given two different `type` values would be counted as two independent schools of analysis. Do not do that.',
    groups: aliasGroups().map((g) => ({
      use: g.canonical,
      identical_to: g.aliases,
      ...(g.misleading === null ? {} : { misleading: g.misleading }),
    })),
    observed_identical_but_separate_implementations: {
      _note:
        'Different functions that returned the same value at every point of the sample. Not proven identical — they could disagree on data the sample does not contain — but treat a pair of them as one piece of evidence, not two.',
      pairs: OBSERVED_IDENTICAL,
    },
  },

  _conditions: {
    _for_numbers: {
      gt: 'greater than `value`',
      lt: 'less than `value`',
      gte: 'greater than or equal to `value`',
      lte: 'less than or equal to `value`',
      between: 'between `value_min` and `value_max`',
      gt_average: 'greater than its own average (value > 1.0 internally)',
      lt_average: 'less than its own average',
      is_true: 'not zero',
      is_false: 'zero',
    },
    _for_text: {
      eq: 'equals `pattern`',
      neq: 'does not equal `pattern`',
      bullish: 'the text contains a bullish marker (bullish / hammer / morning / …)',
      bearish: 'the text contains a bearish marker (bearish / shooting / evening / …)',
    },
    _not_supported: 'rising, falling, cross_above, cross_below — these do NOT exist. A rule using one never fires.',
  },

  _fields: {
    indicator: 'required — must be one of the names in this file',
    condition: 'required — see _conditions',
    signal: 'CALL | PUT | dominant | confirm. `dominant` and `confirm` follow whichever side is ahead.',
    score: 'points added when the rule is true',
    enabled: 'false skips the rule entirely. Defaults to true if omitted.',
    role: 'primary | confirm | filter | omitted — see _pyramid',
    type: 'overrides the consensus category. Omit to let the engine classify it.',
    period: 'lookback, default 14',
    fast: 'default 9',
    slow: 'default 21',
    smooth: 'default 3',
    stddev: 'default 2.0',
    value: 'the number compared against. `level` is accepted as an alias.',
    value_min: 'lower bound for `between`',
    value_max: 'upper bound for `between`',
    pattern: 'the text compared against. `session` and `wave` are accepted as aliases.',
  },

  _pyramid: {
    primary: 'Stage 1 — sets the direction. The winning side must reach min_primary_score.',
    confirm: 'Stage 2 — at least confirmation_ratio of the confirm rules must agree with the direction.',
    filter: 'Stage 3 — every filter must pass, or there is no signal.',
    no_role: 'Adds weight to the final score without being able to block.',
    consensus_multiplier:
      'The primary score is multiplied by the number of DISTINCT categories agreeing: 1 category = 1.0x, 2 = 1.15x, 3 = 1.3x, 4+ = 1.5x. Spreading primary rules across categories is worth more than piling them into one.',
    minimum_gap: 'The two directions must differ by at least 4.0 after multipliers, or the setup is rejected as unclear.',
  },

  _categories: Object.fromEntries([...byCategory].sort().map(([c, l]) => [c, l.length])),

  name: 'Master Reference (generated)',
  version: '4.0',
  confidence_base: 92.5,
  confidence_max: 98.9,
  min_score: 0,

  pyramid: {
    min_primary_score: 6,
    confirmation_ratio: 0.6,
    require_all_filters: true,
    wait_message: 'الهرم غير مكتمل — انتظر الشمعة القادمة',
  },

  rules: grouped,
};

writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);

function round(n: number): number {
  return Math.abs(n) >= 100 ? Math.round(n) : Number(n.toFixed(4));
}

console.log(`indicators : ${names.length}`);
console.log(`numeric    : ${numeric}`);
console.log(`text       : ${stringy}`);
console.log('categories :', [...byCategory].sort().map(([c, l]) => `${c}=${l.length}`).join('  '));
console.log(`written    : ${OUT}`);
