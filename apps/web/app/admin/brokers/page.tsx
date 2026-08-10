'use client';

/**
 * Broker management — ported from `_buildBrokerManagementView`
 * (admin_dashboard.dart:4613) and `_showBrokerDialog` (:4851).
 *
 * These rows drive the notice screen and the login screen's platform picker,
 * so `click_key` matters more than it looks: it is the analytics key AND the
 * value attributed to a user's account on first login.
 *
 * The logo is stored inline as a `data:` URL, exactly as the Dart admin does —
 * `_pickLogoImage` downscales to 160×160 at quality 85 and base64-encodes it,
 * so there is no storage bucket involved.
 */

import { useEffect, useRef, useState } from 'react';
import { supabase, type BrokerRow } from '@euro/shared';
import styles from '../admin.module.css';

const ACCENT_CYAN = '#06B6D4';

type Draft = {
  id?: string;
  name: string;
  logo_url: string;
  registration_link: string;
  click_key: string;
  promo_code: string;
  bonus_percent: string;
  min_deposit: string;
  order: string;
  is_recommended: boolean;
  is_active: boolean;
  themeColor: string;
};

const EMPTY_DRAFT: Draft = {
  name: '',
  logo_url: '',
  registration_link: '',
  click_key: '',
  promo_code: '',
  bonus_percent: '0',
  min_deposit: '0',
  order: '1',
  is_recommended: false,
  is_active: true,
  themeColor: ACCENT_CYAN,
};

/** `_hexToColor` — anything that is not `#RRGGBB` falls back to the accent. */
function normalizeHex(hex: string): string {
  const cleaned = hex.replace(/#/g, '').trim();
  return /^[0-9a-fA-F]{6}$/.test(cleaned) ? `#${cleaned.toUpperCase()}` : ACCENT_CYAN;
}

/**
 * `image_picker`'s `maxWidth/maxHeight/imageQuality` equivalent: fit inside
 * 160×160 keeping the aspect ratio, re-encode as JPEG at 0.85.
 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        const scale = Math.min(1, 160 / img.width, 160 / img.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(String(reader.result));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export default function BrokersView() {
  const [brokers, setBrokers] = useState<BrokerRow[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [colorFor, setColorFor] = useState<BrokerRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function load(): Promise<void> {
    try {
      const { data } = await supabase().from('brokers').select('*').order('order');
      setBrokers((data as BrokerRow[] | null) ?? []);
    } catch {
      setBrokers([]);
      setMessage({ kind: 'error', text: 'تعذّر تحميل المنصات' });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openDialog(row: BrokerRow | null): void {
    setMessage(null);
    if (!row) {
      setDraft({ ...EMPTY_DRAFT });
      return;
    }
    setDraft({
      id: row.id,
      name: row.name ?? '',
      logo_url: row.logo_url ?? '',
      registration_link: row.registration_link ?? '',
      click_key: row.click_key ?? '',
      promo_code: row.promo_code ?? '',
      bonus_percent: String(row.bonus_percent ?? 0),
      min_deposit: String(row.min_deposit ?? 0),
      order: String(row.order ?? 1),
      is_recommended: row.is_recommended ?? false,
      is_active: row.is_active ?? true,
      themeColor: row.themeColor ? normalizeHex(row.themeColor) : ACCENT_CYAN,
    });
  }

  /** `_saveBroker`. */
  async function save(): Promise<void> {
    if (!draft) return;
    const name = draft.name.trim();
    const link = draft.registration_link.trim();
    if (!name || !link) {
      setMessage({ kind: 'error', text: 'الاسم ورابط التسجيل مطلوبان' });
      return;
    }
    setBusy(true);
    try {
      const clickKey = draft.click_key.trim();
      const payload: Record<string, unknown> = {
        name,
        logo_url: draft.logo_url.trim(),
        registration_link: link,
        promo_code: draft.promo_code.trim(),
        bonus_percent: Number.parseInt(draft.bonus_percent, 10) || 0,
        min_deposit: Number.parseInt(draft.min_deposit, 10) || 0,
        order: Number.parseInt(draft.order, 10) || 1,
        click_key: clickKey !== '' ? clickKey : name.toLowerCase().replaceAll(' ', '_'),
        is_recommended: draft.is_recommended,
        is_active: draft.is_active,
        themeColor: normalizeHex(draft.themeColor),
        updated_at: new Date().toISOString(),
      };

      const editing = draft.id;
      if (editing) {
        const { error } = await supabase().from('brokers').update(payload).eq('id', editing);
        if (error) throw error;
      } else {
        payload.created_at = new Date().toISOString();
        const { error } = await supabase().from('brokers').insert(payload);
        if (error) throw error;
      }

      setDraft(null);
      await load();
      setMessage({
        kind: 'ok',
        text: editing ? 'تم تحديث المنصة بنجاح ✅' : 'تمت إضافة المنصة بنجاح ✅',
      });
    } catch (e) {
      setMessage({ kind: 'error', text: `خطأ: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  /** `_confirmDeleteBroker`. */
  async function remove(row: BrokerRow): Promise<void> {
    if (!confirm(`حذف منصة ${row.name}\n\nهل أنت متأكد؟ سيتم حذف المنصة نهائياً.`)) return;
    setBusy(true);
    try {
      await supabase().from('brokers').delete().eq('id', row.id);
      await load();
      setMessage({ kind: 'ok', text: 'تم حذف المنصة' });
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر الحذف' });
    } finally {
      setBusy(false);
    }
  }

  /** `_showQuickColorPicker` — writes only `themeColor`. */
  async function saveQuickColor(id: string, hex: string): Promise<void> {
    setBusy(true);
    try {
      await supabase().from('brokers').update({ themeColor: normalizeHex(hex) }).eq('id', id);
      setColorFor(null);
      await load();
      setMessage({ kind: 'ok', text: 'تم تحديث لون الثيم ✅' });
    } catch {
      setMessage({ kind: 'error', text: 'تعذّر تحديث اللون' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className={styles.brokerHead}>
        <h1 className={styles.title} style={{ margin: 0 }}>
          إدارة المنصات والروابط
        </h1>
        <button type="button" onClick={() => openDialog(null)} className={styles.primaryBtn}>
          + إضافة منصة جديدة
        </button>
      </div>

      <p className={styles.info}>ℹ️ اللوجو: ارفع صورة من الجهاز أو الصق رابط صورة مباشر (مثال: https://site.com/logo.png)</p>

      {message && <p className={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</p>}

      {brokers === null ? (
        <p className={styles.muted}>جاري التحميل...</p>
      ) : brokers.length === 0 ? (
        <p className={styles.muted}>لا توجد منصات مضافة بعد</p>
      ) : (
        brokers.map((b) => {
          const color = b.themeColor ? normalizeHex(b.themeColor) : ACCENT_CYAN;
          const isActive = b.is_active ?? true;
          const isRec = b.is_recommended ?? false;
          return (
            <article
              key={b.id}
              className={`${styles.brokerRow} ${busy ? styles.rowBusy : ''}`}
              style={{
                borderColor: isRec ? 'rgba(16, 185, 129, 0.6)' : `${color}66`,
                borderWidth: isRec ? 1.5 : 1,
              }}
            >
              <span className={styles.brokerLogo}>
                <Logo url={b.logo_url ?? ''} />
              </span>

              <div className={styles.brokerInfo}>
                <div className={styles.brokerNameRow}>
                  <span className={styles.brokerDot} style={{ background: color }} aria-hidden="true" />
                  <strong className={styles.brokerName}>{b.name}</strong>
                  {isRec && <span className={`${styles.badge} ${styles.badgeGreen}`}>مُرشحة</span>}
                  {!isActive && <span className={`${styles.badge} ${styles.badgeRed}`}>مخفية</span>}
                </div>

                <span className={styles.brokerLink} dir="ltr">
                  {b.registration_link}
                </span>

                {(b.promo_code ?? '') !== '' && (
                  <span className={styles.brokerPromo}>
                    كود: {b.promo_code} | بونص: {b.bonus_percent}% على إيداع ${b.min_deposit}+
                  </span>
                )}
              </div>

              <button
                type="button"
                title="تغيير لون الثيم"
                onClick={() => setColorFor(b)}
                className={styles.brokerSwatch}
                style={{ background: color }}
              >
                🎨
              </button>
              <button type="button" title="تعديل" onClick={() => openDialog(b)} className={styles.actionBtn}>
                تعديل
              </button>
              <button
                type="button"
                title="حذف"
                onClick={() => void remove(b)}
                className={`${styles.actionBtn} ${styles.actionDanger}`}
              >
                حذف
              </button>
            </article>
          );
        })
      )}

      {draft && (
        <BrokerDialog
          draft={draft}
          setDraft={setDraft}
          busy={busy}
          onCancel={() => setDraft(null)}
          onSave={() => void save()}
        />
      )}

      {colorFor && (
        <QuickColorDialog
          broker={colorFor}
          busy={busy}
          onCancel={() => setColorFor(null)}
          onSave={(hex) => void saveQuickColor(colorFor.id, hex)}
        />
      )}
    </section>
  );
}

/** `_buildLogoImage` — data URLs, http URLs, or the storefront fallback. */
function Logo({ url, alt = '' }: { url: string; alt?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);

  if (url === '' || broken) return <span className={styles.brokerLogoFallback}>🏪</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} onError={() => setBroken(true)} className={styles.brokerLogoImg} />;
}

function BrokerDialog({
  draft,
  setDraft,
  busy,
  onCancel,
  onSave,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);

  async function pickLogo(file: File | undefined): Promise<void> {
    if (!file) return;
    setPicking(true);
    try {
      setDraft({ ...draft, logo_url: await readAsDataUrl(file) });
    } catch {
      // Leave whatever was there; the URL field is still available.
    } finally {
      setPicking(false);
    }
  }

  const swatch = normalizeHex(draft.themeColor);

  return (
    <div className={styles.modalOverlay} role="dialog" aria-modal="true">
      <div className={styles.modal}>
        <h2 className={styles.modalTitle}>{draft.id ? 'تعديل المنصة' : 'إضافة منصة جديدة'}</h2>

        <div className={styles.modalBody}>
          <DlgField
            value={draft.name}
            onChange={(v) => setDraft({ ...draft, name: v })}
            hint="اسم المنصة *"
            icon="🏪"
          />

          {/* ── Logo section ─────────────────────────────────────────── */}
          <div className={styles.logoSection}>
            <span className={styles.logoPreview}>
              <Logo url={draft.logo_url} />
            </span>
            <div className={styles.logoActions}>
              <button
                type="button"
                disabled={picking}
                onClick={() => fileRef.current?.click()}
                className={styles.uploadBtn}
              >
                {picking ? 'جاري التحميل...' : '⬆ رفع صورة من الجهاز'}
              </button>
              <span className={styles.logoHint}>أو الصق رابط URL للصورة أدناه</span>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  void pickLogo(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
          </div>

          <DlgField
            value={draft.logo_url.startsWith('data:') ? '' : draft.logo_url}
            onChange={(v) => setDraft({ ...draft, logo_url: v.trim() })}
            hint={draft.logo_url.startsWith('data:') ? 'تم رفع صورة من الجهاز' : 'https://example.com/logo.png'}
            icon="🔗"
            ltr
          />

          {/* ── Theme colour ─────────────────────────────────────────── */}
          <label className={styles.label}>لون ثيم المنصة</label>
          <div className={styles.colorRow}>
            <input
              type="color"
              value={swatch}
              onChange={(e) => setDraft({ ...draft, themeColor: e.target.value.toUpperCase() })}
              className={styles.colorInput}
              aria-label="اختيار لون الثيم"
            />
            <input
              value={draft.themeColor}
              onChange={(e) => setDraft({ ...draft, themeColor: e.target.value })}
              placeholder="#06B6D4"
              className={styles.input}
              dir="ltr"
              style={{ borderColor: swatch }}
            />
          </div>

          <DlgField
            value={draft.registration_link}
            onChange={(v) => setDraft({ ...draft, registration_link: v })}
            hint="رابط التسجيل *"
            icon="🔗"
            ltr
          />
          <DlgField
            value={draft.click_key}
            onChange={(v) => setDraft({ ...draft, click_key: v })}
            hint="مفتاح النقرات (بالإنجليزي، مثال: quotex)"
            icon="🔑"
            ltr
          />
          <DlgField
            value={draft.promo_code}
            onChange={(v) => setDraft({ ...draft, promo_code: v })}
            hint="البروموكود (اختياري)"
            icon="🎁"
            ltr
          />

          <div className={styles.dlgPair}>
            <DlgField
              value={draft.bonus_percent}
              onChange={(v) => setDraft({ ...draft, bonus_percent: v })}
              hint="نسبة البونص %"
              icon="٪"
              num
            />
            <DlgField
              value={draft.min_deposit}
              onChange={(v) => setDraft({ ...draft, min_deposit: v })}
              hint="حد أدنى إيداع $"
              icon="💲"
              num
            />
          </div>

          <DlgField
            value={draft.order}
            onChange={(v) => setDraft({ ...draft, order: v })}
            hint="ترتيب العرض (1, 2, 3...)"
            icon="↕"
            num
          />

          <div className={styles.checkRow}>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={draft.is_recommended}
                onChange={(e) => setDraft({ ...draft, is_recommended: e.target.checked })}
              />
              منصة مُرشحة
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={draft.is_active}
                onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
              />
              نشطة / مرئية
            </label>
          </div>
        </div>

        <div className={styles.modalActions}>
          <button type="button" onClick={onCancel} className={styles.actionBtn}>
            إلغاء
          </button>
          <button type="button" disabled={busy} onClick={onSave} className={styles.primaryBtn}>
            {draft.id ? 'حفظ' : 'إضافة'}
          </button>
        </div>
      </div>
    </div>
  );
}

function QuickColorDialog({
  broker,
  busy,
  onCancel,
  onSave,
}: {
  broker: BrokerRow;
  busy: boolean;
  onCancel: () => void;
  onSave: (hex: string) => void;
}) {
  const [hex, setHex] = useState(broker.themeColor ? normalizeHex(broker.themeColor) : ACCENT_CYAN);
  const swatch = normalizeHex(hex);

  return (
    <div className={styles.modalOverlay} role="dialog" aria-modal="true">
      <div className={styles.modal} style={{ maxWidth: 340 }}>
        <h2 className={styles.modalTitle}>لون ثيم المنصة</h2>

        <div className={styles.modalBody}>
          <div className={styles.colorRow}>
            <input
              type="color"
              value={swatch}
              onChange={(e) => setHex(e.target.value.toUpperCase())}
              className={styles.colorInput}
              aria-label="اختيار لون الثيم"
            />
            <input
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              className={styles.input}
              dir="ltr"
              style={{ borderColor: swatch }}
            />
          </div>
        </div>

        <div className={styles.modalActions}>
          <button type="button" onClick={onCancel} className={styles.actionBtn}>
            إلغاء
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSave(hex)}
            className={styles.primaryBtn}
            style={{ background: swatch, color: '#fff' }}
          >
            حفظ
          </button>
        </div>
      </div>
    </div>
  );
}

/** `_dlgField` — the hint doubles as the label, exactly as in the Dart dialog. */
function DlgField({
  value,
  onChange,
  hint,
  icon,
  ltr,
  num,
}: {
  value: string;
  onChange: (v: string) => void;
  hint: string;
  icon: string;
  ltr?: boolean;
  num?: boolean;
}) {
  return (
    <div className={styles.dlgField}>
      <span className={styles.dlgIcon} aria-hidden="true">
        {icon}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
        aria-label={hint}
        inputMode={num ? 'numeric' : undefined}
        className={styles.input}
        dir={ltr || num ? 'ltr' : undefined}
      />
    </div>
  );
}
