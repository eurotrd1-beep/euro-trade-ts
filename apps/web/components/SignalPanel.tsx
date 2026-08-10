'use client';

/**
 * Signal panel — ported from `_buildSignalPanel`, `_buildDurationSelector` and
 * `_buildRequestButton` in main_screen.dart.
 *
 * Three states: idle (request a signal), active (a live trade counting down),
 * and settled (WIN / LOSS / TIE). The wait banner replaces the panel body when
 * the strategy declined to fire — the Dart code is explicit that it must NOT
 * force a signal in that case.
 */

import { formatPrice, tr } from '@euro/shared';
import type { TradingSignal } from '@euro/engine';
import styles from './SignalPanel.module.css';

const DURATIONS = [1, 2, 5, 10];

/** Arabic pluralises 1 / 2 / 3+ differently, so the label is not a simple join. */
function durationLabel(minutes: number): string {
  const ar =
    minutes === 1 ? 'دقيقة واحدة' : minutes === 2 ? 'دقيقتين' : `${minutes} دقائق`;
  const en = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return tr(ar, en);
}

function mmss(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export interface SignalPanelProps {
  signal: TradingSignal | null;
  secondsRemaining: number;
  waitNotice: string;
  analysing: boolean;
  selectedMinutes: number;
  onSelectMinutes: (m: number) => void;
  onRequest: () => void;
  onClear: () => void;
  hasCandles: boolean;
  isVip: boolean;
}

export function SignalPanel({
  signal,
  secondsRemaining,
  waitNotice,
  analysing,
  selectedMinutes,
  onSelectMinutes,
  onRequest,
  onClear,
  hasCandles,
  isVip,
}: SignalPanelProps) {
  const active = signal?.status === 'ACTIVE';
  const settled = signal !== null && !active;

  return (
    <section className={styles.panel}>
      <header className={styles.head}>
        <h2 className={styles.title}>{tr('إشارة التداول', 'Trading signal')}</h2>
        {isVip && <span className={styles.vipTag}>VIP</span>}
      </header>

      {active && signal && <ActiveSignal signal={signal} secondsRemaining={secondsRemaining} />}

      {settled && signal && <SettledSignal signal={signal} onClear={onClear} />}

      {!signal && waitNotice && (
        <div className={styles.waitBanner} role="status">
          <span aria-hidden="true">⏳</span>
          <p>
            {waitNotice === 'strategy'
              ? tr(
                  'لا توجد فرصة دخول الآن — لم تتحقق شروط الاستراتيجية',
                  'No entry opportunity now — the strategy conditions were not met',
                )
              : tr(
                  'لا توجد فرصة دخول الآن — لم يتحقق الحد الأدنى للتوافق (min_score)',
                  'No entry opportunity now — the minimum confluence (min_score) was not reached',
                )}
          </p>
        </div>
      )}

      {!active && (
        <>
          <div className={styles.durations}>
            <div className={styles.durationHead}>
              <span className={styles.label}>
                {tr('مدة الصفقة المستهدفة:', 'Target trade duration:')}
              </span>
              <span className={styles.durationValue}>{durationLabel(selectedMinutes)}</span>
            </div>

            <div className={styles.durationRow} role="group">
              {DURATIONS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onSelectMinutes(m)}
                  className={`${styles.durationBtn} ${selectedMinutes === m ? styles.durationActive : ''}`}
                  aria-pressed={selectedMinutes === m}
                >
                  {tr(`${m} د`, `${m}m`)}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={onRequest}
            disabled={!hasCandles || analysing}
            className={styles.requestBtn}
          >
            {analysing
              ? tr('جاري التحليل...', 'Analysing…')
              : !hasCandles
                ? tr('في انتظار بيانات السوق...', 'Waiting for market data…')
                : tr('اطلب إشارة الآن', 'Request a signal now')}
          </button>
        </>
      )}
    </section>
  );
}

function ActiveSignal({
  signal,
  secondsRemaining,
}: {
  signal: TradingSignal;
  secondsRemaining: number;
}) {
  const isCall = signal.direction === 'CALL';

  return (
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
  );
}

function SettledSignal({ signal, onClear }: { signal: TradingSignal; onClear: () => void }) {
  const result = signal.status;
  const cls = result === 'WIN' ? styles.win : result === 'LOSS' ? styles.loss : styles.tie;

  const resultLabel =
    result === 'WIN'
      ? tr('صفقة رابحة ✅', 'Winning trade ✅')
      : result === 'LOSS'
        ? tr('صفقة خاسرة ❌', 'Losing trade ❌')
        : tr('تعادل — تم رد الرهان', 'Tie — stake refunded');

  return (
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
