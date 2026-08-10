'use client';

/**
 * Global VIP control — ported from `_buildGlobalVipView`
 * (admin_dashboard.dart:4051).
 *
 * Grants or revokes VIP for EVERY user at once, and sets the `globalVip` config
 * row so newly registering users inherit it while it is active — that config
 * write happens FIRST, so an account created mid-run already comes out VIP
 * (`globalVipGrant` in lib/auth reads it on registration).
 *
 * One deliberate change, same result: the Dart version updates users ONE ROW
 * AT A TIME in a loop (`for (final uid in batch) await ...update().eq('id', uid)`),
 * which is one HTTP round trip per user — fine at 12 users, 1000 round trips at
 * 1000. Here each batch is a single `.in()` update. Identical outcome, and the
 * batching is kept so one oversized request can never time out.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@euro/shared';
import {
  VIP_PRESETS,
  VIP_UNITS,
  durationText,
  formatExpiry,
  unitLabel,
  vipDurationMs,
  type VipUnit,
} from '@/lib/vipDuration';
import styles from '../admin.module.css';

const BATCH_SIZE = 100;

interface GlobalVipState {
  enabled: boolean;
  expiry: string | null;
  durationText: string;
}

export default function GlobalVipView() {
  const [state, setState] = useState<GlobalVipState | null>(null);
  const [userCount, setUserCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Exactly one unit is ever selected — the chips are a radio group, not toggles.
  const [unit, setUnit] = useState<VipUnit>('days');
  const [value, setValue] = useState('30');
  const [confirming, setConfirming] = useState(false);

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

  /** `_activateGlobalVipForAll`. */
  async function activate(ms: number, label: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const expiry = new Date(Date.now() + ms).toISOString();

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

      setMessage({
        kind: 'ok',
        text: `تم تفعيل VIP لجميع المستخدمين (${ids.length} مستخدم) لمدة ${label} ✅`,
      });
      await load();
    } catch (e) {
      setMessage({
        kind: 'error',
        text: `خطأ أثناء تفعيل VIP العام: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  }

  /** `_deactivateGlobalVip`. */
  async function deactivate(): Promise<void> {
    if (!confirm('إيقاف VIP العام؟ سيتم تحويل كل حسابات VIP الحالية إلى standard.')) return;
    setBusy(true);
    setMessage(null);
    try {
      const { error: cfgErr } = await supabase().from('configs').upsert({
        id: 'globalVip',
        data: { enabled: false, disabledAt: new Date().toISOString() },
      });
      if (cfgErr) throw cfgErr;

      const { data } = await supabase().from('users').select('id').eq('role', 'vip');
      const ids = ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id);
      await patchAllUsers(ids, { role: 'standard', vip_expiry: null });

      setMessage({
        kind: 'ok',
        text: `تم إيقاف VIP العام. تم تحويل ${ids.length} مستخدم إلى standard ✅`,
      });
      await load();
    } catch {
      setMessage({ kind: 'error', text: 'خطأ أثناء إيقاف VIP العام' });
    } finally {
      setBusy(false);
    }
  }

  const parsed = Number.parseInt(value, 10) || 0;
  const expiryDate = state?.expiry ? new Date(state.expiry) : null;
  const expired = expiryDate !== null && expiryDate < new Date();
  const active = (state?.enabled ?? false) && !expired;

  return (
    <section className={styles.vipWrap}>
      <div className={`${styles.card} ${active ? styles.vipCardOn : ''}`}>
        {/* Header */}
        <div className={styles.vipHead}>
          <span className={styles.vipIcon} aria-hidden="true">
            ✨
          </span>
          <div>
            <h1 className={styles.vipTitle}>تفعيل VIP العام للجميع 👑</h1>
            <p className={styles.vipSub}>يشمل المستخدمين الحاليين والجدد عند التسجيل</p>
          </div>
        </div>

        {/* Current status */}
        <div
          className={`${styles.vipStatus} ${
            active ? styles.vipStatusOn : expired ? styles.vipStatusExpired : ''
          }`}
        >
          <span aria-hidden="true">{active ? '✅' : '⛔'}</span>
          <div>
            <strong>
              {state === null
                ? 'جاري التحميل...'
                : active
                  ? 'VIP العام مفعّل حالياً'
                  : expired
                    ? 'VIP العام منتهي الصلاحية'
                    : 'VIP العام غير مفعّل'}
            </strong>
            {expiryDate && (state?.enabled ?? false) && (
              <span className={styles.vipStatusLine}>
                {expired
                  ? `انتهت صلاحية VIP العام في ${formatExpiry(expiryDate)} ⚠️`
                  : `ينتهي في: ${formatExpiry(expiryDate)}`}
              </span>
            )}
            {(state?.durationText ?? '') !== '' && ((state?.enabled ?? false) || expired) && (
              <span className={styles.vipStatusDuration}>المدة المضبوطة: {state?.durationText}</span>
            )}
            {userCount !== null && <span className={styles.vipStatusLine}>{userCount} حساب مسجّل حالياً</span>}
          </div>
        </div>

        {/* Duration picker */}
        <p className={styles.vipLabel}>اختر وحدة المدة:</p>
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
            onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="مثال: 30"
            inputMode="numeric"
            className={styles.vipValue}
            aria-label={`عدد ${unitLabel(unit)}`}
          />
          <span className={styles.vipValueSuffix}>{unitLabel(unit)}</span>
        </div>

        {/* Quick shortcuts */}
        <p className={styles.vipHint}>اختصارات سريعة:</p>
        <div className={styles.filters} style={{ flexWrap: 'wrap' }}>
          {VIP_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setUnit(p.unit);
                setValue(String(p.value));
              }}
              className={styles.chipSmall}
            >
              {p.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (parsed <= 0) {
              setMessage({ kind: 'error', text: 'يرجى إدخال قيمة صحيحة أكبر من 0' });
              return;
            }
            setMessage(null);
            setConfirming(true);
          }}
          className={styles.vipActivate}
        >
          {busy ? 'جاري التنفيذ...' : 'تفعيل VIP للجميع الآن 👑'}
        </button>

        {active && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void deactivate()}
            className={styles.vipDeactivate}
          >
            إيقاف VIP العام للمستخدمين الجدد
          </button>
        )}

        {message && (
          <p className={message.kind === 'ok' ? styles.ok : styles.error} style={{ marginTop: 14 }}>
            {message.text}
          </p>
        )}
      </div>

      {/* `_showGlobalVipConfirmDialog` */}
      {confirming && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modal} style={{ maxWidth: 400 }}>
            <h2 className={`${styles.modalTitle} ${styles.gold}`}>تأكيد تفعيل VIP العام 👑</h2>
            <div className={styles.modalBody}>
              <p style={{ margin: '0 0 12px', fontSize: 13 }}>
                هل تريد تفعيل عضوية VIP لمدة {durationText(unit, parsed)} لـ:
              </p>
              <p className={styles.confirmPoint}>✅ جميع المستخدمين المسجلين حالياً في قاعدة البيانات</p>
              <p className={styles.confirmPoint}>✅ أي مستخدم جديد سيسجل لاحقاً خلال هذه الفترة</p>
              <p className={styles.vipExpiryBox}>
                تاريخ انتهاء VIP: {formatExpiry(new Date(Date.now() + vipDurationMs(unit, parsed)))}
              </p>
            </div>
            <div className={styles.modalActions}>
              <button type="button" onClick={() => setConfirming(false)} className={styles.actionBtn}>
                إلغاء
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  void activate(vipDurationMs(unit, parsed), durationText(unit, parsed));
                }}
                className={styles.vipActivate}
                style={{ margin: 0, width: 'auto', padding: '11px 18px' }}
              >
                تفعيل VIP للجميع
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
