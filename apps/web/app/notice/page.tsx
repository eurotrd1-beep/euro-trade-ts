'use client';

/**
 * Notice / broker registration — ported from lib/screens/notice_screen.dart.
 *
 * The gate every unverified user lands on: signals only work for accounts
 * registered through these partner links, so the screen streams the active
 * broker list from Supabase and records which one the user clicked.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, tr, type BrokerRow } from '@euro/shared';
import { TradingBackground } from '@/components/TradingBackground';
import styles from './notice.module.css';

export default function NoticePage() {
  const [brokers, setBrokers] = useState<BrokerRow[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const { data } = await supabase()
          .from('brokers')
          .select('*')
          .eq('is_active', true)
          .order('order', { ascending: true });
        if (!cancelled) setBrokers((data as BrokerRow[] | null) ?? []);
      } catch {
        if (!cancelled) setBrokers([]);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Records the click locally before opening the partner link. The account the
   * user is about to create has to be attributable to this broker at login.
   */
  function openBrokerSignUp(name: string, link: string, clickKey: string): void {
    try {
      localStorage.setItem('last_clicked_broker', name);
      localStorage.setItem('last_clicked_broker_key', clickKey);
    } catch {
      // Non-fatal — the user can still pick their broker on the login screen.
    }
    window.open(link, '_blank', 'noopener,noreferrer');
  }

  async function copyPromo(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied(null), 2200);
    } catch {
      // Clipboard blocked — the code is on screen and selectable anyway.
    }
  }

  return (
    <main className={styles.screen}>
      <TradingBackground />
      <div className={styles.ambientGlow} aria-hidden="true" />

      <div className={styles.scroll}>
        <section className={styles.card}>
          <h1 className={styles.title}>
            {tr('تنويه هام وتفعيل العضوية', 'Important Notice & Membership Activation')}
          </h1>

          <p className={styles.intro}>
            {tr(
              'للحصول على إشارات التحليل الفني والذكاء الاصطناعي المجانية، يجب تسجيل حساب جديد من خلال روابط الشراكة أدناه لتوثيق عضويتك بالفيب (VIP Room).',
              'To receive free technical-analysis and AI signals, you must register a new account through the partner links below to verify your VIP Room membership.',
            )}
          </p>

          <div className={styles.warning} role="note">
            <span aria-hidden="true">⚠️</span>
            <p>
              {tr(
                '⚠️ تنبيه: الإشارات لن تعمل إلا إذا قمت بالتسجيل من خلال الروابط الموجودة هنا. أي حساب مسجل من خارج البوت لن يتم تفعيله.',
                '⚠️ Warning: Signals will only work if you register through the links here. Any account registered outside the bot will not be activated.',
              )}
            </p>
          </div>

          {brokers === null ? (
            <p className={styles.loading}>
              {tr('جاري تحميل المنصات المتاحة...', 'Loading available platforms...')}
            </p>
          ) : (
            <ul className={styles.brokers}>
              {brokers.map((b) => (
                <li key={b.id}>
                  <BrokerCard
                    broker={b}
                    copied={copied === b.promo_code}
                    onOpen={() => openBrokerSignUp(b.name, b.registration_link, b.click_key)}
                    onCopyPromo={() => void copyPromo(b.promo_code)}
                  />
                </li>
              ))}
            </ul>
          )}

          <Link href="/login" className={styles.loginLink}>
            {tr('سجلت حساباً بالفعل؟ انقلني لتسجيل الدخول ⟵', 'Already registered? Take me to login ⟵')}
          </Link>
        </section>
      </div>
    </main>
  );
}

function BrokerCard({
  broker,
  copied,
  onOpen,
  onCopyPromo,
}: {
  broker: BrokerRow;
  copied: boolean;
  onOpen: () => void;
  onCopyPromo: () => void;
}) {
  const hasPromo = broker.promo_code.length > 0;

  return (
    <article className={styles.broker}>
      <header className={styles.brokerHead}>
        <span className={styles.logo}>
          {broker.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={broker.logo_url} alt="" width={40} height={40} />
          ) : (
            <span aria-hidden="true">🏦</span>
          )}
        </span>

        <span className={styles.brokerText}>
          <span className={styles.brokerName}>{broker.name}</span>
          {broker.is_recommended && (
            <span className={styles.recommended}>
              <span aria-hidden="true">🏅</span>
              {tr('الأفضل والمُرشحة', 'Best & recommended')}
            </span>
          )}
          {broker.desc && <span className={styles.brokerDesc}>{broker.desc}</span>}
        </span>
      </header>

      {hasPromo && (
        <div className={styles.promo}>
          <p className={styles.promoHeadline}>
            <span aria-hidden="true">🎁</span>
            {broker.min_deposit > 0 && broker.bonus_percent > 0
              ? tr(
                  `أودع ${broker.min_deposit}$ حد أدنى واحصل على ${broker.bonus_percent}% بونص!`,
                  `Deposit a minimum of ${broker.min_deposit}$ and get a ${broker.bonus_percent}% bonus!`,
                )
              : tr('استخدم البروموكود للحصول على مكافأة!', 'Use the promo code to get a bonus!')}
          </p>

          <div className={styles.promoRow}>
            <span className={styles.promoLabel}>{tr('البروموكود:', 'Promo code:')}</span>
            <code className={styles.promoCode}>{broker.promo_code}</code>
            <button type="button" onClick={onCopyPromo} className={styles.copyBtn}>
              {copied ? tr('تم النسخ ✓', 'Copied ✓') : tr('نسخ', 'Copy')}
            </button>
          </div>
        </div>
      )}

      <button type="button" onClick={onOpen} className={styles.registerBtn}>
        {tr(`سجل حساب في ${broker.name} 📈`, `Register an account on ${broker.name} 📈`)}
      </button>
    </article>
  );
}
