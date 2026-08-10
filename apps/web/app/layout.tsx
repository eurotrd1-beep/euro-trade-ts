/**
 * Root layout — the equivalent of `EuroTradeApp` in lib/main.dart.
 *
 * The Dart version wraps everything in a ValueListenableBuilder on the language
 * so the whole tree rebuilds and text direction flips on change. Here that job
 * belongs to `LanguageProvider`, which sets `dir` / `lang` on <html> and
 * re-renders its subtree.
 */

import type { Metadata, Viewport } from 'next';
import { Outfit } from 'next/font/google';
import { AppProviders } from '@/components/AppProviders';
import './globals.css';

// Matches GoogleFonts.outfit(), used throughout the Dart UI.
const outfit = Outfit({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-outfit',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Euro Trade - Premium VIP Signals',
  description: 'Premium VIP trading signals',
};

export const viewport: Viewport = {
  themeColor: '#0A0714',
  width: 'device-width',
  initialScale: 1,
  // The app is a full-screen trading UI; pinch-zoom fights the chart.
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `dir` and `lang` start at the Arabic default and are corrected on the
    // client once the stored choice loads, mirroring LanguageService's fallback.
    <html lang="ar" dir="rtl" className={outfit.variable}>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
