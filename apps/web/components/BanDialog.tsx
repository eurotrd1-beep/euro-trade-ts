'use client';

/**
 * Ban dialog — ported from `_showBanDialog` in splash_screen.dart.
 *
 * Non-dismissible by design: the Dart version passes `barrierDismissible: false`
 * and the only action clears the local session. Colours match the Dart dialog
 * (`#111827` surface, `#EF4444` icon, `#9CA3AF` body) rather than the app
 * palette, because that is what ships today.
 */

import { tr, KEY_USER_VERIFIED, KEY_USER_ACCOUNT_ID, KEY_USER_BROKER } from '@euro/shared';
import { hardNavigate } from '@/lib/nav';
import { clearSession } from '@/lib/session';

export function BanDialog({ reason }: { reason: string }) {
  function signOut(): void {
    // Must clear BOTH stores — leaving either one would resurrect the session
    // on the next load, since loadSession() repairs from whichever survived.
    clearSession();
    hardNavigate('/');
  }

  const body = reason
    ? tr(
        `تم حظر حسابك من قِبَل الإدارة.\nالسبب: ${reason}`,
        `Your account has been banned by the administration.\nReason: ${reason}`,
      )
    : tr(
        'تم حظر حسابك من قِبَل الإدارة.\nللمزيد من المعلومات تواصل مع الدعم.',
        'Your account has been banned by the administration.\nContact support for more information.',
      );

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ban-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(0,0,0,0.72)',
        padding: 20,
      }}
    >
      <div
        style={{
          background: '#111827',
          borderRadius: 16,
          padding: 22,
          maxWidth: 420,
          width: '100%',
          border: '1px solid #1F2937',
        }}
      >
        <h2
          id="ban-title"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            margin: '0 0 12px',
            fontSize: 17,
            fontWeight: 700,
            color: '#F9FAFB',
          }}
        >
          <span aria-hidden="true" style={{ color: '#EF4444', fontSize: 20 }}>
            ⛔
          </span>
          {tr('تم حظر حسابك', 'Your account is banned')}
        </h2>

        <p style={{ margin: 0, color: '#9CA3AF', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
          {body}
        </p>

        <button
          onClick={signOut}
          style={{
            marginTop: 20,
            width: '100%',
            padding: '12px 16px',
            borderRadius: 10,
            background: '#EF4444',
            color: '#fff',
            fontWeight: 600,
          }}
        >
          {tr('تسجيل الخروج', 'Sign out')}
        </button>
      </div>
    </div>
  );
}
