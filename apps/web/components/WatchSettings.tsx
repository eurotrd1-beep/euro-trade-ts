'use client';

/**
 * The settings sheet the ⚙️ beside "generate" opens.
 *
 * It replaces the standalone notifications button, and carries both of that
 * button's job and the pair choice — because they are the same choice. One list
 * decides what the app watches AND what it alerts about, so there is exactly
 * one answer to "which pairs am I following" instead of the two that existed
 * before (a private list inside the notification code, and a watch loop that
 * swept the whole catalogue and ignored it).
 *
 * The sheet has two parts, in this order:
 *
 *   1. the pairs — the choice everything else depends on, so it comes first and
 *      the generate button stays dead until it is made
 *   2. whether to be alerted while the app is closed — offered only once there
 *      is something to be alerted about, since asking for permission to buzz
 *      about nothing spends the one prompt a browser ever allows
 */

import { useCallback, useEffect, useState } from 'react';
import { tr, type PairRow } from '@euro/shared';
import { disablePush, enablePush, pushState, refreshPush, type PushState } from '@/lib/webPush';
import { legacyWantedEverything, loadWatched, saveWatched } from '@/lib/watchedPairs';
import { PushPairPicker } from './PushPairPicker';
import styles from './WatchSettings.module.css';

export interface WatchSettingsProps {
  accountId: string | null;
  plan: 'free' | 'paid';
  pairs: PairRow[];
  /** True while the ⚙️ sheet should be on screen. Owned by the page. */
  open: boolean;
  onClose: () => void;
  /** Told on mount and on every change, so the watch never lags the choice. */
  onChange: (symbols: string[]) => void;
}

export function WatchSettings({
  accountId,
  plan,
  pairs,
  open,
  onClose,
  onChange,
}: WatchSettingsProps) {
  const [watched, setWatched] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  // ── The stored selection ──────────────────────────────────────────────────
  useEffect(() => {
    let list = loadWatched(accountId);

    // The notifications button used to store "every pair" as the string `all`,
    // which cannot be expanded where it is read — that file does not know the
    // catalogue. Expanded here instead, so a user who had already chosen
    // everything is not dropped back to an empty selection and a dead button.
    if (list.length === 0 && legacyWantedEverything() && pairs.length > 0) {
      list = pairs.map((p) => p.chart_symbol);
      saveWatched(accountId, list);
    }

    setWatched(list);
    onChange(list);
  }, [accountId, pairs, onChange]);

  useEffect(() => {
    let cancelled = false;
    void pushState().then((s) => {
      if (!cancelled) setPush(s);
    });
    return () => { cancelled = true; };
  }, []);

  // Keeps the stored subscription pointing at the current list, so changing
  // pairs changes what arrives without touching the switch. Best-effort.
  useEffect(() => {
    if (push === 'on' && watched.length > 0) void refreshPush(accountId, plan, watched);
  }, [push, watched, accountId, plan]);

  const savePairs = useCallback(
    (symbols: string[]) => {
      setPicking(false);
      setWatched(symbols);
      saveWatched(accountId, symbols);
      onChange(symbols);
    },
    [accountId, onChange],
  );

  const togglePush = useCallback(async () => {
    setBusy(true);
    try {
      setPush(push === 'on' ? await disablePush() : await enablePush(accountId, plan, watched));
    } finally {
      setBusy(false);
    }
  }, [push, accountId, plan, watched]);

  if (picking) {
    return (
      <PushPairPicker
        pairs={pairs}
        initial={watched}
        onCancel={() => setPicking(false)}
        onConfirm={savePairs}
      />
    );
  }

  if (!open) return null;

  const count = watched.length;
  const all = count > 0 && count === pairs.length;
  const on = push === 'on';

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true">
      <div className={styles.sheet}>
        <header className={styles.head}>
          <h2 className={styles.title}>{tr('⚙️ الإعدادات', '⚙️ Settings')}</h2>
          <button
            type="button"
            onClick={onClose}
            className={styles.close}
            aria-label={tr('إغلاق', 'Close')}
          >
            ✕
          </button>
        </header>

        {/*
          Said before the choice, not after it. "Choose your pairs" does not on
          its own tell anybody what the choice DOES, and the two things it does
          are the two things the user is here for.
        */}
        <p className={styles.lead}>
          {tr(
            'الأزواج اللي تختارها هنا هي اللي الاستراتيجية هتحللها على كل شمعة، وهي نفسها اللي هتوصلك منها إشعارات.',
            'The pairs you choose here are the ones the strategy analyses on every candle — and the same ones you get alerts from.',
          )}
        </p>

        {/* ── 1. The pairs ── */}
        <button type="button" onClick={() => setPicking(true)} className={styles.pairsBtn}>
          <span aria-hidden="true">📊</span>
          <span className={styles.pairsText}>
            <strong>
              {count === 0
                ? tr('اختار الأزواج اللي تتابعها', 'Choose the pairs to follow')
                : all
                  ? tr(`كل الأزواج (${count})`, `All ${count} pairs`)
                  : tr(`${count} زوج مختار`, `${count} pairs selected`)}
            </strong>
            <em>
              {count === 0
                ? tr('زرار التوليد مش هيشتغل من غير ده', 'The generate button will not work without this')
                : tr('بتتحلل كل شمعة، وبتوصل منها إشعارات', 'Analysed every candle, and alerted on')}
            </em>
          </span>
          <span className={styles.chev} aria-hidden="true">›</span>
        </button>

        {/* ── 2. Alerts while closed ── */}
        <hr className={styles.divider} />

        {push === null ? null : push === 'unsupported' ? (
          <p className={styles.muted}>
            {tr(
              'المتصفح ده مش بيدعم الإشعارات وهو مقفول. جرّب Chrome أو ثبّت التطبيق على الشاشة الرئيسية.',
              'This browser cannot receive notifications while closed. Try Chrome, or install the app to your home screen.',
            )}
          </p>
        ) : push === 'unavailable' ? (
          <p className={styles.muted}>
            {tr('الإشعارات مش مفعّلة على السيرفر لسه.', 'Notifications are not enabled on the server yet.')}
          </p>
        ) : push === 'denied' ? (
          <p className={styles.denied}>
            {tr(
              '🔕 الإشعارات مرفوضة من إعدادات المتصفح — مفيش زرار هنا يقدر يفتحها.',
              '🔕 Notifications are blocked in your browser settings — no button here can undo that.',
            )}
          </p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void togglePush()}
              disabled={busy || (count === 0 && !on)}
              aria-pressed={on}
              className={`${styles.pushBtn} ${on ? styles.pushOn : ''}`}
            >
              <span aria-hidden="true">{on ? '🔔' : '🔕'}</span>
              {busy
                ? tr('لحظة...', 'One moment…')
                : on
                  ? tr('إشعارات والتطبيق مقفول: شغّالة', 'Alerts while closed: on')
                  : tr('نبّهني والتطبيق مقفول', 'Alert me while the app is closed')}
            </button>
            <p className={styles.hint}>
              {count === 0
                ? tr('اختار الأزواج الأول.', 'Choose your pairs first.')
                : on
                  ? tr(
                      `هيوصلك تنبيه على ${count} زوج حتى والتطبيق مقفول. اضغط الإشعار يفتحلك شارت الزوج.`,
                      `You will be alerted on ${count} pairs even with the app closed. Tap one to open that pair's chart.`,
                    )
                  : tr(
                      'من غير ما تفتح التطبيق، هنقولك على الفرص أول بأول.',
                      'Without opening the app, we will tell you about setups as they happen.',
                    )}
            </p>
          </>
        )}

        <footer className={styles.foot}>
          <button type="button" onClick={onClose} className={styles.done}>
            {tr('تم', 'Done')}
          </button>
        </footer>
      </div>
    </div>
  );
}
