'use client';

/**
 * Maintenance screen — ported from lib/screens/maintenance_screen.dart.
 *
 * Reads the live `maintenance` config row so an admin ending the window
 * releases every open client without anyone reloading, and counts down to
 * `endsAt` when one is set.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, tr } from '@euro/shared';
import { TradingBackground } from '@/components/TradingBackground';
import styles from './maintenance.module.css';

interface MaintenanceData {
  isActive?: boolean;
  message?: string;
  endsAt?: string | null;
}

/** Formats the remaining time as HH:MM:SS, matching the Dart countdown. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export default function MaintenancePage() {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [endsAt, setEndsAt] = useState<Date | null>(null);
  const [remaining, setRemaining] = useState<string | null>(null);

  // Poll + subscribe so the screen releases as soon as maintenance ends.
  useEffect(() => {
    let cancelled = false;

    async function check(): Promise<void> {
      try {
        const { data } = await supabase()
          .from('configs')
          .select('data')
          .eq('id', 'maintenance')
          .maybeSingle();
        if (cancelled) return;

        const cfg = (data?.['data'] as MaintenanceData | undefined) ?? {};
        const ends = cfg.endsAt ? new Date(cfg.endsAt) : null;
        const valid = ends && !Number.isNaN(ends.getTime()) ? ends : null;
        const stillActive = (cfg.isActive ?? false) && (valid === null || valid > new Date());

        if (!stillActive) {
          router.replace('/');
          return;
        }
        setMessage(cfg.message ?? '');
        setEndsAt(valid);
      } catch {
        // Keep showing the screen; a transient failure must not let users in.
      }
    }

    void check();
    const poll = setInterval(check, 15_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [router]);

  // Local countdown ticks every second between polls.
  useEffect(() => {
    if (!endsAt) {
      setRemaining(null);
      return;
    }
    const tick = () => {
      const left = endsAt.getTime() - Date.now();
      if (left <= 0) {
        router.replace('/');
        return;
      }
      setRemaining(formatRemaining(left));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endsAt, router]);

  const body =
    message ||
    tr('التطبيق متوقف مؤقتاً للصيانة، سنعود قريباً', 'The app is temporarily down for maintenance, we will be back soon');

  return (
    <main className={styles.screen}>
      <TradingBackground />

      <div className={styles.card}>
        <div className={styles.iconRing} aria-hidden="true">
          🛠️
        </div>

        <h1 className={styles.title}>{tr('جاري الصيانة', 'Under maintenance')}</h1>
        <p className={styles.message}>{body}</p>

        {remaining && (
          <>
            <p className={styles.countdownLabel}>
              {tr('التطبيق سيعود خلال', 'The app will be back in')}
            </p>
            <p className={styles.countdown} dir="ltr">
              {remaining}
            </p>
          </>
        )}

        <p className={styles.footnote}>
          {tr(
            'سيتم تحديث الصفحة تلقائياً عند انتهاء الصيانة',
            'The page will refresh automatically when maintenance ends',
          )}
        </p>
      </div>
    </main>
  );
}
