'use client';

/**
 * Pair management — ported from `_buildPairsSection` (admin_dashboard.dart:1209)
 * and the OTC library view (`_buildOtcLibraryView`, :718).
 *
 * `pairs` is what the user app's asset picker shows. `otc_pairs` is the
 * scraper's own catalogue of everything Pocket Option exposes — the library
 * you import FROM.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase, type PairRow } from '@euro/shared';
import styles from '../admin.module.css';

const CATEGORIES = ['currencies', 'commodities', 'stocks', 'indices', 'crypto'];

export default function PairsView() {
  const [pairs, setPairs] = useState<PairRow[] | null>(null);
  const [library, setLibrary] = useState<Array<Record<string, unknown>> | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function load(): Promise<void> {
    try {
      const { data } = await supabase().from('pairs').select('*').order('order');
      setPairs((data as PairRow[] | null) ?? []);
    } catch {
      setPairs([]);
      setMessage({ kind: 'error', text: 'تعذّر تحميل الأزواج' });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function loadLibrary(): Promise<void> {
    setBusy(true);
    try {
      const { data } = await supabase().from('otc_pairs').select('*').limit(500);
      setLibrary((data as Array<Record<string, unknown>> | null) ?? []);
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر تحميل مكتبة OTC' });
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, updates: Partial<PairRow>): Promise<void> {
    setBusy(true);
    try {
      await supabase().from('pairs').update(updates).eq('id', id);
      await load();
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر التحديث' });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, symbol: string): Promise<void> {
    if (!confirm(`حذف الزوج "${symbol}" من قائمة المستخدمين؟`)) return;
    setBusy(true);
    try {
      await supabase().from('pairs').delete().eq('id', id);
      await load();
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر الحذف' });
    } finally {
      setBusy(false);
    }
  }

  /** Adds a library entry to the user-facing list, skipping duplicates. */
  async function importPair(entry: Record<string, unknown>): Promise<void> {
    const symbol = String(entry['symbol'] ?? entry['id'] ?? '');
    if (!symbol) return;

    if ((pairs ?? []).some((p) => p.chart_symbol === symbol)) {
      setMessage({ kind: 'error', text: `${symbol} موجود بالفعل` });
      return;
    }

    setBusy(true);
    try {
      await supabase().from('pairs').insert({
        symbol: String(entry['display'] ?? symbol),
        chart_symbol: symbol,
        category: String(entry['category'] ?? 'currencies'),
        type: String(entry['category'] ?? 'currencies'),
        source: 'po',
        is_otc: symbol.toLowerCase().includes('otc'),
        enabled: true,
        order: (pairs?.length ?? 0) + 1,
      });
      await load();
      setMessage({ kind: 'ok', text: `تمت إضافة ${symbol} ✓` });
    } catch {
      setMessage({ kind: 'error', text: 'تعذّرت الإضافة' });
    } finally {
      setBusy(false);
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (pairs ?? []).filter(
      (p) =>
        (category === 'all' || p.category === category) &&
        (!q || p.symbol.toLowerCase().includes(q) || p.chart_symbol.toLowerCase().includes(q)),
    );
  }, [pairs, query, category]);

  return (
    <section>
      <h1 className={styles.title}>إدارة الأزواج</h1>

      {message && <p className={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</p>}

      <div className={styles.toolbar}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={styles.search}
          placeholder="ابحث بالاسم أو الرمز..."
        />
        <div className={styles.filters}>
          <button
            type="button"
            onClick={() => setCategory('all')}
            className={`${styles.chip} ${category === 'all' ? styles.chipActive : ''}`}
          >
            الكل
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`${styles.chip} ${category === c ? styles.chipActive : ''}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {pairs === null ? (
        <p className={styles.muted}>جاري التحميل...</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>الاسم المعروض</th>
                <th>رمز الشارت</th>
                <th>التصنيف</th>
                <th>المصدر</th>
                <th>الحالة</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className={busy ? styles.rowBusy : undefined}>
                  <td>{p.symbol}</td>
                  <td dir="ltr" className={styles.mono}>{p.chart_symbol}</td>
                  <td>{p.category}</td>
                  <td dir="ltr" className={styles.mono}>
                    {p.source}
                    {p.is_otc && <span className={styles.badge} style={{ marginInlineStart: 6 }}>OTC</span>}
                  </td>
                  <td>
                    {p.enabled ? (
                      <span className={`${styles.badge} ${styles.badgeGreen}`}>ظاهر</span>
                    ) : (
                      <span className={styles.badge}>مخفي</span>
                    )}
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void patch(p.id, { enabled: !p.enabled })}
                        className={styles.actionBtn}
                      >
                        {p.enabled ? 'إخفاء' : 'إظهار'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(p.id, p.symbol)}
                        className={`${styles.actionBtn} ${styles.actionDanger}`}
                      >
                        حذف
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.card} style={{ marginTop: 20 }}>
        <h2 className={styles.cardTitle}>مكتبة Pocket Option</h2>
        <p className={styles.switchHint} style={{ marginBottom: 12 }}>
          كل الرموز اللي السكرابر شايفها. أضف منها للقائمة اللي المستخدمين بيشوفوها.
        </p>

        <button type="button" disabled={busy} onClick={() => void loadLibrary()} className={styles.actionBtn}>
          {library === null ? 'تحميل المكتبة' : 'إعادة التحميل'}
        </button>

        {library !== null && (
          <>
            <p className={styles.muted} style={{ textAlign: 'start' }}>
              {library.length} رمز متاح
            </p>
            <div className={styles.tableWrap} style={{ maxHeight: 340, overflowY: 'auto' }}>
              <table className={styles.table}>
                <tbody>
                  {library.slice(0, 200).map((e, i) => {
                    const symbol = String(e['symbol'] ?? e['id'] ?? '');
                    const already = (pairs ?? []).some((p) => p.chart_symbol === symbol);
                    return (
                      <tr key={`${symbol}-${i}`}>
                        <td dir="ltr" className={styles.mono}>{symbol}</td>
                        <td>{String(e['category'] ?? '—')}</td>
                        <td>
                          <button
                            type="button"
                            disabled={busy || already}
                            onClick={() => void importPair(e)}
                            className={styles.actionBtn}
                          >
                            {already ? 'مضاف ✓' : 'إضافة'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {library.length > 200 && (
              <p className={styles.switchHint}>
                معروض أول 200 من {library.length} — استخدم البحث في المكتبة الأصلية لو محتاج رمز
                مش ظاهر.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
