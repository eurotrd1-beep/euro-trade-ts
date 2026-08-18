'use client';

/**
 * Which pairs the app watches — and therefore which ones it notifies about.
 *
 * ── ONE CHOICE, NOT TWO ────────────────────────────────────────────────────
 *
 * This used to pick only the notification list while the watch swept every
 * pair the catalogue offered. Those were two answers to one question, and a
 * mismatch between them is invisible: a notification about a pair nobody chose,
 * or silence about the one they did, with nothing anywhere reporting it. The
 * list this returns is now the only answer — see `watchedPairs.ts`.
 *
 * ── WHY IT IS A SCREEN AND NOT A CHECKBOX ──────────────────────────────────
 *
 * 89 rows is a scroll nobody finishes, so it is grouped the way the asset
 * selector already groups them and searchable the way the user already expects.
 * "All pairs" stays one tap, first on the screen, because for a lot of people
 * it is the right answer.
 *
 * ── AND WHY A LARGE SELECTION ASKS FIRST ───────────────────────────────────
 *
 * Every chosen pair is announced individually. That is what was asked for and
 * it is right — a pair somebody named should not wait its turn behind others —
 * but it means choosing all of them is choosing up to 89 separate alerts. Not
 * a performance problem: evaluating 89 pairs costs a fraction of a millisecond.
 * A phone problem. So the number is said out loud before it is committed to,
 * rather than discovered overnight.
 */

import { useMemo, useState } from 'react';
import { tr, type PairRow } from '@euro/shared';
import { NOISY_SELECTION } from '@/lib/watchedPairs';
import styles from './PushPairPicker.module.css';

const CATEGORIES: Array<{ id: string; ar: string; en: string; icon: string }> = [
  { id: 'currencies', ar: 'عملات', en: 'Currencies', icon: '💱' },
  { id: 'commodities', ar: 'سلع', en: 'Commodities', icon: '🛢️' },
  { id: 'crypto', ar: 'كريبتو', en: 'Crypto', icon: '₿' },
];

export interface PushPairPickerProps {
  pairs: PairRow[];
  /** The pairs already chosen. Empty means nothing has been chosen yet. */
  initial: readonly string[];
  onCancel: () => void;
  onConfirm: (symbols: string[]) => void;
}

export function PushPairPicker({ pairs, initial, onCancel, onConfirm }: PushPairPickerProps) {
  const [chosen, setChosen] = useState<Set<string>>(new Set(initial));
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  /** Set when a large selection needs confirming, so the count can be shown. */
  const [confirming, setConfirming] = useState<string[] | null>(null);

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
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(chartSymbol)) next.delete(chartSymbol);
      else next.add(chartSymbol);
      return next;
    });
  };

  /** Everything currently on screen, so a search plus this is "all the EUR pairs". */
  const addVisible = () => {
    setChosen((prev) => {
      const next = new Set(prev);
      for (const p of visible) next.add(p.chart_symbol);
      return next;
    });
  };

  const clearVisible = () => {
    setChosen((prev) => {
      const next = new Set(prev);
      for (const p of visible) next.delete(p.chart_symbol);
      return next;
    });
  };

  const count = chosen.size;
  const nothing = count === 0;
  const everything = count > 0 && count === pairs.length;

  /**
   * Asks before a selection large enough to be a stream of alerts.
   *
   * The confirmation is a second screen rather than an inline note, because a
   * note beside a button somebody is already reaching for is a note nobody
   * reads.
   */
  const commit = () => {
    const list = [...chosen];
    if (list.length > NOISY_SELECTION) setConfirming(list);
    else onConfirm(list);
  };

  if (confirming !== null) {
    return (
      <div className={styles.backdrop} role="dialog" aria-modal="true">
        <div className={styles.sheet}>
          <header className={styles.head}>
            <h2 className={styles.title}>{tr('متأكد؟', 'Are you sure?')}</h2>
          </header>
          <p className={styles.warnBody}>
            {tr(
              `اخترت ${confirming.length} زوج. كل زوج فيهم هيبعتلك إشعار لوحده لما شروطه تكتمل — يعني لحد ${confirming.length} إشعار مستقل.`,
              `You picked ${confirming.length} pairs. Each one alerts you on its own when its conditions are met — up to ${confirming.length} separate notifications.`,
            )}
          </p>
          <p className={styles.warnNote}>
            {tr(
              'المراقبة نفسها مش بتتقل — الحساب على 89 زوج بياخد أقل من واحد على ألف من الثانية. الكلام هنا على عدد الإشعارات اللي هتوصل تليفونك.',
              'The watching itself is not the cost — evaluating 89 pairs takes under a millisecond. This is about how many alerts reach your phone.',
            )}
          </p>
          <footer className={styles.foot}>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className={styles.bulkBtn}
            >
              {tr('أرجع أعدّل', 'Go back and edit')}
            </button>
            <button
              type="button"
              onClick={() => onConfirm(confirming)}
              className={styles.confirm}
            >
              {tr('أيوه، كمّل', 'Yes, continue')}
            </button>
          </footer>
        </div>
      </div>
    );
  }

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
          onClick={() => setChosen(new Set(pairs.map((p) => p.chart_symbol)))}
          aria-pressed={everything}
          className={`${styles.allBtn} ${everything ? styles.allOn : ''}`}
        >
          <span aria-hidden="true">🌍</span>
          <span>
            <strong>{tr('كل الأزواج', 'All pairs')}</strong>
            <em>
              {tr(
                `${pairs.length} زوج · إشعار مستقل لكل واحد`,
                `${pairs.length} pairs, each alerted separately`,
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
              const on = chosen.has(p.chart_symbol);
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
            {nothing
              ? tr('مختارتش ولا زوج', 'Nothing selected')
              : everything
                ? tr(`كل الأزواج (${count})`, `All ${count} pairs`)
                : tr(`${count} زوج مختار`, `${count} selected`)}
          </p>
          <button type="button" disabled={nothing} onClick={commit} className={styles.confirm}>
            {tr('حفظ', 'Save')}
          </button>
        </footer>
      </div>
    </div>
  );
}
