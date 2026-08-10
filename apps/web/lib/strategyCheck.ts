'use client';

/**
 * Strategy validator — answers "will the engine actually read this?".
 *
 * Reading a strategy file tells you almost nothing, because every way it can be
 * wrong is silent:
 *
 *   • an indicator name the engine does not know returns 0.0, no error
 *   • a condition it does not know evaluates to false, so the rule never fires
 *   • a NUMERIC condition on a TEXT indicator also never fires — `rsi` with
 *     `eq: "bullish"`, or `supertrend` with `gt: 0`, look perfectly reasonable
 *     and are dead on arrival
 *   • `between` without value_min/value_max compares against nothing
 *   • `eq` against a value the indicator can never return is false forever
 *
 * So this does not lint the JSON. It runs every rule through the real engine on
 * real candles, observes what each indicator actually returns, and reports what
 * the engine will do with it — ending with a dry run of the whole pyramid.
 */

import {
  computeIndicator,
  evaluateStrategyPro,
  isRegistered,
  pyramidFromJson,
  ruleFromJson,
  systemClock,
  type Candle,
  type DynamicStrategy,
  type StrategyRule,
} from '@euro/engine';

/** Exactly what `checkCondition` implements — nothing else evaluates true. */
const NUMERIC_CONDITIONS = new Set([
  'gt', 'lt', 'gte', 'lte', 'between', 'gt_average', 'lt_average', 'is_true', 'is_false',
]);
const TEXT_CONDITIONS = new Set(['eq', 'neq', 'bullish', 'bearish']);
const ALL_CONDITIONS = new Set([...NUMERIC_CONDITIONS, ...TEXT_CONDITIONS]);

const SIGNALS = new Set(['CALL', 'PUT', 'dominant', 'confirm']);
const ROLES = new Set(['primary', 'confirm', 'filter', '']);

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  severity: Severity;
  /** 1-based position among the real rules, or null for file-level findings. */
  rule: number | null;
  indicator: string | null;
  message: string;
}

export interface CheckReport {
  findings: Finding[];
  /** Rules the engine will actually evaluate. */
  activeRules: number;
  totalRules: number;
  /** The dry run, when the file was complete enough to run one. */
  dryRun: {
    result: string;
    direction: string | null;
    scoreCall: number;
    scorePut: number;
    categoriesCall: number;
    categoriesPut: number;
    blocked: string | null;
  } | null;
  /** What each indicator returned on the live candles. */
  observed: Array<{ indicator: string; type: 'number' | 'text'; sample: string }>;
}

const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

/**
 * @param json   the parsed strategy file
 * @param candles live candles; the engine needs real data to say what an
 *                indicator returns, and 60+ is enough for every lookback
 */
export function checkStrategy(json: Record<string, unknown>, candles: Candle[]): CheckReport {
  const findings: Finding[] = [];
  const observed: CheckReport['observed'] = [];
  const add = (severity: Severity, rule: number | null, indicator: string | null, message: string) =>
    findings.push({ severity, rule, indicator, message });

  // ── File level ───────────────────────────────────────────────────────────
  const rawRules = json['rules'];
  if (!Array.isArray(rawRules)) {
    add('error', null, null, 'الملف لا يحتوي على مصفوفة "rules" — المحرك لن يقرأه إطلاقاً.');
    return { findings, activeRules: 0, totalRules: 0, dryRun: null, observed };
  }

  const real = (rawRules as Array<Record<string, unknown>>).filter(
    (r) => r !== null && typeof r === 'object' && typeof r['indicator'] === 'string',
  );
  const markers = rawRules.length - real.length;
  if (markers > 0) {
    add('info', null, null, `${markers} سطر تعليق (_section) — المحرك يتجاهلها، وهذا سليم.`);
  }
  if (real.length === 0) {
    add('error', null, null, 'لا توجد أي قاعدة بها "indicator".');
    return { findings, activeRules: 0, totalRules: 0, dryRun: null, observed };
  }

  for (const [key, label] of [
    ['confidence_base', 'confidence_base'],
    ['confidence_max', 'confidence_max'],
  ] as const) {
    if (json[key] !== undefined && !num(json[key])) {
      add('warn', null, null, `${label} ليس رقماً — سيُستخدم الافتراضي.`);
    }
  }
  if (json['min_score'] !== undefined && !num(json['min_score'])) {
    add('warn', null, null, 'min_score ليس رقماً — سيُعامل كصفر.');
  }

  // ── Rule by rule, against the live engine ────────────────────────────────
  const clock = systemClock();
  const price = candles.length > 0 ? candles[candles.length - 1]!.close : 0;
  const parsed: StrategyRule[] = [];
  let active = 0;

  real.forEach((raw, i) => {
    const n = i + 1;
    const name = String(raw['indicator']);
    const enabled = raw['enabled'] !== false;
    const rule = ruleFromJson(raw);
    parsed.push(rule);
    if (enabled) active++;

    if (!isRegistered(name)) {
      add(
        'error',
        n,
        name,
        `المؤشر "${name}" غير موجود في المحرك — سيرجع 0.0 بصمت ولن يضيف أي شيء.`,
      );
      return;
    }

    const condition = String(raw['condition'] ?? '');
    if (!ALL_CONDITIONS.has(condition)) {
      add(
        'error',
        n,
        name,
        `الشرط "${condition}" غير منفّذ في المحرك — القاعدة لن تتحقق أبداً.`,
      );
      return;
    }

    // What does this indicator actually return, right now, on real candles?
    let value: number | string;
    try {
      // `undefined` means the registry has no entry — the same case the engine
      // turns into 0.0. It is already reported above, so treat it as numeric 0.
      value = computeIndicator(candles, rule, price, clock, new Map()) ?? 0;
    } catch (e) {
      add('warn', n, name, `تعذّر حساب المؤشر: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const isText = typeof value === 'string';
    observed.push({
      indicator: name,
      type: isText ? 'text' : 'number',
      sample: String(value),
    });

    // The trap that reads perfectly and never fires.
    if (isText && NUMERIC_CONDITIONS.has(condition)) {
      add(
        'error',
        n,
        name,
        `"${name}" يرجع نصاً (مثال: "${value}") والشرط "${condition}" رقمي — القاعدة لن تتحقق أبداً. استخدم eq / neq / bullish / bearish.`,
      );
    }
    if (!isText && TEXT_CONDITIONS.has(condition)) {
      add(
        'error',
        n,
        name,
        `"${name}" يرجع رقماً (مثال: ${value}) والشرط "${condition}" نصّي — القاعدة لن تتحقق أبداً. استخدم gt / lt / gte / lte / between.`,
      );
    }

    // Companion fields the condition cannot work without.
    if (condition === 'between' && (rule.valueMin === null || rule.valueMax === null)) {
      add('error', n, name, 'الشرط "between" يحتاج value_min و value_max.');
    }
    if (['gt', 'lt', 'gte', 'lte'].includes(condition) && rule.value === null) {
      add('warn', n, name, `الشرط "${condition}" بدون "value" — ستتم المقارنة بصفر.`);
    }
    if ((condition === 'eq' || condition === 'neq') && rule.pattern === null) {
      add('error', n, name, `الشرط "${condition}" يحتاج "pattern".`);
    }

    // An `eq` against something this indicator cannot produce.
    if (condition === 'eq' && isText && rule.pattern !== null && rule.pattern !== value) {
      add(
        'info',
        n,
        name,
        `القيمة الحالية "${value}" لا تساوي "${rule.pattern}" — هذا طبيعي، لكن تأكد أن "${rule.pattern}" قيمة يمكن أن يرجعها هذا المؤشر.`,
      );
    }

    const signal = String(raw['signal'] ?? '');
    if (!SIGNALS.has(signal)) {
      add('error', n, name, `"signal" يجب أن يكون CALL أو PUT أو dominant أو confirm (وجدنا: "${signal}").`);
    }
    if (!num(raw['score'])) {
      add('error', n, name, '"score" مفقود أو ليس رقماً.');
    } else if ((raw['score'] as number) <= 0 && String(raw['role'] ?? '') !== 'filter') {
      add('warn', n, name, 'score = 0 لقاعدة غير فلتر — لن تضيف أي وزن.');
    }

    const role = String(raw['role'] ?? '');
    if (!ROLES.has(role)) {
      add('error', n, name, `"role" غير معروف: "${role}" — المسموح: primary / confirm / filter أو اتركه فارغاً.`);
    }
  });

  // ── Pyramid coherence ────────────────────────────────────────────────────
  const enabledRaw = real.filter((r) => r['enabled'] !== false);
  const byRole = (role: string) => enabledRaw.filter((r) => String(r['role'] ?? '') === role);
  const primaries = byRole('primary');
  const confirms = byRole('confirm');
  const filters = byRole('filter');

  const pyramidRaw = json['pyramid'];
  const hasPyramid = pyramidRaw !== null && typeof pyramidRaw === 'object';

  if (hasPyramid) {
    const p = pyramidRaw as Record<string, unknown>;
    const minPrimary = num(p['min_primary_score']) ? (p['min_primary_score'] as number) : 0;

    if (primaries.length === 0) {
      add('error', null, null, 'الهرم مفعّل ولا توجد أي قاعدة role="primary" — لن تصدر إشارة أبداً.');
    } else {
      // Best case: every primary fires and they span 4+ categories (x1.5).
      const best = primaries.reduce((s, r) => s + (num(r['score']) ? (r['score'] as number) : 0), 0) * 1.5;
      if (best < minPrimary) {
        add(
          'error',
          null,
          null,
          `مجموع نقاط primary في أفضل حالة (${best.toFixed(1)} بعد مضاعف الإجماع ×1.5) أقل من min_primary_score (${minPrimary}) — مستحيل تتحقق.`,
        );
      }
      // The engine also demands a 4.0 gap between the two directions.
      if (best < 4) {
        add(
          'error',
          null,
          null,
          `أقصى نتيجة ممكنة (${best.toFixed(1)}) أقل من الفارق الأدنى الذي يطلبه المحرك (4.0) — لن تصدر إشارة.`,
        );
      }
    }

    const ratio = num(p['confirmation_ratio']) ? (p['confirmation_ratio'] as number) : 0;
    if (ratio > 0 && confirms.length === 0) {
      add(
        'warn',
        null,
        null,
        `confirmation_ratio = ${ratio} ولا توجد قواعد role="confirm" — المرحلة الثانية ستمر دائماً.`,
      );
    }
    if (p['require_all_filters'] === true && filters.length === 0) {
      add('info', null, null, 'require_all_filters مفعّل ولا توجد فلاتر — لا مانع، لن يمنع شيئاً.');
    }
  } else if (primaries.length > 0 || confirms.length > 0 || filters.length > 0) {
    add(
      'warn',
      null,
      null,
      'يوجد role على بعض القواعد لكن لا يوجد بلوك "pyramid" — الأدوار ستُتجاهل وستُجمع النقاط فقط.',
    );
  }

  const categories = new Set(
    primaries.map((r) => String(r['type'] ?? r['category'] ?? '')).filter((c) => c !== ''),
  );
  if (primaries.length >= 2 && categories.size === 0) {
    add(
      'info',
      null,
      null,
      'مضاعف الإجماع يعتمد على عدد التصنيفات المختلفة بين قواعد primary. المحرك يصنّفها تلقائياً — وزّعها على فئات مختلفة (اتجاه / مستويات سعرية / إحصاء / أنماط) لتصل إلى ×1.5.',
    );
  }

  if (active === 0) {
    add('error', null, null, 'كل القواعد enabled:false — المحرك لن يقيّم أي شيء.');
  }

  // ── Dry run ──────────────────────────────────────────────────────────────
  let dryRun: CheckReport['dryRun'] = null;
  if (candles.length > 0 && active > 0) {
    try {
      const strategy: DynamicStrategy = {
        name: typeof json['name'] === 'string' ? json['name'] : 'Untitled',
        minScore: num(json['min_score']) ? (json['min_score'] as number) : 0,
        maxScore: num(json['max_score']) ? (json['max_score'] as number) : 0,
        confidenceBase: num(json['confidence_base']) ? (json['confidence_base'] as number) : 92.5,
        confidenceMax: num(json['confidence_max']) ? (json['confidence_max'] as number) : 98.9,
        pyramid: hasPyramid ? pyramidFromJson(pyramidRaw as Record<string, unknown>) : null,
        rules: parsed,
      };
      const pro = evaluateStrategyPro(strategy, {
        candles,
        currentPrice: price,
        clock,
      });
      dryRun = {
        result: pro.result,
        direction: pro.direction,
        scoreCall: pro.finalScore.CALL,
        scorePut: pro.finalScore.PUT,
        categoriesCall: pro.categoryCount.CALL,
        categoriesPut: pro.categoryCount.PUT,
        blocked: pro.reasonBlocked,
      };
    } catch (e) {
      add('warn', null, null, `تعذّر التشغيل التجريبي: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { findings, activeRules: active, totalRules: real.length, dryRun, observed };
}
