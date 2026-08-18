'use client';

/**
 * Signal history — ported from `_buildSignalHistoryCard` (main_screen.dart:6017)
 * and `_buildFilterTab` (:6447).
 *
 * Same three filters (today / yesterday / custom range), the same two summary
 * boxes, and the same row: outcome pill, pair, direction badge, origin badge,
 * entry|close prices, and the entry time.
 *
 * Ties are excluded from the win-rate denominator, as in the original: a
 * refunded stake is neither a win nor a loss.
 */

import { useMemo, useState } from 'react';
import { formatPrice, tr } from '@euro/shared';
import type { TradingSignal } from '@euro/engine';
import styles from './SignalHistory.module.css';

type Filter = 'today' | 'yesterday' | 'custom';

interface DateRange {
  start: string;
  end: string;
}

/** `yyyy/MM/dd` — the format the Dart card prints for the custom range. */
function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

export function SignalHistory({ history }: { history: TradingSignal[] }) {
  const [filter, setFilter] = useState<Filter>('today');
  const [range, setRange] = useState<DateRange | null>(null);

  const filtered = useMemo(() => {
    return history.filter((sig) => {
      const entry = new Date(sig.entryTime);
      if (filter === 'today') return sameDay(entry, new Date());
      if (filter === 'yesterday') {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        return sameDay(entry, yesterday);
      }
      if (filter === 'custom') {
        if (range === null) return false;
        const start = new Date(`${range.start}T00:00:00`);
        // The Dart range ends at 23:59:59 of the last day.
        const end = new Date(`${range.end}T23:59:59`);
        return entry > start && entry < end;
      }
      return true;
    });
  }, [history, filter, range]);

  const totalCount = filtered.length;
  const winsCount = filtered.filter((s) => s.status === 'WIN').length;
  const lossesCount = filtered.filter((s) => s.status === 'LOSS').length;
  const tiesCount = filtered.filter((s) => s.status === 'TIE').length;
  // Running, or opened in a session that closed before expiry. Counted so the
  // breakdown still adds up to the total now that open trades are stored — and
  // kept out of `decidedCount`, because a trade with no result cannot move a
  // win rate in either direction.
  const openCount = filtered.filter((s) => s.status === 'ACTIVE' || s.status === 'PENDING').length;
  // Finished, but with no price to judge it by — the candle it ran on never
  // reached the app. Its own count, because folding it into ties would make
  // ties look commoner than they are and hide a feed problem as a market one.
  const unresolvedCount = filtered.filter((s) => s.status === 'UNRESOLVED').length;
  const decidedCount = winsCount + lossesCount;
  const winRate = decidedCount > 0 ? (winsCount / decidedCount) * 100 : 0;

  return (
    <section className={styles.card}>
      {/* Header */}
      <header className={styles.head}>
        <span className={styles.headIcon} aria-hidden="true">
          📊
        </span>
        <h2 className={styles.title}>{tr('إحصائيات وسجل صفقات الـ VIP', 'VIP stats & trade history')}</h2>
      </header>

      {/* Filter tabs */}
      <div className={styles.filters} role="tablist">
        <FilterTab
          label={tr('صفقات اليوم', 'Today')}
          active={filter === 'today'}
          onClick={() => setFilter('today')}
        />
        <FilterTab
          label={tr('صفقات الأمس', 'Yesterday')}
          active={filter === 'yesterday'}
          onClick={() => setFilter('yesterday')}
        />
        <FilterTab
          label={tr('فترة مخصصة 🗓️', 'Custom range 🗓️')}
          active={filter === 'custom'}
          onClick={() => setFilter('custom')}
        />
      </div>

      {/* Custom range picker — the web stand-in for showDateRangePicker */}
      {filter === 'custom' && (
        <div className={styles.rangeRow}>
          <label className={styles.rangeField}>
            <span>{tr('من', 'From')}</span>
            <input
              type="date"
              value={range?.start ?? ''}
              onChange={(e) => setRange({ start: e.target.value, end: range?.end ?? e.target.value })}
              className={styles.dateInput}
            />
          </label>
          <label className={styles.rangeField}>
            <span>{tr('إلى', 'To')}</span>
            <input
              type="date"
              value={range?.end ?? ''}
              onChange={(e) => setRange({ start: range?.start ?? e.target.value, end: e.target.value })}
              className={styles.dateInput}
            />
          </label>
        </div>
      )}

      {filter === 'custom' && range !== null && range.start !== '' && range.end !== '' && (
        <div className={styles.rangeBox}>
          <span className={styles.rangeLabel}>{tr('الفترة الزمنية المحددة:', 'Selected date range:')}</span>
          <span className={styles.rangeValue} dir="ltr">
            {formatDay(range.start)} {tr('إلى', 'to')} {formatDay(range.end)}
          </span>
        </div>
      )}

      {/* Summary stats */}
      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{tr('نسبة النجاح', 'Win rate')}</span>
          <span className={`${styles.statRate} ${winRate >= 70 ? styles.rateGood : styles.rateBad}`}>
            {winRate.toFixed(1)}%
          </span>
        </div>

        <div className={styles.stat}>
          <span className={styles.statLabel}>{tr('إجمالي الصفقات', 'Total trades')}</span>
          <span className={styles.statValue}>
            {tr(
              [
                `${winsCount} رابحة`,
                `${lossesCount} خاسرة`,
                ...(tiesCount > 0 ? [`${tiesCount} تعادل`] : []),
                // Shown only when it happened. A permanent "0 بدون سعر" would
                // train the eye to skip the one line that means the feed broke.
                ...(unresolvedCount > 0 ? [`${unresolvedCount} بدون سعر`] : []),
              ].join(' / '),
              [
                `${winsCount} won`,
                `${lossesCount} lost`,
                ...(tiesCount > 0 ? [`${tiesCount} tie`] : []),
                ...(unresolvedCount > 0 ? [`${unresolvedCount} no price`] : []),
              ].join(' / '),
            )}
          </span>
          <span className={styles.statSub}>
            {openCount > 0
              ? tr(
                  `(${totalCount} صفقات إجمالية · ${openCount} بلا نتيجة)`,
                  `(${totalCount} trades total · ${openCount} undecided)`,
                )
              : tr(`(${totalCount} صفقات إجمالية)`, `(${totalCount} trades total)`)}
          </span>
        </div>
      </div>

      {/* Log details */}
      {filtered.length === 0 ? (
        <p className={styles.empty}>
          {tr('لا توجد صفقات مسجلة في هذه الفترة.', 'No trades recorded in this period.')}
        </p>
      ) : (
        <ul className={styles.list}>
          {filtered.map((sig, i) => {
            // An undecided trade must never fall through to "loss". The
            // fallthrough used to be safe because only settled trades were ever
            // stored; now an open trade is saved the moment it is placed, so a
            // running trade — or one whose session closed before it expired —
            // reaches this list with no result at all.
            const isWin = sig.status === 'WIN';
            const isTie = sig.status === 'TIE';
            const isRunning = sig.status === 'ACTIVE';
            const isUnknown = sig.status === 'PENDING' || sig.status === 'UNRESOLVED';
            const outcome = isRunning || isUnknown ? 'open' : isTie ? 'tie' : isWin ? 'win' : 'loss';
            const isCall = sig.direction === 'CALL';
            const isMon = sig.origin === 'monitoring';
            const entry = new Date(sig.entryTime);
            const p = (n: number): string => String(n).padStart(2, '0');

            return (
              <li key={`${sig.entryTime}-${i}`} className={`${styles.row} ${styles[`row_${outcome}`]}`}>
                <span className={`${styles.pill} ${styles[`pill_${outcome}`]}`}>
                  {isRunning
                    ? tr('⏳ شغالة', '⏳ Running')
                    : isUnknown
                      ? tr('❔ بلا نتيجة', '❔ No result')
                      : isTie
                        ? tr('➖ تعادل', '➖ Tie')
                        : isWin
                          ? tr('✓ كسب', '✓ Win')
                          : tr('✗ خسارة', '✗ Loss')}
                </span>

                <span className={styles.details}>
                  <span className={styles.detailsTop}>
                    <strong className={styles.pair}>{sig.pair.replaceAll(' (OTC)', '')}</strong>
                    <span className={`${styles.dirBadge} ${isCall ? styles.dirCall : styles.dirPut}`}>
                      {isCall ? tr('صعود', 'Up') : tr('هبوط', 'Down')}
                    </span>
                    <span className={`${styles.originBadge} ${isMon ? styles.originMon : styles.originInstant}`}>
                      {isMon ? tr('🎯 بعد انتظار', '🎯 After waiting') : tr('⚡ أول شمعة', '⚡ First candle')}
                    </span>
                  </span>
                  <span className={styles.prices}>
                    {tr(
                      `دخول: ${formatPrice(sig.entryPrice)} | إغلاق: ${formatPrice(sig.exitPrice ?? sig.currentPrice)}`,
                      `Entry: ${formatPrice(sig.entryPrice)} | Close: ${formatPrice(sig.exitPrice ?? sig.currentPrice)}`,
                    )}
                  </span>
                </span>

                <time className={styles.time} dir="ltr">
                  {`${p(entry.getHours())}:${p(entry.getMinutes())}`}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** `_buildFilterTab`. */
function FilterTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`${styles.filter} ${active ? styles.filterActive : ''}`}
    >
      {label}
    </button>
  );
}
