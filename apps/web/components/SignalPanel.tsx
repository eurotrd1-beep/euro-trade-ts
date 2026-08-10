'use client';

/**
 * Signal panel — ported from `_buildSignalPanel` (main_screen.dart:4645).
 *
 * Structure follows the original exactly, including which state wins:
 *
 *   isAnalyzing              → the analysis panel (stage text + spinner)
 *   isMonitoring && !signal  → the monitoring panel (rendered by the parent)
 *   signal == null           → the idle panel: header, description, wait
 *                              banner, duration selector, then BOTH buttons
 *                              stacked in the same card, each with its own "?"
 *   otherwise                → the active/finished trade
 *
 * Both buttons live here together because that is where they live in the
 * original — one card, one below the other.
 */

import { formatPrice, tr } from '@euro/shared';
import type { TradingSignal } from '@euro/engine';
import { formatElapsed, type MonitoringState } from '@/lib/useMonitoring';
import styles from './SignalPanel.module.css';

const DURATIONS = [1, 2, 5, 10];

/** Arabic pluralises 1 / 2 / 3+ differently, as the original does. */
function durationLabel(minutes: number): string {
  const ar = minutes === 1 ? 'دقيقة واحدة' : minutes === 2 ? 'دقيقتين' : `${minutes} دقائق`;
  return tr(ar, `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
}

function mmss(total: number): string {
  const s = Math.max(0, total);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export interface SignalPanelProps {
  signal: TradingSignal | null;
  secondsRemaining: number;
  waitNotice: string;
  analysing: boolean;
  analysisStage: string;
  marketClosed: boolean;
  pair: string;
  timeframe: string;
  selectedMinutes: number;
  onSelectMinutes: (m: number) => void;
  onRequest: () => void;
  onClear: () => void;
  hasCandles: boolean;
  monitoring: MonitoringState;
  onStartMonitoring: () => void;
  onStopMonitoring: () => void;
}

export function SignalPanel(props: SignalPanelProps) {
  const { signal, analysing, monitoring } = props;

  if (analysing) return <AnalysisView {...props} />;
  if (monitoring.active && signal === null) return <MonitoringView {...props} />;
  if (signal === null) return <IdleView {...props} />;
  return <TradeView {...props} />;
}

/* ── Analysing ─────────────────────────────────────────────────────────────── */

function AnalysisView({ analysisStage }: SignalPanelProps) {
  return (
    <section className={styles.panel}>
      <div className={styles.analysing}>
        <div className={styles.spinner} aria-hidden="true" />
        <p className={styles.stageText} aria-live="polite">
          {analysisStage}
        </p>
      </div>
    </section>
  );
}

/* ── Monitoring ────────────────────────────────────────────────────────────── */

function MonitoringView({ monitoring, onStopMonitoring }: SignalPanelProps) {
  return (
    <section className={`${styles.panel} ${styles.monitoringPanel}`}>
      <div className={styles.monHead}>
        <span className={styles.radar} aria-hidden="true">
          ◎
        </span>
        <h2 className={styles.monTitle}>{tr('جاري المراقبة...', 'Monitoring...')}</h2>
        <span className={styles.monElapsed} dir="ltr">
          {formatElapsed(monitoring.elapsedSeconds)}
        </span>
      </div>

      <div className={styles.countdownRow}>
        <span className={styles.countdownLabel}>
          {tr('الشمعة القادمة بعد', 'Next candle in')}
        </span>
        <span className={styles.monCountdown} dir="ltr">
          {mmss(monitoring.countdown)}
        </span>
      </div>

      <p className={styles.fired}>
        <span aria-hidden="true">🔔</span>{' '}
        {tr(
          `إشارات صدرت حتى الآن: ${monitoring.signalsFired}`,
          `Signals fired so far: ${monitoring.signalsFired}`,
        )}
      </p>

      <p className={monitoring.lastCheckFailed ? styles.notMet : styles.watching}>
        {monitoring.lastCheckFailed
          ? tr(
              'لم تتوافق شروط الدخول، جاري انتظار الشمعة التالية...',
              "Entry conditions weren't met, waiting for the next candle...",
            )
          : tr(
              'يراقب النظام السوق وينتظر أفضل لحظة دخول على بداية الشمعة القادمة.',
              'The system is watching the market and waiting for the best entry at the start of the next candle.',
            )}
      </p>

      <p className={styles.checked}>
        {tr(`شموع تم تحليلها: ${monitoring.checksDone}`, `Candles analysed: ${monitoring.checksDone}`)}
      </p>

      <button type="button" onClick={onStopMonitoring} className={styles.stopBtn}>
        {tr('إيقاف المراقبة', 'Stop monitoring')}
      </button>
    </section>
  );
}

/* ── Idle ──────────────────────────────────────────────────────────────────── */

function IdleView({
  waitNotice,
  marketClosed,
  pair,
  timeframe,
  selectedMinutes,
  onSelectMinutes,
  onRequest,
  hasCandles,
  onStartMonitoring,
}: SignalPanelProps) {
  const name = pair.replace(' (OTC)', '');
  const disabled = !hasCandles || marketClosed;

  return (
    <section className={styles.panel}>
      <header className={styles.idleHead}>
        <span className={styles.brainIcon} aria-hidden="true">
          🧠
        </span>
        <div>
          <p className={styles.sensorTag}>VIP ALGORITHM SENSOR</p>
          <p className={styles.sensorTitle}>
            {tr('التحليل جاهز للاستخراج', 'Analysis ready to extract')}
          </p>
        </div>
      </header>

      <hr className={styles.divider} />

      <p className={styles.description}>
        {tr(
          `اضغط أدناه لبدء تحليل شامل للزوج ${name} بفريم ${timeframe} واستخراج الصفقة ذات الاحتمالية الأكبر.`,
          `Tap below to start a full analysis of ${name} on the ${timeframe} timeframe and extract the highest-probability trade.`,
        )}
      </p>

      {marketClosed && (
        <div className={styles.waitBanner} role="status">
          {tr('السوق مغلق حالياً', 'The market is currently closed')}
        </div>
      )}

      {waitNotice && (
        <div className={styles.waitBanner} role="status">
          {waitNotice === 'strategy'
            ? tr(
                'لا توجد فرصة دخول الآن — لم تتحقق شروط الاستراتيجية',
                'No entry opportunity now — the strategy conditions were not met',
              )
            : tr(
                'لا توجد فرصة دخول الآن — لم يتحقق الحد الأدنى للتوافق (min_score)',
                'No entry opportunity now — the minimum confluence (min_score) was not reached',
              )}
        </div>
      )}

      <DurationSelector selected={selectedMinutes} onSelect={onSelectMinutes} />

      {/* Both buttons, stacked, each with its own help — as in the original. */}
      <div className={styles.buttonRow}>
        <button type="button" onClick={onRequest} disabled={disabled} className={styles.requestBtn}>
          {tr('استخراج الإشارة الفورية ⚡', 'Extract instant signal ⚡')}
        </button>
        <HelpButton
          tone="cyan"
          text={tr(
            'يبدأ تحليلاً كاملاً على الشمعة الحالية، وينتظر إغلاقها ليفتح الصفقة مع الشمعة القادمة.',
            'Runs a full analysis on the current candle and waits for it to close so the trade opens with the next one.',
          )}
        />
      </div>

      <div className={styles.buttonRow}>
        <button
          type="button"
          onClick={onStartMonitoring}
          disabled={disabled}
          className={styles.monitorBtn}
        >
          {tr('المراقبة الذكية 🎯', 'Smart monitoring 🎯')}
        </button>
        <HelpButton
          tone="orange"
          text={tr(
            'يفحص كل شمعة عند إغلاقها ولا يصدر إشارة إلا لما تتحقق شروط الاستراتيجية فعلاً.',
            'Checks every candle as it closes and only fires when the strategy conditions genuinely hold.',
          )}
        />
      </div>
    </section>
  );
}

function DurationSelector({
  selected,
  onSelect,
}: {
  selected: number;
  onSelect: (m: number) => void;
}) {
  return (
    <div className={styles.durations}>
      <div className={styles.durationHead}>
        <span className={styles.label}>{tr('مدة الصفقة المستهدفة:', 'Target trade duration:')}</span>
        <span className={styles.durationValue}>{durationLabel(selected)}</span>
      </div>
      <div className={styles.durationRow} role="group">
        {DURATIONS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onSelect(m)}
            className={`${styles.durationBtn} ${selected === m ? styles.durationActive : ''}`}
            aria-pressed={selected === m}
          >
            {tr(`${m} د`, `${m}m`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function HelpButton({ tone, text }: { tone: 'cyan' | 'orange'; text: string }) {
  return (
    <button
      type="button"
      className={`${styles.helpBtn} ${tone === 'orange' ? styles.helpOrange : ''}`}
      title={text}
      onClick={() => alert(text)}
    >
      <span aria-hidden="true">؟</span>
      <span className="sr-only">{text}</span>
    </button>
  );
}

/* ── Active / finished trade ───────────────────────────────────────────────── */

function TradeView({ signal, secondsRemaining, onClear }: SignalPanelProps) {
  if (!signal) return null;
  const active = signal.status === 'ACTIVE';
  const isCall = signal.direction === 'CALL';

  if (active) {
    return (
      <section className={styles.panel}>
        <div className={`${styles.signalCard} ${isCall ? styles.call : styles.put}`}>
          <div className={styles.directionRow}>
            <span className={styles.direction}>
              {isCall ? '▲' : '▼'} {signal.direction}
            </span>
            <span className={styles.countdown} dir="ltr">
              {mmss(secondsRemaining)}
            </span>
          </div>

          <dl className={styles.metrics}>
            <Metric label={tr('سعر الدخول', 'Entry price')} value={formatPrice(signal.entryPrice)} />
            <Metric label={tr('الثقة', 'Confidence')} value={`${signal.confidence.toFixed(1)}%`} />
            <Metric label={tr('المدة', 'Duration')} value={durationLabel(signal.durationMinutes)} />
          </dl>
        </div>
      </section>
    );
  }

  const result = signal.status;
  const cls = result === 'WIN' ? styles.win : result === 'LOSS' ? styles.loss : styles.tie;
  const resultLabel =
    result === 'WIN'
      ? tr('صفقة رابحة ✅', 'Winning trade ✅')
      : result === 'LOSS'
        ? tr('صفقة خاسرة ❌', 'Losing trade ❌')
        : tr('تعادل — تم رد الرهان', 'Tie — stake refunded');

  return (
    <section className={styles.panel}>
      <div className={`${styles.signalCard} ${cls}`}>
        <p className={styles.resultText}>{resultLabel}</p>

        <dl className={styles.metrics}>
          <Metric label={tr('الدخول', 'Entry')} value={formatPrice(signal.entryPrice)} />
          <Metric
            label={tr('الإغلاق', 'Close')}
            value={signal.exitPrice !== null ? formatPrice(signal.exitPrice) : '—'}
          />
          <Metric label={tr('الاتجاه', 'Direction')} value={signal.direction} />
        </dl>

        <button type="button" onClick={onClear} className={styles.clearBtn}>
          {tr('إشارة جديدة', 'New signal')}
        </button>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <dt>{label}</dt>
      <dd dir="ltr">{value}</dd>
    </div>
  );
}
