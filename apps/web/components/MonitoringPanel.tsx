'use client';

/**
 * Smart monitoring panel — ported from `_buildMonitorButton` and
 * `_buildMonitoringWaitingPanel` (main_screen.dart:4020 / 4057).
 *
 * The difference from the manual request button is the whole point, so the copy
 * says it plainly: monitoring waits for a candle that MEETS the conditions
 * instead of scoring whatever candle happens to be open.
 */

import { tr } from '@euro/shared';
import { formatElapsed, type MonitoringState } from '@/lib/useMonitoring';
import styles from './MonitoringPanel.module.css';

export interface MonitoringPanelProps {
  state: MonitoringState;
  onStart: () => void;
  onStop: () => void;
  disabled: boolean;
  marketClosed: boolean;
}

function mmss(total: number): string {
  const s = Math.max(0, total);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function MonitoringPanel({
  state,
  onStart,
  onStop,
  disabled,
  marketClosed,
}: MonitoringPanelProps) {
  if (!state.active) {
    return (
      <section className={styles.panel}>
        <header className={styles.head}>
          <h2 className={styles.title}>{tr('المراقبة الذكية', 'Smart monitoring')}</h2>
        </header>

        <p className={styles.explain}>
          {tr(
            'بدل ما تطلب إشارة على الشمعة المفتوحة، المراقبة بتستنى كل شمعة تقفل وتفحصها — ومبتديش إشارة غير لما الشروط تتحقق فعلاً.',
            'Instead of scoring whichever candle is open, monitoring waits for each candle to close and checks it — and only fires when the conditions genuinely hold.',
          )}
        </p>

        <button
          type="button"
          onClick={onStart}
          disabled={disabled || marketClosed}
          className={styles.startBtn}
        >
          {marketClosed
            ? tr('السوق مغلق', 'Market closed')
            : tr('ابدأ المراقبة', 'Start monitoring')}
        </button>
      </section>
    );
  }

  return (
    <section className={`${styles.panel} ${styles.active}`}>
      <header className={styles.head}>
        <h2 className={styles.title}>
          <span className={styles.pulse} aria-hidden="true" />
          {tr('المراقبة شغّالة', 'Monitoring active')}
        </h2>
        <span className={styles.elapsed} dir="ltr">
          {formatElapsed(state.elapsedSeconds)}
        </span>
      </header>

      {state.phase === 'trade' ? (
        <p className={styles.phaseTrade}>
          {tr('صفقة مفتوحة — المراقبة هتكمل بعد النتيجة', 'Trade open — monitoring resumes after the result')}
        </p>
      ) : (
        <>
          <div className={styles.countdownRow}>
            <span className={styles.countdownLabel}>
              {tr('الشمعة الجاية بعد', 'Next candle in')}
            </span>
            <span className={styles.countdown} dir="ltr">
              {mmss(state.countdown)}
            </span>
          </div>

          {state.lastCheckFailed && (
            <p className={styles.notMet}>
              {tr(
                'الشمعة الأخيرة لم تحقق الشروط — في انتظار الشمعة القادمة',
                'The last candle did not meet the conditions — waiting for the next one',
              )}
            </p>
          )}
        </>
      )}

      <dl className={styles.stats}>
        <div>
          <dt>{tr('شموع مفحوصة', 'Candles checked')}</dt>
          <dd dir="ltr">{state.checksDone}</dd>
        </div>
        <div>
          <dt>{tr('إشارات صدرت', 'Signals fired')}</dt>
          <dd dir="ltr">{state.signalsFired}</dd>
        </div>
      </dl>

      <button type="button" onClick={onStop} className={styles.stopBtn}>
        {tr('إيقاف المراقبة', 'Stop monitoring')}
      </button>
    </section>
  );
}
