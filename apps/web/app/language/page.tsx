'use client';

/**
 * Language selection — ported from lib/screens/language_screen.dart.
 *
 * The heading is deliberately bilingual and NOT run through tr(): on first
 * launch no language has been chosen yet, so it has to read correctly either
 * way. That is why 'اختر لغتك' / 'Choose your language' are literals here.
 */

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { type AppLanguage } from '@euro/shared';
import { TradingBackground } from '@/components/TradingBackground';
import { useLanguage } from '@/components/AppProviders';
import styles from './language.module.css';

function LanguageChooser() {
  const router = useRouter();
  const params = useSearchParams();
  const { language, setLanguage } = useLanguage();

  // `next` decides where to continue after a choice. Anything unexpected falls
  // back to the notice screen, which is the safe (logged-out) destination.
  const next = params.get('next') === 'main' ? '/app' : '/notice';

  function choose(lang: AppLanguage): void {
    setLanguage(lang);
    router.replace(next);
  }

  return (
    <main className={styles.screen}>
      <TradingBackground />

      <div className={styles.card}>
        <div className={styles.iconRing} aria-hidden="true">
          🌐
        </div>

        <h1 className={styles.title}>اختر لغتك</h1>
        <p className={styles.subtitle}>Choose your language</p>

        <div className={styles.options}>
          <LanguageTile
            flag="🇸🇦"
            title="العربية"
            subtitle="Arabic"
            selected={language === 'arabic'}
            onSelect={() => choose('arabic')}
          />
          <LanguageTile
            flag="🇬🇧"
            title="English"
            subtitle="الإنجليزية"
            selected={language === 'english'}
            onSelect={() => choose('english')}
          />
        </div>
      </div>
    </main>
  );
}

function LanguageTile({
  flag,
  title,
  subtitle,
  selected,
  onSelect,
}: {
  flag: string;
  title: string;
  subtitle: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`${styles.tile} ${selected ? styles.tileSelected : ''}`}
      aria-pressed={selected}
    >
      <span className={styles.flag} aria-hidden="true">
        {flag}
      </span>
      <span className={styles.tileText}>
        <span className={styles.tileTitle}>{title}</span>
        <span className={styles.tileSubtitle}>{subtitle}</span>
      </span>
      <span className={styles.chevron} aria-hidden="true">
        {selected ? '✓' : '›'}
      </span>
    </button>
  );
}

export default function LanguagePage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={<main className={styles.screen} />}>
      <LanguageChooser />
    </Suspense>
  );
}
