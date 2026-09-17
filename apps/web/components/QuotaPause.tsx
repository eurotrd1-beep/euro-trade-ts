'use client';

/**
 * Covers the signals column while D1's daily quota is spent.
 *
 * It shows for that one condition and nothing else — `lib/quota.ts` is only
 * ever set by a response or a socket message the hub produces after matching
 * Cloudflare's documented quota text. A proxy outage, a slow price feed and a
 * reconnecting socket all have their own indicators and never reach this.
 *
 * Two lines, no numbers, no spinner, no technical detail — by request. It
 * leaves on its own when the hub says D1 answers again, or when the app's own
 * check after 00:00 UTC succeeds; no reload.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 *
 * It does not stop the signal engine. The engine runs in the browser from
 * candles the proxy serves, so it keeps working through a D1 lockout, and
 * pausing it would be a change to signal logic. This only covers the column
 * and takes it out of the tab order (`inert`), so the controls under the cover
 * cannot be reached by keyboard either.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { tr } from '@euro/shared';
import { isQuotaActive, onQuotaChange } from '@/lib/quota';
import styles from './QuotaPause.module.css';

/** Whether the pause is up. Starts from the current state, then follows it. */
export function useQuotaPause(): boolean {
  const [active, setActive] = useState(isQuotaActive);
  useEffect(() => {
    setActive(isQuotaActive());
    return onQuotaChange(setActive);
  }, []);
  return active;
}

/**
 * Wraps the column. The wrapper is the positioning context for the cover, and
 * the content goes `inert` while it is up.
 */
export function QuotaPause({ className, children }: { className?: string; children: ReactNode }) {
  const active = useQuotaPause();

  return (
    <aside className={className} style={{ position: 'relative' }}>
      <div inert={active} style={{ display: 'contents' }}>
        {children}
      </div>

      <div
        className={styles.overlay}
        data-open={active}
        role="status"
        aria-live="polite"
        aria-hidden={!active}
      >
        <div className={styles.card}>
          <h2 className={styles.title}>{tr('نستأنف قريباً', 'Resuming soon')}</h2>
          <p className={styles.line}>{tr('الإشارات متوقفة مؤقتاً', 'Signals are paused for now')}</p>
        </div>
      </div>
    </aside>
  );
}
