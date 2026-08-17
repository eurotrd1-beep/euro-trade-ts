'use client';

/**
 * Signal statistics — what each published strategy version actually did.
 *
 * Every number here comes from a server-side aggregate (`signal_stats` RPC or
 * the `strategy_version_stats` view). Nothing on this page groups rows in the
 * browser: a month is ~21,000 signals, and pulling them to count them would be
 * ~19 MB of egress per page open. Raw rows are read in exactly one place — the
 * detail list — with a hard limit.
 *
 * ── THE THREE GUARDS AGAINST A MISLEADING NUMBER ───────────────────────────
 *
 * NO RATE UNDER 30 DECIDED TRADES. Postgres returns null for the rate rather
 * than the page hiding a computed one, because a number that exists somewhere
 * eventually gets displayed somewhere.
 *
 * BREAK-EVEN IS 52.6–55.6%, NOT 50%. A binary option paying 80–90% returns the
 * stake at that rate and nothing more. 54% is red here, and that is not a
 * styling choice.
 *
 * TIES, UNRESOLVED AND FORCED ARE SHOWN SEPARATELY. `unresolved` means the feed
 * had no usable price at expiry — it is not a tie, and folding it into one
 * would inflate ties invisibly. `forced` is a guaranteed-win signal and is out
 * of every rate.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BREAKEVEN_HIGH,
  BREAKEVEN_LOW,
  MIN_TRADES,
  RANGES,
  SLOTS,
  fetchSignals,
  fetchStats,
  fetchVersionJson,
  fetchVersions,
  rangeDates,
  rateText,
  verdictFor,
  wilson,
  type Bucket,
  type RangeId,
  type SignalRow,
  type StatsFilter,
  type VersionStats,
} from '@/lib/signalStats';
import { buildAnalysisPrompt, extractStrategyJson } from '@/lib/aiAnalysis';
import styles from '../admin.module.css';

const K_ORIGIN = 'https://euro-trade-proxy-1.onrender.com';

const OUTCOME_LABEL: Record<string, string> = {
  win: 'ربح',
  loss: 'خسارة',
  tie: 'تعادل',
  unresolved: 'بدون سعر',
  pending: 'معلّقة',
};

export default function SignalStatsView() {
  const [range, setRange] = useState<RangeId>('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [slot, setSlot] = useState<string>('');
  const [versionId, setVersionId] = useState<string>('');
  const [symbol, setSymbol] = useState<string>('');

  const [total, setTotal] = useState<Bucket | null>(null);
  const [bySlot, setBySlot] = useState<Bucket[]>([]);
  const [bySymbol, setBySymbol] = useState<Bucket[]>([]);
  const [byDay, setByDay] = useState<Bucket[]>([]);
  const [versions, setVersions] = useState<VersionStats[]>([]);
  const [detail, setDetail] = useState<SignalRow[]>([]);
  const [open, setOpen] = useState<SignalRow | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [analysing, setAnalysing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);

  const [from, to] = useMemo(
    () => rangeDates(range, customFrom, customTo),
    [range, customFrom, customTo],
  );

  const filter: StatsFilter = useMemo(
    () => ({ from, to, slot: slot || null, versionId: versionId || null, symbol: symbol || null }),
    [from, to, slot, versionId, symbol],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, s, sym, day, vers, rows] = await Promise.all([
        fetchStats(filter, 'total'),
        fetchStats(filter, 'slot'),
        fetchStats(filter, 'symbol'),
        fetchStats(filter, 'day'),
        fetchVersions(),
        fetchSignals(filter, 100),
      ]);
      setTotal(t[0] ?? null);
      setBySlot(s);
      setBySymbol(sym.sort((a, b) => b.signals - a.signals));
      setByDay(day);
      setVersions(vers);
      setDetail(rows);
    } catch (e) {
      setError(
        e instanceof Error && /does not exist|schema cache/i.test(e.message)
          ? 'الجداول لسه مترفعتش — شغّل supabase/migrations/20260811_signal_stats.sql الأول.'
          : `تعذّر التحميل: ${e instanceof Error ? e.message : ''}`,
      );
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const decided = (total?.wins ?? 0) + (total?.losses ?? 0);
  const ci = wilson(total?.wins ?? 0, decided);
  const verdict = verdictFor(total?.wins ?? 0, total?.losses ?? 0);

  const toneClass =
    verdict === 'proven' || verdict === 'above'
      ? styles.statGreen
      : verdict === 'insufficient'
        ? styles.muted
        : styles.statRed;

  async function copyJson(v: VersionStats): Promise<void> {
    try {
      const json = await fetchVersionJson(v.id);
      await navigator.clipboard.writeText(JSON.stringify(json, null, 2));
      setToast(`اتنسخت ${v.name} نسخة ${v.version_number}`);
      setTimeout(() => setToast(null), 2500);
    } catch {
      setToast('تعذّر النسخ');
      setTimeout(() => setToast(null), 2500);
    }
  }

  /**
   * Asks Gemini to read the period. It suggests only — there is no path from
   * this button to publishing, deliberately.
   */
  async function analyse(): Promise<void> {
    setAnalysing(true);
    setAnalysis(null);
    try {
      // Hour distribution needs the raw rows, so it is built from the capped
      // detail sample rather than a sixth aggregate query.
      const [losers, winners] = await Promise.all([
        fetchSignals(filter, 15, 'loss'),
        fetchSignals(filter, 15, 'win'),
      ]);
      const byHour = new Map<number, { wins: number; losses: number }>();
      for (const r of [...losers, ...winners]) {
        const h = new Date(r.created_at).getUTCHours();
        const e = byHour.get(h) ?? { wins: 0, losses: 0 };
        if (r.outcome === 'win') e.wins++;
        else if (r.outcome === 'loss') e.losses++;
        byHour.set(h, e);
      }

      const used = versions.filter((v) => v.signals > 0 && (!slot || v.slot === slot));
      const jsons = await Promise.all(
        used.slice(0, 4).map(async (v) => ({
          name: v.name,
          version: v.version_number,
          slot: v.slot,
          json: await fetchVersionJson(v.id),
        })),
      );

      const prompt = buildAnalysisPrompt({
        rangeLabel: RANGES.find((r) => r.id === range)?.label ?? '',
        from,
        to,
        slotLabel: SLOTS.find((s) => s.id === slot)?.label ?? 'كل الأنواع',
        total,
        bySymbol,
        byDay,
        byHour: [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, ...v })),
        versions: used,
        versionJson: jsons,
        losers,
        winners,
      });

      const res = await fetch(`${K_ORIGIN}/api/gemini`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, temperature: 0.3 }),
        signal: AbortSignal.timeout(120_000),
      });
      const out = (await res.json()) as { available?: boolean; text?: string; reason?: string };
      if (out.available !== true || !out.text) throw new Error(out.reason ?? 'Gemini غير متاح');
      setAnalysis(out.text);
    } catch (e) {
      setAnalysis(`تعذّر التحليل: ${e instanceof Error ? e.message : ''}`);
    } finally {
      setAnalysing(false);
    }
  }

  const suggested = analysis ? extractStrategyJson(analysis) : null;

  return (
    <section>
      <h1 className={styles.title}>إحصائيات الإشارات</h1>

      <p className={styles.switchHint}>
        الإشارات دي بيولّدها السيرفر على كل الأزواج، مستقلة عن أي مستخدم — مش الإشارات اللي صادف إن حد
        كان فاتح التطبيق عليها. كل إشارة مربوطة بنسخة الاستراتيجية اللي ولّدتها بالظبط.
        {' '}<strong>التفاصيل بتتحفظ 30 يوم</strong>، والتجميع اليومي بيفضل للأبد.
      </p>

      {/* ── Filters ── */}
      <div className={styles.card}>
        <div className={styles.filters}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="range">الفترة</label>
            <select
              id="range"
              className={styles.input}
              value={range}
              onChange={(e) => setRange(e.target.value as RangeId)}
            >
              {RANGES.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </div>

          {range === 'custom' && (
            <>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="from">من</label>
                <input id="from" type="date" className={styles.input}
                  value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="to">إلى</label>
                <input id="to" type="date" className={styles.input}
                  value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </div>
            </>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="slot">النوع</label>
            <select id="slot" className={styles.input} value={slot} onChange={(e) => setSlot(e.target.value)}>
              <option value="">الكل</option>
              {SLOTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="version">النسخة</label>
            <select id="version" className={styles.input} value={versionId}
              onChange={(e) => setVersionId(e.target.value)}>
              <option value="">كل النسخ</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — نسخة {v.version_number} ({v.slot})
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="symbol">الزوج</label>
            <input id="symbol" className={styles.input} placeholder="الكل"
              value={symbol} onChange={(e) => setSymbol(e.target.value.trim())} />
          </div>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.primaryBtn} onClick={() => void load()} disabled={loading}>
            {loading ? 'بيحمّل…' : 'تحديث'}
          </button>
          <button type="button" className={styles.geminiBtn} onClick={() => void analyse()}
            disabled={analysing || decided < MIN_TRADES}>
            {analysing ? 'بيحلّل…' : 'حلّل الفترة دي'}
          </button>
        </div>

        {decided < MIN_TRADES && (
          <p className={styles.muted}>
            التحليل مقفول تحت {MIN_TRADES} صفقة محسومة — دلوقتي {decided}.
          </p>
        )}
      </div>

      {error && <p className={styles.error}>{error}</p>}
      {toast && <p className={styles.toast}>{toast}</p>}

      {/* ── Headline ── */}
      <div className={styles.statRow}>
        <Stat label="إجمالي الإشارات" value={total?.signals ?? 0} />
        <Stat label="ربح" value={total?.wins ?? 0} cls={styles.statGreen} />
        <Stat label="خسارة" value={total?.losses ?? 0} cls={styles.statRed} />
        <Stat label="تعادل" value={total?.ties ?? 0} />
        <Stat label="بدون سعر" value={total?.unresolved ?? 0} />
        <Stat label="معلّقة" value={total?.pending ?? 0} />
        <Stat label="مفروضة" value={total?.forced ?? 0} cls={styles.statGold} />
        <Stat label="نسبة النجاح" value={rateText(total?.wins ?? 0, total?.losses ?? 0)} cls={toneClass} />
      </div>

      <p className={styles.switchHint}>
        {decided >= MIN_TRADES && ci ? (
          <>
            مجال ثقة 95%: <strong>{ci.low.toFixed(1)}% — {ci.high.toFixed(1)}%</strong>.
            {' '}نقطة التعادل بعائد 80–90% هي <strong>{BREAKEVEN_LOW}%–{BREAKEVEN_HIGH}%</strong>
            {verdict === 'proven' && ' — كل المجال فوقها، وده أقوى حاجة العيّنة دي تقدر تقولها.'}
            {verdict === 'above' && ` — النسبة فوقها لكن المجال لسه بينزل تحتها (${ci.low.toFixed(1)}%).`}
            {verdict === 'breakeven' && ' — النسبة جوّه نطاق التعادل. فوق الـ 50% مش ربح.'}
            {verdict === 'losing' && ' — النسبة تحتها. خاسرة على العيّنة دي.'}
          </>
        ) : (
          <>مفيش نسبة تحت {MIN_TRADES} صفقة محسومة — العدد ده بيتحرك بالصدفة وحدها.</>
        )}
        {' '}التعادل و«بدون سعر» والمفروضة مستبعدة من النسبة.
      </p>

      {/* ── Slots ── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>الخطتين × لحظة الإشارة</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>النوع</th><th>النسخة النشطة</th><th>اترفعت</th>
                <th>إشارات</th><th>ر/خ</th><th>النسبة</th>
              </tr>
            </thead>
            <tbody>
              {SLOTS.map((s) => {
                const b = bySlot.find((x) => x.bucket === s.id);
                const activeV = versions.find((v) => v.slot === s.id && v.is_active);
                return (
                  <tr key={s.id}>
                    <td data-label="النوع">{s.label}</td>
                    <td data-label="النسخة النشطة">
                      {activeV ? `${activeV.name} — ${activeV.version_number}` : <span className={styles.muted}>مفيش</span>}
                    </td>
                    <td data-label="اترفعت">
                      {activeV ? activeV.uploaded_at.slice(0, 16).replace('T', ' ') : '—'}
                    </td>
                    <td data-label="إشارات">{b?.signals ?? 0}</td>
                    <td data-label="ر/خ">{b?.wins ?? 0}/{b?.losses ?? 0}</td>
                    <td data-label="النسبة"><Rate wins={b?.wins ?? 0} losses={b?.losses ?? 0} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Versions ── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>النسخ</h2>
        <p className={styles.muted}>
          الأرقام دي طول عمر النسخة، مش الفترة المفلترة — نسخة اتشالت من الخدمة أرقامها بتفضل.
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>الاسم</th><th>النوع</th><th>#</th><th>اترفعت</th>
                <th>إشارات</th><th>ر/خ</th><th>النسبة</th><th></th>
              </tr>
            </thead>
            <tbody>
              {versions.length === 0 && (
                <tr><td colSpan={8} className={styles.muted}>مفيش نسخ مسجّلة لسه — أول رفع من صفحة الاستراتيجيات بيعمل نسخة.</td></tr>
              )}
              {versions.map((v) => (
                <tr key={v.id}>
                  <td data-label="الاسم">
                    {v.name}{' '}
                    {v.is_active && <span className={styles.badgeGreen}>نشطة</span>}
                  </td>
                  <td data-label="النوع">{SLOTS.find((s) => s.id === v.slot)?.label ?? v.slot}</td>
                  <td data-label="#">{v.version_number}</td>
                  <td data-label="اترفعت">{v.uploaded_at.slice(0, 16).replace('T', ' ')}</td>
                  <td data-label="إشارات">{v.signals}</td>
                  <td data-label="ر/خ">{v.wins}/{v.losses}</td>
                  <td data-label="النسبة"><Rate wins={v.wins} losses={v.losses} /></td>
                  <td data-label="">
                    <button type="button" className={styles.linkBtn} onClick={() => void copyJson(v)}>
                      نسخ JSON
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Pairs ── */}
      {bySymbol.length > 0 && (
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>الأزواج</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>الزوج</th><th>إشارات</th><th>ر/خ</th><th>النسبة</th></tr></thead>
              <tbody>
                {bySymbol.slice(0, 40).map((b) => (
                  <tr key={b.bucket}>
                    <td data-label="الزوج">{b.bucket}</td>
                    <td data-label="إشارات">{b.signals}</td>
                    <td data-label="ر/خ">{b.wins}/{b.losses}</td>
                    <td data-label="النسبة"><Rate wins={b.wins} losses={b.losses} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Recent signals ── */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>آخر الإشارات</h2>
        <p className={styles.muted}>أحدث 100 في الفترة. اضغط على أي صف للتفاصيل.</p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>الوقت</th><th>الزوج</th><th>الاتجاه</th><th>دخول</th><th>خروج</th><th>النتيجة</th></tr>
            </thead>
            <tbody>
              {detail.length === 0 && (
                <tr><td colSpan={6} className={styles.muted}>مفيش إشارات في الفترة دي.</td></tr>
              )}
              {detail.map((r) => (
                <tr key={r.id} onClick={() => setOpen(r)} style={{ cursor: 'pointer' }}>
                  <td data-label="الوقت">{r.created_at.slice(5, 16).replace('T', ' ')}</td>
                  <td data-label="الزوج">{r.symbol}</td>
                  <td data-label="الاتجاه">{r.direction}</td>
                  <td data-label="دخول">{r.entry_price}</td>
                  <td data-label="خروج">{r.outcome_price ?? '—'}</td>
                  <td data-label="النتيجة">
                    <span className={
                      r.outcome === 'win' ? styles.pillGreen
                        : r.outcome === 'loss' ? styles.pillRed : styles.pill
                    }>
                      {OUTCOME_LABEL[r.outcome] ?? r.outcome}
                    </span>
                    {r.forced && <span className={styles.badgeGold}>مفروضة</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Gemini ── */}
      {analysis && (
        <div className={styles.geminiCard}>
          <div className={styles.geminiHead}>
            <h2 className={styles.cardTitle}>تحليل جيميناي</h2>
            <span className={styles.badge}>اقتراح — مفيش نشر تلقائي</span>
          </div>
          <pre className={styles.geminiText}>{analysis}</pre>
          {suggested && (
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => {
                void navigator.clipboard.writeText(JSON.stringify(suggested, null, 2));
                setToast('اتنسخ JSON المقترح — افتحه في صفحة الاستراتيجيات واختبره قبل الرفع');
                setTimeout(() => setToast(null), 4000);
              }}
            >
              نسخ الـ JSON المقترح
            </button>
          )}
        </div>
      )}

      {/* ── One signal ── */}
      {open && <SignalDetail row={open} onClose={() => setOpen(null)} versions={versions} />}
    </section>
  );
}

function Stat({ label, value, cls }: { label: string; value: number | string; cls?: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${cls ?? ''}`}>{value}</span>
    </div>
  );
}

/** A rate with its verdict baked in — never a bare number. */
function Rate({ wins, losses }: { wins: number; losses: number }) {
  const decided = wins + losses;
  if (decided < MIN_TRADES) {
    return <span className={styles.muted}>عيّنة غير كافية ({decided})</span>;
  }
  const v = verdictFor(wins, losses);
  const cls = v === 'proven' || v === 'above' ? styles.pillGreen : styles.pillRed;
  return <span className={cls}>{((wins / decided) * 100).toFixed(1)}%</span>;
}

function SignalDetail({
  row, onClose, versions,
}: { row: SignalRow; onClose: () => void; versions: VersionStats[] }) {
  const v = versions.find((x) => x.id === row.strategy_version_id);
  const candles: Array<{ o: number; h: number; l: number; c: number; t: number }> = [];
  const s = row.candle_snapshot ?? [];
  for (let i = 0; i + 4 < s.length; i += 5) {
    candles.push({ o: s[i]!, h: s[i + 1]!, l: s[i + 2]!, c: s[i + 3]!, t: s[i + 4]! });
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>
          {row.symbol} · {row.direction} · {OUTCOME_LABEL[row.outcome] ?? row.outcome}
        </h3>
        <div className={styles.modalBody}>
          <div className={styles.kv}>
            <span>الوقت</span><strong>{row.created_at.replace('T', ' ').slice(0, 19)}</strong>
            <span>النسخة</span>
            <strong>
              {/* Never invented: a signal with no version really has none. */}
              {v ? `${v.name} — نسخة ${v.version_number}` : 'نسخة غير معروفة'}
            </strong>
            <span>الفريم</span><strong>{row.timeframe}</strong>
            <span>الثقة</span><strong>{row.confidence ?? '—'}</strong>
            <span>النتيجة الرقمية</span><strong>{row.score ?? '—'}</strong>
            <span>دخول → خروج</span>
            <strong>{row.entry_price} → {row.outcome_price ?? '—'}</strong>
            <span>مدة الانتهاء</span><strong>{row.expiry_seconds}s</strong>
            {row.forced && <><span>مفروضة</span><strong>نعم — مستبعدة من كل نسبة</strong></>}
          </div>

          <h4 className={styles.cardTitle}>الشموع وقتها</h4>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>الوقت</th><th>o</th><th>h</th><th>l</th><th>c</th></tr></thead>
              <tbody>
                {candles.map((c) => (
                  <tr key={c.t}>
                    <td data-label="الوقت">{new Date(c.t * 1000).toISOString().slice(11, 16)}</td>
                    <td data-label="o">{c.o}</td><td data-label="h">{c.h}</td>
                    <td data-label="l">{c.l}</td><td data-label="c">{c.c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 className={styles.cardTitle}>القواعد وقيمها</h4>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>المؤشر</th><th>الدور</th><th>القيمة</th><th>اتحققت</th></tr></thead>
              <tbody>
                {(row.rules_matched ?? []).map((r, i) => (
                  <tr key={i}>
                    <td data-label="المؤشر">{r.i}</td>
                    <td data-label="الدور">{r.r}</td>
                    <td data-label="القيمة">{String(r.v ?? '—')}</td>
                    <td data-label="اتحققت">
                      <span className={r.ok ? styles.pillGreen : styles.pill}>{r.ok ? 'أيوة' : 'لأ'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className={styles.modalActions}>
          <button type="button" className={styles.primaryBtn} onClick={onClose}>إغلاق</button>
        </div>
      </div>
    </div>
  );
}
