'use client';

/**
 * App control — ported from `_buildAppControlView`, `_buildServerSettingsSection`
 * and `_buildSystemSettingsSection` (admin_dashboard.dart:6276 / 6031 / 5813).
 *
 * Everything here is a single `configs` row that the user app reads over
 * Realtime, so each change reaches every open client immediately.
 */

import { useEffect, useState } from 'react';
import { supabase, DEFAULT_PROXY_URL } from '@euro/shared';
import styles from '../admin.module.css';

interface ControlState {
  priceSystem: string;
  displaySource: string;
  chartMode: string;
  proxyUrl: string;
  maintenanceActive: boolean;
  maintenanceMessage: string;
  maintenanceEndsAt: string;
  telegramEnabled: boolean;
}

const EMPTY: ControlState = {
  priceSystem: 'scraping',
  displaySource: 'all',
  // 'scraping', to match `price_system` beside it. The two describe the same
  // choice and a screen that shows them disagreeing before it has loaded
  // anything invites an operator to "fix" a setting that was never wrong.
  chartMode: 'scraping',
  proxyUrl: '',
  maintenanceActive: false,
  maintenanceMessage: '',
  maintenanceEndsAt: '',
  // Off by default. Something that posts to a public channel does not start
  // itself because a screen finished loading.
  telegramEnabled: false,
};

export default function AppControlView() {
  const [state, setState] = useState<ControlState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [proxyStatus, setProxyStatus] = useState<{ ok: boolean; ms: number } | null>(null);

  async function load(): Promise<void> {
    try {
      const { data } = await supabase().from('configs').select('*');
      const rows = (data as Array<{ id: string; data: Record<string, unknown> }> | null) ?? [];
      const get = (id: string): Record<string, unknown> =>
        rows.find((r) => r.id === id)?.data ?? {};

      const maintenance = get('maintenance');
      setState({
        priceSystem: (get('price_system')['value'] as string) ?? 'scraping',
        displaySource: (get('display_source')['value'] as string) ?? 'all',
        chartMode: (get('chart_settings')['mode'] as string) ?? 'sim',
        proxyUrl: (get('proxy_server_url')['url'] as string) ?? '',
        maintenanceActive: maintenance['isActive'] === true,
        maintenanceMessage: (maintenance['message'] as string) ?? '',
        maintenanceEndsAt: (maintenance['endsAt'] as string) ?? '',
        telegramEnabled: get('telegram')['enabled'] === true,
      });
      setLoaded(true);
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر تحميل الإعدادات' });
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function setConfig(id: string, data: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabase().from('configs').upsert({ id, data });
      if (error) throw error;
      setMessage({ kind: 'ok', text: `تم تحديث ${id} — التغيير وصل لكل المستخدمين فورًا` });
      await load();
    } catch {
      setMessage({ kind: 'error', text: `تعذّر تحديث ${id}` });
    } finally {
      setBusy(false);
    }
  }

  /**
   * The Telegram switch.
   *
   * Stored in `configs`, not in the browser: the generator on Render reads it,
   * so it has to survive this page being closed, the laptop being shut and the
   * service restarting — and it has to read the same from another device.
   *
   * OFF stops MESSAGES and nothing else. The strategy keeps running, signals
   * keep appearing, trades keep settling and the statistics keep recording.
   */
  async function setTelegram(on: boolean): Promise<void> {
    setState((s) => ({ ...s, telegramEnabled: on }));
    await setConfig('telegram', { enabled: on });
  }

  /** Pings the proxy the same way the Dart admin does before saving a new URL. */
  async function testProxy(url: string): Promise<void> {
    setProxyStatus(null);
    const base = url.replace(/\/+$/, '') || DEFAULT_PROXY_URL;
    const started = performance.now();
    try {
      const res = await fetch(`${base}/api/otc/status`, { signal: AbortSignal.timeout(8000) });
      setProxyStatus({ ok: res.status === 200, ms: Math.round(performance.now() - started) });
    } catch {
      setProxyStatus({ ok: false, ms: Math.round(performance.now() - started) });
    }
  }

  if (!loaded) return <p className={styles.muted}>جاري التحميل...</p>;

  return (
    <section>
      <h1 className={styles.title}>تحكم في حالة التطبيق</h1>

      {message && <p className={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</p>}

      {/* ── Telegram ─────────────────────────────────────────────────── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>📣 إشعارات تيليجرام</h2>
        <p className={styles.switchHint} style={{ marginBottom: 12 }}>
          بتتبعت من السيرفر مباشرة، مش من الصفحة دي — فقفل اللاب أو المتصفح
          مش بيوقفها. تلات رسايل بس: فتح الإشارة، نتيجتها، وملخص اليوم بعد
          منتصف الليل UTC.
        </p>

        <div className={styles.switchRow}>
          <div>
            <div className={styles.switchLabel}>إرسال الإشعارات للقناة</div>
            <div className={styles.switchHint}>
              الإيقاف بيوقف <strong>الرسايل بس</strong>. الاستراتيجية بتفضل شغالة،
              والإشارات بتفضل تظهر، والصفقات والنتايج والإحصائيات بتتسجّل عادي.
            </div>
          </div>
          <button
            type="button"
            disabled={busy || !loaded}
            onClick={() => void setTelegram(!state.telegramEnabled)}
            aria-pressed={state.telegramEnabled}
            className={`${styles.chip} ${state.telegramEnabled ? styles.chipActive : ''}`}
          >
            {state.telegramEnabled ? 'شغّالة' : 'متوقفة'}
          </button>
        </div>
      </div>

      {/* ── Price system ─────────────────────────────────────────────── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>نظام الأسعار</h2>
        <p className={styles.switchHint} style={{ marginBottom: 12 }}>
          المحاكاة بتولّد شموع صناعية؛ السحب بيجيب OHLC حقيقي من Pocket Option.
        </p>
        <div className={styles.actions}>
          <Choice
            label="🔄 محاكاة (Simulator)"
            active={state.priceSystem === 'simulator'}
            disabled={busy}
            onClick={() => void setConfig('price_system', { value: 'simulator' })}
          />
          <Choice
            label="📡 سحب حقيقي (Scraping)"
            active={state.priceSystem === 'scraping'}
            disabled={busy}
            onClick={() => void setConfig('price_system', { value: 'scraping' })}
          />
        </div>
      </div>

      {/* ── Display source ───────────────────────────────────────────── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>مصدر العرض للمستخدمين</h2>
        <div className={styles.actions}>
          <Choice
            label="🎯 Pocket Option فقط"
            active={state.displaySource === 'po'}
            disabled={busy}
            onClick={() => void setConfig('display_source', { value: 'po' })}
          />
          <Choice
            label="🌐 الكل"
            active={state.displaySource === 'all'}
            disabled={busy}
            onClick={() => void setConfig('display_source', { value: 'all' })}
          />
        </div>
      </div>

      {/* ── Proxy server ─────────────────────────────────────────────── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>سيرفر البيانات (Proxy)</h2>
        <div className={styles.warn}>
          الصف ده بيحدد مصدر كل الأسعار والشموع في التطبيق. أي قيمة غلط بتوقّف الإشارات
          عند كل المستخدمين فورًا — اختبر قبل الحفظ.
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="proxy">
            العنوان (بدون / في الآخر)
          </label>
          <input
            id="proxy"
            value={state.proxyUrl}
            onChange={(e) => setState((s) => ({ ...s, proxyUrl: e.target.value }))}
            className={styles.input}
            dir="ltr"
            placeholder={DEFAULT_PROXY_URL}
          />
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => void testProxy(state.proxyUrl)}
            className={styles.actionBtn}
          >
            اختبار الاتصال
          </button>
          <button
            type="button"
            disabled={busy || !state.proxyUrl.trim()}
            onClick={() =>
              void setConfig('proxy_server_url', { url: state.proxyUrl.replace(/\/+$/, '') })
            }
            className={styles.primaryBtn}
          >
            حفظ
          </button>
        </div>

        {proxyStatus && (
          <p className={proxyStatus.ok ? styles.ok : styles.error} style={{ marginTop: 12 }}>
            {proxyStatus.ok
              ? `متصل ✓ — زمن الاستجابة ${proxyStatus.ms}ms`
              : `فشل الاتصال ✗ — بعد ${proxyStatus.ms}ms`}
          </p>
        )}
      </div>

      {/* ── Chart mode ───────────────────────────────────────────────── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>وضع الشارت</h2>
        <div className={styles.actions}>
          <Choice
            label="محاكاة"
            active={state.chartMode === 'sim'}
            disabled={busy}
            onClick={() => void setConfig('chart_settings', { mode: 'sim' })}
          />
          <Choice
            label="سحب"
            active={state.chartMode !== 'sim'}
            disabled={busy}
            onClick={() => void setConfig('chart_settings', { mode: 'scraping' })}
          />
        </div>
      </div>

      {/* ── Maintenance ──────────────────────────────────────────────── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>وضع الصيانة</h2>
        <p className={styles.switchHint} style={{ marginBottom: 12 }}>
          التفعيل بيطرد كل المستخدمين المفتوحين لشاشة الصيانة فورًا.
        </p>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="msg">
            الرسالة
          </label>
          <input
            id="msg"
            value={state.maintenanceMessage}
            onChange={(e) => setState((s) => ({ ...s, maintenanceMessage: e.target.value }))}
            className={styles.input}
            placeholder="التطبيق متوقف مؤقتاً للصيانة، سنعود قريباً"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="ends">
            ينتهي في (اتركه فارغًا لصيانة مفتوحة)
          </label>
          <input
            id="ends"
            type="datetime-local"
            value={state.maintenanceEndsAt ? state.maintenanceEndsAt.slice(0, 16) : ''}
            onChange={(e) =>
              setState((s) => ({
                ...s,
                maintenanceEndsAt: e.target.value ? new Date(e.target.value).toISOString() : '',
              }))
            }
            className={styles.input}
            dir="ltr"
          />
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void setConfig('maintenance', {
                isActive: true,
                message: state.maintenanceMessage,
                endsAt: state.maintenanceEndsAt || null,
              })
            }
            className={`${styles.actionBtn} ${styles.actionDanger}`}
          >
            تفعيل الصيانة
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void setConfig('maintenance', { isActive: false, message: '', endsAt: null })
            }
            className={styles.actionBtn}
          >
            إيقاف الصيانة
          </button>
        </div>

        {state.maintenanceActive && (
          <p className={styles.error} style={{ marginTop: 12 }}>
            الصيانة مفعّلة حاليًا — المستخدمون لا يستطيعون الدخول.
          </p>
        )}
      </div>
    </section>
  );
}

function Choice({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`${styles.chip} ${active ? styles.chipActive : ''}`}
    >
      {label}
    </button>
  );
}
