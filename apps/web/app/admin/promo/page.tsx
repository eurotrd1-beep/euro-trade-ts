'use client';

/**
 * Promotional announcement — ported from `_buildPromoView` / `_savePromo`
 * (admin_dashboard.dart:6668, :6872).
 *
 * Writes `configs.promo`, which the app reads once on open and shows as a
 * full-screen ad. Two details carried over exactly:
 *
 *  • `version` is bumped on every save. The app records a dismissal against
 *    the version it saw, so editing the offer makes it appear again for users
 *    who already closed the previous one.
 *  • The enable/disable switch writes IMMEDIATELY, without pressing Save, so
 *    turning an ad off actually stops it. Only `enabled` is patched; the rest
 *    of the content is preserved.
 *
 * `hours` is a DURATION, not a date: it is converted to an absolute `endsAt`
 * at save time so the countdown the user sees actually shrinks.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@euro/shared';
import { formatExpiry } from '@/lib/vipDuration';
import styles from '../admin.module.css';

interface PromoDraft {
  enabled: boolean;
  targetMode: 'all' | 'specific';
  targetId: string;
  title: string;
  message: string;
  price: string;
  save: string;
  hours: string;
  autoCloseSeconds: string;
  ctaText: string;
}

const EMPTY: PromoDraft = {
  enabled: false,
  targetMode: 'all',
  targetId: '',
  title: '',
  message: '',
  price: '',
  save: '',
  hours: '',
  autoCloseSeconds: '10',
  ctaText: 'تواصل معايا',
};

export default function PromoView() {
  const [draft, setDraft] = useState<PromoDraft | null>(null);
  const [version, setVersion] = useState(1);
  const [storedEndsAt, setStoredEndsAt] = useState<string | null>(null);
  const [stats, setStats] = useState({ views: 0, cta: 0 });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  /** `_loadPromo`. */
  async function load(): Promise<void> {
    try {
      const [cfg, clicks] = await Promise.all([
        supabase().from('configs').select('data').eq('id', 'promo').maybeSingle(),
        supabase().from('clicks').select('data').eq('id', 'promo').maybeSingle(),
      ]);

      const d = (cfg.data?.['data'] ?? {}) as Record<string, unknown>;
      const str = (k: string, fallback = ''): string =>
        typeof d[k] === 'string' ? (d[k] as string) : fallback;
      const target = str('target', 'all');

      setDraft({
        enabled: d['enabled'] === true,
        targetMode: target === 'all' ? 'all' : 'specific',
        targetId: target === 'all' ? '' : target,
        title: str('title'),
        message: str('message'),
        price: str('price'),
        save: str('save'),
        // `hours` is never stored — only the absolute endsAt it produced.
        hours: '',
        autoCloseSeconds: String(typeof d['autoCloseSeconds'] === 'number' ? d['autoCloseSeconds'] : 10),
        ctaText: str('ctaText', 'تواصل معايا'),
      });
      setVersion(typeof d['version'] === 'number' ? d['version'] : 1);
      setStoredEndsAt(typeof d['endsAt'] === 'string' ? d['endsAt'] : null);

      const c = (clicks.data?.['data'] ?? {}) as Record<string, unknown>;
      setStats({
        views: typeof c['views'] === 'number' ? c['views'] : 0,
        cta: typeof c['cta'] === 'number' ? c['cta'] : 0,
      });
    } catch {
      setDraft({ ...EMPTY });
      setMessage({ kind: 'error', text: 'تعذّر تحميل الإعلان الحالي' });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /** `_savePromo`. */
  async function save(next?: Partial<PromoDraft>): Promise<void> {
    if (!draft || saving) return;
    const d = { ...draft, ...next };
    setSaving(true);
    setMessage(null);
    try {
      const hours = Number.parseInt(d.hours.trim(), 10) || 0;
      const endsAt = hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;
      const autoClose = Number.parseInt(d.autoCloseSeconds.trim(), 10) || 10;
      const target = d.targetMode === 'specific' ? d.targetId.trim() : 'all';
      const newVersion = version + 1;

      const { error } = await supabase()
        .from('configs')
        .upsert({
          id: 'promo',
          data: {
            enabled: d.enabled,
            target: target === '' ? 'all' : target,
            title: d.title.trim(),
            message: d.message.trim(),
            price: d.price.trim(),
            save: d.save.trim(),
            endsAt,
            autoCloseSeconds: autoClose,
            ctaText: d.ctaText.trim() === '' ? 'تواصل معايا' : d.ctaText.trim(),
            version: newVersion,
          },
        });
      if (error) throw error;

      setVersion(newVersion);
      setStoredEndsAt(endsAt);
      setDraft({ ...d, hours: '' });
      setMessage({ kind: 'ok', text: 'تم حفظ العرض الترويجي ✅' });
    } catch (e) {
      setMessage({ kind: 'error', text: `خطأ: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  /**
   * `_setPromoEnabled` — patches ONLY `enabled`, immediately, without bumping
   * the version. Turning the ad off has to take effect at once.
   */
  async function setEnabled(v: boolean): Promise<void> {
    if (!draft) return;
    setDraft({ ...draft, enabled: v });
    try {
      const { data } = await supabase().from('configs').select('data').eq('id', 'promo').maybeSingle();
      const cur = { ...((data?.['data'] as Record<string, unknown> | null) ?? {}) };
      cur['enabled'] = v;
      await supabase().from('configs').upsert({ id: 'promo', data: cur });
      setMessage({
        kind: v ? 'ok' : 'error',
        text: v ? 'تم تفعيل الإعلان ✅' : 'تم إيقاف الإعلان — لن يظهر للمستخدمين',
      });
    } catch (e) {
      setMessage({ kind: 'error', text: `خطأ: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** `_resetPromoStats`. */
  async function resetStats(): Promise<void> {
    if (!confirm('تصفير الإحصائيات\n\nهل تريد تصفير عدد المشاهدات والضغطات إلى صفر؟')) return;
    try {
      const { data } = await supabase().from('clicks').select('data').eq('id', 'promo').maybeSingle();
      const cur = { ...((data?.['data'] as Record<string, unknown> | null) ?? {}) };
      cur['views'] = 0;
      cur['cta'] = 0;
      await supabase().from('clicks').upsert({ id: 'promo', data: cur });
      setStats({ views: 0, cta: 0 });
      setMessage({ kind: 'ok', text: 'تم تصفير الإحصائيات ✅' });
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر تصفير الإحصائيات' });
    }
  }

  if (!draft) {
    return (
      <section>
        <h1 className={styles.title}>العرض الترويجي / الإعلان</h1>
        <p className={styles.muted}>جاري التحميل...</p>
      </section>
    );
  }

  const endsDate = storedEndsAt !== null ? new Date(storedEndsAt) : null;

  return (
    <section>
      <h1 className={styles.title}>العرض الترويجي / الإعلان</h1>

      {message && <p className={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</p>}

      {/* Impressions + link clicks */}
      <div className={styles.statRow}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.views}</span>
          <span className={styles.statLabel}>👁 شاهدوا الإعلان</span>
        </div>
        <div className={`${styles.stat} ${styles.statGreen}`}>
          <span className={styles.statValue}>{stats.cta}</span>
          <span className={styles.statLabel}>👆 ضغطوا على الرابط</span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void resetStats()}
        className={`${styles.actionBtn} ${styles.actionDanger}`}
        style={{ width: '100%', padding: 12, marginBottom: 16 }}
      >
        ↺ تصفير المشاهدات والضغطات
      </button>

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>📣 إعداد الإعلان للمستخدمين</h2>
        <p className={styles.switchHint} style={{ marginBottom: 14 }}>
          يظهر هذا الإعلان للمستخدمين عند فتح التطبيق.
        </p>

        <div className={styles.switchRow}>
          <div>
            <span className={styles.switchLabel}>تفعيل العرض</span>
            <p className={styles.switchHint}>بيتحفظ فوراً من غير ما تضغط حفظ.</p>
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => void setEnabled(e.target.checked)}
            />
          </label>
        </div>

        <p className={styles.label} style={{ marginTop: 14 }}>
          الجمهور المستهدف
        </p>
        <div className={styles.filters}>
          <button
            type="button"
            onClick={() => setDraft({ ...draft, targetMode: 'all' })}
            aria-pressed={draft.targetMode === 'all'}
            className={`${styles.chip} ${draft.targetMode === 'all' ? styles.chipActive : ''}`}
          >
            الجميع
          </button>
          <button
            type="button"
            onClick={() => setDraft({ ...draft, targetMode: 'specific' })}
            aria-pressed={draft.targetMode === 'specific'}
            className={`${styles.chip} ${draft.targetMode === 'specific' ? styles.chipActive : ''}`}
          >
            مستخدم محدد
          </button>
        </div>

        {draft.targetMode === 'specific' && (
          <Field
            label="معرف حساب المستخدم (account id)"
            value={draft.targetId}
            onChange={(v) => setDraft({ ...draft, targetId: v })}
            ltr
          />
        )}

        <Field
          label="العنوان"
          hint="عنوان العرض"
          value={draft.title}
          onChange={(v) => setDraft({ ...draft, title: v })}
        />

        <div className={styles.field}>
          <span className={styles.label}>نص الإعلان</span>
          <textarea
            value={draft.message}
            onChange={(e) => setDraft({ ...draft, message: e.target.value })}
            placeholder="تفاصيل العرض / الخصم"
            className={styles.textarea}
            style={{ minHeight: 100, fontFamily: 'inherit', fontSize: 13 }}
          />
        </div>

        <div className={styles.dlgPair}>
          <Field
            label="السعر"
            hint="مثال: 10$"
            value={draft.price}
            onChange={(v) => setDraft({ ...draft, price: v })}
          />
          <Field
            label="التوفير"
            hint="مثال: وفّر 50%"
            value={draft.save}
            onChange={(v) => setDraft({ ...draft, save: v })}
          />
        </div>

        <Field
          label="مدة العرض (بالساعات)"
          hint="اتركه فارغاً أو 0 لإلغاء العدّاد"
          value={draft.hours}
          onChange={(v) => setDraft({ ...draft, hours: v.replace(/[^0-9]/g, '') })}
          ltr
        />

        {endsDate !== null && !Number.isNaN(endsDate.getTime()) && (
          <p className={styles.switchHint}>ينتهي العرض حالياً: {formatExpiry(endsDate)}</p>
        )}

        <Field
          label="ثواني الإغلاق (autoCloseSeconds)"
          hint="10"
          value={draft.autoCloseSeconds}
          onChange={(v) => setDraft({ ...draft, autoCloseSeconds: v.replace(/[^0-9]/g, '') })}
          ltr
        />

        <Field
          label="نص الزر"
          hint="تواصل معايا"
          value={draft.ctaText}
          onChange={(v) => setDraft({ ...draft, ctaText: v })}
        />
        <p className={styles.switchHint}>الزر يفتح رابط تليجرام من قسم السوشيال.</p>

        <div className={styles.actions} style={{ marginTop: 16 }}>
          <button type="button" disabled={saving} onClick={() => void save()} className={styles.primaryBtn}>
            {saving ? 'جاري الحفظ...' : 'حفظ العرض'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save({ enabled: false })}
            className={`${styles.actionBtn} ${styles.actionDanger}`}
          >
            إيقاف العرض
          </button>
        </div>
      </div>
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
      <span className={styles.label}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
        className={styles.input}
        dir={ltr ? 'ltr' : undefined}
      />
    </div>
  );
}
