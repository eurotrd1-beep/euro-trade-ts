'use client';

/**
 * Splash screen — ported from lib/screens/splash_screen.dart.
 *
 * Same sequence: a 1.5s fade+scale reveal of the logo, a 3.2s minimum dwell
 * while the maintenance and ban checks run in parallel, then a fade to the
 * resolved destination.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { tr } from '@euro/shared';
import { resolveBootDestination, SPLASH_DELAY_MS, type BootDestination } from '@/lib/boot';
import { TradingBackground } from '@/components/TradingBackground';
import { BanDialog } from '@/components/BanDialog';
import { useLanguage } from '@/components/AppProviders';
import styles from './splash.module.css';

export default function SplashPage() {
  const router = useRouter();
  const { ready } = useLanguage();
  const [banReason, setBanReason] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // Wait for the stored language to load, otherwise the first-launch check
    // would always report "not chosen" and show the language screen twice.
    if (!ready || started.current) return;
    started.current = true;

    let cancelled = false;

    void (async () => {
      // Run the dwell and the network checks concurrently, as Dart does with
      // Future.wait — the splash is never shorter than the animation.
      const [, destination] = await Promise.all([
        new Promise((r) => setTimeout(r, SPLASH_DELAY_MS)),
        resolveBootDestination(),
      ]);
      if (cancelled) return;
      route(destination);
    })();

    function route(destination: BootDestination): void {
      switch (destination.kind) {
        case 'maintenance':
          router.replace('/maintenance');
          break;
        case 'banned':
          // Stays on the splash behind a blocking dialog, as in Dart.
          setBanReason(destination.reason);
          break;
        case 'language':
          router.replace(`/language?next=${destination.next}`);
          break;
        case 'main':
          router.replace('/app');
          break;
        case 'notice':
          router.replace('/notice');
          break;
      }
    }

    return () => {
      cancelled = true;
    };
  }, [ready, router]);

  return (
    <main className={styles.splash}>
      <TradingBackground />

      <div className={styles.center}>
        <div className={styles.logoWrap}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/logo.jpg`} alt="Euro Trade" className={styles.logo} />
          <div className={styles.glow} aria-hidden="true" />
        </div>

        <h1 className={styles.title}>EURO TRADE</h1>
        <p className={styles.subtitle}>
          {tr('إشارات تداول احترافية', 'Premium Trading Signals')}
        </p>

        <div className={styles.loader} role="status">
          <span className="sr-only">{tr('جارٍ التحميل', 'Loading')}</span>
        </div>
      </div>

      {banReason !== null && <BanDialog reason={banReason} />}
    </main>
  );
}
