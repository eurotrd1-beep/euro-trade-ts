/**
 * Every social destination the app links to, in one table.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * The links were in three places at once: a `social` config row holding three
 * of them, and three `const TELEGRAM_VIP_URL = 'https://t.me/...'` lines in
 * three components. Changing where the VIP button points meant a code change
 * and a deploy, and meant finding all three — the login page and the account
 * card pointed at one channel and the promo overlay at another, which is the
 * kind of drift a hardcoded constant produces on its own.
 *
 * So: the table below is the list of platforms, the `social` config row is the
 * list of addresses, and the admin panel is the only place either is edited.
 * A component asks for a link and renders nothing if there is none.
 *
 * ── ADDING A PLATFORM ──────────────────────────────────────────────────────
 *
 * Add a row here and an icon in `components/SocialLinks.tsx`. The admin field,
 * the validation and the icon row on the login screen all follow from the
 * table; none of them need touching.
 */

export type SocialId =
  | 'telegram'
  | 'telegramVip'
  | 'whatsapp'
  | 'youtube'
  | 'instagram'
  | 'tiktok'
  | 'facebook'
  | 'x';

export interface SocialPlatform {
  id: SocialId;
  /**
   * Key inside the `social` config row. The three original keys are kept
   * exactly as they were, so the existing row keeps working unread.
   */
  key: string;
  ar: string;
  en: string;
  /** Hosts the real thing uses, for the "that does not look right" hint. */
  hosts: readonly string[];
  /** Shown in the admin field while it is empty. */
  sample: string;
  /** Where in the app this link shows up, for whoever is editing it. */
  where: string;
}

/** The config row every address lives in. */
export const SOCIAL_CONFIG_ID = 'social';

export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = [
  {
    id: 'telegramVip',
    key: 'telegram_vip',
    ar: 'تيليجرام VIP',
    en: 'Telegram VIP',
    hosts: ['t.me', 'telegram.me'],
    sample: 'https://t.me/euro_trd',
    where: 'زر الاشتراك في شاشة الدخول وكارت الحساب',
  },
  {
    id: 'telegram',
    key: 'telegram',
    ar: 'قناة تيليجرام',
    en: 'Telegram channel',
    hosts: ['t.me', 'telegram.me'],
    sample: 'https://t.me/euro_trd1',
    where: 'كارت القناة، زر الهيدر، وعرض الترقية',
  },
  {
    id: 'youtube',
    key: 'youtube',
    ar: 'يوتيوب',
    en: 'YouTube',
    hosts: ['youtube.com', 'youtu.be'],
    sample: 'https://youtube.com/@channel',
    where: 'كارت القناة في شاشة الدخول',
  },
  {
    id: 'whatsapp',
    key: 'whatsapp',
    ar: 'واتساب',
    en: 'WhatsApp',
    hosts: ['wa.me', 'chat.whatsapp.com', 'api.whatsapp.com', 'whatsapp.com'],
    sample: 'https://wa.me/201234567890',
    where: 'صف الأيقونات في شاشة الدخول',
  },
  {
    id: 'instagram',
    key: 'instagram',
    ar: 'إنستجرام',
    en: 'Instagram',
    hosts: ['instagram.com'],
    sample: 'https://instagram.com/page',
    where: 'صف الأيقونات في شاشة الدخول',
  },
  {
    id: 'tiktok',
    key: 'tiktok',
    ar: 'تيك توك',
    en: 'TikTok',
    hosts: ['tiktok.com'],
    sample: 'https://tiktok.com/@page',
    where: 'صف الأيقونات في شاشة الدخول',
  },
  {
    id: 'facebook',
    key: 'facebook',
    ar: 'فيسبوك',
    en: 'Facebook',
    hosts: ['facebook.com', 'fb.com', 'fb.me', 'm.facebook.com'],
    sample: 'https://facebook.com/page',
    where: 'صف الأيقونات في شاشة الدخول',
  },
  {
    id: 'x',
    key: 'x',
    ar: 'إكس (تويتر)',
    en: 'X (Twitter)',
    hosts: ['x.com', 'twitter.com'],
    sample: 'https://x.com/page',
    where: 'صف الأيقونات في شاشة الدخول',
  },
] as const;

export type SocialLinks = Record<SocialId, string>;

/** Nothing configured. An empty link means "hide whatever would have linked". */
export const NO_SOCIAL_LINKS: SocialLinks = {
  telegram: '',
  telegramVip: '',
  whatsapp: '',
  youtube: '',
  instagram: '',
  tiktok: '',
  facebook: '',
  x: '',
};

/**
 * The two buttons that must lead somewhere even before an admin has filled the
 * row in. "اشترك الآن" and the promo call to action are the point of the
 * screens they sit on, and a dead button there is worse than a stale one.
 * Every other link simply disappears when it is not set.
 *
 * These are the values the three deleted constants held, so an installation
 * with an empty config row behaves exactly as it did before.
 */
export const TELEGRAM_VIP_FALLBACK = 'https://t.me/euro_trd';
export const TELEGRAM_PROMO_FALLBACK = 'https://t.me/euro_trd1';

/** Where "اشترك في VIP" goes, configured or not. */
export function vipLink(links: SocialLinks): string {
  return links.telegramVip !== '' ? links.telegramVip : TELEGRAM_VIP_FALLBACK;
}

/** Where the promo overlay's call to action goes, configured or not. */
export function promoLink(links: SocialLinks): string {
  return links.telegram !== '' ? links.telegram : TELEGRAM_PROMO_FALLBACK;
}

function host(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    // A Telegram handle — `@euro_trd` — parses as a URL once a scheme is
    // bolted on: the browser reads the `@` as credentials and `euro_trd` as
    // the host, so the field accepts it and the button leads nowhere. Pasting
    // the handle instead of the link is the likeliest mistake there is here,
    // so a name with no dot in it, or anything carrying credentials, is not an
    // address.
    if (u.username !== '' || u.password !== '') return '';
    if (!u.hostname.includes('.')) return '';
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * What actually gets stored: trimmed, given a scheme if it is missing, and
 * without a trailing slash.
 *
 * Someone pasting `t.me/euro_trd` straight out of Telegram is the common case,
 * and a link with no scheme is read as a relative path by the browser — the
 * button would have gone to `/app/t.me/euro_trd` and looked like a broken app
 * rather than a mistyped setting.
 */
export function normaliseSocialUrl(raw: string): string {
  let url = (raw ?? '').trim();
  if (url === '') return '';
  const lower = url.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    url = 'https://' + url;
  }
  while (url.endsWith('/')) url = url.slice(0, -1);
  return host(url) === '' ? '' : url;
}

/** A reason the link cannot be saved, or null. Empty is always allowed. */
export function socialUrlError(url: string): string | null {
  if (url.trim() === '') return null;
  return normaliseSocialUrl(url) === '' ? 'رابط غير صالح' : null;
}

/**
 * A reason to look twice, or null. Deliberately not an error: a link shortener,
 * a landing page, or a host nobody here has heard of is a legitimate thing to
 * put in one of these fields, and refusing to save it would make the admin
 * panel the reason someone goes back to hardcoding a URL.
 */
export function socialHostWarning(platform: SocialPlatform, url: string): string | null {
  const h = host(normaliseSocialUrl(url));
  if (h === '') return null;
  const known = platform.hosts.some((k) => h === k || h.endsWith('.' + k));
  return known ? null : 'المضيف مش ' + (platform.hosts[0] ?? '') + ' — اتأكد من الرابط';
}

/** Reads the `social` config row. Anything missing or not a string is "unset". */
export function readSocialLinks(data: Record<string, unknown> | null | undefined): SocialLinks {
  const links: SocialLinks = { ...NO_SOCIAL_LINKS };
  if (!data) return links;
  for (const p of SOCIAL_PLATFORMS) {
    const v = data[p.key];
    if (typeof v === 'string') links[p.id] = normaliseSocialUrl(v);
  }
  return links;
}

/** The shape written back to the config row. */
export function socialLinksToData(links: SocialLinks): Record<string, string> {
  const data: Record<string, string> = {};
  for (const p of SOCIAL_PLATFORMS) data[p.key] = normaliseSocialUrl(links[p.id]);
  return data;
}
