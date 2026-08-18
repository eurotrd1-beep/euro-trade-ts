'use client';

/**
 * Which pairs the notifications are about.
 *
 * ── WHY THIS IS A SCREEN AND NOT A CHECKBOX ────────────────────────────────
 *
 * Because the honest default is "all 89 of them", and 89 notifications a day
 * from markets somebody does not trade is how a user turns the feature off for
 * good. But the choice cannot be a plain list either: 89 rows is a scroll
 * nobody finishes, so it is grouped the way the asset selector already groups
 * them and searchable the way the user already expects.
 *
 * "All pairs" stays one tap, and it is the first thing on the screen, because
 * for most people it is the right answer and they should not have to work for
 * it.
 *
 * The distinction this file exists to preserve: choosing everything is stored
 * as "no filter", not as a list of every symbol. A stored list would freeze
 * today's catalogue — add a pair next month and everyone who picked "all"
 * would silently not be told about it.
 */

import { useMemo, useState } from 'react';
import { tr, type PairRow } from '@euro/shared';
import styles from './PushPairPicker.module.css';

const CATEGORIES: Array<{ id: string; ar: string; en: string; icon: string }> = [
  { id: 'currencies', ar: 'عملات', en: 'Currencies', icon: '💱' },
  { id: 'commodities', ar: 'سلع', en: 'Commodities', icon: '🛢️' },
  { id: 'crypto', ar: 'كريبتو', en: 'Crypto', icon: '₿' },
];

export interface PushPairPickerProps {
  pairs: PairRow[];
  /** null means every pair, which is not the same as an empty selection. */
  initial: string[] | null;
  onCancel: () => void;
  onConfirm: (symbols: string[] | null) => void;
}

export function PushPairPicker({ pairs, initial, onCancel, onConfirm }: PushPairPickerProps) {
  const [everything, setEverything] = useState(initial === null);
  const [chosen, setChosen] = useState<Set<string>>(new Set(initial ?? []));
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    return pairs.filter((p) => {
      if (category !== 'all' && p.category !== category) return false;
      if (q === '') return true;
      // Matched on both the display name and the raw symbol: a user types
      // "EUR" and also "EURUSD", and one of those is not on screen anywhere.
      return p.symbol.toUpperCase().includes(q) || p.chart_symbol.toUpperCase().includes(q);
    });
  }, [pairs, query, category]);

  const toggle = (chartSymbol: string) => {
    setEverything(false);
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(chartSymbol)) next.delete(chartSymbol);
      else next.add(chartSymbol);
      return next;
    });
  };

  /** Everything currently on screen, so a search plus this is "all the EUR pairs". */
  const addVisible = () => {
    setEverything(false);
    setChosen((prev) => {
      const next = new Set(prev);
      for (const p of visible) next.add(p.chart_symbol);
      return next;
    });
  };

  const clearVisible = () => {
    setEverything(false);
    setChosen((prev) => {
      const next = new Set(prev);
      for (const p of visible) next.delete(p.chart_symbol);
      return next;
    });
  };

  const count = everything ? pairs.length : chosen.size;
  const nothing = !everything && chosen.size === 0;

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true">
      <div className={styles.sheet}>
        <header className={styles.head}>
          <h2 className={styles.title}>{tr('إشعارات أنهي أزواج؟', 'Notify me about which pairs?')}</h2>
          <button type="button" onClick={onCancel} className={styles.close} aria-label={tr('إغلاق', 'Close')}>
            ✕
          </button>
        </header>

        {/* First, biggest, and for most people the only thing they need. */}
        <button
          type="button"
          onClick={() => { setEverything(true); setChosen(new Set()); }}
          aria-pressed={everything}
          className={`${styles.allBtn} ${everything ? styles.allOn : ''}`}
        >
          <span aria-hidden="true">🌍</span>
          <span>
            <strong>{tr('كل الأزواج', 'All pairs')}</strong>
            <em>
              {tr(
                `${pairs.length} زوج · وأي زوج يتضاف بعدين`,
                `${pairs.length} pairs, plus any added later`,
              )}
            </em>
          </span>
        </button>

        <p className={styles.or}>{tr('أو اختار بنفسك', 'Or choose your own')}</p>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr('دوّر على زوج...', 'Search a pair…')}
          className={styles.search}
        />

        <div className={styles.tabs}>
          <button
            type="button"
            onClick={() => setCategory('all')}
            aria-pressed={category === 'all'}
            className={`${styles.tab} ${category === 'all' ? styles.tabOn : ''}`}
          >
            {tr('الكل', 'All')}
          </button>
          {CATEGORIES.filter((c) => pairs.some((p) => p.category === c.id)).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              aria-pressed={category === c.id}
              className={`${styles.tab} ${category === c.id ? styles.tabOn : ''}`}
            >
              <span aria-hidden="true">{c.icon}</span> {tr(c.ar, c.en)}
            </button>
          ))}
        </div>

        <div className={styles.bulk}>
          <button type="button" onClick={addVisible} className={styles.bulkBtn}>
            {tr(`اختار الظاهر (${visible.length})`, `Select shown (${visible.length})`)}
          </button>
          <button type="button" onClick={clearVisible} className={styles.bulkBtn}>
            {tr('شيل الظاهر', 'Clear shown')}
          </button>
        </div>

        <div className={styles.list}>
          {visible.length === 0 ? (
            <p className={styles.empty}>{tr('مفيش زوج بالاسم ده', 'No pair by that name')}</p>
          ) : (
            visible.map((p) => {
              const on = everything || chosen.has(p.chart_symbol);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggle(p.chart_symbol)}
                  aria-pressed={on}
                  className={`${styles.item} ${on ? styles.itemOn : ''}`}
                >
                  <span className={styles.tick} aria-hidden="true">{on ? '✓' : ''}</span>
                  <span className={styles.name}>{p.symbol}</span>
                </button>
              );
            })
          )}
        </div>

        <footer className={styles.foot}>
          <p className={styles.count}>
            {everything
              ? tr('كل الأزواج', 'All pairs')
              : nothing
                ? tr('مختارتش ولا زوج', 'Nothing selected')
                : tr(`${count} زوج مختار`, `${count} selected`)}
          </p>
          <button
            type="button"
            disabled={nothing}
            onClick={() => onConfirm(everything ? null : [...chosen])}
            className={styles.confirm}
          >
            {tr('فعّل الإشعارات', 'Enable notifications')}
          </button>
        </footer>
      </div>
    </div>
  );
}
