'use client';

/**
 * Manual publishing — the messages the generator wrote but did not send.
 *
 * This screen only has anything on it in manual mode
 * (`configs.telegram.mode = 'manual'`, set in تحكم التطبيق). In automatic mode
 * the generator sends as it always did and nothing is queued, so the page says
 * that rather than showing an empty list that looks like a fault.
 *
 * ── WHAT A DECISION HERE IS, AND IS NOT ────────────────────────────────────
 *
 * Approving does not send from this browser. It sets `status = 'approved'` and
 * the generator on Render — which holds the bot token and never stops — picks
 * it up on its next tick. So the message still goes out if this page is closed
 * a second later, and closing the page never leaves a message half-sent.
 *
 * Rejecting is not "delete". The row stays, marked, in the list below: a
 * channel's record is what was published AND what was held back, and a screen
 * that erases the second half turns a decision into a gap.
 *
 * ── THE ONE MISTAKE THAT CANNOT BE TAKEN BACK ──────────────────────────────
 *
 * Publishing the result of an opening that was rejected. Readers were never
 * given that call, so its result — win or loss — is a claim about a trade they
 * never saw. Those rows are flagged in place, because by the time the result
 * arrives the opening has scrolled out of mind.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@euro/shared';
import {
  KIND_LABEL,
  STATUS_LABEL,
  arabicAge,
  arabicRemaining,
  decide,
  fetchDecided,
  fetchPending,
  isExpired,
  orphanedResult,
  watchQueue,
  type TelegramQueueRow,
} from '@/lib/telegramQueue';
import styles from '../admin.module.css';

/** Ages and countdowns are in minutes; a quarter-minute tick is plenty. */
const TICK_MS = 15_000;

export default function TelegramQueueView() {
  const [pending, setPending] = useState<TelegramQueueRow[]>([]);
  const [decided, setDecided] = useState<TelegramQueueRow[]>([]);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [loaded, setLoaded] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // 0 until the browser has mounted. Stamping the clock during render would
  // put a different age in the prerendered HTML than in the first paint, and
  // React would replace the whole list to reconcile it.
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      const [p, d, cfg] = await Promise.all([
        fetchPending(),
        fetchDecided(),
        supabase().from('configs').select('data').eq('id', 'telegram').maybeSingle(),
      ]);
      setPending(p);
      setDecided(d);
      const data = (cfg.data?.['data'] ?? {}) as Record<string, unknown>;
      setMode(data['mode'] === 'manual' ? 'manual' : 'auto');
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر تحميل الطابور' });
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    // Realtime, not a poll: a signal is publishable for the length of one
    // trade, and a message that shows up after its trade closed is noise.
    return watchQueue(() => void load());
  }, [load]);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  /** Rejected openings live in `decided`, so both lists are needed to spot an orphan. */
  const everything = useMemo(() => [...pending, ...decided], [pending, decided]);

  /**
   * Live messages first, whatever their age.
   *
   * The rows arrive oldest-first, which is the right urgency order right up
   * until one expires — after that it is a row you cannot act on sitting above
   * one you can. Expired rows keep their own order and move to the bottom,
   * where they stay visible: they are the record of what was missed, and the
   * generator closes them out on its next tick.
   */
  const queue = useMemo(() => {
    const live = pending.filter((r) => !isExpired(r, now));
    const late = pending.filter((r) => isExpired(r, now));
    return [...live, ...late];
  }, [pending, now]);

  async function onDecide(row: TelegramQueueRow, status: 'approved' | 'rejected'): Promise<void> {
    setBusyKey(row.event_key);
    setMessage(null);
    try {
      const took = await decide(row.event_key, status);
      if (!took) {
        // Not an error: another tab decided it, or the row expired out from
        // under the click. Saying so beats a button that appears to do nothing.
        setMessage({ kind: 'error', text: 'الرسالة دي اتقرر فيها من مكان تاني — الطابور اتحدّث' });
      } else {
        setMessage({
          kind: 'ok',
          text:
            status === 'approved'
              ? 'اتوافق عليها — السيرفر هيبعتها في ثواني'
              : 'اتجاهلت — مش هتروح القناة',
        });
      }
      await load();
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر حفظ القرار' });
    } finally {
      setBusyKey(null);
    }
  }

  if (!loaded) return <p className={styles.muted}>جاري التحميل...</p>;

  return (
    <section>
      <h1 className={styles.title}>نشر تيليجرام</h1>

      {message && <p className={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</p>}

      {mode === 'auto' ? (
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>النشر تلقائي دلوقتي</h2>
          <p className={styles.switchHint}>
            المولّد بيبعت لوحده، ومفيش حاجة بتستنى موافقة. لو عايز تراجع كل رسالة
            قبل ما تروح القناة، حوّل «طريقة النشر» لـ«يدوي» من{' '}
            <strong>تحكم التطبيق ← إشعارات تيليجرام</strong>.
          </p>
        </div>
      ) : (
        <div className={styles.warn}>
          النشر يدوي: مفيش رسالة بتروح القناة غير لما تضغط «انشر» هنا. الإشارة
          بتفضل صالحة لحد وقت انتهاء صفقتها بس — بعدها بتتقفل تلقائي، وده مقصود:
          إشارة فات وقتها مش رأي متأخر، هي غلط.
        </div>
      )}

      {/* ── المستنّي ──────────────────────────────────────────────────── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>
          مستنية قرارك {pending.length > 0 && <span className={`${styles.badge} ${styles.badgeGold}`}>{pending.length}</span>}
        </h2>

        {pending.length === 0 ? (
          <p className={styles.switchHint}>
            مفيش حاجة مستنية. الرسالة بتظهر هنا أول ما المولّد يكتبها — الصفحة
            بتتحدّث لوحدها، مش محتاجة refresh.
          </p>
        ) : (
          queue.map((row) => {
            const expired = isExpired(row, now);
            const orphan = orphanedResult(row, everything);
            const left = arabicRemaining(row.expires_at, now);
            return (
              <article key={row.event_key} className={styles.queueItem}>
                <header className={styles.queueHead}>
                  <span className={styles.badge}>{KIND_LABEL[row.kind]}</span>
                  {row.symbol && <span className={`${styles.badge} ${styles.badgeGold}`}>{row.symbol}</span>}
                  {row.depth_bps !== null && (
                    <span className={styles.badge}>عمق {row.depth_bps}</span>
                  )}
                  {now > 0 && <span className={styles.queueAge}>{arabicAge(row.created_at, now)}</span>}
                  {now > 0 && left && (
                    <span
                      className={`${styles.badge} ${expired ? styles.badgeRed : styles.badgeGreen}`}
                    >
                      {left}
                    </span>
                  )}
                </header>

                {orphan && (
                  <p className={styles.queueWarn}>
                    افتتاح الصفقة دي اترفض — القناة ماشافتش الإشارة. نشر نتيجتها
                    معناه إعلان ربح أو خسارة على صفقة محدش اتقال له عليها.
                  </p>
                )}

                <pre className={styles.queueBody}>{row.body}</pre>

                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={busyKey !== null || expired}
                    onClick={() => void onDecide(row, 'approved')}
                    className={styles.primaryBtn}
                  >
                    {expired ? 'فات وقتها' : 'انشر'}
                  </button>
                  <button
                    type="button"
                    disabled={busyKey !== null}
                    onClick={() => void onDecide(row, 'rejected')}
                    className={`${styles.actionBtn} ${styles.actionDanger}`}
                  >
                    تجاهل
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>

      {/* ── اللي اتقرر فيه ────────────────────────────────────────────── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>آخر القرارات</h2>
        <p className={styles.switchHint} style={{ marginBottom: 10 }}>
          «اتوافق عليها» معناها القرار اتسجّل والسيرفر لسه بيبعت. «اتبعتت» معناها
          وصلت القناة فعلًا.
        </p>

        {decided.length === 0 ? (
          <p className={styles.switchHint}>لسه مفيش قرارات.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>النوع</th>
                  <th>الزوج</th>
                  <th>الحالة</th>
                  <th>الوقت</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((row) => (
                  <tr key={row.event_key}>
                    <td data-label="النوع">{KIND_LABEL[row.kind]}</td>
                    <td data-label="الزوج">{row.symbol ?? '—'}</td>
                    <td data-label="الحالة">
                      <span
                        className={`${styles.badge} ${
                          row.status === 'rejected'
                            ? styles.badgeRed
                            : row.status === 'sent'
                              ? styles.badgeGreen
                              : styles.badgeGold
                        }`}
                      >
                        {STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td data-label="الوقت">
                      {now > 0 ? arabicAge(row.decided_at ?? row.created_at, now) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
