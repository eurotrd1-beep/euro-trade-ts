/**
 * Runtime theme override — the equivalent of `_loadAppTheme()` in main.dart.
 *
 * The admin can recolour the app from the `theme` config row without a rebuild.
 * Two shapes are supported, and both can be present in the same row:
 *
 *   • `primaryColor` / `secondaryColor` — Dart's 32-bit ARGB ints, which is
 *     what the Flutter admin wrote. Kept working so an existing row does not
 *     go dead.
 *   • `palette` / `mode` / `gradient` — the full token set written by
 *     /admin/theme. Takes precedence when present.
 */

import { supabase } from '@euro/shared';
import { THEME_TOKENS, parseThemeConfig, type ThemeConfig } from './themePresets';

/**
 * Converts Dart's 32-bit ARGB integer to a CSS colour.
 *
 * Flutter's `Color(0xFF00FFF0)` packs alpha in the high byte. A row written by
 * the current admin therefore arrives as a signed or unsigned int covering all
 * four channels; the alpha is dropped unless it is meaningful.
 */
export function argbToCss(value: number): string {
  const v = value >>> 0;
  const a = (v >>> 24) & 0xff;
  const r = (v >>> 16) & 0xff;
  const g = (v >>> 8) & 0xff;
  const b = v & 0xff;
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return a === 0xff || a === 0
    ? `#${hex(r)}${hex(g)}${hex(b)}`
    : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/** `#RRGGBB` → the ARGB int the Flutter admin stored, so both stay readable. */
export function cssToArgb(hex: string): number {
  const cleaned = hex.replace(/#/g, '').trim();
  return (0xff000000 | Number.parseInt(cleaned, 16)) >>> 0;
}

/**
 * Writes a full config onto the document. Exported so /admin/theme can preview
 * a preset live before it is saved.
 */
export function applyThemeConfig(cfg: ThemeConfig, root: HTMLElement = document.documentElement): void {
  for (const token of THEME_TOKENS) {
    root.style.setProperty(token.cssVar, cfg.palette[token.key]);
  }
  root.style.setProperty('--bg-gradient', cfg.gradient);
  root.style.colorScheme = cfg.mode;
  root.dataset['themeMode'] = cfg.mode;
}

/**
 * Applies the admin's palette override, if any. Silent on failure — the CSS
 * defaults in globals.css stand, which is what the Dart version does too.
 */
export async function loadAppTheme(): Promise<void> {
  try {
    const { data } = await supabase()
      .from('configs')
      .select('data')
      .eq('id', 'theme')
      .maybeSingle();

    const raw = (data?.['data'] ?? {}) as Record<string, unknown>;
    const root = document.documentElement;

    if (raw['palette'] && typeof raw['palette'] === 'object') {
      applyThemeConfig(parseThemeConfig(raw), root);
      return;
    }

    // Legacy row written by the Flutter admin: only the two accents.
    if (typeof raw['primaryColor'] === 'number') {
      root.style.setProperty('--accent-cyan', argbToCss(raw['primaryColor']));
    }
    if (typeof raw['secondaryColor'] === 'number') {
      root.style.setProperty('--accent-blue', argbToCss(raw['secondaryColor']));
    }
  } catch {
    // Network or permission failure — keep the defaults.
  }
}
