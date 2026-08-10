'use client';

/**
 * Global VIP control — ported from `_buildGlobalVipView`
 * (admin_dashboard.dart:4051).
 *
 * Grants or revokes VIP for EVERY user at once, and sets the `globalVip` config
 * row so newly registering users inherit it (see `globalVipGrant` in lib/auth).
 *
 * One deliberate change, same result: the Dart version updates users ONE ROW
 * AT A TIME in a loop (`for (final uid in batch) await ...update().eq('id', uid)`),
 * which is one HTTP round trip per user — fine at 12 users, 1000 round trips at
 * 1000. Here each batch is a single `.in()` update. Identical outcome, and the
 * batching is kept so one oversized request can never time out.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@euro/shared';
import styles from '../admin.module.css';

const BATCH_SIZE = 100;

interface GlobalVipState {
  enabled: boolean;
  expiry: string | null;
  durationText: string;
}

const PRESETS: Array<{ days: number; label: string }> = [
  { days: 1, label: 'يوم واحد' },
  { days: 7, label: 'أسبوع' },
  { days: 30, label: 'شهر' },
  { days: 90, label: '3 شهور' },
];

export default function GlobalVipView() {
  const [state, setState] = useState<GlobalVipState | null>(null);
  const [userCount, setUserCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [customDays, setCustomDays] = useState('30');

  async function load(): Promise<void> {
    try {
      const [cfg, users] = await Promise.all([
        supabase().from('configs').select('data').eq('id', 'globalVip').maybeSingle(),
        supabase().from('users').select('id', { count: 'exact', head: true }),
      ]);

      const d = (cfg.data?.['data'] ?? {}) as Record<string, unknown>;
      setState({
        enabled: d['enabled'] === true,
        expiry: typeof d['expiry'] === 'string' ? d['expiry'] : null,
        durationText: typeof d['durationText'] === 'string' ? d['durationText'] : '',
      });
      setUserCount(users.count ?? 0);
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر تحميل حالة VIP العام' });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /** Applies one patch to every user id, in batches of BATCH_SIZE. */
  async function patchAllUsers(ids: string[], updates: Record<string, unknown>): Promise<void> {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const { error } = await supabase().from('users').update(updates).in('id', batch);
      if (error) throw error;
    }
  }

  async function activate(days: number, label: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

      // Config first, so anyone registering mid-run already inherits VIP.
      const { error: cfgErr } = await supabase().from('configs').upsert({
        id: 'globalVip',
        data: {
          enabled: true,
          expiry,
          durationText: label,
          activatedAt: new Date().toISOString(),
        },
      });
      if (cfgErr) throw cfgErr;

      const { data } = await supabase().from('users').select('id');
      const ids = ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id);
      await patchAllUsers(ids, { role: 'vip', vip_expiry: expiry });

      setMessage({ kind: 'ok', text: `تم تفعيل VIP لجميع المستخدمين (${ids.length}) لمدة ${label} ✅` });
      await load();
    } catch {
      setMessage({ kind: 'error', text: 'خطأ أثناء تفعيل VIP العام' });
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const { error: cfgErr } = await supabase().from('configs').upsert({
        id: 'globalVip',
        data: { enabled: false, disabledAt: new Date().toISOString() },
      });
      if (cfgErr) throw cfgErr;

      // Only current VIPs are touched, so individually granted accounts that
      // were already standard stay untouched.
      const { data } = await supabase().from('users').select('id').eq('role', 'vip');
      const ids = ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id);
      await patchAllUsers(ids, { role: 'standard', vip_expiry: null });

      setMessage({ kind: 'ok', text: `تم إلغاء VIP العام وخفض ${ids.length} حساب ✅` });
      await load();
    } catch {
      setMessage({ kind: 'error', text: 'خطأ أثناء إلغاء VIP العام' });
    } finally {
      setBusy(false);
    }
  }

  const expiryDate = state?.expiry ? new Date(state.expiry) : null;
  const expired = expiryDate !== null && expiryDate < new Date();

  return (
    <section>
      <h1 className={styles.title}>التحكم في VIP العام</h1>

      <div className={styles.warn}>
        <strong>انتبه:</strong> الأزرار دي بتأثر على <strong>كل</strong> المستخدمين
        {userCount !== null && ` (${userCount} حساب)`} مرة واحدة، مش على حساب واحد.
      </div>

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>الحالة الحالية</h2>
        {state === null ? (
          <p className={styles.muted}>جاري التحميل...</p>
        ) : state.enabled ? (
          <>
            <p className={expired ? styles.error : styles.ok}>
              {expired
                ? `انتهت صلاحية VIP العام في ${expiryDate?.toLocaleString()} ⚠️`
                : `مفعّل — ينتهي في ${expiryDate?.toLocaleString()}`}
            </p>
            {state.durationText && <p className={styles.muted}>المدة: {state.durationText}</p>}
          </>
        ) : (
          <p className={styles.muted}>غير مفعّل</p>
        )}
      </div>

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>تفعيل لمدة</h2>
        <div className={styles.actions}>
          {PRESETS.map((p) => (
            <button
              key={p.days}
              type="button"
              disabled={busy}
              onClick={() => void activate(p.days, p.label)}
              className={styles.actionBtn}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className={styles.field} style={{ marginTop: 14 }}>
          <label className={styles.label} htmlFor="days">
            مدة مخصّصة (بالأيام)
          </label>
          <input
            id="days"
            value={customDays}
            onChange={(e) => setCustomDays(e.target.value)}
            className={styles.input}
            inputMode="numeric"
            dir="ltr"
          />
        </div>

        <button
          type="button"
          disabled={busy || !(Number(customDays) > 0)}
          onClick={() => void activate(Number(customDays), `${customDays} يوم`)}
          className={styles.primaryBtn}
        >
          {busy ? 'جاري التنفيذ...' : 'تفعيل بالمدة المخصّصة'}
        </button>
      </div>

      <div className={styles.card}>
        <h2 className={styles.cardTitle}>إلغاء</h2>
        <p className={styles.muted} style={{ padding: '0 0 12px', textAlign: 'start' }}>
          بيوقف VIP العام ويخفض <strong>كل</strong> حسابات VIP الحالية للعادي — بما فيها اللي
          فعّلتها يدويًا.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void deactivate()}
          className={`${styles.actionBtn} ${styles.actionDanger}`}
        >
          إلغاء VIP العام وخفض الجميع
        </button>
      </div>

      {message && <p className={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</p>}
    </section>
  );
}
