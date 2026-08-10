'use client';

/**
 * Signal history — ported from `_buildSignalHistoryCard` / `_buildFilterTab`.
 *
 * Same three filters and the same win-rate line. Ties are excluded from the
 * win-rate denominator: a refunded stake is neither a win nor a loss, and
 * counting it as a loss would understate the number the user is judged on.
 */

import { useMemo, useState } from 'react';
import { formatPrice, tr } from '@euro/shared';
import type { TradingSignal } from '@euro/engine';
import styles from './SignalHistory.module.css';

type Filter = 'today' | 'week' | 'all';

const FILTERS: Array<{ id: Filter; ar: string; en: string }> = [
  { id: 'today', ar: 'اليوم', en: 'Today' },
  { id: 'week', ar: 'الأسبوع', en: 'Week' },
  { id: 'all', ar: 'الكل', en: 'All' },
];

function withinFilter(signal: TradingSignal, filter: Filter): boolean {
  if (filter === 'all') return true;
  const now = new Date();
  const entry = new Date(signal.entryTime);

  if (filter === 'today') {
    return (
      entry.getFullYear() === now.getFullYear() &&
      entry.getMonth() === now.getMonth() &&
      entry.getDate() === now.getDate()
    );
  }
  return now.getTime() - entry.getTime() <= 7 * 24 * 60 * 60 * 1000;
}

export function SignalHistory({ history }: { history: TradingSignal[] }) {
  const [filter, setFilter] = useState<Filter>('today');

  const visible = useMemo(
    () => history.filter((s) => withinFilter(s, filter)),
    [history, filter],
  );

  const { wins, decided } = useMemo(() => {
    const settled = visible.filter((s) => s.status === 'WIN' || s.status === 'LOSS');
    return { wins: settled.filter((s) => s.status === 'WIN').length, decided: settled.length };
  }, [visible]);

  const winRate = decided > 0 ? Math.round((wins / decided) * 100) : 0;

  return (
    <section className={styles.card}>
      <header className={styles.head}>
        <h2 className={styles.title}>{tr('سجل الإشارات', 'Signal history')}</h2>
        <span className={styles.rate}>
          {decided > 0
            ? tr(`نسبة النجاح ${winRate}%`, `Win rate ${winRate}%`)
            : tr('لا توجد صفقات بعد', 'No trades yet')}
        </span>
      </header>

      <div className={styles.filters} role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`${styles.filter} ${filter === f.id ? styles.filterActive : ''}`}
          >
            {tr(f.ar, f.en)}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className={styles.empty}>
          {tr('لا توجد إشارات في هذه الفترة', 'No signals in this period')}
        </p>
      ) : (
        <ul className={styles.list}>
          {visible.map((s, i) => (
            <li key={`${s.entryTime}-${i}`} className={styles.row}>
              <span className={`${styles.badge} ${styles[s.status.toLowerCase()] ?? ''}`}>
                {s.status === 'WIN' ? '✓' : s.status === 'LOSS' ? '✕' : '='}
              </span>

              <span className={styles.rowMain}>
                <span className={styles.rowPair}>{s.pair}</span>
                <span className={styles.rowMeta}>
                  {s.direction} · {formatPrice(s.entryPrice)}
                  {s.exitPrice !== null && ` → ${formatPrice(s.exitPrice)}`}
                </span>
              </span>

              <time className={styles.rowTime} dir="ltr">
                {new Date(s.entryTime).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
