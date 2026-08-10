/**
 * Language state and the inline translation helper.
 *
 * Ported from lib/services/language_service.dart. The app keeps its Arabic
 * strings inline and pairs each with an English variant through `tr()`, so
 * switching language is instant and needs no message catalogue or code-gen.
 * That pattern is preserved exactly — every existing `tr('عربي', 'English')`
 * call site translates one-to-one.
 */

export type AppLanguage = 'arabic' | 'english';

const STORAGE_KEY = 'app_language';

type Listener = (lang: AppLanguage | null) => void;

/**
 * `null` means the user has NOT chosen yet (first launch) — the splash flow
 * uses that to show the language screen once.
 */
let current: AppLanguage | null = null;
const listeners = new Set<Listener>();

/** Arabic is the fallback, so a missing choice still reads correctly. */
export function isArabic(): boolean {
  return current !== 'english';
}

export function hasChosen(): boolean {
  return current !== null;
}

export function getLanguage(): AppLanguage | null {
  return current;
}

export function locale(): 'ar' | 'en' {
  return isArabic() ? 'ar' : 'en';
}

export function direction(): 'rtl' | 'ltr' {
  return isArabic() ? 'rtl' : 'ltr';
}

/** Loads the persisted choice. Leaves the state `null` when none was made. */
export function loadLanguage(): void {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (v === 'en') current = 'english';
    else if (v === 'ar') current = 'arabic';
  } catch {
    // Storage can be unavailable (private mode, SSR) — Arabic default stands.
  }
}

/** Persists and applies a choice, then notifies every subscriber. */
export function setLanguage(lang: AppLanguage): void {
  current = lang;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang === 'english' ? 'en' : 'ar');
  } catch {
    // Non-fatal: the choice still applies for this session.
  }
  for (const l of listeners) l(current);
}

/** Subscribes to language changes. Returns an unsubscribe function. */
export function onLanguageChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Inline translation. Returns the Arabic or English variant for the current
 * language. Both sides are evaluated at the call site, so interpolation works
 * normally: `tr(\`مرحبا ${name}\`, \`Hello ${name}\`)`.
 */
export function tr(ar: string, en: string): string {
  return isArabic() ? ar : en;
}
