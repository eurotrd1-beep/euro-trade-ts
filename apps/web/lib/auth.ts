/**
 * Login / verification — the logic inside `_verifyAccount()` in
 * lib/screens/login_screen.dart, lifted out of the UI.
 *
 * There is no real authentication in this system: a user proves ownership by
 * typing their broker account id. The device lock is the only thing stopping a
 * shared VIP id, which is why its rules are reproduced exactly.
 */

import {
  supabase,
  getDeviceId,
  KEY_USER_VERIFIED,
  KEY_USER_ACCOUNT_ID,
  KEY_USER_BROKER,
  tr,
  type UserRow,
} from '@euro/shared';

export interface LoginRequest {
  accountId: string;
  broker: string;
  /** The broker's `click_key`, used to attribute the login. */
  brokerKey: string;
}

export type LoginResult =
  | { ok: true; role: string; vipExpiry: Date | null }
  | { ok: false; error: string };

function readLocal(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/**
 * Derives the analytics field name for a broker.
 * Mirrors the Dart fallback chain: the stored click key wins, otherwise the
 * broker name is matched loosely, defaulting to Pocket Option.
 */
export function clickFieldFor(brokerKey: string, brokerName: string): string {
  if (brokerKey) return brokerKey;
  const n = brokerName.toLowerCase();
  if (n.includes('quotex')) return 'quotex';
  if (n.includes('expert')) return 'expert_option';
  return 'pocket_option';
}

/** Reads the `globalVip` config: new accounts inherit VIP while it is active. */
async function globalVipGrant(): Promise<{ role: string; expiry: string | null }> {
  try {
    const { data } = await supabase()
      .from('configs')
      .select('data')
      .eq('id', 'globalVip')
      .maybeSingle();

    const cfg = (data?.['data'] ?? {}) as { enabled?: boolean; expiry?: string };
    if (cfg.enabled === true && cfg.expiry) {
      const expiry = new Date(cfg.expiry);
      if (!Number.isNaN(expiry.getTime()) && expiry > new Date()) {
        return { role: 'vip', expiry: cfg.expiry };
      }
    }
  } catch {
    // Unreachable config → no grant, which is the safe default.
  }
  return { role: 'standard', expiry: null };
}

/**
 * Verifies an account id and creates or updates its row.
 *
 * Device-lock rules, copied exactly:
 *   • VIP + a different stored device  → refused
 *   • standard + a different device    → the device id is REBOUND to this one
 *   • no stored device                 → bound to this one
 *
 * So a standard account roams freely and only VIP is pinned. That asymmetry is
 * deliberate in the original.
 */
export async function verifyAccount(req: LoginRequest): Promise<LoginResult> {
  const sb = supabase();
  const deviceId = getDeviceId();
  const accountId = req.accountId.trim();

  try {
    const { data } = await sb.from('users').select('*').eq('id', accountId).maybeSingle();
    const row = data as UserRow | null;

    if (row) {
      const role = row.role || 'standard';
      const vipExpiry = row.vip_expiry ? new Date(row.vip_expiry) : null;
      const storedDeviceId = row.device_id;

      if (role === 'vip' && storedDeviceId && storedDeviceId !== deviceId) {
        return {
          ok: false,
          error: tr(
            'هذا الحساب VIP مرتبط بجهاز آخر. لا يمكن تسجيل الدخول من هذا الجهاز.',
            'This VIP account is linked to another device. You cannot sign in from this device.',
          ),
        };
      }

      const updates: Partial<UserRow> = {};
      if (role === 'standard' && storedDeviceId !== deviceId) {
        updates.device_id = deviceId;
      } else if (!storedDeviceId) {
        updates.device_id = deviceId;
      }
      if (row.broker !== req.broker) updates.broker = req.broker;
      // Only ever set once — `null` means it was never recorded.
      if (row.clicked_broker === null) {
        updates.clicked_broker = readLocal('last_clicked_broker');
      }

      if (Object.keys(updates).length > 0) {
        await sb.from('users').update(updates).eq('id', accountId);
      }

      return { ok: true, role, vipExpiry };
    }

    // ── New account ────────────────────────────────────────────────────────
    const lastClickedBroker = readLocal('last_clicked_broker');
    const grant = await globalVipGrant();

    await sb.from('users').upsert({
      id: accountId,
      broker: req.broker,
      role: grant.role,
      vip_expiry: grant.expiry,
      device_id: deviceId,
      clicked_broker: lastClickedBroker,
      created_at: new Date().toISOString(),
    });

    // Analytics: one counter for the login, one for the original click.
    const loginKey = clickFieldFor(req.brokerKey, req.broker);
    await sb.rpc('increment_click', { row_id: 'brokers', field_name: `${loginKey}Logins` });

    if (lastClickedBroker) {
      const savedKey = readLocal('last_clicked_broker_key');
      await sb.rpc('increment_click', {
        row_id: 'brokers',
        field_name: clickFieldFor(savedKey, lastClickedBroker),
      });
    }

    return {
      ok: true,
      role: grant.role,
      vipExpiry: grant.expiry ? new Date(grant.expiry) : null,
    };
  } catch {
    // Dart swallows lookup failures and falls through as a standard user
    // rather than blocking the login.
    return { ok: true, role: 'standard', vipExpiry: null };
  }
}

/** Persists the verified session, exactly the keys the splash reads back. */
export function persistSession(accountId: string, broker: string): void {
  try {
    localStorage.setItem(KEY_USER_VERIFIED, 'true');
    localStorage.setItem(KEY_USER_ACCOUNT_ID, accountId);
    localStorage.setItem(KEY_USER_BROKER, broker);
  } catch {
    // Session survives only this tab if storage is unavailable.
  }
}

/**
 * The five staged messages shown during verification, 900 ms apart.
 * They are theatre — the real lookup runs in parallel and is awaited with a
 * 6-second cap — but they are part of the product's feel, so they stay.
 */
export function verificationSteps(broker: string): Array<{ text: string; progress: number }> {
  return [
    {
      text: tr(
        `جاري الاتصال بخوادم منصة ${broker} الآمنة...`,
        `Connecting to ${broker} secure servers...`,
      ),
      progress: 0.15,
    },
    {
      text: tr(
        'جاري الاستعلام عن سجلات الإحالة النشطة للشركاء...',
        'Querying active partner referral records...',
      ),
      progress: 0.4,
    },
    {
      text: tr(
        'جاري مطابقة معرف الحساب في شبكة VIP المعتمدة...',
        'Matching the Account ID in the certified VIP network...',
      ),
      progress: 0.65,
    },
    {
      text: tr(
        'تفعيل عضوية غرفة VIP الخاصة بحسابك...',
        "Activating your account's VIP Room membership...",
      ),
      progress: 0.85,
    },
    {
      text: tr(
        'تم تأكيد التفعيل بنجاح! جاري الانتقال لمنصة إشارات VIP...',
        'Activation confirmed successfully! Redirecting to the VIP signals platform...',
      ),
      progress: 1.0,
    },
  ];
}

export const STEP_INTERVAL_MS = 900;
export const LOOKUP_TIMEOUT_MS = 6000;
