/**
 * The social links, now that the admin owns them.
 *
 * Two things are worth pinning down. One is what an operator can type into the
 * admin field and still end up with a working button — the field is the only
 * way any of these links can be set now, so a paste that silently produces a
 * dead link is a regression with no workaround. The other is that the links
 * stayed in one file: the bug this replaced was three components each holding
 * their own copy of a Telegram URL, and two of them pointing at different
 * channels, which no amount of unit testing of any one of them would show.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  NO_SOCIAL_LINKS,
  SOCIAL_PLATFORMS,
  TELEGRAM_PROMO_FALLBACK,
  TELEGRAM_VIP_FALLBACK,
  normaliseSocialUrl,
  promoLink,
  readSocialLinks,
  socialHostWarning,
  socialLinksToData,
  socialUrlError,
  vipLink,
  type SocialLinks,
} from '../lib/social.js';

const platform = (id: string) => SOCIAL_PLATFORMS.find((p) => p.id === id)!;

describe('what an operator can paste', () => {
  it('adds the scheme to a bare address', () => {
    // `t.me/euro_trd` is what Telegram's own "copy link" button gives you on
    // some clients. Stored as typed, the browser reads it as a relative path
    // and the button goes to /app/t.me/euro_trd — a broken app, not an
    // obviously mistyped setting.
    expect(normaliseSocialUrl('t.me/euro_trd')).toBe('https://t.me/euro_trd');
  });

  it('keeps an address that already has one', () => {
    expect(normaliseSocialUrl('https://t.me/euro_trd')).toBe('https://t.me/euro_trd');
    expect(normaliseSocialUrl('http://t.me/euro_trd')).toBe('http://t.me/euro_trd');
  });

  it('trims spaces and the trailing slash', () => {
    expect(normaliseSocialUrl('  https://instagram.com/page/  ')).toBe(
      'https://instagram.com/page',
    );
  });

  it('refuses something that is not an address at all', () => {
    expect(normaliseSocialUrl('')).toBe('');
    expect(normaliseSocialUrl('   ')).toBe('');
    expect(socialUrlError('@euro_trd')).not.toBeNull();
  });

  it('treats empty as a setting, not a mistake', () => {
    // Empty is how a link is switched off, so it can never be a save error.
    expect(socialUrlError('')).toBeNull();
  });

  it('warns about an unexpected host without blocking it', () => {
    // A shortener or a landing page is a legitimate thing to put here. Refusing
    // to save it is how somebody ends up hardcoding a URL again.
    const tg = platform('telegram');
    expect(socialHostWarning(tg, 'https://t.me/euro_trd')).toBeNull();
    expect(socialHostWarning(tg, 'https://bit.ly/abc')).not.toBeNull();
    expect(socialUrlError('https://bit.ly/abc')).toBeNull();
  });

  it('accepts a subdomain of the platform', () => {
    expect(socialHostWarning(platform('facebook'), 'https://m.facebook.com/page')).toBeNull();
  });
});

describe('the config row', () => {
  it('reads the three keys that already existed', () => {
    // The row in production holds exactly these. Renaming any of them would
    // have blanked every link in the app on deploy.
    const links = readSocialLinks({
      telegram: 'https://t.me/euro_trd1',
      whatsapp: 'https://wa.me/201234567890',
      youtube: 'https://youtube.com/@euro',
    });
    expect(links.telegram).toBe('https://t.me/euro_trd1');
    expect(links.whatsapp).toBe('https://wa.me/201234567890');
    expect(links.youtube).toBe('https://youtube.com/@euro');
  });

  it('treats a missing row as everything switched off', () => {
    expect(readSocialLinks(null)).toEqual(NO_SOCIAL_LINKS);
    expect(readSocialLinks({})).toEqual(NO_SOCIAL_LINKS);
  });

  it('ignores a value that is not a string', () => {
    expect(readSocialLinks({ telegram: 42, youtube: null }).telegram).toBe('');
  });

  it('survives a round trip', () => {
    const links: SocialLinks = { ...NO_SOCIAL_LINKS, telegram: 't.me/x', x: 'x.com/y' };
    const stored = socialLinksToData(links);
    expect(stored['telegram']).toBe('https://t.me/x');
    expect(readSocialLinks(stored).x).toBe('https://x.com/y');
  });

  it('has a distinct key per platform', () => {
    const keys = SOCIAL_PLATFORMS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the two buttons that must lead somewhere', () => {
  it('falls back to what the deleted constants held', () => {
    // An installation with an empty row behaves exactly as it did before the
    // links moved into the admin panel.
    expect(vipLink(NO_SOCIAL_LINKS)).toBe(TELEGRAM_VIP_FALLBACK);
    expect(promoLink(NO_SOCIAL_LINKS)).toBe(TELEGRAM_PROMO_FALLBACK);
  });

  it('prefers the configured link', () => {
    expect(vipLink({ ...NO_SOCIAL_LINKS, telegramVip: 'https://t.me/new' })).toBe(
      'https://t.me/new',
    );
    expect(promoLink({ ...NO_SOCIAL_LINKS, telegram: 'https://t.me/new' })).toBe(
      'https://t.me/new',
    );
  });
});

describe('there is one copy of each link', () => {
  it('no component hardcodes a social address', () => {
    // The whole point. Three components each held their own Telegram URL and
    // two of them disagreed about which channel to send people to; nothing
    // caught it, because each one was correct on its own terms.
    const root = join(import.meta.dirname, '..');
    const skipDirs = new Set(['node_modules', '.next', 'out', 'test']);
    const allowed = new Set([join(root, 'lib', 'social.ts')]);
    const hosts = /(t\.me|telegram\.me|wa\.me|whatsapp\.com|youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|fb\.me|twitter\.com|x\.com)\//;

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (!skipDirs.has(entry) && !entry.startsWith('.')) walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || allowed.has(full)) continue;
        const code = readFileSync(full, 'utf8')
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join('\n');
        if (hosts.test(code)) offenders.push(full.slice(root.length + 1));
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});
