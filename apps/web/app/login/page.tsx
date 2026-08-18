'use client';

/**
 * Login — the first screen a paying user sees, so it carries the brand as well
 * as the form.
 *
 * Two panels on desktop: the brand side (logo, live prices, VIP offer, channel
 * links) and the form side. On mobile the form comes first — someone opening
 * the app to trade should not have to scroll past marketing to sign in.
 *
 * Verification logic is unchanged; it still runs `verifyAccount` with the same
 * staged progress the Dart screen showed.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CATALOGUE_SYMBOLS, supabase, tr, type BrokerRow } from '@euro/shared';
import {
  verifyAccount,
  persistSession,
  verificationSteps,
  STEP_INTERVAL_MS,
  LOOKUP_TIMEOUT_MS,
  type LoginResult,
} from '@/lib/auth';
import { LiveTicker } from '@/components/LiveTicker';
import { TelegramIcon, YouTubeIcon } from '@/components/BrandIcons';
import {
  BASE_STATS,
  communityStats,
  compactMembers,
  compactUsd,
  type CommunityStats,
} from '@/lib/communityStats';
import styles from './login.module.css';

/** The chat VIP subscriptions go through. */
const TELEGRAM_VIP_URL = 'https://t.me/euro_trd';

interface Social {
  telegram: string;
  youtube: string;
}

export default function LoginPage() {
  const router = useRouter();

  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [selected, setSelected] = useState<BrokerRow | null>(null);
  const [accountId, setAccountId] = useState('');
  const [promo, setPromo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [social, setSocial] = useState<Social>({ telegram: '', youtube: '' });
  // Prerendered HTML must not depend on "today", or hydration mismatches.
  const [stats, setStats] = useState<CommunityStats>(BASE_STATS);

  useEffect(() => setStats(communityStats()), []);

  const [verifying, setVerifying] = useState(false);
  const [stepText, setStepText] = useState('');
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [b, s] = await Promise.all([
          supabase().from('brokers').select('*').eq('is_active', true).order('order'),
          supabase().from('configs').select('data').eq('id', 'social').maybeSingle(),
        ]);
        if (cancelled) return;

        const list = (b.data as BrokerRow[] | null) ?? [];
        setBrokers(list);
        const last = localStorage.getItem('last_clicked_broker');
        setSelected(list.find((x) => x.name === last) ?? list[0] ?? null);

        const cfg = (s.data?.['data'] ?? {}) as Record<string, string>;
        setSocial({ telegram: cfg['telegram'] ?? '', youtube: cfg['youtube'] ?? '' });
      } catch {
        if (!cancelled) setBrokers([]);
      }
    })();

    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    setError(null);

    const id = accountId.trim();
    if (!id) {
      setError(tr('من فضلك أدخل معرف الحساب', 'Please enter your Account ID'));
      return;
    }
    if (!selected) {
      setError(tr('من فضلك اختر المنصة', 'Please choose a platform'));
      return;
    }
    if (
      selected.promo_code &&
      promo.trim().toLowerCase() !== selected.promo_code.trim().toLowerCase()
    ) {
      setError(
        tr(
          'البروموكود غير صحيح. انسخه من شاشة التسجيل وأعد المحاولة.',
          'Incorrect promo code. Copy it from the registration screen and try again.',
        ),
      );
      return;
    }

    setVerifying(true);
    setProgress(0);

    // The lookup starts now and runs alongside the staged messages.
    const lookup = Promise.race<LoginResult>([
      verifyAccount({ accountId: id, broker: selected.name, brokerKey: selected.click_key }),
      new Promise<LoginResult>((resolve) =>
        setTimeout(
          () => resolve({ ok: true, role: 'standard', vipExpiry: null }),
          LOOKUP_TIMEOUT_MS,
        ),
      ),
    ]);

    const steps = verificationSteps(selected.name);
    let i = 0;

    timerRef.current = setInterval(() => {
      if (i < steps.length) {
        const step = steps[i]!;
        setStepText(step.text);
        setProgress(step.progress);
        i++;
        return;
      }

      if (timerRef.current) clearInterval(timerRef.current);
      void lookup.then((result) => {
        if (!result.ok) {
          setVerifying(false);
          setProgress(0);
          setStepText('');
          setError(result.error);
          return;
        }
        persistSession(id, selected.name);
        router.replace('/app');
      });
    }, STEP_INTERVAL_MS);
  }

  return (
    <main className={styles.screen}>
      <LiveTicker />

      <div className={styles.split}>
        {/* ── Form ─────────────────────────────────────────────────────── */}
        <section className={styles.formPanel}>
          <div className={styles.formInner}>
            <div className={styles.mark}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/logo.jpg`}
                alt="EURO TRADE"
                className={styles.logo}
              />
              <div>
                <p className={styles.brand}>EURO TRADE</p>
                <p className={styles.brandSub}>
                  {tr('غرفة إشارات VIP', 'VIP Signals Room')}
                </p>
              </div>
            </div>

            <h1 className={styles.title}>{tr('تسجيل الدخول', 'Sign in')}</h1>
            <p className={styles.subtitle}>
              {tr(
                'أدخل معرف الحساب الذي سجّلت به لدى المنصة',
                'Enter the Account ID you registered with on the platform',
              )}
            </p>

            <form onSubmit={submit} className={styles.form}>
              <fieldset className={styles.field} disabled={verifying}>
                <legend className={styles.label}>{tr('المنصة', 'Platform')}</legend>
                <div className={styles.brokerRow}>
                  {brokers.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => setSelected(b)}
                      className={`${styles.chip} ${selected?.id === b.id ? styles.chipActive : ''}`}
                      aria-pressed={selected?.id === b.id}
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className={styles.field}>
                <span className={styles.label}>{tr('معرف الحساب', 'Account ID')}</span>
                <input
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className={styles.input}
                  inputMode="numeric"
                  autoComplete="off"
                  dir="ltr"
                  disabled={verifying}
                  placeholder={tr('مثال: 12345678', 'e.g. 12345678')}
                />
              </label>

              {selected?.promo_code && (
                <label className={styles.field}>
                  <span className={styles.label}>{tr('البروموكود', 'Promo code')}</span>
                  <input
                    value={promo}
                    onChange={(e) => setPromo(e.target.value)}
                    className={styles.input}
                    autoComplete="off"
                    dir="ltr"
                    disabled={verifying}
                  />
                </label>
              )}

              {error && (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              )}

              {verifying ? (
                <div className={styles.progressWrap} role="status" aria-live="polite">
                  <div className={styles.progressTrack}>
                    <div className={styles.progressBar} style={{ width: `${progress * 100}%` }} />
                  </div>
                  <p className={styles.stepText}>{stepText}</p>
                </div>
              ) : (
                <button type="submit" className={styles.submit}>
                  {tr('تفعيل العضوية', 'Activate membership')}
                </button>
              )}
            </form>

            <Link href="/notice" className={styles.backLink}>
              {tr('لم تسجّل بعد؟ اعرض المنصات ⟵', 'Not registered yet? See the platforms ⟵')}
            </Link>
          </div>
        </section>

        {/* ── Brand ────────────────────────────────────────────────────── */}
        <aside className={styles.brandPanel}>
          <div className={styles.glow} aria-hidden="true" />

          <div className={styles.brandInner}>
            <h2 className={styles.headline}>
              {tr('إشارات مبنية على تحليل حقيقي', 'Signals built on real analysis')}
            </h2>
            <p className={styles.tagline}>
              {/*
                It used to say 350+ indicators. The engine registers eight, and
                the strategy the app runs reads exactly one thing: whether price
                came back to the 0.236 retracement of the last confirmed swing.
                A headline that says "real analysis" cannot sit above a number
                that is off by a factor of forty, so this says what it does.
              */}
              {tr(
                'المحرك يرسم فيبوناتشي من آخر قمة وقاع مؤكدين، ويصدر الإشارة لما السعر يرجع يلمس مستوى 0.236 — ولو ملمسش، ميقولش حاجة.',
                'The engine draws Fibonacci between the last confirmed high and low, and fires when price returns to touch the 0.236 level — and says nothing when it does not.',
              )}
            </p>

            <div className={styles.stats}>
              <Stat value={compactMembers(stats.members)} label={tr('مشترك معانا', 'Members')} />
              <Stat value={compactUsd(stats.profitUsd)} label={tr('إجمالي الأرباح', 'Total profits')} />
              <Stat value="0.236" label={tr('مستوى الارتداد', 'Retracement')} />
              <Stat
                value={String(CATALOGUE_SYMBOLS)}
                label={tr('زوج تداول', 'Instruments')}
              />
              <Stat value="24/7" label={tr('أسواق OTC', 'OTC markets')} />
            </div>

            <p className={styles.urgency}>
              <span aria-hidden="true">🔥</span>
              {tr('الحق مكانك — الأرقام بتزيد كل يوم', 'Claim your spot — the numbers grow daily')}
            </p>

            {/* VIP offer → the owner's chat */}
            <a
              href={TELEGRAM_VIP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.vipCard}
            >
              <span className={styles.vipCrown} aria-hidden="true">
                👑
              </span>
              <span className={styles.vipText}>
                <span className={styles.vipTitle}>{tr('اشترك في VIP', 'Get VIP access')}</span>
                <span className={styles.vipSub}>
                  {tr(
                    'استراتيجية أقوى وإشارات أدق — تواصل معنا مباشرة',
                    'A stronger strategy and sharper signals — talk to us directly',
                  )}
                </span>
              </span>
              <span className={styles.vipArrow} aria-hidden="true">
                ←
              </span>
            </a>

            {/* Channel cards — each hidden until its link is set in the admin. */}
            <div className={styles.channels}>
              {social.telegram && (
                <ChannelCard
                  href={social.telegram}
                  icon={<TelegramIcon size={18} />}
                  title={tr('قناة تيليجرام', 'Telegram channel')}
                  sub={tr('إشارات وتحديثات', 'Signals and updates')}
                  tone="telegram"
                />
              )}
              {social.youtube && (
                <ChannelCard
                  href={social.youtube}
                  icon={<YouTubeIcon size={18} />}
                  title={tr('قناة يوتيوب', 'YouTube channel')}
                  sub={tr('شروحات وتحليلات', 'Tutorials and analysis')}
                  tone="youtube"
                />
              )}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function ChannelCard({
  href,
  icon,
  title,
  sub,
  tone,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
  tone: 'telegram' | 'youtube';
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${styles.channel} ${tone === 'youtube' ? styles.youtube : styles.telegram}`}
    >
      <span className={styles.channelIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.channelText}>
        <span className={styles.channelTitle}>{title}</span>
        <span className={styles.channelSub}>{sub}</span>
      </span>
    </a>
  );
}
