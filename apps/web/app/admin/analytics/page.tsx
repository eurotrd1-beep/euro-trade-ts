'use client';

/**
 * Analytics — ported from `_buildAnalyticsView` (admin_dashboard.dart:3842).
 *
 * Conversion per broker, from the `clicks` counters that `increment_click`
 * maintains. For a broker whose `click_key` is `quotex`:
 *   clicks  → clicks.brokers.data['quotex']
 *   logins  → clicks.brokers.data['quotexLogins']
 *   rate    → logins / clicks × 100
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase, type BrokerRow } from '@euro/shared';
import styles from '../admin.module.css';

interface Row {
  name: string;
  key: string;
  clicks: number;
  logins: number;
  rate: number;
}

export default function AnalyticsView() {
  const [brokers, setBrokers] = useState<BrokerRow[] | null>(null);
  const [counters, setCounters] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [b, c] = await Promise.all([
          supabase().from('brokers').select('*').order('order'),
          supabase().from('clicks').select('data').eq('id', 'brokers').maybeSingle(),
        ]);
        if (cancelled) return;
        setBrokers((b.data as BrokerRow[] | null) ?? []);
        setCounters((c.data?.['data'] as Record<string, number> | undefined) ?? {});
      } catch {
        if (!cancelled) {
          setBrokers([]);
          setError('تعذّر تحميل الإحصائيات');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const rows: Row[] = useMemo(() => {
    return (brokers ?? []).map((b) => {
      // Dart falls back to a lowercased name when click_key is empty.
      const key = b.click_key || b.name.toLowerCase();
      const clicks = counters[key] ?? 0;
      const logins = counters[`${key}Logins`] ?? 0;
      return {
        name: b.name,
        key,
        clicks,
        logins,
        // Guard the divide: a broker with no clicks yet is 0%, not NaN.
        rate: clicks > 0 ? (logins / clicks) * 100 : 0,
      };
    });
  }, [brokers, counters]);

  const totals = useMemo(
    () => ({
      clicks: rows.reduce((a, r) => a + r.clicks, 0),
      logins: rows.reduce((a, r) => a + r.logins, 0),
    }),
    [rows],
  );

  const overallRate = totals.clicks > 0 ? (totals.logins / totals.clicks) * 100 : 0;

  return (
    <section>
      <h1 className={styles.title}>الإحصائيات ومعدل التحويل</h1>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.statRow}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{totals.clicks}</span>
          <span className={styles.statLabel}>إجمالي النقرات</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{totals.logins}</span>
          <span className={styles.statLabel}>إجمالي التسجيلات</span>
        </div>
        <div className={`${styles.stat} ${styles.statGreen}`}>
          <span className={styles.statValue}>{overallRate.toFixed(1)}%</span>
          <span className={styles.statLabel}>معدل التحويل</span>
        </div>
      </div>

      {brokers === null ? (
        <p className={styles.muted}>جاري التحميل...</p>
      ) : rows.length === 0 ? (
        <p className={styles.muted}>لا توجد منصات مسجّلة</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>المنصة</th>
                <th>المفتاح</th>
                <th>النقرات</th>
                <th>التسجيلات</th>
                <th>معدل التحويل</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td data-label="المنصة">{r.name}</td>
                  <td data-label="المفتاح" dir="ltr" className={styles.mono}>
                    {r.key}
                  </td>
                  <td data-label="النقرات" dir="ltr" className={styles.mono}>
                    {r.clicks}
                  </td>
                  <td data-label="التسجيلات" dir="ltr" className={styles.mono}>
                    {r.logins}
                  </td>
                  <td data-label="معدل التحويل">
                    <span
                      className={`${styles.badge} ${
                        r.rate >= 20 ? styles.badgeGreen : r.rate >= 5 ? styles.badgeGold : ''
                      }`}
                    >
                      {r.rate.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.muted} style={{ textAlign: 'start', paddingTop: 16 }}>
        النقرات تُسجَّل عند فتح رابط التسجيل من شاشة التنويه، والتسجيلات عند أول دخول ناجح
        لحساب جديد.
      </p>
    </section>
  );
}
