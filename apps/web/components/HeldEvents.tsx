'use client';

/**
 * What happened on the other pairs while a trade was running.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * The watch keeps evaluating every chosen pair throughout a trade — that is the
 * point of choosing several. What it stops doing is interrupting: a phone that
 * buzzes about GBP/JPY while the user is watching a trade play out on gold is
 * pulling their attention off the one thing that is costing them money.
 *
 * But silence must not mean forgetting. Every event is kept, and they all
 * arrive together the moment the trade finishes, so the user learns what they
 * missed without having been disturbed during it.
 *
 * ── FIVE, AND A COUNT ──────────────────────────────────────────────────────
 *
 * Nearest to firing first, because that is the order somebody would want to act
 * in. Five shown, and the rest counted rather than listed: a panel of fifteen
 * rows arriving at once is the interruption this was built to avoid, wearing a
 * different shape.
 *
 * Every row opens that pair's chart. It is dismissible, and dismissing it is
 * the only way it leaves — a panel that faded on its own would take the
 * information with it.
 */

import { tr } from '@euro/shared';
import styles from './HeldEvents.module.css';

/** How many to list before the rest become a number. */
const SHOWN = 5;

export interface HeldEvent {
  symbol: string;
  percent: number;
  at: number;
  /** True when the pair reached its level — the strongest kind of event. */
  fired: boolean;
}

export interface HeldEventsProps {
  events: readonly HeldEvent[];
  displayName: (chartSymbol: string) => string;
  onSelect: (chartSymbol: string) => void;
  onDismiss: () => void;
}

export function HeldEvents({ events, displayName, onSelect, onDismiss }: HeldEventsProps) {
  if (events.length === 0) return null;

  // A pair that actually reached its level outranks one that merely came close,
  // whatever their percentages say — 100 and "fired" are not the same claim.
  const sorted = [...events].sort(
    (a, b) =>
      Number(b.fired) - Number(a.fired) ||
      b.percent - a.percent ||
      a.symbol.localeCompare(b.symbol),
  );
  const shown = sorted.slice(0, SHOWN);
  const rest = sorted.length - shown.length;

  return (
    <section className={styles.panel} role="status">
      <header className={styles.head}>
        <span aria-hidden="true">📬</span>
        <h2 className={styles.title}>
          {tr('حصل ده وإنت مشغول', 'While you were busy')}
        </h2>
        <button
          type="button"
          onClick={onDismiss}
          className={styles.close}
          aria-label={tr('إخفاء', 'Dismiss')}
        >
          ✕
        </button>
      </header>

      <ul className={styles.list}>
        {shown.map((e) => (
          <li key={e.symbol}>
            <button type="button" onClick={() => onSelect(e.symbol)} className={styles.row}>
              <span className={styles.icon} aria-hidden="true">{e.fired ? '⚡' : '🎯'}</span>
              <span className={styles.name}>{displayName(e.symbol)}</span>
              <span className={e.fired ? styles.fired : styles.near}>
                {e.fired
                  ? tr('وصل للمستوى', 'Reached its level')
                  : tr(`${Math.round(e.percent)}%`, `${Math.round(e.percent)}%`)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {rest > 0 && (
        <p className={styles.more}>
          {tr(`+${rest} غيرهم`, `+${rest} more`)}
        </p>
      )}
    </section>
  );
}
