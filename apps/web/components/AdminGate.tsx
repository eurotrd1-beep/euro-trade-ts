'use client';

/**
 * The gate in front of every /admin route.
 *
 * One choke point on purpose: when real authentication replaces this, only
 * this file changes rather than each of the nine admin screens.
 */

import { useEffect, useState } from 'react';
import { checkCredentials, isAdminSignedIn, signInAdmin } from '@/lib/adminAuth';
import styles from './AdminGate.module.css';

export function AdminGate({ children }: { children: React.ReactNode }) {
  // `null` = still checking, so the form never flashes for a signed-in admin.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSignedIn(isAdminSignedIn());
  }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (await checkCredentials(username, password)) {
        signInAdmin();
        setSignedIn(true);
        return;
      }
      setError('بيانات الدخول غير صحيحة');
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
          <span className={styles.label}>اسم المستخدم</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={styles.input}
            autoComplete="username"
            dir="ltr"
            autoFocus
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>كلمة المرور</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={styles.input}
            autoComplete="current-password"
            dir="ltr"
          />
        </label>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} className={styles.submit}>
          {busy ? 'جاري التحقق...' : 'دخول'}
        </button>

        <p className={styles.note}>تفضل مسجّلاً لمدة 30 يوماً على هذا الجهاز.</p>
      </form>
    </main>
  );
}
