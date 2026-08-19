'use client';

/**
 * Admin shell — replaces the navigation half of admin_dashboard.dart.
 *
 * The Dart admin is a separate Flutter application (`euro_trade_admin`) that
 * duplicates the Supabase client, the palette and the models. Here it is a
 * route group inside the same app, so it shares `@euro/shared` and cannot
 * drift out of sync with the user app's understanding of the schema — which is
 * exactly how the `sma` / `macd` naming mismatch happened in the first place.
 *
 * ⚠️ Access is currently NOT authenticated. See docs/security.md: there is no
 * auth system at all, and RLS is open, so this gate is cosmetic. It is written
 * as a single choke point so that adding real auth later is a change to one
 * file rather than nine.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AdminGate } from '@/components/AdminGate';
import { signOutAdmin } from '@/lib/adminAuth';
import { hardNavigate } from '@/lib/nav';
import { countPending, watchQueue } from '@/lib/telegramQueue';
import styles from './admin.module.css';

const VIEWS: Array<{ href: string; label: string; icon: string }> = [
  { href: '/admin', label: 'المستخدمين', icon: '👥' },
  { href: '/admin/vip', label: 'التحكم في VIP', icon: '👑' },
  { href: '/admin/analytics', label: 'الإحصائيات', icon: '📊' },
  { href: '/admin/brokers', label: 'المنصات', icon: '🏦' },
  { href: '/admin/pairs', label: 'الأزواج', icon: '💱' },
  { href: '/admin/strategy', label: 'الاستراتيجيات', icon: '🧠' },
  { href: '/admin/signals', label: 'إحصائيات الإشارات', icon: '🎯' },
  { href: '/admin/control', label: 'تحكم التطبيق', icon: '⚙️' },
  { href: '/admin/telegram', label: 'نشر تيليجرام', icon: '✈️' },
  { href: '/admin/promo', label: 'الإعلان', icon: '📣' },
  { href: '/admin/updates', label: 'إشعارات التحديث', icon: '🔔' },
  { href: '/admin/theme', label: 'ثيم التطبيق', icon: '🎨' },
  { href: '/admin/health', label: 'صحة النظام', icon: '🩺' },
];

/**
 * How many Telegram messages are waiting on a decision.
 *
 * It lives in the shell rather than on the review page, because the whole
 * point of manual publishing is finding out that something arrived while you
 * were looking at a different screen. Zero in automatic mode — nothing is
 * queued — so the badge simply never appears.
 *
 * A failure here is silent on purpose: the count is a convenience, and an
 * admin shell that refuses to render because a badge could not be counted
 * would be a worse trade than a missing number.
 */
function usePendingCount(): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    countPending()
      .then(setCount)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return watchQueue(refresh);
  }, [refresh]);

  return count;
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const pending = usePendingCount();

  return (
    <AdminGate>
      <div className={styles.shell} dir="rtl">
        <nav className={styles.nav} aria-label="أقسام لوحة التحكم">
          <span className={styles.brand}>EURO ADMIN</span>

          <ul className={styles.navList}>
            {VIEWS.map((v) => {
              // `/admin` must not match every child route.
              const active = v.href === '/admin' ? pathname === '/admin' : pathname.startsWith(v.href);
              return (
                <li key={v.href}>
                  <Link
                    href={v.href}
                    className={`${styles.navLink} ${active ? styles.navActive : ''}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span aria-hidden="true">{v.icon}</span>
                    {v.label}
                    {v.href === '/admin/telegram' && pending > 0 && (
                      <span className={styles.navBadge} title="رسايل مستنية قرارك">
                        {pending}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            onClick={() => { signOutAdmin(); hardNavigate('/admin'); }}
            className={styles.signOut}
          >
            تسجيل الخروج
          </button>
        </nav>

        <main className={styles.content}>{children}</main>
      </div>
    </AdminGate>
  );
}
