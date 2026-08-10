/**
 * Brand marks, inlined as SVG.
 *
 * The emoji stand-ins (✈️ for Telegram, ▶ for YouTube) were placeholders and
 * read as a plane and a play button, not as the services. These are the real
 * logos, drawn with `currentColor` so the surrounding style still controls them.
 *
 * Inline rather than files: the site is a static export behind a strict CSP,
 * and these never change.
 */

export const TELEGRAM_BLUE = '#229ED9';
export const YOUTUBE_RED = '#FF0000';

export function TelegramIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.568 8.16l-1.86 8.77c-.14.62-.51.77-1.03.48l-2.85-2.1-1.37 1.32c-.15.15-.28.28-.58.28l.21-2.94 5.36-4.84c.23-.21-.05-.32-.36-.12l-6.62 4.17-2.85-.89c-.62-.19-.63-.62.13-.92l11.14-4.29c.52-.19.97.12.79.99z" />
    </svg>
  );
}

export function YouTubeIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.08 0 12 0 12s0 3.92.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.92 24 12 24 12s0-3.92-.5-5.81zM9.55 15.57V8.43L15.82 12l-6.27 3.57z" />
    </svg>
  );
}
