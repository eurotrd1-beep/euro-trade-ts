/**
 * App palette — the tokens declared in `app/globals.css` (`:root`), which the
 * whole user app references. The admin can override any of them at runtime
 * from the `theme` config row; nothing is rebuilt.
 *
 * The admin shell keeps its own `--admin-*` palette on purpose, so an operator
 * can always tell which app they are looking at.
 */

export type ThemeMode = 'dark' | 'light';

/** One editable colour: the CSS custom property and its Arabic label. */
export interface ThemeToken {
  key: keyof Palette;
  cssVar: string;
  label: string;
}

export interface Palette {
  spaceBg: string;
  cardBg: string;
  accentCyan: string;
  accentBlue: string;
  callGreen: string;
  putRed: string;
  warningOrange: string;
  textPrimary: string;
  textSecondary: string;
  borderGlow: string;
}

export const THEME_TOKENS: ThemeToken[] = [
  { key: 'spaceBg', cssVar: '--space-bg', label: 'خلفية التطبيق' },
  { key: 'cardBg', cssVar: '--card-bg', label: 'خلفية الكروت' },
  { key: 'accentCyan', cssVar: '--accent-cyan', label: 'اللون الأساسي' },
  { key: 'accentBlue', cssVar: '--accent-blue', label: 'اللون الثانوي' },
  { key: 'callGreen', cssVar: '--call-green', label: 'لون الشراء CALL' },
  { key: 'putRed', cssVar: '--put-red', label: 'لون البيع PUT' },
  { key: 'warningOrange', cssVar: '--warning-orange', label: 'لون التحذير' },
  { key: 'textPrimary', cssVar: '--text-primary', label: 'لون النص الأساسي' },
  { key: 'textSecondary', cssVar: '--text-secondary', label: 'لون النص الثانوي' },
  { key: 'borderGlow', cssVar: '--border-glow', label: 'لون الحدود' },
];

export interface ThemePreset {
  id: string;
  name: string;
  mode: ThemeMode;
  /** The page gradient. Kept explicit so a preset can set its own depth. */
  gradient: string;
  palette: Palette;
}

/** The shipped defaults from globals.css — "الافتراضي". */
export const DEFAULT_PRESET: ThemePreset = {
  id: 'default',
  name: 'الافتراضي (نيون)',
  mode: 'dark',
  gradient: 'linear-gradient(135deg, #06030c 0%, #0e091f 50%, #05030a 100%)',
  palette: {
    spaceBg: '#0A0714',
    cardBg: '#161129',
    accentCyan: '#00FFF0',
    accentBlue: '#1A8CFF',
    callGreen: '#00FF7F',
    putRed: '#FF2A6D',
    warningOrange: '#FFAD00',
    textPrimary: '#FFFFFF',
    textSecondary: '#8B88A0',
    borderGlow: '#2C2250',
  },
};

/**
 * Five ready themes: two light, three dark where black dominates and no pale
 * surface is used anywhere.
 */
export const THEME_PRESETS: ThemePreset[] = [
  // ── Dark ──────────────────────────────────────────────────────────────
  {
    id: 'oled',
    name: 'أسود مطلق',
    mode: 'dark',
    gradient: 'linear-gradient(135deg, #000000 0%, #050505 50%, #000000 100%)',
    palette: {
      spaceBg: '#000000',
      cardBg: '#0B0B0D',
      accentCyan: '#0E7490',
      accentBlue: '#155E75',
      callGreen: '#15803D',
      putRed: '#B91C1C',
      warningOrange: '#B45309',
      textPrimary: '#E4E4E7',
      textSecondary: '#71717A',
      borderGlow: '#1C1C1F',
    },
  },
  {
    id: 'charcoal',
    name: 'فحمي',
    mode: 'dark',
    gradient: 'linear-gradient(135deg, #08080A 0%, #121215 50%, #08080A 100%)',
    palette: {
      spaceBg: '#0C0C0E',
      cardBg: '#17171B',
      accentCyan: '#B45309',
      accentBlue: '#92400E',
      callGreen: '#166534',
      putRed: '#991B1B',
      warningOrange: '#A16207',
      textPrimary: '#E7E5E4',
      textSecondary: '#78716C',
      borderGlow: '#26262B',
    },
  },
  {
    id: 'midnight',
    name: 'ليلي',
    mode: 'dark',
    gradient: 'linear-gradient(135deg, #03040A 0%, #0A0C18 50%, #03040A 100%)',
    palette: {
      spaceBg: '#05070D',
      cardBg: '#101423',
      accentCyan: '#3730A3',
      accentBlue: '#1E3A8A',
      callGreen: '#15803D',
      putRed: '#9F1239',
      warningOrange: '#A16207',
      textPrimary: '#E2E8F0',
      textSecondary: '#64748B',
      borderGlow: '#1B2137',
    },
  },

  // ── Light ─────────────────────────────────────────────────────────────
  {
    id: 'daylight',
    name: 'نهاري',
    mode: 'light',
    gradient: 'linear-gradient(135deg, #FFFFFF 0%, #EEF2F7 50%, #F8FAFC 100%)',
    palette: {
      spaceBg: '#F5F7FA',
      cardBg: '#FFFFFF',
      accentCyan: '#0284C7',
      accentBlue: '#2563EB',
      callGreen: '#059669',
      putRed: '#DC2626',
      warningOrange: '#D97706',
      textPrimary: '#0F172A',
      textSecondary: '#64748B',
      borderGlow: '#E2E8F0',
    },
  },
  {
    id: 'pearl',
    name: 'لؤلؤي',
    mode: 'light',
    gradient: 'linear-gradient(135deg, #FDFBF7 0%, #F3ECE1 50%, #FBF8F3 100%)',
    palette: {
      spaceBg: '#FAF7F2',
      cardBg: '#FFFFFF',
      accentCyan: '#B08D57',
      accentBlue: '#8A6D3B',
      callGreen: '#2F855A',
      putRed: '#C53030',
      warningOrange: '#B7791F',
      textPrimary: '#1C1917',
      textSecondary: '#78716C',
      borderGlow: '#E7E0D5',
    },
  },
];

export const ALL_PRESETS: ThemePreset[] = [DEFAULT_PRESET, ...THEME_PRESETS];

/** What the `theme` config row stores. */
export interface ThemeConfig {
  preset: string;
  mode: ThemeMode;
  gradient: string;
  palette: Palette;
}

/** Normalises anything to `#RRGGBB`, falling back to the given default. */
export function safeHex(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/#/g, '').trim();
  return /^[0-9a-fA-F]{6}$/.test(cleaned) ? `#${cleaned.toUpperCase()}` : fallback;
}

/** Reads a stored row into a complete config, filling every gap from defaults. */
export function parseThemeConfig(raw: Record<string, unknown> | null | undefined): ThemeConfig {
  const source = (raw?.['palette'] ?? {}) as Record<string, unknown>;
  const palette = {} as Palette;
  for (const token of THEME_TOKENS) {
    palette[token.key] = safeHex(source[token.key], DEFAULT_PRESET.palette[token.key]);
  }

  return {
    preset: typeof raw?.['preset'] === 'string' ? (raw['preset'] as string) : 'default',
    mode: raw?.['mode'] === 'light' ? 'light' : 'dark',
    gradient:
      typeof raw?.['gradient'] === 'string' && (raw['gradient'] as string) !== ''
        ? (raw['gradient'] as string)
        : DEFAULT_PRESET.gradient,
    palette,
  };
}

/** A plain two-stop gradient derived from a background colour. */
export function gradientFor(bg: string): string {
  return `linear-gradient(135deg, ${bg} 0%, ${bg} 100%)`;
}
