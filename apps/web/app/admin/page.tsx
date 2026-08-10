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
import styles from './admin.module.css';

type RoleFilter = 'all' | 'vip' | 'standard' | 'banned';

export default function UsersView() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RoleFilter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UserRowView({
  user,
  busy,
  onPatch,
}: {
  user: UserRow;
  busy: boolean;
  onPatch: (updates: Partial<UserRow>) => void;
}) {
  const isVip = user.role === 'vip';

  /** Grants VIP for a number of days from now. */
  function grantVip(days: number): void {
    const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    onPatch({ role: 'vip', vip_expiry: expiry.toISOString() });
  }

  return (
    <tr className={busy ? styles.rowBusy : undefined}>
      <td dir="ltr" className={styles.mono}>
        {user.id}
      </td>
      <td>{user.broker || '—'}</td>
      <td>
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
      <td dir="ltr" className={styles.mono}>
        {user.vip_expiry ? new Date(user.vip_expiry).toLocaleDateString() : '—'}
      </td>
      <td dir="ltr" className={`${styles.mono} ${styles.truncate}`} title={user.device_id}>
        {user.device_id || '—'}
      </td>
      <td>
        <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={() => grantVip(30)} className={styles.actionBtn}>
            VIP 30ي
          </button>
          <button type="button" disabled={busy} onClick={() => grantVip(7)} className={styles.actionBtn}>
            VIP 7ي
          </button>
          {isVip && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onPatch({ role: 'standard', vip_expiry: null })}
              className={styles.actionBtn}
            >
              إلغاء VIP
            </button>
          )}
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
