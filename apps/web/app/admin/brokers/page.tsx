'use client';

/**
 * Broker management — ported from `_buildBrokerManagementView`
 * (admin_dashboard.dart:4613).
 *
 * These rows drive the notice screen and the login screen's platform picker,
 * so `click_key` matters more than it looks: it is the analytics key AND the
 * value attributed to a user's account on first login.
 */

import { useEffect, useState } from 'react';
import { supabase, type BrokerRow } from '@euro/shared';
import styles from '../admin.module.css';

type Draft = Omit<BrokerRow, 'id' | 'created_at' | 'updated_at'> & { id?: string };

const EMPTY_DRAFT: Draft = {
  name: '',
  logo_url: '',
  chart_url: '',
  registration_link: '',
  desc: '',
  click_key: '',
  promo_code: '',
  bonus_percent: 0,
  min_deposit: 0,
  is_active: true,
  is_recommended: false,
  order: 1,
};

export default function BrokersView() {
  const [brokers, setBrokers] = useState<BrokerRow[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function load(): Promise<void> {
    try {
      const { data } = await supabase().from('brokers').select('*').order('order');
      setBrokers((data as BrokerRow[] | null) ?? []);
    } catch {
      setBrokers([]);
      setMessage({ kind: 'error', text: 'تعذّر تحميل المنصات' });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      const payload = { ...draft, updated_at: new Date().toISOString() };
      const { error } = draft.id
        ? await supabase().from('brokers').update(payload).eq('id', draft.id)
        : await supabase().from('brokers').insert(payload);
      if (error) throw error;
      setDraft(null);
      await load();
      setMessage({ kind: 'ok', text: 'تم الحفظ ✓' });
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, updates: Partial<BrokerRow>): Promise<void> {
    setBusy(true);
    try {
      await supabase().from('brokers').update(updates).eq('id', id);
      await load();
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر التحديث' });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string): Promise<void> {
    // Deleting a broker orphans its analytics counters, so it is worth a pause.
    if (!confirm(`حذف المنصة "${name}"؟ الإحصائيات المرتبطة بها هتفضل موجودة لكن بدون منصة.`)) {
      return;
    }
    setBusy(true);
    try {
      await supabase().from('brokers').delete().eq('id', id);
      await load();
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر الحذف' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1 className={styles.title}>إدارة المنصات</h1>

      {message && <p className={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</p>}

      <button
        type="button"
        onClick={() => setDraft({ ...EMPTY_DRAFT, order: (brokers?.length ?? 0) + 1 })}
        className={styles.primaryBtn}
        style={{ marginBottom: 16 }}
      >
        + منصة جديدة
      </button>

      {draft && (
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>{draft.id ? 'تعديل منصة' : 'منصة جديدة'}</h2>

          <Field label="الاسم" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
          <Field
            label="مفتاح النقرات (click_key)"
            hint="مفتاح الإحصائيات، ومصدر نسبة الحساب للمنصة عند أول دخول. لا تغيّره بعد التشغيل."
            value={draft.click_key}
            onChange={(v) => setDraft({ ...draft, click_key: v })}
            ltr
          />
          <Field
            label="رابط التسجيل"
            value={draft.registration_link}
            onChange={(v) => setDraft({ ...draft, registration_link: v })}
            ltr
          />
          <Field label="رابط الشعار" value={draft.logo_url} onChange={(v) => setDraft({ ...draft, logo_url: v })} ltr />
          <Field label="الوصف" value={draft.desc} onChange={(v) => setDraft({ ...draft, desc: v })} />
          <Field
            label="البروموكود"
            hint="لو مملوء، المستخدم لازم يكتبه بالظبط في شاشة الدخول."
            value={draft.promo_code}
            onChange={(v) => setDraft({ ...draft, promo_code: v })}
            ltr
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <Field
              label="نسبة البونص %"
              value={String(draft.bonus_percent)}
              onChange={(v) => setDraft({ ...draft, bonus_percent: Number(v) || 0 })}
              ltr
            />
            <Field
              label="أقل إيداع $"
              value={String(draft.min_deposit)}
              onChange={(v) => setDraft({ ...draft, min_deposit: Number(v) || 0 })}
              ltr
            />
            <Field
              label="الترتيب"
              value={String(draft.order)}
              onChange={(v) => setDraft({ ...draft, order: Number(v) || 0 })}
              ltr
            />
          </div>

          <div className={styles.actions} style={{ marginTop: 12 }}>
            <button type="button" disabled={busy || !draft.name} onClick={() => void save()} className={styles.primaryBtn}>
              حفظ
            </button>
            <button type="button" onClick={() => setDraft(null)} className={styles.actionBtn}>
              إلغاء
            </button>
          </div>
        </div>
      )}

      {brokers === null ? (
        <p className={styles.muted}>جاري التحميل...</p>
      ) : brokers.length === 0 ? (
        <p className={styles.muted}>لا توجد منصات</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>الترتيب</th>
                <th>الاسم</th>
                <th>المفتاح</th>
                <th>الحالة</th>
                <th>البونص</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {brokers.map((b) => (
                <tr key={b.id} className={busy ? styles.rowBusy : undefined}>
                  <td dir="ltr" className={styles.mono}>{b.order}</td>
                  <td>{b.name}</td>
                  <td dir="ltr" className={styles.mono}>{b.click_key || '—'}</td>
                  <td>
                    {b.is_active ? (
                      <span className={`${styles.badge} ${styles.badgeGreen}`}>نشطة</span>
                    ) : (
                      <span className={styles.badge}>مخفية</span>
                    )}
                    {b.is_recommended && <span className={`${styles.badge} ${styles.badgeGold}`}>مُرشّحة</span>}
                  </td>
                  <td dir="ltr" className={styles.mono}>
                    {b.bonus_percent > 0 ? `${b.bonus_percent}%` : '—'}
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <button type="button" disabled={busy} onClick={() => setDraft(b)} className={styles.actionBtn}>
                        تعديل
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void patch(b.id, { is_active: !b.is_active })}
                        className={styles.actionBtn}
                      >
                        {b.is_active ? 'إخفاء' : 'إظهار'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void patch(b.id, { is_recommended: !b.is_recommended })}
                        className={styles.actionBtn}
                      >
                        {b.is_recommended ? 'إلغاء الترشيح' : 'ترشيح'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(b.id, b.name)}
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
    </section>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  ltr,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  ltr?: boolean;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={styles.input}
        dir={ltr ? 'ltr' : undefined}
      />
      {hint && <span className={styles.switchHint}>{hint}</span>}
    </div>
  );
}
