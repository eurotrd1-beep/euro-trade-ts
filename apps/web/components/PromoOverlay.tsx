'use client';

/**
 * Promotional announcement — ported from `_maybeShowPromo` / `_showPromoDialog`
 * (main_screen.dart:2051, :2088).
 *
 * Four gates, in this order, all of which must pass before it shows:
 *   1. `enabled`
 *   2. targeted at everyone, or at this exact account id
 *   3. `endsAt` is null or still in the future (UTC)
 *   4. this device has not dismissed THIS version
 *
 * Two counters go to `clicks.promo`: one impression when it opens, one when
 * the CTA is pressed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, tr } from '@euro/shared';
import { TelegramIcon } from './BrandIcons';
import styles from './PromoOverlay.module.css';

const FALLBACK_TELEGRAM = 'https://t.me/euro_trd1';

interface Promo {
  title: string;
  message: string;
  price: string;
  save: string;
  ctaText: string;
  version: number;
  autoCloseSeconds: number;
  endsAtUtc: number | null;
}

function dismissedKey(version: number): string {
  return `promo_dismissed_v${version}`;
}

/** Dart `fmtCountdown`. */
function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const two = (v: number): string => String(v).padStart(2, '0');
  if (d > 0) return tr(`${d} يوم ${two(h)}:${two(m)}:${two(s)}`, `${d}d ${two(h)}:${two(m)}:${two(s)}`);
  return `${two(h)}:${two(m)}:${two(s)}`;
}

function bump(field: 'views' | 'cta'): void {
  void supabase()
    .rpc('increment_click', { row_id: 'promo', field_name: field })
    .then(undefined, () => {
      // Analytics only — never block the ad on a counter.
    });
}

export function PromoOverlay({
  accountId,
  telegram,
}: {
  accountId: string;
  /** The social Telegram link; falls back to the owner's channel. */
  telegram: string;
}) {
  const [promo, setPromo] = useState<Promo | null>(null);
  const [skipRemaining, setSkipRemaining] = useState(0);
  const [offerRemaining, setOfferRemaining] = useState<number | null>(null);
  const checkedRef = useRef(false);

  // ── Gate 1-4, then show ───────────────────────────────────────────────────
  useEffect(() => {
    if (checkedRef.current || !accountId) return;
    checkedRef.current = true;

    void (async () => {
      try {
        const { data } = await supabase().from('configs').select('data').eq('id', 'promo').maybeSingle();
        if (!data) return;
        const d = (data['data'] ?? {}) as Record<string, unknown>;

        if (d['enabled'] !== true) return;

        const target = String(d['target'] ?? 'all').trim();
        if (target !== 'all' && target !== accountId) return;

        const endsAtStr = typeof d['endsAt'] === 'string' ? d['endsAt'] : null;
        let endsAtUtc: number | null = null;
        if (endsAtStr !== null && endsAtStr !== '') {
          const parsed = Date.parse(endsAtStr);
          if (!Number.isNaN(parsed)) {
            if (parsed <= Date.now()) return;
            endsAtUtc = parsed;
          }
        }

        const version = typeof d['version'] === 'number' ? d['version'] : 0;
        try {
          if (globalThis.localStorage?.getItem(dismissedKey(version)) === 'true') return;
        } catch {
          // Storage blocked — show it; a repeat is better than never showing.
        }

        const str = (k: string, fallback = ''): string =>
          typeof d[k] === 'string' ? (d[k] as string).trim() : fallback;
        const autoClose = Math.min(3600, Math.max(0, Number(d['autoCloseSeconds'] ?? 0) || 0));

        bump('views');
        setSkipRemaining(autoClose);
        setOfferRemaining(endsAtUtc === null ? null : endsAtUtc - Date.now());
        setPromo({
          title: str('title'),
          message: str('message'),
          price: str('price'),
          save: str('save'),
          ctaText: str('ctaText') === '' ? tr('تواصل معايا', 'Contact me') : str('ctaText'),
          version,
          autoCloseSeconds: autoClose,
          endsAtUtc,
        });
      } catch {
        // No promo rather than a broken screen.
      }
    })();
  }, [accountId]);

  const close = useCallback(() => {
    if (promo === null) return;
    try {
      globalThis.localStorage?.setItem(dismissedKey(promo.version), 'true');
    } catch {
      // Nothing to persist to; it will show again next visit.
    }
    setPromo(null);
  }, [promo]);

  // The X only becomes active after autoCloseSeconds, as in the original.
  useEffect(() => {
    if (promo === null || skipRemaining <= 0) return;
    const id = setInterval(() => setSkipRemaining((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [promo, skipRemaining]);

  // Offer countdown; at zero the ad closes itself WITHOUT recording a
  // dismissal — an expired offer will not re-show anyway.
  useEffect(() => {
    if (promo?.endsAtUtc == null) return;
    const endsAt = promo.endsAtUtc;
    const id = setInterval(() => {
      const left = endsAt - Date.now();
      if (left <= 0) {
        clearInterval(id);
        setPromo(null);
        return;
      }
      setOfferRemaining(left);
    }, 1000);
    return () => clearInterval(id);
  }, [promo]);

  if (promo === null) return null;

  const canClose = skipRemaining <= 0;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={promo.title}>
      <div className={styles.card}>
        <button
          type="button"
          onClick={close}
          disabled={!canClose}
          className={styles.close}
          aria-label={tr('إغلاق', 'Close')}
        >
          {canClose ? '✕' : skipRemaining}
        </button>

        <div className={styles.head}>
          <span className={styles.gift} aria-hidden="true">
            🎁
          </span>
          <h2 className={styles.title}>{promo.title || tr('عرض خاص', 'Special offer')}</h2>
        </div>

        {promo.message !== '' && <p className={styles.message}>{promo.message}</p>}

        {(promo.price !== '' || promo.save !== '') && (
          <div className={styles.priceRow}>
            {promo.price !== '' && (
              <div className={styles.priceBox}>
                <span className={styles.priceLabel}>{tr('السعر', 'Price')}</span>
                <strong className={styles.priceValue} dir="ltr">
                  {promo.price}
                </strong>
              </div>
            )}
            {promo.save !== '' && (
              <div className={styles.saveBox}>
                <span aria-hidden="true">🔥</span>
                <strong className={styles.saveValue}>{promo.save}</strong>
              </div>
            )}
          </div>
        )}

        {offerRemaining !== null && (
          <p className={styles.countdown}>
            {tr(
              `ينتهي خلال ${fmtCountdown(offerRemaining)}`,
              `Ends in ${fmtCountdown(offerRemaining)}`,
            )}
          </p>
        )}

        <a
          href={telegram !== '' ? telegram : FALLBACK_TELEGRAM}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => bump('cta')}
          className={styles.cta}
        >
          <TelegramIcon size={18} />
          {promo.ctaText}
        </a>
      </div>
    </div>
  );
}
