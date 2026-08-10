'use client';

/**
 * Strategy upload — ported from `_buildStrategyUploadSection`
 * (admin_dashboard.dart:7641).
 *
 * This is the highest-leverage screen in the whole system: what gets saved here
 * decides every signal every user receives. So it does one thing the Dart admin
 * does not, and the reason matters:
 *
 *   It VALIDATES the indicator names against the engine before saving.
 *
 * The audit at migration time found 31 indicator names in the master reference
 * file that the engine has never implemented — `sma`, `macd`, `bollinger_upper`,
 * `stochastic_k`, `adx_plus`… Each one silently evaluates to 0.0 and quietly
 * contributes nothing. They are all currently `enabled: false`, so nothing is
 * broken today, but enabling one would degrade signals with no error anywhere.
 *
 * The check is a WARNING, never a block: an unknown name is still saved if the
 * operator insists, so behaviour is unchanged. It just stops being invisible.
 */

import { useMemo, useState } from 'react';
import { supabase } from '@euro/shared';
import { registeredNames } from '@euro/engine';
import styles from '../admin.module.css';

const TARGETS = [
  { id: 'strategy_standard', label: 'استراتيجية العادي' },
  { id: 'strategy_vip', label: 'استراتيجية VIP' },
  { id: 'monitoring_standard', label: 'مراقبة العادي' },
  { id: 'monitoring_vip', label: 'مراقبة VIP' },
];

interface RuleLike {
  indicator?: unknown;
  enabled?: unknown;
}

export default function StrategyUploadView() {
  const [target, setTarget] = useState(TARGETS[0]!.id);
  const [json, setJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const known = useMemo(() => new Set(registeredNames()), []);

  /** Parses and audits without saving, so the operator sees issues first. */
  const audit = useMemo(() => {
    if (!json.trim()) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      return { error: `JSON غير صالح: ${(e as Error).message}` };
    }

    const obj = parsed as { rules?: unknown; pyramid?: unknown };
    if (!Array.isArray(obj.rules)) {
      return { error: 'الملف لا يحتوي على مصفوفة "rules"' };
    }

    const rules = obj.rules as RuleLike[];
    // Section markers carry no indicator; they are documentation, not rules.
    const real = rules.filter((r) => typeof r.indicator === 'string');
    const enabled = real.filter((r) => r.enabled !== false);

    const unknownAll = [
      ...new Set(real.filter((r) => !known.has(r.indicator as string)).map((r) => r.indicator as string)),
    ];
    const unknownEnabled = [
      ...new Set(
        enabled.filter((r) => !known.has(r.indicator as string)).map((r) => r.indicator as string),
      ),
    ];

    return {
      total: rules.length,
      real: real.length,
      enabled: enabled.length,
      hasPyramid: obj.pyramid != null,
      unknownAll,
      unknownEnabled,
    };
  }, [json, known]);

  async function save(): Promise<void> {
    if (!audit || 'error' in audit) return;
    setSaving(true);
    setMessage(null);
    try {
      const data = JSON.parse(json) as Record<string, unknown>;
      const { error } = await supabase().from('configs').upsert({ id: target, data });
      if (error) throw error;
      setMessage({
        kind: 'ok',
        text: `تم الحفظ في ${target} — ${audit.enabled} قاعدة مفعّلة. التغيير يصل للمستخدمين فورًا.`,
      });
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر الحفظ. راجع الاتصال والصلاحيات.' });
    } finally {
      setSaving(false);
    }
  }

  async function loadCurrent(): Promise<void> {
    setMessage(null);
    try {
      const { data } = await supabase().from('configs').select('data').eq('id', target).maybeSingle();
      setJson(JSON.stringify(data?.['data'] ?? {}, null, 2));
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر تحميل الاستراتيجية الحالية' });
    }
  }

  const hasError = audit !== null && 'error' in audit;

  return (
    <section>
      <h1 className={styles.title}>رفع الاستراتيجيات</h1>

      <div className={styles.card}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="target">
            الوجهة
          </label>
          <select
            id="target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className={styles.input}
          >
            {TARGETS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} ({t.id})
              </option>
            ))}
          </select>
        </div>

        <button type="button" onClick={() => void loadCurrent()} className={styles.actionBtn}>
          تحميل الحالية
        </button>
      </div>

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>محتوى الاستراتيجية (JSON)</h2>
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          className={styles.textarea}
          dir="ltr"
          spellCheck={false}
          placeholder='{ "name": "...", "min_score": 0, "rules": [ ... ] }'
        />
      </div>

      {hasError && <p className={styles.error}>{(audit as { error: string }).error}</p>}

      {audit !== null && !('error' in audit) && (
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>الفحص قبل الحفظ</h2>

          <div className={styles.statRow}>
            <div className={styles.stat}>
              <span className={styles.statValue}>{audit.real}</span>
              <span className={styles.statLabel}>قاعدة</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{audit.enabled}</span>
              <span className={styles.statLabel}>مفعّلة</span>
            </div>
            <div className={`${styles.stat} ${audit.unknownEnabled.length > 0 ? styles.statRed : ''}`}>
              <span className={styles.statValue}>{audit.unknownEnabled.length}</span>
              <span className={styles.statLabel}>مفعّلة ومجهولة</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{audit.hasPyramid ? 'نعم' : 'لا'}</span>
              <span className={styles.statLabel}>وضع الهرم</span>
            </div>
          </div>

          {audit.unknownEnabled.length > 0 && (
            <div className={styles.error}>
              <strong>خطر:</strong> المؤشرات دي <strong>مفعّلة</strong> والمحرك لا يعرفها، فهترجّع{' '}
              <code>0.0</code> بصمت وتشارك في الحساب بلا قيمة:
              <br />
              <code dir="ltr">{audit.unknownEnabled.join(', ')}</code>
            </div>
          )}

          {audit.unknownAll.length > audit.unknownEnabled.length && (
            <div className={styles.warn}>
              <strong>تنبيه:</strong> {audit.unknownAll.length - audit.unknownEnabled.length} مؤشر
              غير معروف موجود في الملف لكنه <strong>معطّل</strong> — لا يؤثر الآن، لكنه سيرجع{' '}
              <code>0.0</code> لو فعّلته.
              <br />
              <code dir="ltr">
                {audit.unknownAll.filter((n) => !audit.unknownEnabled.includes(n)).join(', ')}
              </code>
            </div>
          )}

          {audit.unknownAll.length === 0 && (
            <p className={styles.ok}>كل المؤشرات معروفة للمحرك ✓</p>
          )}
        </div>
      )}

      {message && (
        <p className={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</p>
      )}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving || audit === null || hasError}
        className={styles.primaryBtn}
      >
        {saving ? 'جاري الحفظ...' : 'حفظ ونشر'}
      </button>
    </section>
  );
}
