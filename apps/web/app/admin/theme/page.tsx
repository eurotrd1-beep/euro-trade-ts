'use client';

/**
 * Theme control — recolours the whole user app from the `theme` config row.
 *
 * The app reads this row on boot (`loadAppTheme`), so a save takes effect on
 * the next load for every user with no rebuild and no release. The admin shell
 * keeps its own palette, which is why the preview below is a scoped box rather
 * than the live page.
 *
 * `primaryColor` / `secondaryColor` are written alongside the palette as ARGB
 * ints so the old Flutter app, which only understands those two, still picks up
 * the accents.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@euro/shared';
import { cssToArgb } from '@/lib/theme';
import {
  ALL_PRESETS,
  DEFAULT_PRESET,
  THEME_TOKENS,
  gradientFor,
  parseThemeConfig,
  safeHex,
  type Palette,
  type ThemeConfig,
} from '@/lib/themePresets';
import styles from '../admin.module.css';

export default function ThemeView() {
  const [cfg, setCfg] = useState<ThemeConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await supabase().from('configs').select('data').eq('id', 'theme').maybeSingle();
        const raw = (data?.['data'] ?? {}) as Record<string, unknown>;
        // A legacy row has no palette; start from the shipped defaults.
        setCfg(
          raw['palette']
            ? parseThemeConfig(raw)
            : { preset: 'default', mode: 'dark', gradient: DEFAULT_PRESET.gradient, palette: { ...DEFAULT_PRESET.palette } },
        );
      } catch {
        setCfg({ preset: 'default', mode: 'dark', gradient: DEFAULT_PRESET.gradient, palette: { ...DEFAULT_PRESET.palette } });
        setMessage({ kind: 'error', text: 'تعذّر تحميل الثيم الحالي — بدأنا من الافتراضي' });
      }
    })();
  }, []);

  function setColor(key: keyof Palette, value: string): void {
    if (!cfg) return;
    // Any hand-edit stops it being one of the ready presets.
    setCfg({ ...cfg, preset: 'custom', palette: { ...cfg.palette, [key]: value } });
  }

  async function save(): Promise<void> {
    if (!cfg) return;
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabase()
        .from('configs')
        .upsert({
          id: 'theme',
          data: {
            preset: cfg.preset,
            mode: cfg.mode,
            gradient: cfg.gradient,
            palette: cfg.palette,
            // Legacy fields, for the old Flutter build.
            primaryColor: cssToArgb(cfg.palette.accentCyan),
            secondaryColor: cssToArgb(cfg.palette.accentBlue),
            updatedAt: new Date().toISOString(),
          },
        });
      if (error) throw error;
      setMessage({ kind: 'ok', text: 'تم حفظ الثيم ✅ — هيظهر لكل المستخدمين عند فتح التطبيق' });
    } catch (e) {
      setMessage({ kind: 'error', text: `خطأ أثناء الحفظ: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) {
    return (
      <section>
        <h1 className={styles.title}>ثيم التطبيق</h1>
        <p className={styles.muted}>جاري التحميل...</p>
      </section>
    );
  }

  return (
    <section>
      <h1 className={styles.title}>ثيم التطبيق</h1>

      <p className={styles.info}>
        ℹ️ الألوان دي بتتطبق على تطبيق المستخدم كله. لوحة الأدمن بتفضل بألوانها عشان تفرق بينهم.
      </p>

      {message && <p className={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</p>}

      {/* ── Ready presets ──────────────────────────────────────────────── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>ثيمات جاهزة</h2>
        <div className={styles.presetGrid}>
          {ALL_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() =>
                setCfg({ preset: p.id, mode: p.mode, gradient: p.gradient, palette: { ...p.palette } })
              }
              aria-pressed={cfg.preset === p.id}
              className={`${styles.preset} ${cfg.preset === p.id ? styles.presetActive : ''}`}
              style={{ background: p.gradient }}
            >
              <span className={styles.presetSwatches}>
                {[p.palette.accentCyan, p.palette.accentBlue, p.palette.callGreen, p.palette.putRed].map(
                  (c) => (
                    <span key={c} style={{ background: c }} />
                  ),
                )}
              </span>
              <span className={styles.presetName} style={{ color: p.palette.textPrimary }}>
                {p.name}
              </span>
              <span className={styles.presetMode} style={{ color: p.palette.textSecondary }}>
                {p.mode === 'dark' ? 'داكن' : 'فاتح'}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Custom colours ─────────────────────────────────────────────── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>ألوان مخصصة</h2>

        <div className={styles.switchRow}>
          <div>
            <span className={styles.switchLabel}>وضع الثيم</span>
            <p className={styles.switchHint}>بيحدد لون واجهات المتصفح (شريط التمرير وحقول الإدخال).</p>
          </div>
          <div className={styles.filters}>
            {(['dark', 'light'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setCfg({ ...cfg, mode: m, preset: 'custom' })}
                aria-pressed={cfg.mode === m}
                className={`${styles.chip} ${cfg.mode === m ? styles.chipActive : ''}`}
              >
                {m === 'dark' ? 'داكن' : 'فاتح'}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.colorGrid}>
          {THEME_TOKENS.map((token) => (
            <div key={token.key} className={styles.colorField}>
              <span className={styles.label}>{token.label}</span>
              <div className={styles.colorRow} style={{ marginBottom: 0 }}>
                <input
                  type="color"
                  value={cfg.palette[token.key]}
                  onChange={(e) => setColor(token.key, e.target.value.toUpperCase())}
                  className={styles.colorInput}
                  aria-label={token.label}
                />
                <input
                  value={cfg.palette[token.key]}
                  onChange={(e) => setColor(token.key, safeHex(e.target.value, cfg.palette[token.key]))}
                  className={styles.input}
                  dir="ltr"
                />
              </div>
            </div>
          ))}
        </div>

        <div className={styles.field} style={{ marginTop: 14 }}>
          <span className={styles.label}>تدرّج الخلفية (CSS gradient)</span>
          <input
            value={cfg.gradient}
            onChange={(e) => setCfg({ ...cfg, gradient: e.target.value, preset: 'custom' })}
            className={styles.input}
            dir="ltr"
          />
          <button
            type="button"
            onClick={() => setCfg({ ...cfg, gradient: gradientFor(cfg.palette.spaceBg), preset: 'custom' })}
            className={styles.actionBtn}
            style={{ marginTop: 8, alignSelf: 'flex-start' }}
          >
            اشتقّه من لون الخلفية
          </button>
        </div>
      </div>

      {/* ── Live preview ───────────────────────────────────────────────── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>معاينة</h2>
        <ThemePreview cfg={cfg} />
      </div>

      <div className={styles.actions}>
        <button type="button" disabled={busy} onClick={() => void save()} className={styles.primaryBtn}>
          {busy ? 'جاري الحفظ...' : 'حفظ الثيم'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            setCfg({
              preset: 'default',
              mode: 'dark',
              gradient: DEFAULT_PRESET.gradient,
              palette: { ...DEFAULT_PRESET.palette },
            })
          }
          className={styles.actionBtn}
        >
          رجوع للافتراضي
        </button>
      </div>
    </section>
  );
}

/**
 * A miniature of the app's own surfaces, driven by the same custom properties
 * the real screens use — so what is shown here is what ships.
 */
function ThemePreview({ cfg }: { cfg: ThemeConfig }) {
  const vars = Object.fromEntries(
    THEME_TOKENS.map((t) => [t.cssVar, cfg.palette[t.key]]),
  ) as React.CSSProperties;

  return (
    <div className={styles.preview} style={{ ...vars, background: cfg.gradient }} dir="rtl">
      <div className={styles.previewCard}>
        <div className={styles.previewHead}>
          <strong className={styles.previewTitle}>EUR/USD (OTC)</strong>
          <span className={styles.previewBadge}>VIP</span>
        </div>
        <p className={styles.previewMuted}>الثقة 87% · انتهاء بعد 1 دقيقة</p>
        <div className={styles.previewRow}>
          <span className={styles.previewCall}>▲ CALL</span>
          <span className={styles.previewPut}>▼ PUT</span>
          <span className={styles.previewWarn}>⚠ تحذير</span>
        </div>
        <button type="button" className={styles.previewBtn}>
          استخراج الإشارة الفورية ⚡
        </button>
      </div>
    </div>
  );
}
