'use client';

/**
 * Asset selector — ported from `_buildAssetSelector` / `_buildCategoryTab`.
 *
 * A category tab only appears when at least one visible pair belongs to it
 * (`_categoryHasPairs` in Dart), so a filtered list never shows an empty tab.
 */

import { useMemo, useState } from 'react';
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
  /** Symbols the proxy reports as closed; they stay visible but disabled. */
  closedPairs?: Record<string, boolean>;
}

export function AssetSelector({ pairs, active, onSelect, closedPairs = {} }: AssetSelectorProps) {
  const [category, setCategory] = useState('currencies');
  const [query, setQuery] = useState('');

  const available = useMemo(
    () => CATEGORIES.filter((c) => pairs.some((p) => p.category === c.id)),
    [pairs],
  );

  // If the active category disappears (admin disabled its last pair), fall
  // back to the first one that still has pairs.
  const effectiveCategory = available.some((c) => c.id === category)
    ? category
    : (available[0]?.id ?? 'currencies');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pairs.filter(
      (p) => p.category === effectiveCategory && (!q || p.symbol.toLowerCase().includes(q)),
    );
  }, [pairs, effectiveCategory, query]);

  return (
    <section className={styles.selector}>
      <div className={styles.tabs} role="tablist">
        {available.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={effectiveCategory === c.id}
            onClick={() => setCategory(c.id)}
            className={`${styles.tab} ${effectiveCategory === c.id ? styles.tabActive : ''}`}
          >
            <span aria-hidden="true">{c.icon}</span>
            {tr(c.ar, c.en)}
          </button>
        ))}
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={styles.search}
        placeholder={tr('ابحث عن زوج...', 'Search for a pair…')}
        aria-label={tr('ابحث عن زوج', 'Search for a pair')}
      />

      <div className={styles.pairs}>
        {visible.length === 0 ? (
          <p className={styles.empty}>
            {tr('لا توجد أزواج متاحة في هذا القسم', 'No pairs available in this section')}
          </p>
        ) : (
          visible.map((p) => {
            const closed = closedPairs[p.chart_symbol] === true;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p.symbol)}
                disabled={closed}
                className={`${styles.pair} ${active === p.symbol ? styles.pairActive : ''}`}
                aria-pressed={active === p.symbol}
              >
                <span className={styles.pairSymbol}>{p.symbol}</span>
                {closed && <span className={styles.closed}>{tr('مغلق', 'Closed')}</span>}
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
