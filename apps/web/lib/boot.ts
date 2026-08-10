/**
 * Boot routing — the logic inside `_checkUserStatus()` in splash_screen.dart.
 *
 * Kept as a pure-ish function separate from the splash UI so the decision can
 * be reasoned about and tested on its own. The order of checks is significant
 * and matches the Dart original exactly:
 *
 *   1. maintenance  — beats everything, even a banned user never sees the ban
 *   2. ban          — only checked for an already-verified account
 *   3. language     — shown once on first launch, before the destination
 *   4. destination  — main screen if verified, otherwise the notice screen
 */

import { supabase, hasChosen } from '@euro/shared';
import { loadSession } from './session';

export type BootDestination =
  | { kind: 'maintenance'; message: string; endsAt: string | null }
  | { kind: 'banned'; reason: string }
  | { kind: 'language'; next: 'main' | 'notice' }
  | { kind: 'main' }
  | { kind: 'notice' };

/** The splash animation runs for this long before routing, as in Dart. */
export const SPLASH_DELAY_MS = 3200;

interface MaintenanceData {
  isActive?: boolean;
  message?: string;
  endsAt?: string | null;
}

async function fetchMaintenance(): Promise<MaintenanceData | null> {
  try {
    const { data } = await supabase()
      .from('configs')
      .select('data')
      .eq('id', 'maintenance')
      .maybeSingle();
    return (data?.['data'] as MaintenanceData | undefined) ?? null;
  } catch {
    // Unreachable backend must not strand the user on the splash.
    return null;
  }
}

async function fetchBanState(accountId: string): Promise<{ banned: boolean; reason: string }> {
  try {
    const { data } = await supabase()
      .from('users')
      .select('is_banned, ban_reason')
      .eq('id', accountId)
      .maybeSingle();
    return {
      banned: (data?.['is_banned'] as boolean | undefined) ?? false,
      reason: (data?.['ban_reason'] as string | undefined) ?? '',
    };
  } catch {
    // Fail open: a network error must not lock a paying user out.
    return { banned: false, reason: '' };
  }
}

/** Resolves where the app should go after the splash. */
export async function resolveBootDestination(): Promise<BootDestination> {
  // Reads from localStorage OR the cookie, and repairs whichever was lost.
  const session = loadSession();
  const isVerified = session !== null;
  const accountId = session?.accountId ?? null;

  const maintenance = await fetchMaintenance();

  // An `endsAt` in the past means the window has closed even if the flag is
  // still set — the Dart code treats a null endsAt as "indefinite".
  if (maintenance?.isActive) {
    const endsAt = maintenance.endsAt ? new Date(maintenance.endsAt) : null;
    const stillActive = endsAt === null || Number.isNaN(endsAt.getTime()) || endsAt > new Date();
    if (stillActive) {
      return {
        kind: 'maintenance',
        message: maintenance.message ?? '',
        endsAt: maintenance.endsAt ?? null,
      };
    }
  }

  if (isVerified && accountId) {
    const { banned, reason } = await fetchBanState(accountId);
    if (banned) return { kind: 'banned', reason };
  }

  const destination: 'main' | 'notice' = isVerified && accountId ? 'main' : 'notice';

  // First launch only: pick a language, then continue to the destination.
  if (!hasChosen()) return { kind: 'language', next: destination };

  return destination === 'main' ? { kind: 'main' } : { kind: 'notice' };
}
