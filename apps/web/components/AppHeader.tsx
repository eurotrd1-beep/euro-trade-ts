'use client';

/**
 * Header — ported from `_buildHeader`, `_buildUserInfoSection` and
 * `_buildVipBannerSection` in main_screen.dart.
 *
 * Shows who is signed in, the VIP state, and a live countdown to VIP expiry.
 */

import { useEffect, useState } from 'react';
import { tr, KEY_USER_VERIFIED, KEY_USER_ACCOUNT_ID, KEY_USER_BROKER } from '@euro/shared';
import { hardNavigate } from '@/lib/nav';
import styles from './AppHeader.module.css';

export interface AppHeaderProps {
  accountId: string;
  broker: string;
  isVip: boolean;
  vipExpiry: Date | null;
  telegram: string;
}

interface Remaining {
  days: number;
  hours: number;
  minutes: number;
}

function remainingUntil(expiry: Date): Remaining | null {
  const ms = expiry.getTime() - Date.now();
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60000);
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
  };
}

export function AppHeader({ accountId, broker, isVip, vipExpiry, telegram }: AppHeaderProps) {
  const [remaining, setRemaining] = useState<Remaining | null>(null);

  useEffect(() => {
    if (!isVip || !vipExpiry) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(remainingUntil(vipExpiry));
    tick();
    // Minute resolution is enough for a days/hours/minutes readout.
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [isVip, vipExpiry]);

  function signOut(): void {
    try {
      localStorage.removeItem(KEY_USER_VERIFIED);
      localStorage.removeItem(KEY_USER_ACCOUNT_ID);
      localStorage.removeItem(KEY_USER_BROKER);
    } catch {
      // The redirect still drops the session for this tab.
    }
    hardNavigate('/');
  }

  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <span className={styles.brand}>EURO TRADE</span>
        <span className={styles.account} dir="ltr">
          {broker ? `${broker} · ` : ''}
          {accountId}
        </span>
      </div>

      <div className={styles.right}>
        {isVip ? (
          <span className={styles.vipBadge}>
            <span aria-hidden="true">👑</span> VIP
            {remaining && (
              <span className={styles.vipRemaining}>
                {tr(
                  `${remaining.days}ي ${remaining.hours}س`,
                  `${remaining.days}d ${remaining.hours}h`,
                )}
              </span>
            )}
          </span>
        ) : (
          <span className={styles.standardBadge}>{tr('عادي', 'Standard')}</span>
        )}

        {telegram && (
          <a
            href={telegram}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.iconBtn}
            title={tr('قناة تيليجرام', 'Telegram channel')}
          >
            <span aria-hidden="true">✈️</span>
            <span className="sr-only">{tr('قناة تيليجرام', 'Telegram channel')}</span>
          </a>
        )}

        <button type="button" onClick={signOut} className={styles.iconBtn}>
          <span aria-hidden="true">⏻</span>
          <span className="sr-only">{tr('تسجيل الخروج', 'Sign out')}</span>
        </button>
      </div>
    </header>
  );
}
