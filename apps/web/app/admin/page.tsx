'use client';

/**
 * User database — ported from `_buildUserDatabaseView` (admin_dashboard.dart:2857).
 *
 * Every control here writes straight to the `users` table, which is what the
 * Dart admin does. Search, ban, VIP grant and guaranteed-win all live in one
 * table, so they are one screen.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase, type UserRow } from '@euro/shared';
import {
  VIP_PRESETS,
  VIP_UNITS,
  durationText,
  formatExpiry,
  unitLabel,
  vipDurationMs,
  type VipUnit,
} from '@/lib/vipDuration';
import styles from './admin.module.css';

type RoleFilter = 'all' | 'vip' | 'standard' | 'banned';

export default function UsersView() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RoleFilter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vipFor, setVipFor] = useState<UserRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const { data } = await supabase()
        .from('users')
        .select('*')
        .order('created_at', { ascending: false });
      setUsers((data as UserRow[] | null) ?? []);
    } catch {
      setUsers([]);
      setError('تعذّر تحميل المستخدمين');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /** Applies a patch and refreshes, so the table always shows the stored truth. */
  async function patch(id: string, updates: Partial<UserRow>): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      const { error: err } = await supabase().from('users').update(updates).eq('id', id);
      if (err) throw err;
      await load();
    } catch {
      setError(`تعذّر تحديث الحساب ${id}`);
    } finally {
      setBusy(null);
    }
  }

  const visible = useMemo(() => {
    const list = users ?? [];
    const q = query.trim().toLowerCase();
    return list.filter((u) => {
      if (q && !u.id.toLowerCase().includes(q) && !u.broker.toLowerCase().includes(q)) return false;
      if (filter === 'vip') return u.role === 'vip';
      if (filter === 'standard') return u.role !== 'vip' && !u.is_banned;
      if (filter === 'banned') return u.is_banned;
      return true;
    });
  }, [users, query, filter]);

  const stats = useMemo(() => {
    const list = users ?? [];
    return {
      total: list.length,
      vip: list.filter((u) => u.role === 'vip').length,
      banned: list.filter((u) => u.is_banned).length,
      guaranteed: list.filter((u) => u.guaranteed_win).length,
    };
  }, [users]);

  return (
    <section>
      <h1 className={styles.title}>قاعدة بيانات المستخدمين</h1>

      <div className={styles.statRow}>
        <Stat label="إجمالي" value={stats.total} />
        <Stat label="VIP" value={stats.vip} tone="gold" />
        <Stat label="محظور" value={stats.banned} tone="red" />
        <Stat label="ربح مضمون" value={stats.guaranteed} tone="green" />
      </div>

      <div className={styles.toolbar}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={styles.search}
          placeholder="ابحث بمعرف الحساب أو المنصة..."
          aria-label="بحث"
        />
        <div className={styles.filters}>
          {(
            [
              ['all', 'الكل'],
              ['vip', 'VIP'],
              ['standard', 'عادي'],
              ['banned', 'محظور'],
            ] as Array<[RoleFilter, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={`${styles.chip} ${filter === id ? styles.chipActive : ''}`}
              aria-pressed={filter === id}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className={styles.error}>{error}</p>}
      {notice && <p className={styles.ok}>{notice}</p>}

      {users === null ? (
        <p className={styles.muted}>جاري التحميل...</p>
      ) : visible.length === 0 ? (
        <p className={styles.muted}>لا توجد نتائج</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>معرف الحساب</th>
                <th>المنصة</th>
                <th>الحالة</th>
                <th>انتهاء VIP</th>
                <th>الجهاز</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((u) => (
                <UserRowView
                  key={u.id}
                  user={u}
                  busy={busy === u.id}
                  onPatch={(updates) => void patch(u.id, updates)}
                  onVip={() => setVipFor(u)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {vipFor && (
        <VipDialog
          user={vipFor}
          onCancel={() => setVipFor(null)}
          onApply={(updates, text) => {
            const id = vipFor.id;
            setVipFor(null);
            setNotice(text);
            void patch(id, updates);
          }}
        />
      )}
    </section>
  );
}

function UserRowView({
  user,
  busy,
  onPatch,
  onVip,
}: {
  user: UserRow;
  busy: boolean;
  onPatch: (updates: Partial<UserRow>) => void;
  onVip: () => void;
}) {
  const isVip = user.role === 'vip';

  return (
    <tr className={busy ? styles.rowBusy : undefined}>
      <td data-label="معرف الحساب" dir="ltr" className={styles.mono}>
        {user.id}
      </td>
      <td data-label="المنصة">{user.broker || '—'}</td>
      <td data-label="الحالة">
        {user.is_banned ? (
          <span className={`${styles.badge} ${styles.badgeRed}`}>محظور</span>
        ) : isVip ? (
          <span className={`${styles.badge} ${styles.badgeGold}`}>VIP</span>
        ) : (
          <span className={styles.badge}>عادي</span>
        )}
        {user.guaranteed_win && (
          <span className={`${styles.badge} ${styles.badgeGreen}`}>ربح مضمون</span>
        )}
      </td>
      <td data-label="انتهاء VIP" dir="ltr" className={styles.mono}>
        {user.vip_expiry ? new Date(user.vip_expiry).toLocaleDateString() : '—'}
      </td>
      <td data-label="الجهاز" dir="ltr" className={`${styles.mono} ${styles.truncate}`} title={user.device_id}>
        {user.device_id || '—'}
      </td>
      <td data-label="إجراءات">
        <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={onVip} className={styles.actionBtn}>
            {isVip ? 'إدارة VIP 👑' : 'تفعيل VIP 👑'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onPatch({ guaranteed_win: !user.guaranteed_win })}
            className={styles.actionBtn}
          >
            {user.guaranteed_win ? 'إيقاف الربح المضمون' : 'ربح مضمون'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onPatch({ is_banned: !user.is_banned })}
            className={`${styles.actionBtn} ${user.is_banned ? '' : styles.actionDanger}`}
          >
            {user.is_banned ? 'رفع الحظر' : 'حظر'}
          </button>
          {/* Clearing the device id lets a VIP move to a new phone. */}
          <button
            type="button"
            disabled={busy || !user.device_id}
            onClick={() => onPatch({ device_id: '' })}
            className={styles.actionBtn}
            title="يسمح للحساب بتسجيل الدخول من جهاز جديد"
          >
            تحرير الجهاز
          </button>
        </div>
      </td>
    </tr>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'gold' | 'red' | 'green' }) {
  const toneClass = tone === 'gold' ? styles.statGold : tone === 'red' ? styles.statRed : tone === 'green' ? styles.statGreen : '';
  return (
    <div className={`${styles.stat} ${toneClass}`}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

/**
 * `_showVipManagementDialog` (admin_dashboard.dart:3448).
 *
 * The duration is one unit plus a count — the chips are a radio group, so two
 * units can never be combined.
 */
function VipDialog({
  user,
  onCancel,
  onApply,
}: {
  user: UserRow;
  onCancel: () => void;
  onApply: (updates: Partial<UserRow>, notice: string) => void;
}) {
  const [unit, setUnit] = useState<VipUnit>('days');
  const [value, setValue] = useState('30');
  const [error, setError] = useState<string | null>(null);

  const isVip = user.role === 'vip';
  const parsed = Number.parseInt(value, 10) || 0;

  // `expiryStatusText` from the caller in the Dart version.
  let expiryStatusText = '';
  if (isVip && typeof user.vip_expiry === 'string' && user.vip_expiry !== '') {
    const d = new Date(user.vip_expiry);
    if (!Number.isNaN(d.getTime())) {
      expiryStatusText =
        d < new Date()
          ? `منتهي الصلاحية ${formatExpiry(d).slice(0, 10)} ⚠️`
          : `ينتهي: ${formatExpiry(d)}`;
    }
  } else if (isVip) {
    expiryStatusText = 'تفعيل دائم';
  }

  function activate(): void {
    if (parsed <= 0) {
      setError('يرجى إدخال قيمة صحيحة أكبر من 0');
      return;
    }
    const label = durationText(unit, parsed);
    const expiry = new Date(Date.now() + vipDurationMs(unit, parsed));
    onApply(
      { role: 'vip', vip_expiry: expiry.toISOString() },
      `تم تفعيل عضوية VIP بنجاح للمستخدم لمدة ${label} ✅`,
    );
  }

  return (
    <div className={styles.modalOverlay} role="dialog" aria-modal="true">
      <div className={styles.modal} style={{ maxWidth: 420 }}>
        <h2 className={styles.modalTitle}>
          إدارة عضوية الـ VIP للحساب: <span dir="ltr">{user.id}</span>
        </h2>

        <div className={styles.modalBody}>
          {isVip && (
            <div className={`${styles.vipStatus} ${styles.vipStatusOn}`} style={{ marginBottom: 16 }}>
              <span aria-hidden="true">✅</span>
              <div>
                <strong>الحالة الحالية: الـ VIP نشط حالياً.</strong>
                {expiryStatusText !== '' && <span className={styles.vipStatusLine}>{expiryStatusText}</span>}
              </div>
            </div>
          )}

          <p className={styles.vipLabel} style={{ marginTop: 0 }}>
            اختر وحدة المدة:
          </p>
          <div className={styles.filters} style={{ flexWrap: 'wrap' }}>
            {VIP_UNITS.map((u) => (
              <button
                key={u.unit}
                type="button"
                aria-pressed={unit === u.unit}
                onClick={() => setUnit(u.unit)}
                className={`${styles.chip} ${unit === u.unit ? styles.chipGold : ''}`}
              >
                {u.chip}
              </button>
            ))}
          </div>

          <p className={styles.vipLabel}>أدخل عدد {unitLabel(unit)}:</p>
          <div className={styles.vipValueWrap}>
            <input
              value={value}
              onChange={(e) => {
                setValue(e.target.value.replace(/[^0-9]/g, ''));
                setError(null);
              }}
              placeholder="مثال: 30"
              inputMode="numeric"
              className={styles.vipValue}
              aria-label={`عدد ${unitLabel(unit)}`}
              autoFocus
            />
            <span className={styles.vipValueSuffix}>{unitLabel(unit)}</span>
          </div>

          <p className={styles.vipHint}>اختصارات سريعة:</p>
          <div className={styles.filters} style={{ flexWrap: 'wrap' }}>
            {VIP_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setUnit(p.unit);
                  setValue(String(p.value));
                  setError(null);
                }}
                className={styles.chipSmall}
              >
                {p.label}
              </button>
            ))}
          </div>

          {parsed > 0 && (
            <p className={styles.vipExpiryBox}>
              تاريخ انتهاء VIP: {formatExpiry(new Date(Date.now() + vipDurationMs(unit, parsed)))}
            </p>
          )}

          {error && (
            <p className={styles.error} style={{ marginTop: 12 }} role="alert">
              {error}
            </p>
          )}
        </div>

        <div className={styles.modalActions}>
          <button type="button" onClick={onCancel} className={styles.actionBtn}>
            إلغاء
          </button>
          {isVip && (
            <button
              type="button"
              onClick={() =>
                onApply(
                  { role: 'standard', vip_expiry: null },
                  'تم إلغاء عضوية VIP وإرجاع المستخدم للباقة القياسية.',
                )
              }
              className={`${styles.actionBtn} ${styles.actionDanger}`}
            >
              إلغاء الـ VIP وإرجاعه قياسي
            </button>
          )}
          <button
            type="button"
            onClick={activate}
            className={styles.vipActivate}
            style={{ margin: 0, width: 'auto', padding: '11px 18px' }}
          >
            {isVip ? 'تحديث وتمديد الاشتراك' : 'تفعيل العضوية VIP 👑'}
          </button>
        </div>
      </div>
    </div>
  );
}
