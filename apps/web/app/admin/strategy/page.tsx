'use client';

/**
 * Strategies — what each plan runs, and how it did on history.
 *
 * ── WHAT THIS SCREEN USED TO BE ────────────────────────────────────────────
 *
 * A JSON editor. You wrote a rule file — or had Gemini write one from the
 * generated indicator reference — ran a validator over it, published it into a
 * `configs` row, and every user's next signal came from it. That whole loop is
 * gone, because strategies are no longer data: they are programs compiled into
 * the engine, state machines over a sequence of candles that no list of rules
 * could express (see `programs/types.ts`).
 *
 * Which means there is nothing to upload here any more, and pretending
 * otherwise would be the worst outcome — an operator publishing a file, seeing
 * nothing change, and having no way to find out why. So the upload, the
 * generator, the validator and the publish button were removed rather than
 * left switched off.
 *
 * What remains is the honest pair of questions: which strategy does each plan
 * run, and what does it do on candles that already happened. Changing a plan's
 * strategy is now a code change — one line in `programs/index.ts` — and this
 * screen reads that map rather than keeping its own copy of the answer.
 */

import { useState } from 'react';
import { programForPlan, type Plan, type StrategyProgram } from '@euro/engine';
import {
  backtest,
  confidence,
  verdict,
  BREAKEVEN_HIGH,
  MIN_TRADES_TO_JUDGE,
  type BacktestReport,
} from '@/lib/backtest';
import styles from '../admin.module.css';

/**
 * The pairs the replay runs over.
 *
 * All eight the feed keeps history for. More pairs is the only way to grow the
 * sample — the scraper records every symbol in the same minutes, so adding
 * pairs adds trades while adding no new hours of the day.
 */
const BACKTEST_PAIRS = [
  'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'AUDUSD_otc',
  'USDCAD_otc', 'EURJPY_otc', 'GBPJPY_otc', 'AUDCAD_otc',
];

const PLANS: Array<{ id: Plan; label: string }> = [
  { id: 'free', label: 'الخطة المجانية' },
  { id: 'paid', label: 'الخطة المدفوعة' },
];

export default function StrategyView() {
  const [plan, setPlan] = useState<Plan>('free');
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const program = programForPlan(plan);

  /**
   * Replays the plan's own program over the history the feed has.
   *
   * The program object handed to `backtest` is the same one the app drives, so
   * this cannot measure something other than what ships — and it is looked up
   * by PLAN, so the day the paid plan gets its own strategy this button starts
   * testing it with nothing here changing.
   */
  async function run(): Promise<void> {
    setBusy(true);
    setReport(null);
    setError(null);
    try {
      const r = await backtest({
        program,
        symbols: BACKTEST_PAIRS,
        onProgress: (done, total) => setProgress(`${done}/${total} زوج`),
      });
      setReport(r);
    } catch (e) {
      setError(`تعذّر الباك تست: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  return (
    <section>
      <h1 className={styles.title}>الاستراتيجيات</h1>

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>الخطط واستراتيجياتها</h2>
        <p className={styles.switchHint} style={{ marginBottom: 12 }}>
          الاستراتيجيات مثبّتة في المحرك — مفيش رفع ولا تعديل من هنا. تغيير استراتيجية خطة بيتم من
          الكود (<code>programs/index.ts</code>) وبينزل مع الديبلوي، فاللي بيوصل للمستخدمين هو نفسه
          اللي الباك تست بيقيسه بالظبط.
        </p>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>الخطة</th><th>الاستراتيجية</th><th>الفريم</th><th>مدة الصفقة</th>
              </tr>
            </thead>
            <tbody>
              {PLANS.map((p) => {
                const prog: StrategyProgram = programForPlan(p.id);
                return (
                  <tr key={p.id}>
                    <td>{p.label}</td>
                    <td>
                      {prog.name} <code>{prog.id}</code>
                    </td>
                    <td>{prog.timeframe}</td>
                    <td>{prog.durationMinutes} دقيقة</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>🧪 باك تست</h2>
        <p className={styles.switchHint} style={{ marginBottom: 12 }}>
          بيشغّل استراتيجية الخطة على كل التاريخ المتاح من {BACKTEST_PAIRS.length} أزواج، شمعة
          بشمعة، بنفس الكود اللي بيشتغل في التطبيق — بنفس قواعد عدم الـrepainting، وبنفس التسوية،
          وبنفس المضاعفة.
        </p>

        <p className={styles.label}>الخطة</p>
        <div className={styles.filters} style={{ marginBottom: 12 }}>
          {PLANS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => { setPlan(p.id); setReport(null); }}
              aria-pressed={plan === p.id}
              className={`${styles.chip} ${plan === p.id ? styles.chipActive : ''}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <button type="button" onClick={() => void run()} disabled={busy} className={styles.primaryBtn}>
          {busy ? (progress || 'جاري التشغيل...') : `▶️ شغّل على ${program.name}`}
        </button>

        {error !== null && <p className={styles.error} style={{ marginTop: 12 }}>{error}</p>}
      </div>

      {report !== null && <BacktestPanel report={report} program={program} />}
    </section>
  );
}

/**
 * The result.
 *
 * Cycles lead, trades follow. A martingale strategy read per trade is
 * misleading in both directions: a loss followed by a winning double is a
 * PROFIT that shows up as 50%, and a loss followed by a losing double is one
 * bad decision that shows up as two.
 */
function BacktestPanel({ report, program }: { report: BacktestReport; program: StrategyProgram }) {
  const v = verdict(report);
  const decided = report.wins + report.losses;
  const ci = confidence(report.wins, decided);
  const cyclesDecided = report.cycles.won + report.cycles.recovered + report.cycles.finalLoss;
  const toneClass = v.tone === 'good' ? styles.ok : v.tone === 'ok' ? styles.warn : styles.error;

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>📊 نتيجة الباك تست — {program.name}</h2>

      <p className={toneClass}>{v.text}</p>

      <div className={styles.statRow}>
        <div
          className={`${styles.stat} ${
            report.cycleWinRate >= BREAKEVEN_HIGH ? styles.statGreen : styles.statRed
          }`}
        >
          <span className={styles.statValue}>{report.cycleWinRate.toFixed(1)}%</span>
          <span className={styles.statLabel}>دورات رابحة</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{cyclesDecided}</span>
          <span className={styles.statLabel}>دورة محسومة</span>
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
      </div>

      <div className={styles.tableWrap} style={{ marginTop: 12 }}>
        <table className={styles.table}>
          <thead>
            <tr><th>نهاية الدورة</th><th>العدد</th><th>معناها</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>ربحت من الأول</td>
              <td>{report.cycles.won}</td>
              <td>الصفقة الأساسية كسبت — مفيش مضاعفة</td>
            </tr>
            <tr>
              <td>المضاعفة عوّضت</td>
              <td>{report.cycles.recovered}</td>
              <td>خسرت الأولى وكسبت التانية — ربح صافي بضعف الرهان</td>
            </tr>
            <tr>
              <td>خسارة نهائية</td>
              <td>{report.cycles.finalLoss}</td>
              <td>خسرت الاتنين — التكلفة تلات أضعاف رهان واحد</td>
            </tr>
            <tr>
              <td>تعادل</td>
              <td>{report.cycles.tie}</td>
              <td>الرهان اترد — خارج الحساب</td>
            </tr>
            <tr>
              <td>ملغاة</td>
              <td>{report.cycles.aborted}</td>
              <td>شمعة الدخول ما وصلتش — مفيش صفقة اتفتحت</td>
            </tr>
          </tbody>
        </table>
      </div>

      {report.warnings.some((w) => w.startsWith('⚠️')) && (
        <p className={styles.warn} style={{ marginTop: 12 }}>
          {report.warnings
            .filter((w) => w.startsWith('⚠️'))
            .map((w, i) => (
              <span key={i}>
                {w}
                <br />
              </span>
            ))}
        </p>
      )}

      <p className={styles.switchHint}>
        اتجرّبت على <strong>{report.evaluated.toLocaleString('en-US')}</strong> شمعة من{' '}
        <strong>{report.pairsUsed}</strong> زوج، بتغطية{' '}
        <strong>{report.coverage.hours}/24</strong> ساعة على{' '}
        <strong>{report.coverage.days}</strong> يوم. الدخول على افتتاح الشمعة اللي بعد الإشارة
        والخروج على إغلاقها.
        {report.coverage.gaps > 0 && (
          <>
            {' '}اتقسّم عند <strong>{report.coverage.gaps}</strong> فجوة في التاريخ
            {report.coverage.barsDropped > 0 && (
              <> (و<strong>{report.coverage.barsDropped}</strong> شمعة اتشالت)</>
            )}.
          </>
        )}
        {' '}بتصدر إشارة على {report.signalsPer100.toFixed(1)}% من الشموع.
        {ci !== null && decided >= MIN_TRADES_TO_JUDGE && (
          <>
            {' '}مجال الثقة 95% لنسبة الصفقات: {ci.low.toFixed(1)}% — {ci.high.toFixed(1)}%.
          </>
        )}
      </p>

      {report.perPair.length > 0 && (
        <div className={styles.tableWrap} style={{ marginTop: 12 }}>
          <table className={styles.table}>
            <thead>
              <tr><th>الزوج</th><th>صفقات</th><th>ربح</th><th>خسارة</th></tr>
            </thead>
            <tbody>
              {report.perPair.map((p) => (
                <tr key={p.symbol}>
                  <td>{p.symbol}</td>
                  <td>{p.trades}</td>
                  <td>{p.wins}</td>
                  <td>{p.losses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
