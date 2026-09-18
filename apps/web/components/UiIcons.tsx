/**
 * The interface icon set.
 *
 * ── WHY NOT EMOJI ──────────────────────────────────────────────────────────
 *
 * The screen used 🧠 ⚙️ 📊 👀 🎛 🔒 as section marks. Each one is a different
 * artwork drawn by the platform, at a different optical weight and in colours
 * nothing here chose — a pink brain and a blue gear beside a cyan panel — and
 * they change under the user on an OS update. They read as decoration, which
 * is exactly what a section mark must not do.
 *
 * These are one family: 24px box, 1.5 stroke, round caps, `currentColor`, so
 * the surrounding style decides the colour and every mark sits at the same
 * weight. Inline rather than files, because the site is a static export behind
 * a strict CSP.
 */

function Line({ size, children }: { size: number; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** The analysis panel: a waveform being read. */
export function SignalIcon({ size = 16 }: { size?: number }) {
  return (
    <Line size={size}>
      <path d="M3 12h3l2.5-6 3 12 2.5-9 2 3h5" />
    </Line>
  );
}

export function GearIcon({ size = 16 }: { size?: number }) {
  return (
    <Line size={size}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V10a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Line>
  );
}

/** Results and statistics. */
export function ChartIcon({ size = 16 }: { size?: number }) {
  return (
    <Line size={size}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </Line>
  );
}

/** The live feed: something arriving. */
export function PulseIcon({ size = 16 }: { size?: number }) {
  return (
    <Line size={size}>
      <path d="M2 12h4l2-5 4 10 2-5h8" />
    </Line>
  );
}

/** The watch list: pairs being followed. */
export function WatchIcon({ size = 16 }: { size?: number }) {
  return (
    <Line size={size}>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </Line>
  );
}

export function LockIcon({ size = 16 }: { size?: number }) {
  return (
    <Line size={size}>
      <rect x="4" y="10" width="16" height="10" rx="1.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Line>
  );
}

export function ShieldIcon({ size = 16 }: { size?: number }) {
  return (
    <Line size={size}>
      <path d="M12 3l7 3v5.5c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6z" />
    </Line>
  );
}
