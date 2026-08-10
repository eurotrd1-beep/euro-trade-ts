'use client';

/**
 * Account type strip — compact by design: one row, no wasted height, so the
 * chart and the signal panel keep the space.
 *
 * Silver for standard, gold for VIP, both with a glow. A standard account gets
 * a subscribe button; a VIP one gets its remaining time in the same slot.
 */

import { useEffect, useState } from 'react';
import { tr } from '@euro/shared';
import styles from './AccountCard.module.css';

/** The channel VIP subscriptions go through. */
const TELEGRAM_VIP_URL = 'https://t.me/euro_trd';

export interface AccountCardProps {
  accountId: string;
  broker: string;
  isVip: boolean;
  vipExpiry: Date | null;
}

/** Compact remaining time: days if any, otherwise hours and minutes. */
function shortRemaining(expiry: Date): string | null {
  const ms = expiry.getTime() - Date.now();
  if (ms <= 0) return null;

  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return tr(`${days}ي ${hours}س`, `${days}d ${hours}h`);
  return tr(`${hours}س ${minutes}د`, `${hours}h ${minutes}m`);
}

export function AccountCard({ accountId, broker, isVip, vipExpiry }: AccountCardProps) {
  const [remaining, setRemaining] = useState<string | null>(null);

  useEffect(() => {
    if (!isVip || !vipExpiry) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(shortRemaining(vipExpiry));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [isVip, vipExpiry]);

  return (
    <section className={`${styles.strip} ${isVip ? styles.gold : styles.silver}`}>
      <div className={styles.sheen} aria-hidden="true" />

      <span className={styles.plan}>
        <span aria-hidden="true">{isVip ? '👑' : '🛡️'}</span>
        {isVip ? 'VIP' : tr('عادي', 'STANDARD')}
      </span>

      <span className={styles.account} dir="ltr" title={broker || undefined}>
        {accountId}
      </span>

      {isVip ? (
        remaining && (
          <span className={styles.remaining} dir="auto">
            {remaining}
          </span>
        )
      ) : (
        <a
          href={TELEGRAM_VIP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.subscribe}
        >
          {tr('اشترك في VIP', 'Get VIP')}
        </a>
      )}
    </section>
  );
}
