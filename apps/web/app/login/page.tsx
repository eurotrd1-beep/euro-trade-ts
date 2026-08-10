'use client';

/**
 * Login — ported from lib/screens/login_screen.dart.
 *
 * The user picks the broker they registered with, types their account id, and
 * (when the broker has one) confirms the promo code. The staged progress bar
 * runs while the lookup resolves in the background.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase, tr, type BrokerRow } from '@euro/shared';
import {
  verifyAccount,
  persistSession,
  verificationSteps,
  STEP_INTERVAL_MS,
  LOOKUP_TIMEOUT_MS,
  type LoginResult,
} from '@/lib/auth';
import { TradingBackground } from '@/components/TradingBackground';
import styles from './login.module.css';

export default function LoginPage() {
  const router = useRouter();

  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [selected, setSelected] = useState<BrokerRow | null>(null);
  const [accountId, setAccountId] = useState('');
  const [promo, setPromo] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [stepText, setStepText] = useState('');
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await supabase()
          .from('brokers')
          .select('*')
          .eq('is_active', true)
          .order('order', { ascending: true });
        if (cancelled) return;
        const list = (data as BrokerRow[] | null) ?? [];
        setBrokers(list);
        // Pre-select the broker the user clicked through from, if any.
        const last = localStorage.getItem('last_clicked_broker');
        setSelected(list.find((b) => b.name === last) ?? list[0] ?? null);
      } catch {
        if (!cancelled) setBrokers([]);
      }
    })();
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  async function submit(e: React.FormEvent): Promise<void> {
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
    // Promo confirmation is only required when the broker defines one.
    if (selected.promo_code && promo.trim().toLowerCase() !== selected.promo_code.trim().toLowerCase()) {
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

    // The lookup runs NOW, in parallel with the staged messages — exactly as
    // Dart kicks off its future before starting the timer.
    const lookup = Promise.race<LoginResult>([
      verifyAccount({ accountId: id, broker: selected.name, brokerKey: selected.click_key }),
      new Promise<LoginResult>((resolve) =>
        setTimeout(() => resolve({ ok: true, role: 'standard', vipExpiry: null }), LOOKUP_TIMEOUT_MS),
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
      <TradingBackground />

      <div className={styles.scroll}>
        <section className={styles.card}>
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
                    className={`${styles.brokerChip} ${selected?.id === b.id ? styles.chipActive : ''}`}
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
        </section>
      </div>
    </main>
  );
}
