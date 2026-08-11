'use client';

/**
 * Strategy upload — ported from `_buildStrategyUploadSection`
 * (admin_dashboard.dart:7641).
 *
 * This is the highest-leverage screen in the whole system: what gets saved here
 * decides every signal every user receives. So it does one thing the Dart admin
 * does not, and the reason matters:
 *
 *   It VALIDATES the indicator names against the engine before saving.
 *
 * The audit at migration time found 31 indicator names in the master reference
 * file that the engine has never implemented — `sma`, `macd`, `bollinger_upper`,
 * `stochastic_k`, `adx_plus`… Each one silently evaluates to 0.0 and quietly
 * contributes nothing. They are all currently `enabled: false`, so nothing is
 * broken today, but enabling one would degrade signals with no error anywhere.
 *
 * The check is a WARNING, never a block: an unknown name is still saved if the
 * operator insists, so behaviour is unchanged. It just stops being invisible.
 */

import { useMemo, useState } from 'react';
import { supabase } from '@euro/shared';
import { registeredNames, type Candle } from '@euro/engine';
import { fetchCandles } from '@/lib/candles';
import { checkStrategy, type CheckReport } from '@/lib/strategyCheck';
import { backtest, confidence, verdict, type BacktestReport } from '@/lib/backtest';
import {
  SPEEDS,
  buildPrompt,
  buildRefinePrompt,
  extractJson,
  tierFor,
  type Speed,
} from '@/lib/aiStrategy';
import { appUrl } from '@/lib/nav';
import { pyramidFromJson, ruleFromJson, type DynamicStrategy } from '@euro/engine';

/** Pairs the backtest replays. One pair's 100 candles is not a sample. */
const BACKTEST_PAIRS = [
  'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'AUDUSD_otc', 'USDCAD_otc',
  'USDCHF_otc', 'NZDUSD_otc', 'EURGBP_otc', 'EURJPY_otc', 'GBPJPY_otc',
];

const K_ORIGIN = 'https://euro-trade-proxy-1.onrender.com';

/** Generate → backtest → refine, at most this many times. */
const ROUNDS = 3;

/**
 * Ranks two attempts. A 100% win rate off three trades must not beat 68% off
 * forty, so the rate is discounted until the sample is big enough to mean
 * something.
 */
function score(r: BacktestReport): number {
  const decided = r.wins + r.losses;
  if (decided === 0) return -1;
  const trust = Math.min(1, decided / 25);
  return r.winRate * trust;
}
import styles from '../admin.module.css';

/**
 * `id` is the `configs` row the app reads; `slot` is the version-history key.
 *
 * The two names differ because the slots were named for what they are rather
 * than for what the old rows happened to be called. The mapping lives in
 * `publish_strategy_version` as well — deliberately, so neither side has to
 * guess the other's naming.
 */
const TARGETS = [
  { id: 'strategy_standard', slot: 'instant_free', label: 'استراتيجية العادي' },
  { id: 'strategy_vip', slot: 'instant_paid', label: 'استراتيجية VIP' },
  { id: 'monitoring_standard', slot: 'monitoring_free', label: 'مراقبة العادي' },
  { id: 'monitoring_vip', slot: 'monitoring_paid', label: 'مراقبة VIP' },
];

interface RuleLike {
  indicator?: unknown;
  enabled?: unknown;
}

export default function StrategyUploadView() {
  const [target, setTarget] = useState(TARGETS[0]!.id);
  const [json, setJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [testing, setTesting] = useState(false);

  const [speed, setSpeed] = useState<Speed>('fast');
  const [extra, setExtra] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState('');

  const [bt, setBt] = useState<BacktestReport | null>(null);
  const [btBusy, setBtBusy] = useState(false);
  const [btProgress, setBtProgress] = useState('');

  const speedSpec = SPEEDS.find((s) => s.id === speed)!;

  /** Turns the editor's JSON into something the engine can run. */
  function toStrategy(parsed: Record<string, unknown>): DynamicStrategy {
    const rules = (parsed['rules'] as Array<Record<string, unknown>>)
      .filter((r) => typeof r?.['indicator'] === 'string')
      .map(ruleFromJson);
    const n = (k: string, d: number) => (typeof parsed[k] === 'number' ? (parsed[k] as number) : d);
    return {
      name: typeof parsed['name'] === 'string' ? parsed['name'] : 'Untitled',
      minScore: n('min_score', 0),
      maxScore: n('max_score', 0),
      confidenceBase: n('confidence_base', 92.5),
      confidenceMax: n('confidence_max', 98.9),
      pyramid: parsed['pyramid'] ? pyramidFromJson(parsed['pyramid'] as Record<string, unknown>) : null,
      rules,
    };
  }

  /** One call to Gemini through the proxy, which holds the API key. */
  async function askGemini(prompt: string): Promise<Record<string, unknown>> {
    const gr = await fetch(`${K_ORIGIN}/api/gemini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, json: true, temperature: 0.4 }),
      signal: AbortSignal.timeout(90_000),
    });
    const out = (await gr.json()) as { available?: boolean; text?: string; reason?: string };
    if (out.available !== true || !out.text) throw new Error(out.reason ?? 'Gemini غير متاح');
    return extractJson(out.text);
  }

  /**
   * Generate, replay over history, feed the numbers back, repeat.
   *
   * One shot at a strategy is a guess. The engine can replay a hundred candles
   * across ten pairs in seconds, so the model gets to see how its own rules
   * actually performed and correct them — and the best attempt is kept, not
   * the last, because a refinement can make things worse.
   */
  async function generate(): Promise<void> {
    setGenerating(true);
    setMessage(null);
    setReport(null);
    setBt(null);
    try {
      // The catalogue ships as a static asset, so it can never be out of step
      // with the engine that will run the result.
      const res = await fetch(appUrl('/strategy-reference.json'));
      if (!res.ok) throw new Error('تعذّر تحميل مرجع المؤشرات');
      const reference = (await res.json()) as Record<string, unknown>;
      const tier = tierFor(target);

      let best: { strategy: Record<string, unknown>; report: BacktestReport } | null = null;
      let prompt = buildPrompt({ reference, speed: speedSpec, tier, extra });

      for (let attempt = 1; attempt <= ROUNDS; attempt++) {
        setGenProgress(`محاولة ${attempt}/${ROUNDS} — جيميناي بيكتب...`);
        const strategy = await askGemini(prompt);

        setGenProgress(`محاولة ${attempt}/${ROUNDS} — باك تست على ${BACKTEST_PAIRS.length} أزواج...`);
        const r = await backtest({
          strategy: toStrategy(strategy),
          symbols: BACKTEST_PAIRS,
          interval: '1m',
          horizon: speedSpec.horizon,
          onProgress: (done, total) =>
            setGenProgress(`محاولة ${attempt}/${ROUNDS} — باك تست ${done}/${total} زوج`),
        });

        if (best === null || score(r) > score(best.report)) best = { strategy, report: r };

        // Good enough on a sample worth trusting — stop spending calls.
        if (r.winRate >= 65 && r.wins + r.losses >= 15) break;
        if (attempt === ROUNDS) break;

        prompt = buildRefinePrompt({
          previous: strategy,
          stats: {
            trades: r.trades.length,
            wins: r.wins,
            losses: r.losses,
            winRate: r.winRate,
            signalsPer100: r.signalsPer100,
            avgCandlesBetweenSignals: r.avgCandlesBetweenSignals,
            blockedReasons: r.blockedReasons,
            pairsUsed: r.pairsUsed,
          },
          speed: speedSpec,
          tier,
          reference,
        });
      }

      if (best === null) throw new Error('لم ينتج أي شيء');
      setJson(JSON.stringify(best.strategy, null, 2));
      setBt(best.report);
      setMessage({
        kind: 'ok',
        text: `تم التوليد ✅ — أفضل محاولة: ${best.report.trades.length} صفقة، نسبة نجاح ${best.report.winRate.toFixed(1)}%. اختبرها بنفسك قبل النشر.`,
      });
    } catch (e) {
      setMessage({ kind: 'error', text: `فشل التوليد: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setGenerating(false);
      setGenProgress('');
    }
  }

  /** Replays the strategy over candles that already happened. */
  async function runBacktest(): Promise<void> {
    setBtBusy(true);
    setBt(null);
    setMessage(null);
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const r = await backtest({
        strategy: toStrategy(parsed),
        symbols: BACKTEST_PAIRS,
        interval: '1m',
        horizon: speedSpec.horizon,
        onProgress: (done, total) => setBtProgress(`${done}/${total} زوج`),
      });
      setBt(r);
    } catch (e) {
      setMessage({ kind: 'error', text: `تعذّر الباك تست: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBtBusy(false);
      setBtProgress('');
    }
  }

  /**
   * The deep check. The quick audit above reads the file; this one RUNS it —
   * every rule through the real engine on real candles, then the whole pyramid
   * — because every way a strategy can be wrong is silent otherwise.
   */
  async function testStrategy(): Promise<void> {
    setTesting(true);
    setReport(null);
    setMessage(null);
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;

      // Real candles, so an indicator's actual return type and value are known
      // rather than guessed. EURUSD 1m is the pair every strategy is tuned on.
      const candles: Candle[] = (await fetchCandles('EURUSD_otc', '1m')) ?? [];
      if (candles.length === 0) {
        setMessage({
          kind: 'error',
          text: 'تعذّر جلب الشموع — الفحص يحتاج بيانات حقيقية عشان يعرف كل مؤشر بيرجّع إيه.',
        });
        return;
      }

      setReport(checkStrategy(parsed, candles));
    } catch (e) {
      setMessage({ kind: 'error', text: `JSON غير صالح: ${(e as Error).message}` });
    } finally {
      setTesting(false);
    }
  }

  const known = useMemo(() => new Set(registeredNames()), []);

  /** Parses and audits without saving, so the operator sees issues first. */
  const audit = useMemo(() => {
    if (!json.trim()) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      return { error: `JSON غير صالح: ${(e as Error).message}` };
    }

    const obj = parsed as { rules?: unknown; pyramid?: unknown };
    if (!Array.isArray(obj.rules)) {
      return { error: 'الملف لا يحتوي على مصفوفة "rules"' };
    }

    const rules = obj.rules as RuleLike[];
    // Section markers carry no indicator; they are documentation, not rules.
    const real = rules.filter((r) => typeof r.indicator === 'string');
    const enabled = real.filter((r) => r.enabled !== false);

    const unknownAll = [
      ...new Set(real.filter((r) => !known.has(r.indicator as string)).map((r) => r.indicator as string)),
    ];
    const unknownEnabled = [
      ...new Set(
        enabled.filter((r) => !known.has(r.indicator as string)).map((r) => r.indicator as string),
      ),
    ];

    return {
      total: rules.length,
      real: real.length,
      enabled: enabled.length,
      hasPyramid: obj.pyramid != null,
      unknownAll,
      unknownEnabled,
    };
  }, [json, known]);

  async function save(): Promise<void> {
    if (!audit || 'error' in audit) return;
    setSaving(true);
    setMessage(null);
    try {
      const data = JSON.parse(json) as Record<string, unknown>;
      const slot = TARGETS.find((t) => t.id === target)?.slot;
      if (!slot) throw new Error('slot');

      // Not an upsert on `configs` any more. That wrote over the previous
      // strategy in place, so the version that produced last month's signals
      // ceased to exist the moment a new one was uploaded — and every statistic
      // about it silently became a statistic about the new one.
      //
      // The function appends a version, flips the active flag, and writes the
      // `configs` row the app reads, all in one transaction. Half of that
      // applying would leave the app and the history disagreeing.
      const { data: result, error } = await supabase().rpc('publish_strategy_version', {
        p_slot: slot,
        p_name: typeof data['name'] === 'string' ? data['name'] : 'Untitled',
        p_json: data,
        p_by: 'admin',
      });
      if (error) throw error;

      const row = (Array.isArray(result) ? result[0] : result) as
        | { version_number?: number; created?: boolean; message?: string }
        | undefined;

      setMessage({
        kind: 'ok',
        text: row?.created === false
          ? `${row.message ?? 'نفس المحتوى'} — مفيش تغيير، النسخة النشطة زي ما هي.`
          : `اتنشرت النسخة ${row?.version_number ?? '?'} — ${audit.enabled} قاعدة مفعّلة. ` +
            `التغيير يوصل للمستخدمين فورًا، وإحصائيات النسخة دي هتتجمّع لوحدها.`,
      });
    } catch (e) {
      setMessage({
        kind: 'error',
        text: `تعذّر النشر: ${e instanceof Error ? e.message : 'راجع الاتصال والصلاحيات'}`,
      });
    } finally {
      setSaving(false);
    }
  }

  async function loadCurrent(): Promise<void> {
    setMessage(null);
    try {
      const { data } = await supabase().from('configs').select('data').eq('id', target).maybeSingle();
      setJson(JSON.stringify(data?.['data'] ?? {}, null, 2));
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر تحميل الاستراتيجية الحالية' });
    }
  }

  const hasError = audit !== null && 'error' in audit;

  return (
    <section>
      <h1 className={styles.title}>رفع الاستراتيجيات</h1>

      <div className={styles.card}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="target">
            الوجهة
          </label>
          <select
            id="target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className={styles.input}
          >
            {TARGETS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} ({t.id})
              </option>
            ))}
          </select>
        </div>

        <button type="button" onClick={() => void loadCurrent()} className={styles.actionBtn}>
          تحميل الحالية
        </button>
      </div>

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>🤖 عمل الاستراتيجيات بالذكاء الاصطناعي</h2>
        <p className={styles.switchHint} style={{ marginBottom: 12 }}>
          جيميناي بيشوف مرجع الـ 359 مؤشر بأسمائهم الحقيقية، بيكتب استراتيجية مناسبة
          لـ <strong>{tierFor(target).paid ? 'الباقة المدفوعة' : 'الباقة العادية'}</strong>،
          بيجرّبها على شموع قديمة، وبيشوف نتيجته ويحسّنها — لحد {ROUNDS} محاولات، وبناخد أحسن واحدة.
        </p>

        <p className={styles.label}>الصفقة تاخد قد إيه؟</p>
        <div className={styles.filters} style={{ flexWrap: 'wrap', marginBottom: 12 }}>
          {SPEEDS.map((sp) => (
            <button
              key={sp.id}
              type="button"
              onClick={() => setSpeed(sp.id)}
              aria-pressed={speed === sp.id}
              className={`${styles.chip} ${speed === sp.id ? styles.chipActive : ''}`}
            >
              {sp.label}
            </button>
          ))}
        </div>

        <div className={styles.field}>
          <span className={styles.label}>تعليمات إضافية (اختياري)</span>
          <input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            className={styles.input}
            placeholder="مثال: ركّز على جلسة لندن، أو تجنّب الأنماط النادرة"
          />
        </div>

        <button
          type="button"
          disabled={generating || btBusy}
          onClick={() => void generate()}
          className={styles.primaryBtn}
        >
          {generating ? (genProgress || 'جاري العمل...') : '✨ ولّد الاستراتيجية'}
        </button>
      </div>

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>محتوى الاستراتيجية (JSON)</h2>
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          className={styles.textarea}
          dir="ltr"
          spellCheck={false}
          placeholder='{ "name": "...", "min_score": 0, "rules": [ ... ] }'
        />

        <div className={styles.actions} style={{ marginTop: 12 }}>
          <button
            type="button"
            disabled={testing || json.trim() === ''}
            onClick={() => void testStrategy()}
            className={styles.actionBtn}
          >
            {testing ? 'جاري الفحص...' : '🧪 افحص الصياغة'}
          </button>
          <button
            type="button"
            disabled={btBusy || generating || json.trim() === ''}
            onClick={() => void runBacktest()}
            className={styles.actionBtn}
          >
            {btBusy ? `باك تست ${btProgress}` : '📊 باك تست على أرقام قديمة'}
          </button>
          <span className={styles.switchHint}>
            الفحص بيقولك المحرك هيقراها إزاي. الباك تست بيجرّبها فعلاً على تاريخ{' '}
            {BACKTEST_PAIRS.length} أزواج.
          </span>
        </div>
      </div>

      {bt && <BacktestPanel report={bt} horizon={speedSpec.horizon} />}

      {report && <TestReport report={report} />}

      {hasError && <p className={styles.error}>{(audit as { error: string }).error}</p>}

      {audit !== null && !('error' in audit) && (
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>الفحص قبل الحفظ</h2>

          <div className={styles.statRow}>
            <div className={styles.stat}>
              <span className={styles.statValue}>{audit.real}</span>
              <span className={styles.statLabel}>قاعدة</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{audit.enabled}</span>
              <span className={styles.statLabel}>مفعّلة</span>
            </div>
            <div className={`${styles.stat} ${audit.unknownEnabled.length > 0 ? styles.statRed : ''}`}>
              <span className={styles.statValue}>{audit.unknownEnabled.length}</span>
              <span className={styles.statLabel}>مفعّلة ومجهولة</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{audit.hasPyramid ? 'نعم' : 'لا'}</span>
              <span className={styles.statLabel}>وضع الهرم</span>
            </div>
          </div>

          {audit.unknownEnabled.length > 0 && (
            <div className={styles.error}>
              <strong>خطر:</strong> المؤشرات دي <strong>مفعّلة</strong> والمحرك لا يعرفها، فهترجّع{' '}
              <code>0.0</code> بصمت وتشارك في الحساب بلا قيمة:
              <br />
              <code dir="ltr">{audit.unknownEnabled.join(', ')}</code>
            </div>
          )}

          {audit.unknownAll.length > audit.unknownEnabled.length && (
            <div className={styles.warn}>
              <strong>تنبيه:</strong> {audit.unknownAll.length - audit.unknownEnabled.length} مؤشر
              غير معروف موجود في الملف لكنه <strong>معطّل</strong> — لا يؤثر الآن، لكنه سيرجع{' '}
              <code>0.0</code> لو فعّلته.
              <br />
              <code dir="ltr">
                {audit.unknownAll.filter((n) => !audit.unknownEnabled.includes(n)).join(', ')}
              </code>
            </div>
          )}

          {audit.unknownAll.length === 0 && (
            <p className={styles.ok}>كل المؤشرات معروفة للمحرك ✓</p>
          )}
        </div>
      )}

      {message && (
        <p className={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</p>
      )}

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>🚀 النشر</h2>
        <p className={styles.switchHint} style={{ marginBottom: 12 }}>
          النشر بيوصل <strong>كل</strong> المستخدمين فورًا — الإشارة اللي بعدها هتتحسب
          بالاستراتيجية دي. اختبرها الأول.
        </p>

        {report !== null && report.findings.some((f) => f.severity === 'error') && (
          <p className={styles.error}>
            الفحص لقى أخطاء هتخلي قواعد متشتغلش. صلّحها قبل النشر.
          </p>
        )}
        {bt !== null && bt.trades.length === 0 && (
          <p className={styles.warn}>
            الباك تست ما أصدرش أي صفقة على كل التاريخ المتاح — النشر كده يعني إشارات نادرة جداً أو معدومة.
          </p>
        )}

        <button
          type="button"
          onClick={() => {
            const t = TARGETS.find((x) => x.id === target)?.label ?? target;
            if (confirm(`نشر الاستراتيجية على "${t}"؟

هتوصل كل المستخدمين فورًا وتحكم كل إشارة جاية.`)) {
              void save();
            }
          }}
          disabled={saving || audit === null || hasError}
          className={styles.primaryBtn}
        >
          {saving ? 'جاري النشر...' : '🚀 انشر للكل'}
        </button>
      </div>
    </section>
  );
}

/**
 * The result of the deep check.
 *
 * Ordered by what actually stops a signal: errors first, then the dry run —
 * because "the engine ran this and got NO_SIGNAL because filter X failed" is
 * more useful than any amount of static linting.
 */
function TestReport({ report }: { report: CheckReport }) {
  const errors = report.findings.filter((f) => f.severity === 'error');
  const warns = report.findings.filter((f) => f.severity === 'warn');
  const infos = report.findings.filter((f) => f.severity === 'info');
  const clean = errors.length === 0;

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>🧪 نتيجة الاختبار</h2>

      <p className={clean ? styles.ok : styles.error}>
        {clean
          ? `✅ الاستراتيجية سليمة — المحرك هيقرا كل القواعد الـ ${report.activeRules} المفعّلة.`
          : `❌ ${errors.length} مشكلة هتخلي قواعد متشتغلش خالص.`}
      </p>

      <div className={styles.statRow}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{report.totalRules}</span>
          <span className={styles.statLabel}>قاعدة</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{report.activeRules}</span>
          <span className={styles.statLabel}>مفعّلة</span>
        </div>
        <div className={`${styles.stat} ${errors.length > 0 ? styles.statRed : styles.statGreen}`}>
          <span className={styles.statValue}>{errors.length}</span>
          <span className={styles.statLabel}>خطأ</span>
        </div>
        <div className={`${styles.stat} ${warns.length > 0 ? styles.statGold : ''}`}>
          <span className={styles.statValue}>{warns.length}</span>
          <span className={styles.statLabel}>تحذير</span>
        </div>
      </div>

      {/* The dry run — what the engine did with it, just now. */}
      {report.dryRun && (
        <div className={styles.card} style={{ marginBottom: 12 }}>
          <h3 className={styles.cardTitle}>تشغيل تجريبي على شموع EURUSD الحقيقية</h3>
          <p className={report.dryRun.result === 'SIGNAL' ? styles.ok : styles.warn}>
            {report.dryRun.result === 'SIGNAL'
              ? `✅ أصدرت إشارة ${report.dryRun.direction} — النتيجة ${report.dryRun.scoreCall.toFixed(1)} مقابل ${report.dryRun.scorePut.toFixed(1)}`
              : `⏸ ما أصدرتش إشارة على الشمعة دي — ${report.dryRun.blocked ?? 'الشروط لم تتحقق'}`}
          </p>
          <p className={styles.switchHint}>
            النتيجة: CALL {report.dryRun.scoreCall.toFixed(1)} ({report.dryRun.categoriesCall} تصنيف)
            · PUT {report.dryRun.scorePut.toFixed(1)} ({report.dryRun.categoriesPut} تصنيف).
            عدم إصدار إشارة على شمعة واحدة أمر طبيعي — المهم إن مفيش أخطاء فوق.
          </p>
        </div>
      )}

      {[
        { list: errors, cls: styles.error, title: 'أخطاء — القواعد دي مش هتشتغل' },
        { list: warns, cls: styles.warn, title: 'تحذيرات' },
        { list: infos, cls: styles.info, title: 'ملاحظات' },
      ].map(({ list, cls, title }) =>
        list.length === 0 ? null : (
          <div key={title} style={{ marginBottom: 12 }}>
            <h3 className={styles.cardTitle}>{title}</h3>
            {list.map((f, i) => (
              <p key={i} className={cls} style={{ marginBottom: 6 }}>
                {f.rule !== null && (
                  <strong>
                    قاعدة {f.rule}
                    {f.indicator && (
                      <>
                        {' — '}
                        <code dir="ltr">{f.indicator}</code>
                      </>
                    )}
                    :{' '}
                  </strong>
                )}
                {f.message}
              </p>
            ))}
          </div>
        ),
      )}

      {report.observed.length > 0 && (
        <details>
          <summary className={styles.summary}>
            القيم اللي رجعت من كل مؤشر دلوقتي ({report.observed.length})
          </summary>
          <div className={styles.tableWrap} style={{ marginTop: 10 }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>المؤشر</th>
                  <th>النوع</th>
                  <th>القيمة الحالية</th>
                </tr>
              </thead>
              <tbody>
                {report.observed.map((o, i) => (
                  <tr key={`${o.indicator}-${i}`}>
                    <td data-label="المؤشر" dir="ltr" className={styles.mono}>
                      {o.indicator}
                    </td>
                    <td data-label="النوع">{o.type === 'text' ? 'نص' : 'رقم'}</td>
                    <td data-label="القيمة الحالية" dir="ltr" className={styles.mono}>
                      {o.sample}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Backtest results.
 *
 * Leads with the honest reading rather than the headline number: a 100% win
 * rate off four trades is noise, and printing it large is how a strategy gets
 * shipped on the strength of nothing. The confidence interval and the trade
 * count sit right next to the rate for the same reason.
 */
function BacktestPanel({ report, horizon }: { report: BacktestReport; horizon: number }) {
  const v = verdict(report);
  const decided = report.wins + report.losses;
  const ci = confidence(report.wins, decided);
  const toneClass = v.tone === 'good' ? styles.ok : v.tone === 'ok' ? styles.warn : styles.error;

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>📊 نتيجة الباك تست</h2>

      <p className={toneClass}>{v.text}</p>

      <div className={styles.statRow}>
        <div
          className={`${styles.stat} ${
            v.tone === 'good' ? styles.statGreen : v.tone === 'bad' ? styles.statRed : styles.statGold
          }`}
        >
          <span className={styles.statValue}>{report.winRate.toFixed(1)}%</span>
          <span className={styles.statLabel}>نسبة النجاح</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{report.trades.length}</span>
          <span className={styles.statLabel}>صفقة</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>
            {report.avgCandlesBetweenSignals !== null
              ? `${Math.round(report.avgCandlesBetweenSignals)}د`
              : '—'}
          </span>
          <span className={styles.statLabel}>متوسط الانتظار</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{report.wins}/{report.losses}</span>
          <span className={styles.statLabel}>ربح / خسارة</span>
        </div>
      </div>

      {/* Every ⚠️ warning, not just the coverage one — the gap-splitting notice
          was invisible while this was gated on `hours < 24`. */}
      {report.warnings.some((w) => w.startsWith('⚠️')) && (
        <p className={styles.warn}>
          {report.warnings
            .filter((w) => w.startsWith('⚠️'))
            .map((w, i) => (
              <span key={i}>
                {w}
                <br />
              </span>
            ))}
          {report.coverage.hours < 24 && report.warnings[report.warnings.length - 1]}
        </p>
      )}

      <p className={styles.switchHint}>
        اتجرّبت على <strong>{report.evaluated.toLocaleString('en-US')}</strong> شمعة من{' '}
        <strong>{report.pairsUsed}</strong> زوج، بتغطية{' '}
        <strong>{report.coverage.hours}/24</strong> ساعة على{' '}
        <strong>{report.coverage.days}</strong> يوم، بدخول على الإشارة وخروج بعد{' '}
        <strong>{horizon}</strong> شمعة بالظبط.
        {report.coverage.gaps > 0 && (
          <>
            {' '}اتقسّم عند <strong>{report.coverage.gaps}</strong> فجوة في التاريخ
            {report.coverage.barsDropped > 0 && (
              <> (و<strong>{report.coverage.barsDropped}</strong> شمعة اتشالت)</>
            )}.
          </>
        )}
        {' '}بتصدر إشارة على {report.signalsPer100.toFixed(1)}% من الشموع.
        {ci && (
          <>
            {' '}المدى الواقعي لنسبة النجاح بثقة 95%: <strong>{ci.low.toFixed(0)}%–{ci.high.toFixed(0)}%</strong>
            {' '}— كل ما الصفقات تزيد، المدى ده يضيق.
          </>
        )}
      </p>

      {report.blockedReasons.length > 0 && (
        <>
          <h3 className={styles.cardTitle} style={{ marginTop: 14 }}>إيه اللي رفض الصفقات</h3>
          {report.blockedReasons.map((b) => (
            <p key={b.reason} className={styles.switchHint}>
              <strong>{b.count}×</strong> {b.reason}
            </p>
          ))}
        </>
      )}

      {report.perPair.some((p) => p.trades > 0) && (
        <details style={{ marginTop: 12 }}>
          <summary className={styles.summary}>التفصيل حسب الزوج</summary>
          <div className={styles.tableWrap} style={{ marginTop: 10 }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>الزوج</th>
                  <th>صفقات</th>
                  <th>ربح</th>
                  <th>خسارة</th>
                </tr>
              </thead>
              <tbody>
                {report.perPair
                  .filter((p) => p.trades > 0)
                  .map((p) => (
                    <tr key={p.symbol}>
                      <td data-label="الزوج" dir="ltr" className={styles.mono}>
                        {p.symbol.replace('_otc', '')}
                      </td>
                      <td data-label="صفقات">{p.trades}</td>
                      <td data-label="ربح">{p.wins}</td>
                      <td data-label="خسارة">{p.losses}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {report.warnings.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className={styles.summary}>أزواج اتخطّت ({report.warnings.length})</summary>
          {report.warnings.map((w) => (
            <p key={w} className={styles.switchHint}>{w}</p>
          ))}
        </details>
      )}
    </div>
  );
}
