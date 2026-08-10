'use client';

/**
 * System health — ported from system_repair_screen.dart (1,444 lines).
 *
 * The Dart screen defines ~26 checks across proxy / worker / data / Supabase /
 * Pocket Option / 2captcha. The ones reproduced here are those a browser can
 * genuinely verify: anything needing the Render or Supabase management API
 * requires a server-side token and belongs in a Route Handler, not the client.
 *
 * Each check reports what it measured and what to do when it goes red — the
 * Dart original carries the same guidance in its `RHelp` records, and it is the
 * part that makes the screen useful at 3am.
 */

import { useCallback, useState } from 'react';
import { supabase, getProxyUrl } from '@euro/shared';
import styles from '../admin.module.css';

const WORKER_URL = 'https://euro-trade-cache.eurotrade.workers.dev';
const EXPECTED_SYMBOLS = 183;

type Status = 'idle' | 'running' | 'ok' | 'warn' | 'fail';

interface CheckResult {
  status: Status;
  detail: string;
  fix?: string;
}

interface Check {
  id: string;
  section: string;
  title: string;
  run: () => Promise<CheckResult>;
}

const SECTIONS: Record<string, string> = {
  proxy: 'البروكسي',
  worker: 'الـ Worker',
  data: 'البيانات',
  supabase: 'Supabase',
};

async function timedFetch(url: string, timeoutMs = 10_000): Promise<{ res: Response; ms: number }> {
  const started = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { res, ms: Math.round(performance.now() - started) };
}

function buildChecks(): Check[] {
  return [
    {
      id: 'proxy_alive',
      section: 'proxy',
      title: 'البروكسي حي + زمن الاستجابة',
      run: async () => {
        try {
          const { res, ms } = await timedFetch(`${getProxyUrl()}/api/otc/status`);
          if (res.status !== 200) {
            return { status: 'fail', detail: `رجّع ${res.status}`, fix: 'راجع سيرفر Render — غالبًا نايم أو واقع.' };
          }
          // Render free tier cold-starts take seconds; that is slow, not broken.
          return {
            status: ms > 3000 ? 'warn' : 'ok',
            detail: `${ms}ms`,
            fix: ms > 3000 ? 'استجابة بطيئة — غالبًا السيرفر كان نايم (cold start).' : undefined,
          };
        } catch (e) {
          return { status: 'fail', detail: (e as Error).message, fix: 'البروكسي مش راد خالص. راجع Render.' };
        }
      },
    },
    {
      id: 'proxy_serves',
      section: 'proxy',
      title: `⭐ الرابط في الكونفيج بيخدم ${EXPECTED_SYMBOLS} رمز فعلاً؟`,
      run: async () => {
        try {
          const { res } = await timedFetch(`${getProxyUrl()}/api/otc/status`);
          const rows = (await res.json()) as Array<{ id?: string; data?: unknown }>;
          const prices = (rows.find((r) => r.id === 'otc_prices')?.data ?? {}) as Record<string, unknown>;
          const n = Object.keys(prices).length;
          if (n === 0) {
            return { status: 'fail', detail: 'صفر رموز', fix: 'السكرابر مش شغّال أو مش متصل بـ Pocket Option.' };
          }
          return {
            status: n >= EXPECTED_SYMBOLS ? 'ok' : 'warn',
            detail: `${n} رمز`,
            fix: n < EXPECTED_SYMBOLS ? `أقل من المتوقع (${EXPECTED_SYMBOLS}) — بعض الرموز مش بتتسحب.` : undefined,
          };
        } catch (e) {
          return { status: 'fail', detail: (e as Error).message };
        }
      },
    },
    {
      id: 'wk_alive',
      section: 'worker',
      title: 'الـ Worker حي + زمن الاستجابة',
      run: async () => {
        try {
          const { res, ms } = await timedFetch(`${WORKER_URL}/api/otc/status`);
          return res.status === 200
            ? { status: 'ok', detail: `${ms}ms` }
            : { status: 'fail', detail: `رجّع ${res.status}`, fix: 'راجع الـ Worker على Cloudflare.' };
        } catch (e) {
          return { status: 'fail', detail: (e as Error).message };
        }
      },
    },
    {
      id: 'wk_cache',
      section: 'worker',
      title: 'الكاش شغّال (HIT/MISS)',
      run: async () => {
        try {
          // Two hits in a row: the second must come from cache.
          await timedFetch(`${WORKER_URL}/api/otc/candles?symbol=EURUSD_otc&interval=1m`);
          const { res } = await timedFetch(`${WORKER_URL}/api/otc/candles?symbol=EURUSD_otc&interval=1m`);
          const tag = res.headers.get('x-cache') ?? 'غائب';
          return tag === 'HIT' || tag === 'STALE'
            ? { status: 'ok', detail: `X-Cache: ${tag}` }
            : {
                status: 'warn',
                detail: `X-Cache: ${tag}`,
                fix: 'الطلب التاني المفروض يجيب HIT. لو فضل MISS، الكاش مش شغّال والبروكسي بياخد كل الحمل.',
              };
        } catch (e) {
          return { status: 'fail', detail: (e as Error).message };
        }
      },
    },
    {
      id: 'wk_active',
      section: 'worker',
      title: 'التطبيق بيضرب على الـ Worker ولا الأصل؟',
      run: async () => {
        const configured = getProxyUrl();
        const usingWorker = configured.includes('workers.dev');
        return {
          status: usingWorker ? 'ok' : 'warn',
          detail: configured,
          fix: usingWorker
            ? undefined
            : 'الكونفيج بيشاور على الأصل مباشرة — الكاش متخطّي وكل الحمل على Render.',
        };
      },
    },
    {
      id: 'd_fresh',
      section: 'data',
      title: 'الأسعار مش متجمّدة (عمر أحدث تحديث)',
      run: async () => {
        try {
          const { res } = await timedFetch(`${getProxyUrl()}/api/otc/status`);
          const rows = (await res.json()) as Array<{ id?: string; data?: unknown }>;
          const prices = (rows.find((r) => r.id === 'otc_prices')?.data ?? {}) as Record<string, { t?: number }>;
          const newest = Math.max(0, ...Object.values(prices).map((v) => v?.t ?? 0));
          const age = Math.round(Date.now() / 1000 - newest);
          if (newest === 0) return { status: 'fail', detail: 'مفيش أي طوابع زمنية' };
          return {
            status: age < 60 ? 'ok' : age < 300 ? 'warn' : 'fail',
            detail: `أحدث تحديث من ${age} ثانية`,
            fix: age >= 60 ? 'الأسعار متجمّدة — السكرابر فقد الاتصال بـ Pocket Option.' : undefined,
          };
        } catch (e) {
          return { status: 'fail', detail: (e as Error).message };
        }
      },
    },
    {
      id: 'd_anom',
      section: 'data',
      title: 'مفيش أسعار صفر/null/شاذة',
      run: async () => {
        try {
          const { res } = await timedFetch(`${getProxyUrl()}/api/otc/status`);
          const rows = (await res.json()) as Array<{ id?: string; data?: unknown }>;
          const prices = (rows.find((r) => r.id === 'otc_prices')?.data ?? {}) as Record<string, { p?: number }>;
          const bad = Object.entries(prices).filter(
            ([, v]) => typeof v?.p !== 'number' || !Number.isFinite(v.p) || v.p <= 0,
          );
          return bad.length === 0
            ? { status: 'ok', detail: `كل الأسعار سليمة (${Object.keys(prices).length})` }
            : {
                status: 'warn',
                detail: `${bad.length} رمز بسعر غير صالح: ${bad.slice(0, 4).map(([k]) => k).join(', ')}`,
                fix: 'الرموز دي هتدّي إشارات غلط. اخفيها من قائمة الأزواج لحد ما تتصلّح.',
              };
        } catch (e) {
          return { status: 'fail', detail: (e as Error).message };
        }
      },
    },
    {
      id: 'd_candles',
      section: 'data',
      title: 'الشموع راجعة لكل فريم',
      run: async () => {
        const frames = ['1m', '5m', '15m', '1h'];
        const missing: string[] = [];
        for (const f of frames) {
          try {
            const { res } = await timedFetch(`${getProxyUrl()}/api/otc/candles?symbol=EURUSD_otc&interval=${f}`);
            const body = (await res.json()) as { candles?: unknown[] };
            if (!Array.isArray(body.candles) || body.candles.length === 0) missing.push(f);
          } catch {
            missing.push(f);
          }
        }
        return missing.length === 0
          ? { status: 'ok', detail: frames.join(' · ') }
          : {
              status: 'fail',
              detail: `مفيش شموع لـ ${missing.join(', ')}`,
              fix: 'المستخدم اللي يختار الفريم ده هيشوف شارت فاضي ومش هيقدر ياخد إشارة.',
            };
      },
    },
    {
      id: 's_alive',
      section: 'supabase',
      title: 'الاتصال حي + زمن الاستجابة',
      run: async () => {
        const started = performance.now();
        try {
          const { error } = await supabase().from('configs').select('id').limit(1);
          const ms = Math.round(performance.now() - started);
          return error
            ? { status: 'fail', detail: error.message }
            : { status: ms > 2000 ? 'warn' : 'ok', detail: `${ms}ms` };
        } catch (e) {
          return { status: 'fail', detail: (e as Error).message };
        }
      },
    },
    {
      id: 's_tables',
      section: 'supabase',
      title: 'الجداول موجودة وفيها بيانات',
      run: async () => {
        const tables = ['configs', 'pairs', 'brokers', 'users'];
        const counts: string[] = [];
        const empty: string[] = [];
        for (const t of tables) {
          try {
            const { count } = await supabase().from(t).select('*', { count: 'exact', head: true });
            counts.push(`${t}:${count ?? 0}`);
            if (!count) empty.push(t);
          } catch {
            empty.push(t);
          }
        }
        return empty.length === 0
          ? { status: 'ok', detail: counts.join(' · ') }
          : { status: 'warn', detail: counts.join(' · '), fix: `جداول فاضية: ${empty.join(', ')}` };
      },
    },
    {
      id: 's_engine',
      section: 'data',
      title: 'مدخلات المحرك سليمة (استراتيجيات + شموع)',
      run: async () => {
        try {
          const { data } = await supabase()
            .from('configs')
            .select('id, data')
            .in('id', ['strategy_standard', 'strategy_vip']);
          const rows = (data as Array<{ id: string; data: Record<string, unknown> }> | null) ?? [];
          const problems: string[] = [];
          for (const id of ['strategy_standard', 'strategy_vip']) {
            const row = rows.find((r) => r.id === id);
            if (!row) { problems.push(`${id} غير موجود`); continue; }
            const rules = row.data?.['rules'];
            if (!Array.isArray(rules)) { problems.push(`${id} بدون rules`); continue; }
            const enabled = rules.filter(
              (r) => typeof (r as { indicator?: unknown }).indicator === 'string' &&
                     (r as { enabled?: unknown }).enabled !== false,
            );
            if (enabled.length === 0) problems.push(`${id} مفيش قواعد مفعّلة`);
          }
          return problems.length === 0
            ? { status: 'ok', detail: 'الاستراتيجيتين فيهم قواعد مفعّلة' }
            : {
                status: 'warn',
                detail: problems.join(' · '),
                fix: 'من غير قواعد مفعّلة، المحرك بيرجع للتسجيل البارامتري (V2) بدل استراتيجيتك.',
              };
        } catch (e) {
          return { status: 'fail', detail: (e as Error).message };
        }
      },
    },
  ];
}

export default function HealthView() {
  const checks = buildChecks();
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);

  const runAll = useCallback(async () => {
    setRunning(true);
    setResults({});
    setDone(0);
    for (const check of checks) {
      setResults((r) => ({ ...r, [check.id]: { status: 'running', detail: '...' } }));
      try {
        const result = await check.run();
        setResults((r) => ({ ...r, [check.id]: result }));
      } catch (e) {
        setResults((r) => ({ ...r, [check.id]: { status: 'fail', detail: (e as Error).message } }));
      }
      setDone((d) => d + 1);
    }
    setRunning(false);
    // `checks` is rebuilt each render but is structurally constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bySection = checks.reduce<Record<string, Check[]>>((acc, c) => {
    (acc[c.section] ??= []).push(c);
    return acc;
  }, {});

  const failed = Object.values(results).filter((r) => r.status === 'fail').length;
  const warned = Object.values(results).filter((r) => r.status === 'warn').length;

  return (
    <section>
      <h1 className={styles.title}>صحة النظام</h1>

      <div className={styles.card}>
        <div className={styles.actions}>
          <button type="button" disabled={running} onClick={() => void runAll()} className={styles.primaryBtn}>
            {running ? `بيفحص… ${done}/${checks.length}` : 'افحص كل حاجة'}
          </button>
        </div>

        {!running && done > 0 && (
          <p className={failed > 0 ? styles.error : warned > 0 ? styles.warn : styles.ok} style={{ marginTop: 14 }}>
            {failed > 0
              ? `${failed} فحص فاشل${warned > 0 ? ` و${warned} تحذير` : ''}`
              : warned > 0
                ? `${warned} تحذير — مفيش أعطال`
                : 'كل الفحوصات سليمة ✓'}
          </p>
        )}
      </div>

      {Object.entries(bySection).map(([section, list]) => (
        <div key={section} className={styles.card}>
          <h2 className={styles.cardTitle}>{SECTIONS[section] ?? section}</h2>
          {list.map((c) => {
            const r = results[c.id];
            return (
              <div key={c.id} className={styles.switchRow}>
                <div style={{ minWidth: 0 }}>
                  <div className={styles.switchLabel}>{c.title}</div>
                  {r && r.detail && (
                    <div className={styles.switchHint} dir="auto">
                      {r.detail}
                    </div>
                  )}
                  {r?.fix && (
                    <div className={styles.switchHint} style={{ color: 'var(--admin-gold)' }}>
                      ↳ {r.fix}
                    </div>
                  )}
                </div>
                <StatusBadge status={r?.status ?? 'idle'} />
              </div>
            );
          })}
        </div>
      ))}

      <p className={styles.muted} style={{ textAlign: 'start' }}>
        فحوصات إعادة تشغيل البروكسي، رصيد 2captcha، توكن Pocket Option واستهلاك Supabase محتاجة
        مفاتيح إدارة على السيرفر — مكانها Route Handler مش المتصفح.
      </p>
    </section>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, { text: string; cls: string }> = {
    idle: { text: '—', cls: '' },
    running: { text: '…', cls: '' },
    ok: { text: 'سليم', cls: styles.badgeGreen! },
    warn: { text: 'تحذير', cls: styles.badgeGold! },
    fail: { text: 'فشل', cls: styles.badgeRed! },
  };
  const { text, cls } = map[status];
  return <span className={`${styles.badge} ${cls}`}>{text}</span>;
}
