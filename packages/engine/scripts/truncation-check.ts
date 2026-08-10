/**
 * Truncation impact check.
 *
 * Answers one question with data instead of reasoning: if the scraper stored
 * fewer candles per key, would the signals users receive change?
 *
 * Run with:  npx tsx scripts/truncation-check.ts [KEEP] [SYMBOL] [INTERVAL]
 */

import {
  computeIndicator,
  makeRule,
  registeredNames,
  scoreV2,
  systemClock,
  type Candle,
} from '../src/index.js';

const KEEP = Number(process.argv[2] ?? 60);
const SYMBOL = process.argv[3] ?? 'EURUSD_otc';
const INTERVAL = process.argv[4] ?? '1m';
const PROXY = 'https://euro-trade-cache.eurotrade.workers.dev';

async function main(): Promise<void> {
  const res = await fetch(
    `${PROXY}/api/otc/candles?symbol=${SYMBOL}&interval=${INTERVAL}`,
    { signal: AbortSignal.timeout(25_000) },
  );
  const raw = ((await res.json()) as { candles?: Array<Record<string, number>> }).candles ?? [];

  const full: Candle[] = raw.map((e) => ({
    open: e['o']!, high: e['h']!, low: e['l']!, close: e['c']!,
    volume: 1000, time: e['t']! * 1000,
  }));
  const cut = full.slice(-KEEP);
  const price = full[full.length - 1]!.close;
  const clock = systemClock();

  console.log(`${SYMBOL} @ ${INTERVAL}`);
  console.log(`full: ${full.length} candles   truncated: ${cut.length} candles`);
  console.log('');

  let same = 0;
  const changed: Array<[string, string, string]> = [];

  for (const name of registeredNames()) {
    const rule = makeRule({ indicator: name, condition: 'gt', signal: 'CALL', score: 1 });
    const a = computeIndicator(full, rule, price, clock);
    const b = computeIndicator(cut, rule, price, clock);

    if (a === b) { same++; continue; }
    if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-12) {
      same++;
      continue;
    }
    changed.push([name, String(a).slice(0, 16), String(b).slice(0, 16)]);
  }

  console.log(`identical: ${same}/${registeredNames().length}`);
  console.log(`CHANGED:   ${changed.length}`);
  console.log('');
  for (const [n, a, b] of changed.slice(0, 16)) {
    console.log(`  ${n.padEnd(24)} ${String(full.length)}→ ${a.padEnd(18)} ${KEEP}→ ${b}`);
  }
  if (changed.length > 16) console.log(`  … and ${changed.length - 16} more`);

  console.log('');
  const sa = scoreV2(full, price);
  const sb = scoreV2(cut, price);
  console.log(`V2 score  ${full.length} candles: ${sa.toFixed(4)}  (${sa >= 0 ? 'CALL' : 'PUT'})`);
  console.log(`V2 score  ${KEEP} candles: ${sb.toFixed(4)}  (${sb >= 0 ? 'CALL' : 'PUT'})`);
  console.log(`DIRECTION FLIPS: ${(sa >= 0) !== (sb >= 0) ? 'YES' : 'no'}`);
}

void main().catch((e: unknown) => {
  console.error('failed:', (e as Error).message);
  process.exitCode = 1;
});
