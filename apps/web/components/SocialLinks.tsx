'use client';

/**
 * The social links, as the app draws them.
 *
 * One component rather than a link written out at each site: the icon, the
 * brand colour, the `rel="noopener noreferrer"` and the hidden label are the
 * same everywhere, and the thing that varies — whether a link exists at all —
 * is the one thing each site kept getting wrong. A link that is not configured
 * renders nothing here, so no screen has to remember to check.
 */

import type { ComponentType, CSSProperties } from 'react';
import {
  TelegramIcon,
  YouTubeIcon,
  WhatsAppIcon,
  InstagramIcon,
  TikTokIcon,
  FacebookIcon,
  XIcon,
  TELEGRAM_BLUE,
  YOUTUBE_RED,
  WHATSAPP_GREEN,
  INSTAGRAM_PINK,
  TIKTOK_CYAN,
  FACEBOOK_BLUE,
  X_INK,
} from './BrandIcons';
import { SOCIAL_PLATFORMS, type SocialId, type SocialLinks } from '@/lib/social';
import styles from './SocialLinks.module.css';

interface Mark {
  Icon: ComponentType<{ size?: number }>;
  colour: string;
}

const MARKS: Record<SocialId, Mark> = {
  telegram: { Icon: TelegramIcon, colour: TELEGRAM_BLUE },
  telegramVip: { Icon: TelegramIcon, colour: TELEGRAM_BLUE },
  youtube: { Icon: YouTubeIcon, colour: YOUTUBE_RED },
  whatsapp: { Icon: WhatsAppIcon, colour: WHATSAPP_GREEN },
  instagram: { Icon: InstagramIcon, colour: INSTAGRAM_PINK },
  tiktok: { Icon: TikTokIcon, colour: TIKTOK_CYAN },
  facebook: { Icon: FacebookIcon, colour: FACEBOOK_BLUE },
  x: { Icon: XIcon, colour: X_INK },
};

export function SocialIcon({ id, size = 18 }: { id: SocialId; size?: number }) {
  const { Icon } = MARKS[id];
  return <Icon size={size} />;
}

export function socialColour(id: SocialId): string {
  return MARKS[id].colour;
}

interface SocialRowProps {
  links: SocialLinks;
  /** Which platforms this row may show. Defaults to all of them. */
  only?: readonly SocialId[];
  size?: number;
  className?: string;
}

/**
 * The configured links as a row of icon buttons, in the order of the platform
 * table. Renders nothing at all when none of them are set, so a caller can drop
 * it into a layout without a surrounding condition.
 */
export function SocialRow({ links, only, size = 18, className }: SocialRowProps) {
  const shown = SOCIAL_PLATFORMS.filter(
    (p) => (!only || only.includes(p.id)) && links[p.id] !== '',
  );
  if (shown.length === 0) return null;

  return (
    <div className={className ? `${styles.row} ${className}` : styles.row}>
      {shown.map((p) => (
        <a
          key={p.id}
          href={links[p.id]}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.chip}
          style={{ '--brand': MARKS[p.id].colour } as CSSProperties}
          title={p.ar}
        >
          <SocialIcon id={p.id} size={size} />
          <span className="sr-only">{p.ar}</span>
        </a>
      ))}
    </div>
  );
}
