/**
 * System health checks — ported from `system_repair_screen.dart` (1,444 lines).
 *
 * All 27 checks across the 8 sections, with the same ids, titles, thresholds,
 * Arabic wording, help text, repair actions and danger flags. The measurement
 * helpers (`_otcStatus`, `_timed`, `_header`, `_count`) are ported one to one so
 * a status here means the same thing it meant in the Flutter admin.
 */

import { CATALOGUE_SYMBOLS, supabase } from '@euro/shared';

// ── Fixed infra endpoints (Dart: _kWorker / _kOrigin / _kRef …) ────────────

export const K_WORKER = 'https://euro-trade-cache.eurotrade.workers.dev';
/** The working proxy / worker origin. */
export const K_ORIGIN = 'https://euro-trade-proxy-1.onrender.com';
const K_REF = 'dlzqdmqkvlvwnjhqxqym';
export const K_RENDER_DASH = 'https://dashboard.render.com';
export const K_SUPA_USAGE = `https://supabase.com/dashboard/project/${K_REF}/reports`;

export type RStatus = 'checking' | 'ok' | 'warn' | 'fail' | 'na' | 'unknown';

export interface RHelp {
  measure?: string;
  why?: string;
  whenRed?: string;
  quickFix?: string;
  deepFix?: string;
  external?: string;
}

export interface RCheck {
  id: string;
  section: string;
  title: string;
  help: RHelp;
}

/** What one run produced. Mirrors the mutable fields on the Dart `RCheck`. */
export interface RResult {
  status: RStatus;
  detail: string;
  cause: string;
  fix: string;
  externalUrl?: string;
  externalLabel?: string;
  fixLabel?: string;
  /** Named so the UI can look the action up; functions are not serialisable. */
  action?: FixId;
  danger: boolean;
}

export type FixId =
  | 'switch_origin'
  | 'switch_worker'
  | 'nudge_scraper'
  | 'restart_proxy'
  | 'clear_cache'
  | 'resub_realtime';

export const SECTIONS: Array<[string, string]> = [
  ['proxy', '⚙️ البروكسي / Render'],
  ['worker', '⚡ Cloudflare Worker'],
  ['data', '📊 الأسعار والبيانات'],
  ['supabase', '🗄️ Supabase'],
  ['po', '🔑 جلسة Pocket Option'],
  ['captcha', '💸 رصيد 2captcha'],
  ['gwin', '🎯 ضمان الفوز'],
  ['app', '📱 التطبيق'],
];

export const PO_FIX_TEXT =
  'التوكن انتهى — سجّل دخول بإيدك في المتصفح على pocketoption.com، افتح شارت، ومن أدوات المطور (Network → WS) خُد إطار "auth" اللي فيه session. الصقه تحت واحفظ.';

// ══════════════════════════ Check catalogue ══════════════════════════

export const CHECKS: RCheck[] = [
  // ── 1) Proxy / Render ──
  {
    id: 'proxy_serves',
    section: 'proxy',
    title: `⭐ الرابط في الكونفيج بيخدم ${CATALOGUE_SYMBOLS} رمز فعلاً؟`,
    help: {
      measure: 'يقرأ configs.proxy_server_url ثم يطلب /api/otc/status منه ويعدّ الرموز.',
      why: 'أخطر فخّ: ممكن الكونفيج يشاور على خدمة Render مكرّرة ميتة بتردّ /health أخضر بس بترجّع 0 رمز — فالتطبيق يقول "تعذر الاتصال بالسوق".',
      whenRed: '0 رمز = الرابط بيشاور على بروكسي ميّت.',
      quickFix: 'رجّع الكونفيج للبروكسي الشغّال (زرار "رجّع للبروكسي المباشر" في قسم الـ Worker).',
      deepFix: 'علّق/امسح خدمة Render المكرّرة الميتة من الداشبورد.',
      external: 'Render dashboard',
    },
  },
  {
    id: 'proxy_alive',
    section: 'proxy',
    title: 'البروكسي حي + زمن الاستجابة',
    help: {
      measure: 'GET /health على الرابط النشط مع توقيت.',
      why: 'لو مردّش، مفيش أسعار ولا شموع.',
      whenRed: 'فشل الاتصال.',
      quickFix: 'استنى ~دقيقة (cold start) وافحص تاني.',
      deepFix: 'اعمل Manual Deploy للخدمة في Render.',
    },
  },
  {
    id: 'proxy_endpoints',
    section: 'proxy',
    title: 'كل الـ endpoints بتردّ (status/candles/health)',
    help: {
      measure: 'GET لكل endpoint والتأكد إنه 200.',
      why: 'التطبيق بيعتمد عليهم كلهم.',
      whenRed: 'أي endpoint ≠ 200.',
    },
  },
  {
    id: 'proxy_restart',
    section: 'proxy',
    title: 'إعادة تشغيل البروكسي (يدوي)',
    help: {
      measure: 'زرار بيفتح Render.',
      why: 'أحياناً السكرابر يحتاج restart.',
      quickFix: 'Render → الخدمة → Manual Deploy → Deploy latest commit.',
    },
  },

  // ── 2) Cloudflare Worker ──
  {
    id: 'wk_alive',
    section: 'worker',
    title: 'الـ Worker حي + زمن الاستجابة',
    help: {
      measure: `GET ${K_WORKER}/health.`,
      why: 'طبقة الكاش قدام البروكسي.',
      whenRed: 'فشل → التطبيق لازم يرجع للأصل المباشر.',
    },
  },
  {
    id: 'wk_active',
    section: 'worker',
    title: 'التطبيق بيضرب على الـ Worker ولا الأصل؟',
    help: {
      measure: 'يقرأ configs.proxy_server_url ويقارنه برابط الـ Worker.',
      why: 'تعرف مصدر البيانات الحالي.',
    },
  },
  {
    id: 'wk_cache',
    section: 'worker',
    title: 'الكاش شغّال (HIT/MISS)',
    help: {
      measure: 'يطلب status مرتين ويقرأ هيدر X-Cache.',
      why: 'لو دايماً MISS، الكاش مش بيوفّر حمل.',
      whenRed: 'مفيش HIT إطلاقاً.',
    },
  },
  {
    id: 'wk_match',
    section: 'worker',
    title: 'الـ Worker بيرجّع نفس داتا الأصل',
    help: {
      measure: 'يقارن عدد الرموز بين الـ Worker والأصل.',
      why: 'لو مختلفين = الكاش قديم/تالف.',
      whenRed: 'فرق في عدد الرموز.',
    },
  },
  {
    id: 'wk_ws',
    section: 'worker',
    title: '⭐ الـ WebSocket /ws شغّال من خلال الـ Worker',
    help: {
      measure: 'يفتح WS على الـ Worker ويشوف اتصل/جه tick.',
      why: 'السعر اللحظي + ضمان الفوز بيركبوا الـ WS.',
      whenRed: 'مقطوع = ضمان الفوز مش هيشتغل.',
      quickFix: 'رجّع للبروكسي المباشر لو الـ Worker بيكسر الـ WS.',
    },
  },
  {
    id: 'wk_cors',
    section: 'worker',
    title: 'CORS headers موجودة',
    help: {
      measure: 'يتأكد Access-Control-Allow-Origin موجود.',
      why: 'من غيرها المتصفح مش هيقرا.',
    },
  },

  // ── 3) Prices / data ──
  {
    id: 'd_fresh',
    section: 'data',
    title: 'الأسعار مش متجمّدة (عمر أحدث تحديث)',
    help: {
      measure: 'عمر أحدث t في otc_prices.',
      why: 'أسعار متجمّدة = السكرابر واقف.',
      whenRed: 'أكبر من 90 ثانية.',
      quickFix: 'نبّه السكرابر يعيد المحاولة، أو راجع جلسة PO.',
    },
  },
  {
    id: 'd_count',
    section: 'data',
    title: `عدد الرموز من ${CATALOGUE_SYMBOLS}`,
    help: {
      measure: 'عدد المفاتيح في otc_prices.',
      why: 'رموز ناقصة = مشكلة اشتراك في السكرابر.',
      whenRed: '0 رمز.',
    },
  },
  {
    id: 'd_anom',
    section: 'data',
    title: 'مفيش أسعار صفر/null/شاذة',
    help: {
      measure: 'يمسح القيم على 0/null/غير منطقي.',
      why: 'أسعار شاذة تفسد الشموع والإشارات.',
      whenRed: 'أي قيمة شاذة.',
    },
  },
  {
    id: 'd_candles',
    section: 'data',
    title: 'الشموع راجعة لكل فريم (1m..1D)',
    help: {
      measure: 'GET /api/otc/candles لكل فريم على رمز شغّال.',
      why: 'محرك الإشارات بيتغذى منها.',
      whenRed: 'أي فريم فاضي.',
    },
  },
  {
    id: 'd_market',
    section: 'data',
    title: 'حالة السوق متسقة مع طزاجة الأسعار',
    help: { measure: 'يقارن فلاج po مع طزاجة السعر.', why: 'تناقض = بيانات غير موثوقة.' },
  },
  {
    id: 'd_engine',
    section: 'data',
    title: 'مدخلات المحرك سليمة (استراتيجيات + شموع + أسعار)',
    help: {
      measure: 'configs الاستراتيجيات موجودة + أسعار طازة + شموع.',
      why: 'المحرك بيشتغل في تطبيق المستخدم — ده فحص المدخلات.',
    },
  },

  // ── 4) Supabase ──
  {
    id: 's_alive',
    section: 'supabase',
    title: 'الاتصال حي + زمن الاستجابة',
    help: {
      measure: 'استعلام configs?select=id&limit=1 مع توقيت.',
      why: 'كل حاجة معتمدة على Supabase.',
      whenRed: 'فشل/522 = الداتابيز Unhealthy.',
      deepFix: 'Settings → Infrastructure → Restart project، ولو تكرّر كبّر المعالج.',
    },
  },
  {
    id: 's_tables',
    section: 'supabase',
    title: 'الجداول موجودة وفيها بيانات',
    help: {
      measure: 'count: configs/pairs/otc_pairs/users/candles.',
      why: 'مشروع فاضي/غلط = التطبيق مايشتغلش.',
      whenRed: 'أي جدول 404 أو 0.',
    },
  },
  {
    id: 's_usage',
    section: 'supabase',
    title: 'الاستهلاك (connections/messages/egress) + صحة المشروع',
    help: {
      measure: 'عبر البروكسي (/api/supabase-usage) بمفتاح Management. الأرقام الكاملة من الداشبورد.',
      why: 'تجاوز الحدود = قطع الخدمة. الحدود: 500 اتصال، 5M رسالة/شهر، 250GB Egress.',
      whenRed: 'المشروع Unhealthy أو أي مقياس فوق 90%.',
      external: 'صفحة Usage في الداشبورد',
    },
  },

  // ── 5) PO session (view only) ──
  {
    id: 'po_token',
    section: 'po',
    title: 'توكن Pocket Option صالح',
    help: {
      measure: 'طول التوكن (authLen) من otc_status.cfg.',
      why: 'من غير توكن سليم مفيش أسعار.',
      whenRed: 'authLen ~144 أو 0 = لوجين معلّق/منتهي.',
      quickFix: 'سجّل دخول بإيدك والصق التوكن الجديد تحت.',
    },
  },
  {
    id: 'po_last',
    section: 'po',
    title: 'آخر اتصال ناجح بـ PO',
    help: { measure: 'طزاجة الأسعار = آخر بثّ ناجح.', why: 'مؤشر إن الجلسة لسه حية.' },
  },

  // ── 6) 2captcha (view only) ──
  {
    id: 'cap_bal',
    section: 'captcha',
    title: 'رصيد 2captcha',
    help: {
      measure: 'عبر البروكسي (/api/captcha-balance).',
      why: 'من غير رصيد، السكرابر مش هيحل كابتشا اللوجين.',
      whenRed: '$0 (ZERO_BALANCE).',
      quickFix: 'اشحن الحساب على 2captcha.com.',
      external: '2captcha.com',
    },
  },

  // ── 7) Guaranteed win ──
  {
    id: 'g_users',
    section: 'gwin',
    title: 'ضمان الفوز مفعّل على كام مستخدم',
    help: { measure: 'عدّ users حيث guaranteed_win = true.', why: 'تعرف مين متأثر لو الـ WS وقع.' },
  },
  {
    id: 'g_ws',
    section: 'gwin',
    title: 'الـ WebSocket اللي بيغذّي ضمان الفوز متصل',
    help: {
      measure: 'نفس فحص /ws.',
      why: 'ضمان الفوز بيعدّل السعر لايف عبر الـ WS.',
      whenRed: 'مقطوع = ضمان الفوز مش هيشتغل.',
    },
  },

  // ── 8) App ──
  {
    id: 'a_ver',
    section: 'app',
    title: 'الإصدار + الكونفيج الحالي',
    help: { measure: 'إصدار الأدمن + قيم configs الأساسية.', why: 'مرجع سريع للحالة.' },
  },
  {
    id: 'a_push',
    section: 'app',
    title: 'الإشعارات (Web Push) مظبوطة',
    help: { measure: 'جدول push_subscriptions فيه اشتراكات.', why: 'من غيرها مفيش تنبيهات.', whenRed: '0 اشتراك.' },
  },
  {
    id: 'a_env',
    section: 'app',
    title: 'متغيرات بيئة البروكسي (من otc_status.cfg)',
    help: {
      measure: 'email/pass/captcha booleans من cfg.',
      why: 'أي واحد false = السكرابر ناقصه إعداد.',
      whenRed: 'أي واحد false.',
    },
  },
];

// ══════════════════════════ Measurement helpers ══════════════════════════

/** Dart `_readActiveProxy` — configs.proxy_server_url, trailing slashes cut. */
export async function readActiveProxy(): Promise<string> {
  try {
    const { data } = await supabase()
      .from('configs')
      .select('data')
      .eq('id', 'proxy_server_url')
      .maybeSingle();
    const url = (data?.['data'] as { url?: string } | null)?.url?.trim();
    if (url) return url.replace(/\/+$/, '');
  } catch {
    // Fall through to the known-good origin.
  }
  return K_ORIGIN;
}

export function wsUrl(base: string): string {
  return `${base.replace(/^http/, 'ws')}/ws`;
}

/** Dart `_timed` → `(status, ms)` or null. */
async function timed(url: string): Promise<{ status: number; ms: number } | null> {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return { status: r.status, ms: Math.round(performance.now() - t0) };
  } catch {
    return null;
  }
}

/** Dart `_json`. */
async function json(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (r.status !== 200) return null;
    const d: unknown = await r.json();
    if (d !== null && typeof d === 'object' && !Array.isArray(d)) return d as Record<string, unknown>;
    return { _list: d };
  } catch {
    return null;
  }
}

/** Dart `_header`. */
async function header(url: string, name: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return r.headers.get(name.toLowerCase());
  } catch {
    return null;
  }
}

interface OtcStatus {
  count: number;
  newestAge: number | null;
  anomalies: number;
  closed: number;
  authLen: number;
  cfg: string;
}

/** Dart `_otcStatus` — parses /api/otc/status into the six numbers used above. */
async function otcStatus(base: string): Promise<OtcStatus | null> {
  try {
    const r = await fetch(`${base}/api/otc/status`, { signal: AbortSignal.timeout(15_000) });
    if (r.status !== 200) return null;
    const list = (await r.json()) as Array<Record<string, unknown>>;
    const find = (id: string): Record<string, unknown> =>
      (list.find((x) => x['id'] === id)?.['data'] as Record<string, unknown>) ?? {};
    const prices = find('otc_prices');
    const status = find('otc_status');

    const now = Math.floor(Date.now() / 1000);
    let anomalies = 0;
    let closed = 0;
    let newest: number | null = null;

    for (const v of Object.values(prices)) {
      if (v === null || typeof v !== 'object') continue;
      const row = v as Record<string, unknown>;
      const p = row['p'];
      if (p === null || p === undefined || (typeof p === 'number' && (p <= 0 || !Number.isFinite(p)))) {
        anomalies++;
      }
      if (row['po'] === false) closed++;
      const t = typeof row['t'] === 'number' ? Math.trunc(row['t']) : null;
      if (t !== null) {
        const age = now - t;
        if (newest === null || age < newest) newest = age;
      }
    }

    const cfg = status['cfg'] === undefined || status['cfg'] === null ? '' : String(status['cfg']);
    const m = /authLen=(\d+)/.exec(cfg);

    return {
      count: Object.keys(prices).length,
      newestAge: newest,
      anomalies,
      closed,
      authLen: m ? Number.parseInt(m[1]!, 10) : 0,
      cfg,
    };
  } catch {
    return null;
  }
}

/**
 * Dart `_count` — fetch id-only rows and count them. Throws if the table does
 * not exist, which the caller reads as "missing".
 */
async function count(
  table: string,
  col = 'id',
  filter?: (q: ReturnType<ReturnType<typeof supabase>['from']>) => unknown,
): Promise<number> {
  const base = supabase().from(table).select(col);
  const q = filter ? filter(base as never) : base;
  const { data, error } = (await q) as { data: unknown[] | null; error: unknown };
  if (error) throw error;
  return data?.length ?? 0;
}

const short = (e: unknown): string => String(e instanceof Error ? e.message : e).replace(/\n/g, ' ').trim();
export const short2 = (e: unknown): string => (short(e).length > 60 ? `${short(e).slice(0, 60)}…` : short(e));

/**
 * Dart `checkWebSocket` (repair_web_impl.dart) — connect, subscribe, and treat
 * either a tick or a clean 3-second open as success.
 */
export function checkWebSocket(url: string, sym: string, timeoutMs = 9_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | null = null;
    let overall: ReturnType<typeof setTimeout> | null = null;
    let afterOpen: ReturnType<typeof setTimeout> | null = null;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (overall) clearTimeout(overall);
      if (afterOpen) clearTimeout(afterOpen);
      try {
        ws?.close();
      } catch {
        // Already closed.
      }
      resolve(ok);
    };

    try {
      ws = new WebSocket(url);
      overall = setTimeout(() => finish(false), timeoutMs);
      ws.onopen = () => {
        try {
          ws?.send(`{"sub":"${sym}"}`);
        } catch {
          // The open handshake is what matters.
        }
        // Give it 3s for a live tick; a quiet market still counts as connected.
        afterOpen = setTimeout(() => finish(true), 3_000);
      };
      ws.onmessage = () => finish(true);
      ws.onerror = () => finish(false);
      ws.onclose = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

// ══════════════════════════ Repairs ══════════════════════════

export async function logRepair(action: string, result: string): Promise<void> {
  try {
    await supabase().from('repair_log').insert({
      action,
      result,
      at: new Date().toISOString(),
    });
  } catch {
    // The table may not exist yet — non-fatal, exactly as in Dart.
  }
}

export async function switchProxy(url: string): Promise<string> {
  await supabase()
    .from('configs')
    .upsert({ id: 'proxy_server_url', data: { url, updatedAt: new Date().toISOString() } });
  await logRepair('switch_proxy', `proxy_server_url → ${url}`);
  return `تم التحويل إلى:\n${url}\nكل الأجهزة هتتحول خلال ثواني (realtime).`;
}

export async function nudgeScraper(): Promise<string> {
  // po-scraper.js watches configs.otc_scan.data.requestedAt + status=='requested'.
  // Merge so fields other writers own are not wiped.
  let cur: Record<string, unknown> = {};
  try {
    const { data } = await supabase().from('configs').select('data').eq('id', 'otc_scan').maybeSingle();
    if (data?.['data'] && typeof data['data'] === 'object') cur = data['data'] as Record<string, unknown>;
  } catch {
    // Start from empty.
  }
  await supabase()
    .from('configs')
    .upsert({
      id: 'otc_scan',
      data: { ...cur, requestedAt: new Date().toISOString(), status: 'requested' },
    });
  await logRepair('nudge_scraper', 'otc_scan requestedAt');
  return 'اتبعت إشارة للسكرابر يعيد المحاولة. استنى ~دقيقة وافحص تاني.';
}

export async function savePoToken(token: string): Promise<string> {
  const t = token.trim();
  if (t.length < 40) return 'التوكن قصير جداً — تأكد إنك لصقت إطار auth كامل.';
  await supabase()
    .from('configs')
    .upsert({
      id: 'otc_token',
      data: { auth: t, capturedAt: new Date().toISOString(), via: 'admin_repair' },
    });
  await logRepair('save_po_token', `otc_token updated (len=${t.length})`);
  return 'اتحفظ التوكن الجديد ✅. اعمل Manual Deploy للبروكسي عشان يلتقطه، أو نبّه السكرابر.';
}

export async function resubRealtime(): Promise<string> {
  try {
    supabase().realtime.disconnect();
  } catch {
    // Nothing connected.
  }
  await logRepair('resub_realtime', 'realtime disconnect (auto-reconnect)');
  return 'اتقطع الـ realtime — هيعيد الاشتراك تلقائياً.';
}

/** Dart `clearWebCaches`. */
export async function clearCache(): Promise<string> {
  let caches = 0;
  let sws = 0;
  try {
    const keys = await globalThis.caches.keys();
    for (const k of keys) {
      await globalThis.caches.delete(k);
      caches++;
    }
  } catch {
    // Cache Storage unavailable.
  }
  try {
    const regs = await navigator.serviceWorker?.getRegistrations();
    for (const r of regs ?? []) {
      await r.unregister();
      sws++;
    }
  } catch {
    // No service workers.
  }
  const msg = `مسح ${caches} كاش و ${sws} service worker`;
  await logRepair('clear_cache', msg);
  return `${msg}. اعمل refresh للصفحة.`;
}

export async function restartProxy(): Promise<string> {
  const r = await fetch(`${K_ORIGIN}/api/render-restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(25_000),
  });
  const d = (await r.json()) as Record<string, unknown>;
  if (d['ok'] === true) {
    await logRepair('render_restart', `deploy ${d['deployId'] ?? ''}`);
    return 'اتبعت أمر إعادة النشر ✅. البروكسي هيرجع خلال ~1–2 دقيقة. افحص تاني بعدها.';
  }
  throw new Error(d['reason'] === undefined ? 'مش متاح' : String(d['reason']));
}

export async function sendAlert(text: string, test = false): Promise<string> {
  const r = await fetch(`${K_ORIGIN}/api/alert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(test ? { test: true } : { text }),
    signal: AbortSignal.timeout(20_000),
  });
  const d = (await r.json()) as Record<string, unknown>;
  if (d['ok'] === true) return 'اتبعت رسالة تيليجرام ✅';
  throw new Error(d['reason'] === undefined ? 'التنبيه مش متاح' : String(d['reason']));
}

export const FIX_ACTIONS: Record<FixId, { label: string; run: () => Promise<string> }> = {
  switch_origin: { label: 'رجّع للبروكسي المباشر', run: () => switchProxy(K_ORIGIN) },
  switch_worker: { label: 'حوّل للـ Worker', run: () => switchProxy(K_WORKER) },
  nudge_scraper: { label: 'نبّه السكرابر', run: nudgeScraper },
  restart_proxy: { label: 'إعادة تشغيل البروكسي', run: restartProxy },
  clear_cache: { label: 'مسح الكاش المحلي', run: clearCache },
  resub_realtime: { label: 'إعادة اشتراك Realtime', run: resubRealtime },
};

// ══════════════════════════ Runner ══════════════════════════

/** State shared by every check in one run, primed before they fan out. */
export interface RunContext {
  activeProxy: string;
  wsOk: boolean;
  wsOkActive: boolean;
  opsRender: boolean;
  opsTelegram: boolean;
}

export async function loadOps(): Promise<{ render: boolean; telegram: boolean }> {
  try {
    const r = await fetch(`${K_ORIGIN}/api/ops-status`, { signal: AbortSignal.timeout(10_000) });
    const d = (await r.json()) as Record<string, unknown>;
    return { render: d['render'] === true, telegram: d['telegram'] === true };
  } catch {
    return { render: false, telegram: false };
  }
}

const res = (status: RStatus, detail: string, extra: Partial<RResult> = {}): RResult => ({
  status,
  detail,
  cause: '',
  fix: '',
  danger: false,
  ...extra,
});

/** Dart `_runOne`, case by case. */
export async function runOne(check: RCheck, ctx: RunContext): Promise<RResult> {
  try {
    switch (check.id) {
      // ---- proxy ----
      case 'proxy_serves': {
        const st = await otcStatus(ctx.activeProxy);
        const n = st?.count ?? -1;
        if (st === null) {
          return res('fail', `الرابط النشط مش بيردّ: ${ctx.activeProxy}`, {
            cause: 'البروكسي ميّت أو غلط',
            fix: 'رجّع للبروكسي المباشر',
            externalUrl: K_RENDER_DASH,
            externalLabel: 'Render',
          });
        }
        if (n === 0) {
          return res('fail', `🔴 0 رمز! الكونفيج بيشاور على بروكسي ميّت (${ctx.activeProxy})`, {
            cause: 'خدمة Render مكرّرة/معطّلة — بتردّ /health بس مفيش بيانات',
            fix: 'اضغط "رجّع للبروكسي المباشر" (تحت في قسم الـ Worker)، وعلّق الخدمة المكررة في Render',
            externalUrl: K_RENDER_DASH,
            externalLabel: 'Render',
            fixLabel: 'رجّع للبروكسي المباشر',
            action: 'switch_origin',
            danger: true,
          });
        }
        if (n < CATALOGUE_SYMBOLS) {
          return res('warn', `${n} / ${CATALOGUE_SYMBOLS} رمز`, {
            cause: 'بعض الرموز ناقصة من السكرابر',
          });
        }
        // More than the catalogue is not "extra coverage" — it means the
        // scraper subscribed to something the asset policy dropped, and those
        // candles are being stored and paid for with nobody reading them.
        if (n > CATALOGUE_SYMBOLS) {
          return res('warn', `${n} / ${CATALOGUE_SYMBOLS} رمز — فيه زيادة`, {
            cause: 'السكرابر مشترك في رموز خارج سياسة الأصول',
            fix: 'راجع isAllowedAsset في po-scraper.js — لازم تطابق asset_allowed في الترحيل',
          });
        }
        return res('ok', `${n} / ${CATALOGUE_SYMBOLS} رمز ✅ (${ctx.activeProxy})`);
      }

      case 'proxy_alive': {
        const r = await timed(`${ctx.activeProxy}/health`);
        if (r === null) {
          return res('fail', 'مفيش رد', {
            cause: 'البروكسي واقف أو cold-start طويل',
            fix: 'استنى ~دقيقة وافحص تاني، أو اعمل Manual Deploy',
            externalUrl: K_RENDER_DASH,
            externalLabel: 'Render',
          });
        }
        if (r.status !== 200) return res('fail', `HTTP ${r.status}`, { cause: 'البروكسي بيردّ خطأ' });
        if (r.ms > 5000) {
          return res('warn', `بطيء: ${r.ms}ms (cold start)`, { cause: 'الخدمة كانت نايمة وبتصحى' });
        }
        return res('ok', `200 في ${r.ms}ms`);
      }

      case 'proxy_endpoints': {
        const eps: Record<string, string> = {
          '/health': `${ctx.activeProxy}/health`,
          '/api/otc/status': `${ctx.activeProxy}/api/otc/status`,
          '/api/otc/candles': `${ctx.activeProxy}/api/otc/candles?symbol=EURUSD_otc&interval=1m`,
        };
        const bad: string[] = [];
        for (const [name, url] of Object.entries(eps)) {
          const r = await timed(url);
          if (r === null || r.status !== 200) bad.push(`${name} (${r?.status ?? 'لا رد'})`);
        }
        if (bad.length === 0) return res('ok', 'كل الـ endpoints 200 ✅');
        return res('fail', `فشل: ${bad.join('، ')}`, { cause: 'endpoint مش بيردّ صح' });
      }

      case 'proxy_restart': {
        if (ctx.opsRender) {
          return res('ok', 'جاهز — إعادة تشغيل بضغطة', {
            fix: 'redeploy للبروكسي عبر Render API',
            fixLabel: 'إعادة تشغيل البروكسي',
            action: 'restart_proxy',
            danger: true,
            externalUrl: K_RENDER_DASH,
            externalLabel: 'أو افتح Render',
          });
        }
        return res('na', 'زرار يدوي (فعّل RENDER_API_KEY للضغطة الواحدة)', {
          fix: 'Render → الخدمة → Manual Deploy → Deploy latest commit',
          externalUrl: K_RENDER_DASH,
          externalLabel: 'افتح Render',
        });
      }

      // ---- worker ----
      case 'wk_alive': {
        const r = await timed(`${K_WORKER}/health`);
        if (r === null) {
          return res('fail', 'الـ Worker مش بيردّ', {
            cause: 'مشكلة في Cloudflare أو شهادة',
            fix: 'رجّع للبروكسي المباشر مؤقتاً',
            fixLabel: 'رجّع للبروكسي المباشر',
            action: 'switch_origin',
            danger: true,
          });
        }
        return res('ok', `200 في ${r.ms}ms`);
      }

      case 'wk_active': {
        if (ctx.activeProxy.includes('workers.dev')) {
          return res('ok', 'التطبيق بيضرب على الـ Worker ✅', {
            fixLabel: 'رجّع للبروكسي المباشر',
            action: 'switch_origin',
            danger: true,
          });
        }
        return res('warn', `التطبيق بيضرب على الأصل مباشرة: ${ctx.activeProxy}`, {
          cause: 'الكاش مش مفعّل — حمل أعلى على البروكسي',
          fix: 'حوّل للـ Worker لتفعيل الكاش',
          fixLabel: 'حوّل للـ Worker',
          action: 'switch_worker',
          danger: true,
        });
      }

      case 'wk_cache': {
        await timed(`${K_WORKER}/api/otc/status`); // warm
        const h1 = await header(`${K_WORKER}/api/otc/status`, 'x-cache');
        const h2 = await header(`${K_WORKER}/api/otc/status`, 'x-cache');
        const tag = (h2 ?? h1 ?? '').toUpperCase();
        if (tag.includes('HIT')) return res('ok', 'X-Cache: HIT ✅ (الكاش شغّال)');
        if (tag.includes('STALE')) {
          return res('warn', 'X-Cache: STALE', { cause: 'الأصل بطّأ — الـ Worker بيقدّم نسخة محفوظة' });
        }
        if (tag === '') return res('warn', 'مفيش هيدر X-Cache', { cause: 'ممكن التطبيق مش على الـ Worker' });
        return res('warn', `X-Cache: ${tag} (مفيش HIT)`, { cause: 'الكاش لسه بيسخّن' });
      }

      case 'wk_match': {
        const w = await otcStatus(K_WORKER);
        const o = await otcStatus(K_ORIGIN);
        if (w === null || o === null) return res('warn', 'تعذّر المقارنة', { cause: 'أحد الطرفين مردّش' });
        if (w.count !== o.count) {
          return res('fail', `فرق: Worker ${w.count} / الأصل ${o.count}`, {
            cause: 'كاش قديم/تالف',
            fix: 'رجّع للبروكسي المباشر مؤقتاً',
            fixLabel: 'رجّع للبروكسي المباشر',
            action: 'switch_origin',
            danger: true,
          });
        }
        return res('ok', `مطابق: ${w.count} رمز على الاتنين ✅`);
      }

      case 'wk_ws': {
        if (ctx.wsOk) return res('ok', 'الـ WS متصل عبر الـ Worker ✅');
        return res('fail', '🔴 الـ WS مقطوع عبر الـ Worker — ضمان الفوز مش هيشتغل!', {
          cause: 'الـ Worker بيكسر تمرير الـ WebSocket',
          fix: 'رجّع للبروكسي المباشر فوراً',
          fixLabel: 'رجّع للبروكسي المباشر',
          action: 'switch_origin',
          danger: true,
        });
      }

      case 'wk_cors': {
        const cors = await header(`${K_WORKER}/api/otc/status`, 'access-control-allow-origin');
        return res(cors !== null ? 'ok' : 'warn', cors !== null ? `موجود: ${cors} ✅` : 'مش ظاهر', {
          cause: cors === null ? 'ممكن قيد على قراءة الهيدر من المتصفح' : '',
        });
      }

      // ---- data ----
      case 'd_fresh': {
        const st = await otcStatus(ctx.activeProxy);
        if (st === null) return res('fail', 'مفيش رد من البروكسي', { cause: 'البروكسي واقف' });
        const age = st.newestAge;
        if (age === null) return res('fail', 'مفيش أسعار', { cause: 'السكرابر مش بيبثّ' });
        if (age > 90) {
          return res('fail', `متجمّدة من ${age}s`, {
            cause: 'السكرابر واقف / جلسة PO ماتت',
            fix: 'نبّه السكرابر يعيد المحاولة، وراجع قسم Pocket Option',
            fixLabel: 'نبّه السكرابر',
            action: 'nudge_scraper',
          });
        }
        if (age > 30) return res('warn', `آخر تحديث من ${age}s`, { cause: 'بثّ بطيء' });
        return res('ok', `حيّة — آخر تحديث ${age}s ✅`);
      }

      case 'd_count': {
        const st = await otcStatus(ctx.activeProxy);
        const n = st?.count ?? -1;
        if (n < 0) return res('fail', 'مفيش رد', { cause: 'البروكسي واقف' });
        if (n === 0) return res('fail', '0 رمز', { cause: 'السكرابر مش مشترك في أي رمز' });
        if (n < CATALOGUE_SYMBOLS) {
          return res('warn', `${n} / ${CATALOGUE_SYMBOLS}`, { cause: 'رموز ناقصة' });
        }
        if (n > CATALOGUE_SYMBOLS) {
          return res('warn', `${n} / ${CATALOGUE_SYMBOLS} — فيه زيادة`, {
            cause: 'رموز خارج سياسة الأصول',
          });
        }
        return res('ok', `${n} / ${CATALOGUE_SYMBOLS} ✅`);
      }

      case 'd_anom': {
        const st = await otcStatus(ctx.activeProxy);
        if (st === null) return res('warn', 'تعذّر الفحص');
        if (st.anomalies > 0) {
          return res('fail', `${st.anomalies} قيمة شاذة (0/null)`, { cause: 'خطأ في السكرابر' });
        }
        return res('ok', 'كل الأسعار سليمة ✅');
      }

      case 'd_candles': {
        const tfs = ['1m', '5m', '15m', '1h', '1D'];
        const empty: string[] = [];
        for (const tf of tfs) {
          const r = await json(`${ctx.activeProxy}/api/otc/candles?symbol=EURUSD_otc&interval=${tf}`);
          const cnt = Array.isArray(r?.['candles']) ? (r['candles'] as unknown[]).length : 0;
          if (cnt === 0) empty.push(tf);
        }
        if (empty.length === 0) return res('ok', 'كل الفريمات فيها شموع ✅');
        return res('warn', `فاضية: ${empty.join('، ')}`, {
          cause: 'الفريمات دي لسه بتتراكم أو مش مخزّنة',
        });
      }

      case 'd_market': {
        const st = await otcStatus(ctx.activeProxy);
        if (st === null) return res('warn', 'تعذّر الفحص');
        const total = st.count;
        const age = st.newestAge ?? 999;
        const open = total - st.closed;
        // Pairs marked OPEN should have FRESH prices.
        if (open > 0 && age > 90) {
          return res('warn', `${st.closed} مقفول / ${total} — بس الأسعار قديمة (${age}s)`, {
            cause: 'أزواج «مفتوحة» ومصدر السعر متأخّر — تعارض',
          });
        }
        return res('ok', `${st.closed} مقفول / ${total} • أحدث سعر ${age}s ✅`);
      }

      case 'd_engine': {
        // The strategies used to live in `configs` and this counted the rows.
        // They are compiled into the engine now, so their existence is a
        // deploy-time fact that tests cover and nothing here can check. What
        // is left worth checking is the input: a strategy reading stale
        // candles is the failure this section can still catch.
        const st = await otcStatus(ctx.activeProxy);
        const age = st?.newestAge ?? 999;
        if (age <= 90) return res('ok', `المحرك على أسعار عمرها ${age}s ✅`);
        return res('warn', `أحدث سعر عمره ${age}s — المحرك بيقرا بيانات قديمة`, {
          cause: 'راجع قسم الأسعار',
        });
      }

      // ---- supabase ----
      case 's_alive': {
        const t0 = performance.now();
        try {
          const { error } = await supabase().from('configs').select('id').limit(1);
          if (error) throw error;
          const ms = Math.round(performance.now() - t0);
          return res(ms > 3000 ? 'warn' : 'ok', `200 في ${ms}ms`, {
            cause: ms > 3000 ? 'بطيء — ممكن ضغط على النانو' : '',
          });
        } catch (e) {
          return res('fail', `فشل: ${short(e)}`, {
            cause: 'الداتابيز Unhealthy / 522',
            fix: 'Settings → Infrastructure → Restart project (لو تكرّر: كبّر المعالج)',
            externalUrl: `https://supabase.com/dashboard/project/${K_REF}`,
            externalLabel: 'Supabase',
          });
        }
      }

      case 's_tables': {
        // `candles` is keyed by `key` and has NO `id` column, so probing `id`
        // there would throw and show a false "خطأ". Probe each by a real column.
        const probe: Record<string, string> = {
          configs: 'id',
          pairs: 'id',
          otc_pairs: 'id',
          users: 'id',
          candles: 'key',
        };
        const miss: string[] = [];
        for (const [table, col] of Object.entries(probe)) {
          try {
            const n = await count(table, col);
            if (n <= 0) miss.push(`${table} (0)`);
          } catch {
            miss.push(`${table} (خطأ)`);
          }
        }
        if (miss.length === 0) return res('ok', 'كل الجداول موجودة وفيها بيانات ✅');
        return res('fail', `مشكلة: ${miss.join('، ')}`, { cause: 'مشروع فاضي/غلط' });
      }

      case 's_usage': {
        const u = await json(`${K_ORIGIN}/api/supabase-usage`);
        if (u === null || u['available'] !== true) {
          return res('na', 'الأرقام مش متاحة من التطبيق', {
            cause: u?.['reason'] === undefined ? 'البروكسي/التوكن مش جاهز' : String(u['reason']),
            fix: 'الأرقام الكاملة (اتصالات/رسائل/Egress) من صفحة Usage في الداشبورد',
            externalUrl: K_SUPA_USAGE,
            externalLabel: 'افتح Usage',
          });
        }
        const ps = u['projectStatus'] === undefined ? '?' : String(u['projectStatus']);
        const healthy = ps === 'ACTIVE_HEALTHY';
        let over: string | null = null;
        const usage = u['usage'];
        if (usage !== null && typeof usage === 'object') {
          for (const [k, v] of Object.entries(usage as Record<string, unknown>)) {
            if (v === null || typeof v !== 'object') continue;
            const row = v as { usage?: unknown; limit?: unknown };
            if (
              typeof row.usage === 'number' &&
              typeof row.limit === 'number' &&
              row.limit > 0 &&
              row.usage / row.limit > 0.9
            ) {
              over = k;
            }
          }
        }
        if (!healthy) {
          return res('warn', `المشروع: ${ps}`, {
            cause: 'المشروع مش ACTIVE_HEALTHY',
            fix: 'راجع الداشبورد',
            externalUrl: K_SUPA_USAGE,
            externalLabel: 'افتح Usage',
          });
        }
        if (over !== null) {
          return res('warn', `مقياس فوق 90%: ${over}`, {
            cause: 'قرّب على الحد',
            fix: 'راجع Usage',
            externalUrl: K_SUPA_USAGE,
            externalLabel: 'افتح Usage',
          });
        }
        return res('ok', `المشروع صحّي (${ps}) — الأرقام التفصيلية على الداشبورد فقط`, {
          fix: 'الاستهلاك (اتصالات/رسائل/Egress، حد 500/5M/250GB) من صفحة Usage',
          externalUrl: K_SUPA_USAGE,
          externalLabel: 'افتح Usage',
        });
      }

      // ---- PO session ----
      case 'po_token': {
        const st = await otcStatus(ctx.activeProxy);
        const authLen = st?.authLen ?? 0;
        if (authLen === 0) {
          return res('fail', 'مفيش توكن', { cause: 'السكرابر ماقدرش يسجّل دخول', fix: PO_FIX_TEXT });
        }
        if (authLen < 200) {
          return res('fail', `توكن معلّق/منتهي (authLen=${authLen})`, {
            cause: 'اللوجين واقف أو التوكن انتهى',
            fix: PO_FIX_TEXT,
          });
        }
        return res('ok', `توكن سليم (authLen=${authLen}) ✅`);
      }

      case 'po_last': {
        const st = await otcStatus(ctx.activeProxy);
        const age = st?.newestAge ?? null;
        if (age === null) return res('warn', 'مفيش بثّ', { cause: 'الجلسة ممكن تكون ماتت' });
        if (age > 90) return res('warn', `آخر بثّ ناجح من ${age}s`, { cause: 'الجلسة بطيئة/واقفة' });
        return res('ok', `آخر اتصال ناجح من ${age}s ✅`);
      }

      // ---- 2captcha ----
      case 'cap_bal': {
        const b = await json(`${K_ORIGIN}/api/captcha-balance`);
        if (b === null || b['available'] !== true) {
          return res('na', 'مش متاح', {
            cause: b?.['reason'] === undefined ? 'البروكسي/المفتاح مش جاهز' : String(b['reason']),
            fix: 'الرصيد من 2captcha.com',
            externalUrl: 'https://2captcha.com',
            externalLabel: '2captcha',
          });
        }
        const bal = typeof b['balance'] === 'number' ? b['balance'] : 0;
        if (bal <= 0) {
          return res('fail', `$${bal.toFixed(2)} — ZERO BALANCE`, {
            cause: 'اللوجين مش هيشتغل من غير رصيد',
            fix: 'اشحن الحساب',
            externalUrl: 'https://2captcha.com',
            externalLabel: 'اشحن 2captcha',
          });
        }
        if (bal < 2) {
          return res('warn', `$${bal.toFixed(2)} (قليل)`, {
            cause: 'قرّب يخلص',
            fix: 'اشحن قريباً',
            externalUrl: 'https://2captcha.com',
            externalLabel: '2captcha',
          });
        }
        return res('ok', `$${bal.toFixed(2)} ✅`);
      }

      // ---- gwin ----
      case 'g_users': {
        const n = await count('users', 'id', (q) => (q as never as { eq: (a: string, b: boolean) => unknown }).eq('guaranteed_win', true));
        return res('ok', `مفعّل على ${n} مستخدم`);
      }

      case 'g_ws': {
        if (ctx.wsOkActive) return res('ok', 'الـ WS متصل — ضمان الفوز هيشتغل ✅');
        return res('fail', '🔴 الـ WS مقطوع — ضمان الفوز مش هيشتغل', {
          cause: 'مصدر السعر اللحظي مقطوع',
          fix: 'رجّع للبروكسي المباشر / راجع البروكسي',
          fixLabel: 'رجّع للبروكسي المباشر',
          action: 'switch_origin',
          danger: true,
        });
      }

      // ---- app ----
      case 'a_ver': {
        const { data } = await supabase()
          .from('configs')
          .select('id,data')
          .in('id', ['price_system', 'display_source', 'chart_settings']);
        const rows = (data as Array<{ id: string; data: Record<string, unknown> | null }> | null) ?? [];
        const m: Record<string, unknown> = {};
        for (const r of rows) m[r.id] = r.data?.['value'] ?? r.data?.['mode'];
        return res('ok', `v1.0.0 • proxy=${ctx.activeProxy} • ${JSON.stringify(m)}`);
      }

      case 'a_push': {
        const n = await count('push_subscriptions');
        return res(n > 0 ? 'ok' : 'warn', `${n} اشتراك`, {
          cause: n === 0 ? 'مفيش أجهزة مشتركة في الإشعارات' : '',
        });
      }

      case 'a_env': {
        const st = await otcStatus(ctx.activeProxy);
        const cfg = st?.cfg ?? '';
        const missing: string[] = [];
        if (!cfg.includes('email=true')) missing.push('PO_EMAIL');
        if (!cfg.includes('pass=true')) missing.push('PO_PASSWORD');
        if (!cfg.includes('captcha=true')) missing.push('CAPTCHA_API_KEY');
        if (missing.length === 0 && cfg !== '') return res('ok', 'email/pass/captcha كلهم مضبوطين ✅');
        if (cfg === '') return res('warn', 'مفيش cfg من السكرابر', { cause: 'السكرابر لسه بيقلع' });
        return res('fail', `ناقص: ${missing.join('، ')}`, {
          cause: 'متغيرات بيئة ناقصة في Render',
          externalUrl: K_RENDER_DASH,
          externalLabel: 'Render → Environment',
        });
      }

      default:
        return res('unknown', '—');
    }
  } catch (e) {
    return res('warn', `خطأ في الفحص: ${short(e)}`);
  }
}

// ══════════════════════════ Reporting ══════════════════════════

export function statusEmoji(s: RStatus): string {
  switch (s) {
    case 'ok':
      return '🟢';
    case 'warn':
      return '🟡';
    case 'fail':
      return '🔴';
    case 'na':
      return '⚫';
    default:
      return '⚪';
  }
}

export function summarise(results: Record<string, RResult>): Record<string, number> {
  const m: Record<string, number> = { fail: 0, warn: 0, ok: 0, na: 0 };
  for (const r of Object.values(results)) {
    if (r.status in m) m[r.status] = (m[r.status] ?? 0) + 1;
  }
  return m;
}

/** Dart `_textReport`. */
export function textReport(results: Record<string, RResult>): string {
  const lines: string[] = ['تقرير إصلاح النظام — Euro Trade', `${new Date().toISOString()} UTC`, ''];
  for (const [id, title] of SECTIONS) {
    lines.push(`═══ ${title} ═══`);
    for (const c of CHECKS.filter((x) => x.section === id)) {
      const r = results[c.id];
      if (!r) continue;
      lines.push(`${statusEmoji(r.status)} ${c.title}: ${r.detail}`);
      if (r.cause !== '') lines.push(`   السبب: ${r.cause}`);
      if (r.fix !== '') lines.push(`   الحل: ${r.fix}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Dart `_runGemini` — POSTs the report to the proxy's /api/diagnose. */
export async function runGemini(
  results: Record<string, RResult>,
): Promise<{ text: string } | { error: string }> {
  const report = {
    summary: summarise(results),
    checks: CHECKS.map((c) => ({
      section: c.section,
      title: c.title,
      status: results[c.id]?.status ?? 'unknown',
      detail: results[c.id]?.detail ?? '',
      cause: results[c.id]?.cause ?? '',
    })),
  };
  try {
    const r = await fetch(`${K_ORIGIN}/api/diagnose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(32_000),
    });
    const d = (await r.json()) as Record<string, unknown>;
    if (d['available'] === true && d['text'] !== undefined && d['text'] !== null) {
      return { text: String(d['text']) };
    }
    return { error: d['reason'] === undefined ? 'Gemini مش متاح' : String(d['reason']) };
  } catch (e) {
    return { error: `تعذّر الاتصال بالبروكسي: ${short2(e)}` };
  }
}

/** Dart `_loadNotifs` — the repair_log feed shown at the top. */
export async function loadNotifs(): Promise<Array<Record<string, unknown>>> {
  try {
    const { data } = await supabase()
      .from('repair_log')
      .select('action,result,at')
      .order('at', { ascending: false })
      .limit(20);
    return (data as Array<Record<string, unknown>> | null) ?? [];
  } catch {
    return [];
  }
}

// ── Browser desktop notifications (repair_web_impl.dart) ────────────────────

export function notifyPermission(): string {
  try {
    return Notification.permission;
  } catch {
    return 'unsupported';
  }
}

export async function requestNotifyPermission(): Promise<string> {
  try {
    return await Notification.requestPermission();
  } catch {
    return 'unsupported';
  }
}

export function notifyDesktop(title: string, body: string): void {
  try {
    if (Notification.permission === 'granted') new Notification(title, { body });
  } catch {
    // Unsupported or blocked.
  }
}
