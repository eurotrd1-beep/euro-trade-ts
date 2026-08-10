'use client';

/**
 * Account type card — the user's plan, shown prominently at the top.
 *
 * Silver for standard, gold for VIP, both with a glow. VIP also counts down to
 * expiry so the user can see their remaining time without digging.
 */

import { useEffect, useState } from 'react';
import { tr } from '@euro/shared';
import styles from './AccountCard.module.css';

export interface AccountCardProps {
  accountId: string;
  broker: string;
  isVip: boolean;
  vipExpiry: Date | null;
}

interface Remaining {
  days: number;
  hours: number;
  minutes: number;
}

function remainingUntil(expiry: Date): Remaining | null {
  const ms = expiry.getTime() - Date.now();
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
  };
}

export function AccountCard({ accountId, broker, isVip, vipExpiry }: AccountCardProps) {
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

  return (
    <section className={`${styles.card} ${isVip ? styles.gold : styles.silver}`}>
      <div className={styles.sheen} aria-hidden="true" />

      <div className={styles.top}>
        <span className={styles.plan}>
          <span className={styles.crown} aria-hidden="true">
            {isVip ? '👑' : '🛡️'}
          </span>
          {isVip ? 'VIP' : tr('عادي', 'STANDARD')}
        </span>

        {isVip && remaining && (
          <span className={styles.countdown} dir="ltr">
            {remaining.days}
            <small>{tr('ي', 'd')}</small> {remaining.hours}
            <small>{tr('س', 'h')}</small> {remaining.minutes}
            <small>{tr('د', 'm')}</small>
          </span>
        )}
      </div>

      <div className={styles.bottom}>
        <span className={styles.label}>{tr('رقم الحساب', 'Account ID')}</span>
        <span className={styles.account} dir="ltr">
          {accountId}
        </span>
      </div>

      {broker && <span className={styles.broker}>{broker}</span>}

      {!isVip && (
        <p className={styles.upsell}>
          {tr(
            'ترقية للـ VIP تفتح استراتيجية أقوى وإشارات أدق',
            'Upgrading to VIP unlocks a stronger strategy and sharper signals',
          )}
        </p>
      )}
    </section>
  );
}
