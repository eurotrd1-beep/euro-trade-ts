'use client';

/**
 * System health — the port of `system_repair_screen.dart`.
 *
 * All 27 checks in the same 8 sections, the same repair buttons, the same
 * self-heal / live-monitoring / notification behaviour, and the same Gemini
 * diagnosis through the proxy's `/api/diagnose`. The measurement logic lives in
 * `lib/healthChecks.ts`; this file is the screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHECKS,
  FIX_ACTIONS,
  K_ORIGIN,
  K_WORKER,
  PO_FIX_TEXT,
  SECTIONS,
  checkWebSocket,
  loadNotifs,
  loadOps,
  notifyDesktop,
  notifyPermission,
  requestNotifyPermission,
  readActiveProxy,
  runGemini,
  runOne,
  savePoToken,
  sendAlert,
  short2,
  summarise,
  switchProxy,
  nudgeScraper,
  clearCache,
  resubRealtime,
  textReport,
  wsUrl,
  type FixId,
  type RCheck,
  type RResult,
  type RStatus,
  type RunContext,
} from '@/lib/healthChecks';
import styles from '../admin.module.css';

/** Dart: 20-second per-check timeout. */
const CHECK_TIMEOUT_MS = 20_000;
/** Dart: `Timer.periodic(const Duration(seconds: 30))`. */
const LIVE_TICK_MS = 30_000;
/** Dart: 15-minute alert debounce. */
const ALERT_DEBOUNCE_MS = 15 * 60 * 1000;

const CHECKING: RResult = { status: 'checking', detail: '', cause: '', fix: '', danger: false };

export default function HealthView() {
  const [results, setResults] = useState<Record<string, RResult>>({});
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [activeProxy, setActiveProxy] = useState(K_ORIGIN);
  const [ops, setOps] = useState({ render: false, telegram: false });

  const [geminiLoading, setGeminiLoading] = useState(false);
  const [geminiText, setGeminiText] = useState<string | null>(null);
  const [geminiError, setGeminiError] = useState<string | null>(null);

  const [liveMode, setLiveMode] = useState(false);
  const [notifs, setNotifs] = useState<Array<Record<string, unknown>>>([]);
  const [notifPerm, setNotifPerm] = useState('default');
  const [toast, setToast] = useState<string | null>(null);
  const [poToken, setPoToken] = useState('');
  const [confirmFix, setConfirmFix] = useState<{ title: string; body: string; run: () => Promise<string> } | null>(
    null,
  );
  const [helpFor, setHelpFor] = useState<RCheck | null>(null);

  const lastAlertRef = useRef(0);
  const runningRef = useRef(false);

  const snack = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 6000);
  }, []);

  /** Dart `_runAll`. */
  const runAll = useCallback(async (): Promise<void> => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setDone(0);
    setGeminiText(null);
    setGeminiError(null);
    setResults(Object.fromEntries(CHECKS.map((c) => [c.id, CHECKING])));

    // Prime shared state first. gwin rides the ACTIVE proxy's /ws, not the
    // Worker's — probe both so g_ws reflects reality.
    const proxy = await readActiveProxy();
    setActiveProxy(proxy);
    const opsNow = await loadOps();
    setOps(opsNow);

    const wsOk = await checkWebSocket(wsUrl(K_WORKER), 'EURUSD_otc');
    const wsOkActive = proxy === K_WORKER ? wsOk : await checkWebSocket(wsUrl(proxy), 'EURUSD_otc');

    const ctx: RunContext = {
      activeProxy: proxy,
      wsOk,
      wsOkActive,
      opsRender: opsNow.render,
      opsTelegram: opsNow.telegram,
    };

    const finished: Record<string, RResult> = {};
    await Promise.all(
      CHECKS.map(async (c) => {
        const timeout = new Promise<RResult>((resolve) =>
          setTimeout(
            () =>
              resolve({
                status: 'warn',
                detail: 'انتهت المهلة',
                cause: 'الفحص أخذ أكتر من 20 ثانية',
                fix: '',
                danger: false,
              }),
            CHECK_TIMEOUT_MS,
          ),
        );
        const r = await Promise.race([runOne(c, ctx), timeout]);
        finished[c.id] = r;
        setResults((prev) => ({ ...prev, [c.id]: r }));
        setDone((n) => n + 1);
      }),
    );

    setRunning(false);
    runningRef.current = false;

    // Dart `_afterScan`.
    setNotifs(await loadNotifs());
    const fails = CHECKS.filter((c) => finished[c.id]?.status === 'fail');
    if (fails.length === 0) return;
    const now = Date.now();
    if (now - lastAlertRef.current < ALERT_DEBOUNCE_MS) return;
    lastAlertRef.current = now;
    notifyDesktop(
      `⚠️ إصلاح النظام: ${fails.length} مشكلة`,
      fails.slice(0, 3).map((c) => c.title).join(' • '),
    );
    if (opsNow.telegram) {
      const lines = fails.slice(0, 8).map((c) => `🔴 ${c.title}: ${finished[c.id]?.detail ?? ''}`).join('\n');
      void sendAlert(`⚠️ إصلاح النظام لقى ${fails.length} مشكلة:\n${lines}`).catch(() => {});
    }
  }, []);

  useEffect(() => {
    setNotifPerm(notifyPermission());
    void loadNotifs().then(setNotifs);
    void runAll();
  }, [runAll]);

  // Live monitoring — a rescan every 30s while it is on.
  useEffect(() => {
    if (!liveMode) return;
    const id = setInterval(() => {
      if (!runningRef.current) void runAll();
    }, LIVE_TICK_MS);
    return () => clearInterval(id);
  }, [liveMode, runAll]);

  /** Re-runs one check on its own, as the per-check "افحص تاني" does. */
  async function recheck(c: RCheck): Promise<void> {
    setResults((prev) => ({ ...prev, [c.id]: CHECKING }));
    const r = await runOne(c, {
      activeProxy,
      wsOk: results['wk_ws']?.status === 'ok',
      wsOkActive: results['g_ws']?.status === 'ok',
      opsRender: ops.render,
      opsTelegram: ops.telegram,
    });
    setResults((prev) => ({ ...prev, [c.id]: r }));
  }

  function askFix(title: string, body: string, run: () => Promise<string>): void {
    setConfirmFix({ title, body, run });
  }

  /** Dart `_doFix`: dangerous fixes confirm first, safe ones run immediately. */
  async function doFix(c: RCheck, r: RResult): Promise<void> {
    const fixId = r.action;
    if (!fixId) return;
    const action = FIX_ACTIONS[fixId];
    if (r.danger) {
      askFix(r.fixLabel ?? 'إصلاح', `إيه اللي هيحصل:\n${r.fix}`, action.run);
      return;
    }
    try {
      snack(await action.run());
    } catch (e) {
      snack(`فشل: ${short2(e)}`);
    }
    await recheck(c);
  }

  /** Dart `_autoFixableCount` — distinct labels, not distinct checks. */
  const autoFixable = new Set(
    CHECKS.filter((c) => results[c.id]?.status === 'fail' && results[c.id]?.action).map(
      (c) => results[c.id]!.fixLabel,
    ),
  );

  /** Dart `_autoHealAll`. */
  function autoHealAll(): void {
    const planned = new Map<string, FixId>();
    for (const c of CHECKS) {
      const r = results[c.id];
      if (r?.status === 'fail' && r.action && r.fixLabel && !planned.has(r.fixLabel)) {
        planned.set(r.fixLabel, r.action);
      }
    }
    // Safety: prefer the DIRECT proxy over the Worker if both are ever queued.
    if (planned.has('رجّع للبروكسي المباشر')) planned.delete('حوّل للـ Worker');
    if (planned.size === 0) {
      snack('مفيش أعطال ليها حل تلقائي دلوقتي.');
      return;
    }
    const list = [...planned.keys()].map((k) => `• ${k}`).join('\n');
    askFix(
      'صلّح كل الأحمر تلقائيًا',
      `هيتنفّذ الإصلاحات الآمنة دي بالترتيب:\n\n${list}\n\nكلها قابلة للرجوع، ومش بتمس الكابتشا ولا اللوجين ولا التداول.`,
      async () => {
        const out: string[] = [];
        for (const [label, id] of planned) {
          try {
            out.push(`✅ ${label}: ${await FIX_ACTIONS[id].run()}`);
          } catch (e) {
            out.push(`❌ ${label}: ${short2(e)}`);
          }
        }
        return `تم تنفيذ ${planned.size} إصلاح. بيعيد الفحص…`;
      },
    );
  }

  async function askGemini(): Promise<void> {
    setGeminiLoading(true);
    setGeminiText(null);
    setGeminiError(null);
    const out = await runGemini(results);
    if ('text' in out) setGeminiText(out.text);
    else setGeminiError(out.error);
    setGeminiLoading(false);
  }

  function copy(text: string, msg: string): void {
    void navigator.clipboard.writeText(text).then(
      () => snack(msg),
      () => snack('تعذّر النسخ'),
    );
  }

  const sum = summarise(results);
  const fails = sum['fail'] ?? 0;
  const warns = sum['warn'] ?? 0;
  const overall = fails > 0 ? 'fail' : warns > 0 ? 'warn' : 'ok';
  const overallText =
    fails > 0
      ? `🔴 النظام فيه ${fails} مشكلة`
      : warns > 0
        ? `🟡 النظام شغّال مع ${warns} تحذير`
        : '🟢 النظام سليم تمامًا';

  return (
    <section>
      <h1 className={styles.title}>إصلاح النظام</h1>

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div className={styles.card}>
        <div className={`${styles.banner} ${styles[`banner_${overall}`]}`}>
          <span className={`${styles.bannerDot} ${styles[`dot_${overall}`]}`} aria-hidden="true" />
          <strong>{running ? '⚪ بيفحص النظام…' : overallText}</strong>
          {liveMode && <span className={styles.liveTag}>● مراقبة حيّة</span>}
        </div>

        <button
          type="button"
          disabled={running}
          onClick={() => void runAll()}
          className={styles.scanBtn}
        >
          {running ? `بيفحص… ${done}/${CHECKS.length}` : '📡 افحص كل حاجة'}
        </button>

        <div className={styles.opsRow}>
          {autoFixable.size > 0 && (
            <button type="button" disabled={running} onClick={autoHealAll} className={`${styles.opBtn} ${styles.opGreen}`}>
              🛠️ صلّح كل الأحمر ({autoFixable.size})
            </button>
          )}
          {ops.render && (
            <button
              type="button"
              disabled={running}
              onClick={() =>
                askFix(
                  'إعادة تشغيل البروكسي',
                  'هيعمل redeploy للبروكسي على Render (زي Manual Deploy). بيرجع خلال ~1–2 دقيقة.',
                  FIX_ACTIONS.restart_proxy.run,
                )
              }
              className={`${styles.opBtn} ${styles.opAmber}`}
            >
              ♻️ إعادة تشغيل البروكسي
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setLiveMode((v) => !v);
              snack(liveMode ? 'المراقبة الحيّة وقفت.' : 'المراقبة الحيّة اشتغلت — فحص تلقائي كل 30 ثانية.');
            }}
            className={`${styles.opBtn} ${liveMode ? styles.opAmber : styles.opPurple}`}
          >
            {liveMode ? '⏸️ إيقاف المراقبة' : '📡 مراقبة حيّة'}
          </button>
          {notifPerm !== 'granted' && (
            <button
              type="button"
              onClick={() =>
                void requestNotifyPermission().then((p) => {
                  setNotifPerm(p);
                  snack(
                    p === 'granted'
                      ? 'تنبيهات المتصفح اشتغلت ✅ — هتوصلك لو حاجة وقعت والتاب مفتوح.'
                      : p === 'denied'
                        ? 'المتصفح رافض التنبيهات — فعّلها من إعدادات الموقع.'
                        : 'اتلغى الطلب.',
                  );
                })
              }
              className={`${styles.opBtn} ${styles.opCyan}`}
            >
              🔔 فعّل تنبيهات المتصفح
            </button>
          )}
          {ops.telegram && (
            <button
              type="button"
              onClick={() =>
                void sendAlert('', true).then(snack, (e: unknown) => snack(`فشل: ${short2(e)}`))
              }
              className={`${styles.opBtn} ${styles.opCyan}`}
            >
              🔔 اختبر التنبيه
            </button>
          )}
        </div>

        <div className={styles.pillRow}>
          <span className={`${styles.pill} ${styles.pillRed}`}>🔴 {sum['fail']} مشكلة</span>
          <span className={`${styles.pill} ${styles.pillAmber}`}>🟡 {sum['warn']} تحذير</span>
          <span className={`${styles.pill} ${styles.pillGreen}`}>🟢 {sum['ok']} تمام</span>
          {(sum['na'] ?? 0) > 0 && <span className={styles.pill}>⚫ {sum['na']} غير متاح</span>}
          <button type="button" onClick={() => copy(textReport(results), 'اتنسخ التقرير')} className={styles.linkBtn}>
            نسخ التقرير
          </button>
        </div>
      </div>

      {/* ── Notifications (repair_log) ──────────────────────────────────── */}
      {notifs.length > 0 && (
        <details className={styles.card} open={notifs.some((n) => n['action'] === 'watchdog')}>
          <summary className={styles.summary}>🔔 آخر التنبيهات والإصلاحات ({notifs.length})</summary>
          {notifs.map((n, i) => (
            <NotifRow key={`${String(n['at'])}-${i}`} row={n} />
          ))}
        </details>
      )}

      {/* ── Sections ────────────────────────────────────────────────────── */}
      {SECTIONS.map(([id, title]) => {
        const items = CHECKS.filter((c) => c.section === id);
        const rank = (s: RStatus): number => (s === 'fail' ? 3 : s === 'warn' ? 2 : s === 'checking' ? 1 : 0);
        const worst = items.reduce<RStatus>(
          (acc, c) => (rank(results[c.id]?.status ?? 'unknown') > rank(acc) ? results[c.id]!.status : acc),
          'ok',
        );
        return (
          <details key={id} className={styles.card} open={worst === 'fail'}>
            <summary className={styles.summary}>
              <span className={`${styles.statusDot} ${styles[`dot_${worst}`]}`} aria-hidden="true" />
              {title}
            </summary>
            {items.map((c) => (
              <CheckTile
                key={c.id}
                check={c}
                result={results[c.id] ?? { ...CHECKING, status: 'unknown' }}
                onRecheck={() => void recheck(c)}
                onFix={(r) => void doFix(c, r)}
                onHelp={() => setHelpFor(c)}
                poToken={poToken}
                setPoToken={setPoToken}
                askFix={askFix}
              />
            ))}
          </details>
        );
      })}

      {/* ── Gemini ──────────────────────────────────────────────────────── */}
      <div className={`${styles.card} ${styles.geminiCard}`}>
        <div className={styles.geminiHead}>
          <span aria-hidden="true">🧠</span>
          <h2 className={styles.cardTitle} style={{ margin: 0, flex: 1 }}>
            تشخيص ذكي
          </h2>
          <button
            type="button"
            disabled={geminiLoading || running}
            onClick={() => void askGemini()}
            className={styles.geminiBtn}
          >
            {geminiLoading ? 'جاري التحليل...' : 'حلّل بالذكاء الاصطناعي'}
          </button>
        </div>

        {geminiError !== null && (
          <>
            <p className={styles.warn} style={{ marginTop: 10 }}>
              ⚠️ {geminiError}
            </p>
            <p className={styles.switchHint}>الفحوصات اليدوية فوق تكفي للتشخيص.</p>
          </>
        )}

        {geminiText !== null && (
          <>
            <pre className={styles.geminiText}>{geminiText}</pre>
            <button type="button" onClick={() => copy(geminiText, 'اتنسخ التشخيص')} className={styles.linkBtn}>
              نسخ التشخيص
            </button>
          </>
        )}
      </div>

      {/* ── Dialogs / toast ─────────────────────────────────────────────── */}
      {confirmFix && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modal} style={{ maxWidth: 420 }}>
            <h2 className={styles.modalTitle}>{confirmFix.title}</h2>
            <div className={styles.modalBody}>
              <p className={styles.preLine}>{confirmFix.body}</p>
            </div>
            <div className={styles.modalActions}>
              <button type="button" onClick={() => setConfirmFix(null)} className={styles.actionBtn}>
                إلغاء
              </button>
              <button
                type="button"
                onClick={() => {
                  const job = confirmFix.run;
                  setConfirmFix(null);
                  void job().then(
                    (m) => {
                      snack(m);
                      void runAll();
                    },
                    (e: unknown) => {
                      snack(`فشل: ${short2(e)}`);
                      void runAll();
                    },
                  );
                }}
                className={styles.vipActivate}
                style={{ margin: 0, width: 'auto', padding: '11px 18px' }}
              >
                تأكيد
              </button>
            </div>
          </div>
        </div>
      )}

      {helpFor && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modal} style={{ maxWidth: 440 }}>
            <h2 className={styles.modalTitle} style={{ color: 'var(--admin-primary)' }}>
              ؟ {helpFor.title}
            </h2>
            <div className={styles.modalBody}>
              {helpFor.help.measure && <Kv k="بيقيس إيه" v={helpFor.help.measure} tone="cyan" />}
              {helpFor.help.why && <Kv k="ليه مهم" v={helpFor.help.why} tone="purple" />}
              {helpFor.help.whenRed && <Kv k="إيه اللي بيخليه أحمر" v={helpFor.help.whenRed} tone="red" />}
              {helpFor.help.quickFix && <Kv k="الحل السريع" v={helpFor.help.quickFix} tone="green" />}
              {helpFor.help.deepFix && <Kv k="الحل الجذري" v={helpFor.help.deepFix} tone="amber" />}
              {helpFor.help.external && <Kv k="تدخل خارجي" v={helpFor.help.external} tone="muted" />}
            </div>
            <div className={styles.modalActions}>
              <button type="button" onClick={() => setHelpFor(null)} className={styles.primaryBtn}>
                تمام
              </button>
            </div>
          </div>
        </div>
      )}

      {toast !== null && <div className={styles.toast}>{toast}</div>}
    </section>
  );
}

function CheckTile({
  check,
  result,
  onRecheck,
  onFix,
  onHelp,
  poToken,
  setPoToken,
  askFix,
}: {
  check: RCheck;
  result: RResult;
  onRecheck: () => void;
  onFix: (r: RResult) => void;
  onHelp: () => void;
  poToken: string;
  setPoToken: (v: string) => void;
  askFix: (title: string, body: string, run: () => Promise<string>) => void;
}) {
  const isRed = result.status === 'fail';

  return (
    <details className={`${styles.checkTile} ${isRed ? styles.checkRed : ''}`} open={isRed}>
      <summary className={styles.checkHead}>
        <span className={`${styles.statusDot} ${styles[`dot_${result.status}`]}`} aria-hidden="true" />
        <span className={styles.checkTitle}>
          {check.title}
          {result.detail !== '' && <span className={styles.checkDetail}>{result.detail}</span>}
        </span>
        <button
          type="button"
          title="شرح الفحص"
          onClick={(e) => {
            e.preventDefault();
            onHelp();
          }}
          className={styles.helpBtn}
        >
          ؟
        </button>
      </summary>

      <div className={styles.checkBody}>
        {result.cause !== '' && <Kv k="السبب المحتمل" v={result.cause} tone="amber" />}
        {result.fix !== '' && <Kv k="الحل" v={result.fix} tone="cyan" />}

        <div className={styles.actions} style={{ marginTop: 6 }}>
          <button type="button" onClick={onRecheck} className={styles.actionBtn}>
            ↻ افحص تاني
          </button>
          {result.action && result.fixLabel && (
            <button
              type="button"
              onClick={() => onFix(result)}
              className={`${styles.actionBtn} ${result.danger ? styles.fixDanger : styles.fixSafe}`}
            >
              {result.danger ? '⚠ ' : '🔧 '}
              {result.fixLabel}
            </button>
          )}
          {result.externalUrl && (
            <a href={result.externalUrl} target="_blank" rel="noreferrer" className={styles.extLink}>
              ↗ {result.externalLabel ?? 'افتح'}
            </a>
          )}
        </div>

        {check.id === 'po_token' && (
          <div className={styles.tokenBox}>
            <strong className={styles.tokenTitle}>تجديد التوكن يدوي (بدون كابتشا آلي):</strong>
            <p className={styles.switchHint}>{PO_FIX_TEXT}</p>
            <textarea
              value={poToken}
              onChange={(e) => setPoToken(e.target.value)}
              rows={3}
              placeholder='["auth",{"session":"...",...}]'
              className={styles.textarea}
              style={{ minHeight: 70 }}
              dir="ltr"
            />
            <button
              type="button"
              onClick={() =>
                askFix('حفظ توكن PO', 'هيتحفظ التوكن اللي لصقته في configs.otc_token.', () =>
                  savePoToken(poToken),
                )
              }
              className={`${styles.actionBtn} ${styles.fixSafe}`}
              style={{ marginTop: 8 }}
            >
              حفظ التوكن
            </button>
          </div>
        )}

        {(check.id === 'proxy_serves' || check.id === 'wk_active') && (
          <div className={styles.actions} style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={() =>
                askFix(
                  'حوّل للـ Worker',
                  'التطبيق هيضرب على الـ Worker (كاش). كل الأجهزة تتحول realtime.',
                  () => switchProxy(K_WORKER),
                )
              }
              className={styles.actionBtn}
            >
              حوّل للـ Worker
            </button>
            <button
              type="button"
              onClick={() =>
                askFix(
                  'رجّع للبروكسي المباشر',
                  `التطبيق هيضرب على ${K_ORIGIN} مباشرة (بدون كاش). كل الأجهزة تتحول realtime.`,
                  () => switchProxy(K_ORIGIN),
                )
              }
              className={styles.actionBtn}
            >
              رجّع للبروكسي المباشر
            </button>
            <button
              type="button"
              onClick={() => askFix('نبّه السكرابر', 'هيتبعت للسكرابر إشارة يعيد المحاولة.', nudgeScraper)}
              className={styles.actionBtn}
            >
              نبّه السكرابر
            </button>
            <button
              type="button"
              onClick={() =>
                askFix(
                  'مسح الكاش المحلي',
                  'هيتمسح كاش المتصفح + الـ service workers لهذه الصفحة.',
                  clearCache,
                )
              }
              className={styles.actionBtn}
            >
              مسح الكاش المحلي
            </button>
            <button
              type="button"
              onClick={() =>
                askFix('إعادة اشتراك Realtime', 'هيتقطع اتصال realtime ويعيد الاشتراك.', resubRealtime)
              }
              className={styles.actionBtn}
            >
              إعادة اشتراك Realtime
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

function NotifRow({ row }: { row: Record<string, unknown> }) {
  const action = String(row['action'] ?? '');
  const result = String(row['result'] ?? '');
  const isWatch = action === 'watchdog';
  const icon = isWatch ? '🔴' : action === 'auto_heal' ? '🛠️' : '✅';

  let when = String(row['at'] ?? '');
  const dt = new Date(when);
  if (!Number.isNaN(dt.getTime())) {
    const two = (x: number): string => String(x).padStart(2, '0');
    when = `${two(dt.getHours())}:${two(dt.getMinutes())} ${dt.getDate()}/${dt.getMonth() + 1}`;
  }

  return (
    <div className={styles.notifRow}>
      <span aria-hidden="true">{icon}</span>
      <div className={styles.notifText}>
        <span className={`${styles.mono} ${isWatch ? styles.notifWatch : ''}`}>{action}</span>
        {result !== '' && <span className={styles.switchHint}>{result}</span>}
      </div>
      <span className={styles.mono}>{when}</span>
    </div>
  );
}

function Kv({ k, v, tone }: { k: string; v: string; tone: 'cyan' | 'purple' | 'red' | 'green' | 'amber' | 'muted' }) {
  return (
    <p className={styles.kv}>
      <strong className={styles[`kv_${tone}`]}>{k}: </strong>
      {v}
    </p>
  );
}
