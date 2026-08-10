'use client';

/**
 * App-wide bootstrap — the equivalent of the `main()` function in
 * lib/main.dart, minus the Flutter-specific error plumbing.
 *
 * Dart's main() does, in order:
 *   1. Supabase.initialize          → the shared client is lazy, nothing to do
 *   2. LanguageService.load()       → loadLanguage()
 *   3. ServerConfig.load()          → loadProxyUrl()
 *   4. ServerConfig.startRealtime() → startProxyRealtime()
 *   5. _loadAppTheme()              → loadAppTheme()
 *   6. runApp()
 *
 * Steps 3-5 hit the network. The Dart app awaits them before the first frame;
 * here the splash renders immediately and they resolve underneath it, which is
 * the same user-visible sequence — the splash is on screen for 3.2s either way.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import {
  getLanguage,
  loadLanguage,
  onLanguageChange,
  setLanguage as applyLanguage,
  direction,
  locale,
  type AppLanguage,
} from '@euro/shared';
import { loadProxyUrl, startProxyRealtime } from '@euro/shared';
import { loadAppTheme } from '@/lib/theme';
import { initBackButton, initNetworkWatch, initStatusBar, hideSplash } from '@/lib/native';

interface LanguageContextValue {
  language: AppLanguage | null;
  setLanguage: (lang: AppLanguage) => void;
  /** True once the persisted choice has been read. */
  ready: boolean;
  /** Browser/native connectivity, for the offline banner. */
  online: boolean;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: null,
  setLanguage: () => {},
  ready: false,
  online: true,
});

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [language, setLang] = useState<AppLanguage | null>(null);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    loadLanguage();
    setLang(getLanguage());
    setReady(true);

    const unsubscribe = onLanguageChange(setLang);

    // Fire-and-forget: a failure here leaves the documented fallbacks in place
    // (default proxy URL, default palette), exactly as the Dart version does.
    void loadProxyUrl();
    void loadAppTheme();
    const stopRealtime = startProxyRealtime();

    // Native shell wiring. All no-ops in a browser, so the same build serves
    // both targets.
    void initStatusBar();
    void hideSplash();
    let stopBackButton: (() => void) | null = null;
    void initBackButton().then((off) => {
      stopBackButton = off;
    });
    const stopNetworkWatch = initNetworkWatch(setOnline);

    return () => {
      unsubscribe();
      stopRealtime();
      stopBackButton?.();
      stopNetworkWatch();
    };
  }, []);

  // Keep <html> in sync so CSS logical properties and the browser agree with
  // the chosen language.
  useEffect(() => {
    if (!ready) return;
    document.documentElement.dir = direction();
    document.documentElement.lang = locale();
  }, [language, ready]);

  return (
    <LanguageContext.Provider
      value={{ language, setLanguage: applyLanguage, ready, online }}
    >
      {children}
    </LanguageContext.Provider>
  );
}
