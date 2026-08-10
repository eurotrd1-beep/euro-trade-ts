'use client';

/**
 * Asset selector.
 *
 * The pair list used to sit open on the screen as a grid. It took a lot of
 * vertical space and, with 183 symbols, still meant a lot of scrolling.
 *
 * Now the categories are the only thing on screen; tapping one opens a dialog
 * holding just that category's pairs, with the search focused and ready. The
 * category tabs themselves still follow `_categoryHasPairs` — a category with
 * no visible pairs is not shown at all.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { tr, type PairRow } from '@euro/shared';
import styles from './AssetSelector.module.css';

/** Fixed order and copy, matching the Dart tab row. */
const CATEGORIES: Array<{ id: string; ar: string; en: string; icon: string }> = [
  { id: 'currencies', ar: 'عملات', en: 'Currencies', icon: '💱' },
  { id: 'commodities', ar: 'سلع', en: 'Commodities', icon: '🛢️' },
  { id: 'stocks', ar: 'أسهم', en: 'Stocks', icon: '🏢' },
  { id: 'indices', ar: 'مؤشرات', en: 'Indices', icon: '📈' },
  { id: 'crypto', ar: 'كريبتو', en: 'Crypto', icon: '₿' },
];

export interface AssetSelectorProps {
  pairs: PairRow[];
  active: string;
  onSelect: (symbol: string) => void;
  /** Symbols the proxy reports as closed; shown but not selectable. */
  closedPairs?: Record<string, boolean>;
}

export function AssetSelector({ pairs, active, onSelect, closedPairs = {} }: AssetSelectorProps) {
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  const available = useMemo(
    () =>
      CATEGORIES.map((c) => ({ ...c, count: pairs.filter((p) => p.category === c.id).length }))
        .filter((c) => c.count > 0),
    [pairs],
  );

  const activePair = pairs.find((p) => p.symbol === active);

  return (
    <section className={styles.selector}>
      <div className={styles.currentRow}>
        <span className={styles.currentLabel}>{tr('الزوج الحالي', 'Current pair')}</span>
        <span className={styles.currentPair}>{active}</span>
      </div>

      <div className={styles.tabs}>
        {available.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setOpenCategory(c.id)}
            className={`${styles.tab} ${activePair?.category === c.id ? styles.tabActive : ''}`}
            aria-haspopup="dialog"
          >
            <span aria-hidden="true">{c.icon}</span>
            {tr(c.ar, c.en)}
            <span className={styles.count}>{c.count}</span>
          </button>
        ))}
      </div>

      {openCategory && (
        <PairDialog
          category={CATEGORIES.find((c) => c.id === openCategory)!}
          pairs={pairs.filter((p) => p.category === openCategory)}
          active={active}
          closedPairs={closedPairs}
          onPick={(symbol) => {
            onSelect(symbol);
            setOpenCategory(null);
          }}
          onClose={() => setOpenCategory(null)}
        />
      )}
    </section>
  );
}

function PairDialog({
  category,
  pairs,
  active,
  closedPairs,
  onPick,
  onClose,
}: {
  category: { id: string; ar: string; en: string; icon: string };
  pairs: PairRow[];
  active: string;
  closedPairs: Record<string, boolean>;
  onPick: (symbol: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus the search immediately — the whole point is to type instead of scroll.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Escape closes, and the page behind must not scroll while the dialog is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pairs;
    return pairs.filter(
      (p) => p.symbol.toLowerCase().includes(q) || p.chart_symbol.toLowerCase().includes(q),
    );
  }, [pairs, query]);

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={tr(category.ar, category.en)}
      // Only a click on the backdrop itself closes — not one that bubbles up
      // from inside the panel.
      onMouseDown={(e) => {
        if (!panelRef.current?.contains(e.target as Node)) onClose();
      }}
    >
      <div className={styles.panel} ref={panelRef}>
        <header className={styles.panelHead}>
          <h2 className={styles.panelTitle}>
            <span aria-hidden="true">{category.icon}</span>
            {tr(category.ar, category.en)}
            <span className={styles.count}>{pairs.length}</span>
          </h2>
          <button type="button" onClick={onClose} className={styles.closeBtn}>
            <span aria-hidden="true">✕</span>
            <span className="sr-only">{tr('إغلاق', 'Close')}</span>
          </button>
        </header>

        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={styles.search}
          placeholder={tr('ابحث عن زوج...', 'Search for a pair…')}
          aria-label={tr('ابحث عن زوج', 'Search for a pair')}
        />

        <div className={styles.pairs}>
          {visible.length === 0 ? (
            <p className={styles.empty}>{tr('لا توجد نتائج', 'No results')}</p>
          ) : (
            visible.map((p) => {
              const closed = closedPairs[p.chart_symbol] === true;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onPick(p.symbol)}
                  disabled={closed}
                  className={`${styles.pair} ${active === p.symbol ? styles.pairActive : ''}`}
                  aria-current={active === p.symbol ? 'true' : undefined}
                >
                  <span className={styles.pairSymbol}>{p.symbol}</span>
                  {closed && <span className={styles.closed}>{tr('مغلق', 'Closed')}</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
