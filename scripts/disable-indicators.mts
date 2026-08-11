/**
 * Moves indicator registrations out of the registry and into
 * indicators/unavailable/, without deleting a line of implementation.
 *
 * Written because doing it by hand went wrong twice: a multi-line `register(...)`
 * was cut off at its first line and left an orphaned block that would not
 * compile, and one name was dropped from the list by transcription. So this
 * matches balanced parentheses rather than lines, and refuses outright if a
 * registration mixes a name being disabled with one that is staying — dropping
 * a working alias along with a dead one is silent and would not show up in any
 * test.
 *
 * Run: npx tsx scripts/disable-indicators.mts <file.json> "<reason>" "<re-enable>"
 *   where <file.json> is a JSON array of indicator names.
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'packages/engine/src/indicators';
const OUT = join(DIR, 'unavailable', 'disabled.ts');

const [listFile, reason, reEnable] = process.argv.slice(2);
if (!listFile || !reason || !reEnable) {
  console.error('usage: disable-indicators.mts <names.json> "<reason>" "<re-enable condition>"');
  process.exit(1);
}

const targets = new Set(JSON.parse(readFileSync(listFile, 'utf8')) as string[]);

/** From `register(` to the `);` that closes it, counting depth and skipping strings. */
function extractCall(src: string, start: number): { text: string; end: number } | null {
  let i = src.indexOf('(', start);
  if (i < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        const semi = src.indexOf(';', i);
        return { text: src.slice(start, semi + 1), end: semi + 1 };
      }
    }
  }
  return null;
}

const extracted: string[] = [];
const touched: string[] = [];

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
  const path = join(DIR, file);
  let src = readFileSync(path, 'utf8');
  let changed = false;

  for (;;) {
    let found = false;
    let cursor = 0;
    while (cursor < src.length) {
      const at = src.indexOf('register(', cursor);
      if (at < 0) break;
      const call = extractCall(src, at);
      if (!call) break;

      // Names live in the first argument only.
      const head = call.text.slice(0, call.text.indexOf(',') + 1 || call.text.length);
      const names = new Set([...head.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!));
      const hit = [...names].filter((n) => targets.has(n));

      if (hit.length > 0) {
        const keep = [...names].filter((n) => !targets.has(n));
        if (keep.length > 0) {
          console.error(
            `REFUSED ${file}: "${hit.join(', ')}" shares a registration with "${keep.join(', ')}", which is staying. Split it by hand first.`,
          );
          process.exit(1);
        }
        extracted.push(call.text);
        src = src.slice(0, at) + src.slice(call.end).replace(/^\n/, '');
        changed = true;
        found = true;
        break;
      }
      cursor = call.end;
    }
    if (!found) break;
  }

  if (changed) {
    writeFileSync(path, src);
    touched.push(file);
  }
}

if (extracted.length === 0) {
  console.log('nothing matched');
  process.exit(0);
}

const header = `/**
 * DISABLED — not imported by indicators/index.ts, so none of these names reach
 * the registry. The implementations are untouched, in their original files.
 *
 * Reason: ${reason}
 *
 * Re-enable: ${reEnable}
 *
 * Appended by scripts/disable-indicators.mts.
 */

import * as m from '../math.js';
import { register } from '../../registry.js';
import * as advanced from '../advanced.js';
import * as extended from '../extended.js';
import * as ict from '../ict.js';
import * as oscillators2 from '../oscillators2.js';
import * as patterns from '../patterns.js';
import * as quant from '../quant.js';
import * as schools from '../schools.js';
import * as structure from '../structure.js';

// Referenced so the namespace imports above are never "unused" while this file
// is excluded from the build graph.
void m; void advanced; void extended; void ict; void oscillators2;
void patterns; void quant; void schools; void structure;

`;

if (!existsSync(OUT)) writeFileSync(OUT, header);
appendFileSync(
  OUT,
  `\n// ── ${reason} ──\n${extracted.join('\n')}\n`,
);

console.log(`moved ${extracted.length} registrations from ${touched.join(', ')}`);
console.log(`appended to ${OUT}`);
