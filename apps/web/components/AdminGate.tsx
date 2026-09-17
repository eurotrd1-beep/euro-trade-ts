'use client';

/**
 * The gate in front of every /admin route.
 *
 * One choke point on purpose: when real authentication replaces this, only
 * this file changes rather than each of the nine admin screens.
 *
 * ── HOW SIGN-IN IS CHECKED ─────────────────────────────────────────────────
 *
 * By making a real admin request, not by asking whether the secret is right.
 *
 * The data hub deliberately has no verify endpoint. One would be an oracle: an
 * unauthenticated caller could test a guess, get a clean yes or no, and do it
 * as fast as the network allows. Instead the secret is stored, a request only
 * an admin may make is attempted, and it is kept only if that request is not
 * refused — so a guess costs the same as a guess at any other admin call, and
 * is counted and rate-limited by the hub the same way.
 *
 * The request is a one-row read of `repair_log`, which is admin-only and
 * useless to anyone: one row read against a daily budget of five million, and
 * nothing in it worth returning to an attacker who has already succeeded.
 */

import { useEffect, useState } from 'react';
import { isAdminSignedIn, signInAdmin, signOutAdmin } from '@/lib/adminAuth';
import { hubAcceptsAdmin } from '@/lib/dataHub';
import styles from './AdminGate.module.css';

/**
 * Turns the hub's answer into something to show the admin.
 *
 * The distinction that matters is between a refused credential and an
 * unreachable Worker. Reporting the second as "wrong password" sends the admin
 * looking for a credential that was never the problem — and, because a wrong
 * secret is deliberately kept out of storage, they would be locked out of a
 * panel whose password is fine.
 */
function reasonFor(status: number, detail: string): string {
  // 401 is the hub saying the secret is wrong; 403 is it saying this caller may
  // not read the table, which on an admin-only table means the same thing.
  if (status === 401 || status === 403) return 'كلمة السر غير صحيحة';
  if (status === 429) return 'محاولات كتيرة. استنى شوية وجرّب تاني.';
  if (status === 0 && detail === 'no hub configured') {
    return 'الخادم مش متظبط — مفيش عنوان للـhub في الإعدادات.';
  }
  return `تعذّر الوصول للخادم${detail ? ` (${detail})` : ''}`;
}

export function AdminGate({ children }: { children: React.ReactNode }) {
  // `null` = still checking, so the form never flashes for a signed-in admin.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSignedIn(isAdminSignedIn());
  }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (secret.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Stored first, because the check is a request that has to carry it.
      signInAdmin(secret);
      const verdict = await hubAcceptsAdmin();
      if (verdict.ok) {
        setSecret('');
        setSignedIn(true);
        return;
      }
      // Not accepted — so it is not kept. A rejected secret left in storage
      // would send a bad credential on every subsequent request and get this
      // browser rate-limited for a password it is not even using.
      signOutAdmin();
      setError(reasonFor(verdict.status, verdict.detail));
    } finally {
      setBusy(false);
    }
  }

  if (signedIn === null) return <div className={styles.blank} />;
  if (signedIn) return <>{children}</>;

  return (
    <main className={styles.screen} dir="rtl">
      <form onSubmit={(e) => void submit(e)} className={styles.card}>
        <p className={styles.brand}>EURO ADMIN</p>
        <h1 className={styles.title}>لوحة التحكم</h1>
        <p className={styles.subtitle}>الدخول مقصور على الإدارة</p>

        <label className={styles.field}>
          <span className={styles.label}>كلمة السر</span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className={styles.input}
            autoComplete="current-password"
            dir="ltr"
            autoFocus
          />
        </label>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy || secret.length === 0} className={styles.submit}>
          {busy ? 'جاري التحقق...' : 'دخول'}
        </button>

        <p className={styles.note}>
          تفضل مسجّلاً لمدة 30 يوماً على هذا الجهاز. كلمة السر محفوظة في المتصفح ده بس.
        </p>
      </form>
    </main>
  );
}
