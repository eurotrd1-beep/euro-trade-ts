/**
 * Runtime theme override — the equivalent of `_loadAppTheme()` in main.dart.
 *
 * The admin can recolour the app from the `theme` config row without a rebuild.
 * Dart stores the two accents as 32-bit ARGB ints (`Color(primary)`); the same
 * ints are converted to CSS hex here so an existing row keeps working
 * unchanged.
 */

import { supabase } from '@euro/shared';

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

    const cfg = (data?.['data'] ?? {}) as { primaryColor?: number; secondaryColor?: number };
    const root = document.documentElement;

    if (typeof cfg.primaryColor === 'number') {
      root.style.setProperty('--accent-cyan', argbToCss(cfg.primaryColor));
    }
    if (typeof cfg.secondaryColor === 'number') {
      root.style.setProperty('--accent-blue', argbToCss(cfg.secondaryColor));
    }
  } catch {
    // Network or permission failure — keep the defaults.
  }
}
