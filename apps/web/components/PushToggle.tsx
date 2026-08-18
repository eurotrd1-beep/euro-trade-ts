'use client';

/**
 * The notifications switch.
 *
 * Two decisions and no more: whether to be told, and about which pairs. The
 * second one earns its place because the honest default is all 89 of them, and
 * 89 markets somebody does not trade is how a feature like this gets switched
 * off for good. Everything else it could have offered — which kinds of event,
 * quiet hours, per-pair sounds — is another setting that can be silently wrong
 * on the night a notification does not arrive.
 *
 * What it will not do is pretend. A browser that cannot receive pushes, a
 * server with no keys configured, a permission the user has already refused:
 * each says so in its own words, because "notifications are on" over a channel
 * that can never deliver is the worst state this can be in — the user stops
 * watching the market and nothing ever tells them to look.
 */

import { useCallback, useEffect, useState } from 'react';
import { tr, type PairRow } from '@euro/shared';
import {
  disablePush,
  enablePush,
  pushState,
  refreshPush,
  storedSymbols,
  type PushState,
} from '@/lib/webPush';
import { PushPairPicker } from './PushPairPicker';
import styles from './PushToggle.module.css';

export interface PushToggleProps {
  accountId: string | null;
  plan: 'free' | 'paid';
  pairs: PairRow[];
}

export function PushToggle({ accountId, plan, pairs }: PushToggleProps) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [symbols, setSymbols] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void pushState().then((s) => {
      if (cancelled) return;
      setState(s);
      // Already on: make sure the row still says who this is. The account may
      // have been created, or upgraded, after the subscription was stored.
      if (s === 'on') {
        const chosen = storedSymbols();
        setSymbols(chosen);
        void refreshPush(accountId, plan, chosen);
      }
    });
    return () => { cancelled = true; };
  }, [accountId, plan]);

  /**
   * Off is one press. On asks which pairs first.
   *
   * The picker comes BEFORE the permission prompt on purpose: a browser that
   * is asked and refused can only be undone in settings, so the one chance to
   * ask is spent after the user has finished deciding they want this — not
   * while a dialog they have not read yet is still open.
   */
  const toggle = useCallback(async () => {
    if (state !== 'on') {
      setSymbols(storedSymbols());
      setPicking(true);
      return;
    }
    setBusy(true);
    try {
      setState(await disablePush());
    } finally {
      setBusy(false);
    }
  }, [state]);

  const confirm = useCallback(
    async (chosen: string[] | null) => {
      setPicking(false);
      setBusy(true);
      try {
        setSymbols(chosen);
        setState(await enablePush(accountId, plan, chosen));
      } finally {
        setBusy(false);
      }
    },
    [accountId, plan],
  );

  // Nothing at all until the check finishes. A button that flashes "off" and
  // then corrects itself to "on" reads as having just switched something off.
  if (state === null) return null;

  if (state === 'unsupported') {
    return (
      <p className={`${styles.row} ${styles.muted}`}>
        {tr(
          'المتصفح ده مش بيدعم الإشعارات وهو مقفول. جرّب Chrome أو ثبّت التطبيق على الشاشة الرئيسية.',
          'This browser cannot receive notifications while closed. Try Chrome, or install the app to your home screen.',
        )}
      </p>
    );
  }

  if (state === 'unavailable') {
    return (
      <p className={`${styles.row} ${styles.muted}`}>
        {tr('الإشعارات مش مفعّلة على السيرفر لسه.', 'Notifications are not enabled on the server yet.')}
      </p>
    );
  }

  if (state === 'denied') {
    return (
      <p className={`${styles.row} ${styles.denied}`}>
        {tr(
          '🔕 الإشعارات مرفوضة من إعدادات المتصفح. افتح إعدادات الموقع واسمح بالإشعارات — مفيش زرار هنا يقدر يعمل ده.',
          '🔕 Notifications are blocked in your browser settings. Allow them for this site — no button here can do it for you.',
        )}
      </p>
    );
  }

  const on = state === 'on';
  const scope =
    symbols === null
      ? tr('كل الأزواج', 'all pairs')
      : tr(`${symbols.length} زوج`, `${symbols.length} pairs`);

  return (
    <div className={styles.row}>
      {picking && (
        <PushPairPicker
          pairs={pairs}
          initial={symbols}
          onCancel={() => setPicking(false)}
          onConfirm={(chosen) => void confirm(chosen)}
        />
      )}

      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={on}
        className={`${styles.btn} ${on ? styles.on : ''}`}
      >
        <span aria-hidden="true">{on ? '🔔' : '🔕'}</span>
        {busy
          ? tr('لحظة...', 'One moment…')
          : on
            ? tr('الإشعارات شغّالة', 'Notifications on')
            : tr('فعّل الإشعارات', 'Enable notifications')}
      </button>

      {on && (
        <button type="button" onClick={() => setPicking(true)} className={styles.editBtn}>
          {tr(`الأزواج: ${scope} — غيّرها`, `Pairs: ${scope} — change`)}
        </button>
      )}

      <p className={styles.hint}>
        {on
          ? tr(
              'هيوصلك تنبيه أول ما تتكوّن فرصة وأول ما تبدأ صفقة — حتى والتطبيق مقفول. اضغط على الإشعار يفتحلك شارت الزوج.',
              'You will be told when a setup forms and when a trade opens — even with the app closed. Tap a notification to open that pair’s chart.',
            )
          : tr(
              'من غير ما تفتح التطبيق ولا تضغط أي زرار، هنقولك على الفرص أول بأول.',
              'Without opening the app or pressing anything, we will tell you about setups as they happen.',
            )}
      </p>
    </div>
  );
}
