'use client';

/**
 * ⚙️ Settings — the pairs this account follows, and whether it is told about
 * them while the app is closed.
 *
 * ── WHAT IT REPLACES ───────────────────────────────────────────────────────
 *
 * A notifications button that owned its own private list of pairs, beside a
 * watch loop that swept every pair in the catalogue regardless. Two answers to
 * "which pairs am I following", and a mismatch between them that no screen
 * showed: an alert about a market nobody chose, or silence about the one they
 * did. The list lives in `watchedPairs.ts` now and both read it.
 *
 * ── WHY NOTIFICATIONS ARE A SEPARATE SWITCH INSIDE IT ──────────────────────
 *
 * Because they are a separate question with a different answer. The pairs are
 * what the app watches; notifications are whether it may interrupt you about
 * them. Somebody who keeps the app open all day wants the first and not the
 * second, and folding them into one control would make choosing pairs an
 * implicit request for permission to buzz — which is also the surest way to get
 * that permission refused for good, since a browser that has been asked and
 * refused can only be undone in settings.
 */

import { useCallback, useEffect, useState } from 'react';
import { tr, type PairRow } from '@euro/shared';
import {
  disablePush,
  enablePush,
  pushState,
  refreshPush,
  type PushState,
} from '@/lib/webPush';
import { legacyWantedEverything, loadWatched, saveWatched } from '@/lib/watchedPairs';
import { PushPairPicker } from './PushPairPicker';
import styles from './WatchSettings.module.css';

export interface WatchSettingsProps {
  accountId: string | null;
  plan: 'free' | 'paid';
  pairs: PairRow[];
  /** Told on every change, including the first load, so the watch never lags it. */
  onChange: (symbols: string[]) => void;
}

export function WatchSettings({ accountId, plan, pairs, onChange }: WatchSettingsProps) {
  const [watched, setWatched] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
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

  // Keeps the stored subscription pointing at the current list. Silent: a
  // failure here must never interrupt anything, and the next change retries.
  useEffect(() => {
    if (push === 'on' && watched.length > 0) void refreshPush(accountId, plan, watched);
  }, [push, watched, accountId, plan]);

  const save = useCallback(
    (symbols: string[]) => {
      setOpen(false);
      setWatched(symbols);
      saveWatched(accountId, symbols);
      onChange(symbols);
    },
    [accountId, onChange],
  );

  const togglePush = useCallback(async () => {
    setBusy(true);
    try {
      if (push === 'on') {
        setPush(await disablePush());
      } else {
        setPush(await enablePush(accountId, plan, watched));
      }
    } finally {
      setBusy(false);
    }
  }, [push, accountId, plan, watched]);

  const count = watched.length;
  const all = count > 0 && count === pairs.length;

  return (
    <>
      {open && (
        <PushPairPicker
          pairs={pairs}
          initial={watched}
          onCancel={() => setOpen(false)}
          onConfirm={save}
        />
      )}

      <div className={styles.row}>
        <button type="button" onClick={() => setOpen(true)} className={styles.settingsBtn}>
          <span aria-hidden="true">⚙️</span>
          <span className={styles.label}>
            {count === 0
              ? tr('اختار الأزواج اللي تتابعها', 'Choose the pairs to follow')
              : all
                ? tr(`كل الأزواج (${count})`, `All ${count} pairs`)
                : tr(`${count} زوج مختار`, `${count} pairs selected`)}
          </span>
          <span className={styles.chev} aria-hidden="true">›</span>
        </button>

        {/* Only once there is something to be notified about. Offering the
            switch first would be asking permission to buzz about nothing. */}
        {count > 0 && push !== null && push !== 'unsupported' && push !== 'unavailable' && (
          push === 'denied' ? (
            <p className={styles.denied}>
              {tr(
                '🔕 الإشعارات مرفوضة من إعدادات المتصفح — مفيش زرار هنا يقدر يفتحها.',
                '🔕 Notifications are blocked in your browser settings — no button here can undo that.',
              )}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => void togglePush()}
              disabled={busy}
              aria-pressed={push === 'on'}
              className={`${styles.pushBtn} ${push === 'on' ? styles.pushOn : ''}`}
            >
              <span aria-hidden="true">{push === 'on' ? '🔔' : '🔕'}</span>
              {busy
                ? tr('لحظة...', 'One moment…')
                : push === 'on'
                  ? tr('إشعارات والتطبيق مقفول: شغّالة', 'Alerts while closed: on')
                  : tr('فعّل الإشعارات والتطبيق مقفول', 'Alert me while the app is closed')}
            </button>
          )
        )}
      </div>
    </>
  );
}
