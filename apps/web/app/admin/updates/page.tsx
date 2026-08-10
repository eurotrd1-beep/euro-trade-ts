'use client';

/**
 * Update notifications — ported from `_buildAppUpdatesView`
 * (admin_dashboard.dart:5416).
 *
 * Publishes the `appUpdate` config row the app reads on launch. `isForced`
 * blocks the user until they update, so it gets an explicit confirmation
 * rather than a plain toggle.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@euro/shared';
import styles from '../admin.module.css';

interface UpdateState {
  hasUpdate: boolean;
  version: string;
  features: string;
  downloadLink: string;
  isForced: boolean;
  publishedAt: string | null;
}

const EMPTY: UpdateState = {
  hasUpdate: false,
  version: '',
  features: '',
  downloadLink: '',
  isForced: false,
  publishedAt: null,
};

export default function AppUpdatesView() {
  const [current, setCurrent] = useState<UpdateState>(EMPTY);
  const [draft, setDraft] = useState<UpdateState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function load(): Promise<void> {
    try {
      const { data } = await supabase()
        .from('configs')
        .select('data')
        .eq('id', 'appUpdate')
        .maybeSingle();
      const d = (data?.['data'] ?? {}) as Record<string, unknown>;
      const state: UpdateState = {
        hasUpdate: d['hasUpdate'] === true,
        version: (d['version'] as string) ?? '',
        features: (d['features'] as string) ?? '',
        downloadLink: (d['downloadLink'] as string) ?? '',
        isForced: d['isForced'] === true,
        publishedAt: (d['publishedAt'] as string) ?? null,
      };
      setCurrent(state);
      setDraft(state);
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر تحميل حالة التحديث' });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function publish(): Promise<void> {
    if (draft.isForced) {
      const ok = confirm(
        'التحديث الإجباري بيمنع المستخدمين من استخدام التطبيق لحد ما يحدّثوا.\n' +
          'اتأكد إن رابط التحميل شغّال قبل النشر. تكمّل؟',
      );
      if (!ok) return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabase().from('configs').upsert({
        id: 'appUpdate',
        data: {
          hasUpdate: true,
          version: draft.version,
          features: draft.features,
          downloadLink: draft.downloadLink,
          isForced: draft.isForced,
          publishedAt: new Date().toISOString(),
        },
      });
      if (error) throw error;
      await load();
      setMessage({ kind: 'ok', text: 'تم نشر التحديث ✓' });
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر النشر' });
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      // Dart writes only `hasUpdate: false`, dropping the other keys — kept
      // identical so a stale version string can never linger.
      const { error } = await supabase()
        .from('configs')
        .upsert({ id: 'appUpdate', data: { hasUpdate: false } });
      if (error) throw error;
      await load();
      setMessage({ kind: 'ok', text: 'تم إلغاء إشعار التحديث ✓' });
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر الإلغاء' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1 className={styles.title}>إشعارات التحديث</h1>

      {message && <p className={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</p>}

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>الحالة الحالية</h2>
        {current.hasUpdate ? (
          <>
            <p className={styles.ok}>
              إشعار منشور — الإصدار {current.version || '—'}
              {current.isForced && ' (إجباري)'}
            </p>
            {current.publishedAt && (
              <p className={styles.muted} style={{ textAlign: 'start' }}>
                نُشر في {new Date(current.publishedAt).toLocaleString()}
              </p>
            )}
          </>
        ) : (
          <p className={styles.muted} style={{ textAlign: 'start' }}>
            لا يوجد إشعار تحديث منشور.
          </p>
        )}
      </div>

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>نشر تحديث</h2>

        <div className={styles.field}>
          <label className={styles.label}>رقم الإصدار</label>
          <input
            value={draft.version}
            onChange={(e) => setDraft({ ...draft, version: e.target.value })}
            className={styles.input}
            dir="ltr"
            placeholder="1.2.0"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>المميزات الجديدة</label>
          <textarea
            value={draft.features}
            onChange={(e) => setDraft({ ...draft, features: e.target.value })}
            className={styles.textarea}
            style={{ minHeight: 110, fontFamily: 'inherit', fontSize: 13 }}
            placeholder="- تحسينات في سرعة الشارت&#10;- إصلاح مشكلة..."
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>رابط التحميل</label>
          <input
            value={draft.downloadLink}
            onChange={(e) => setDraft({ ...draft, downloadLink: e.target.value })}
            className={styles.input}
            dir="ltr"
            placeholder="https://..."
          />
        </div>

        <div className={styles.switchRow}>
          <div>
            <div className={styles.switchLabel}>تحديث إجباري</div>
            <div className={styles.switchHint}>
              بيمنع المستخدم من استخدام التطبيق لحد ما يحدّث. استخدمه للأعطال الحرجة فقط.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDraft({ ...draft, isForced: !draft.isForced })}
            aria-pressed={draft.isForced}
            className={`${styles.chip} ${draft.isForced ? styles.chipActive : ''}`}
          >
            {draft.isForced ? 'مفعّل' : 'معطّل'}
          </button>
        </div>

        <div className={styles.actions} style={{ marginTop: 14 }}>
          <button
            type="button"
            disabled={busy || !draft.version.trim() || !draft.downloadLink.trim()}
            onClick={() => void publish()}
            className={styles.primaryBtn}
          >
            {busy ? 'جاري النشر...' : 'نشر الإشعار'}
          </button>
          <button
            type="button"
            disabled={busy || !current.hasUpdate}
            onClick={() => void clear()}
            className={styles.actionBtn}
          >
            إلغاء الإشعار
          </button>
        </div>
      </div>
    </section>
  );
}
