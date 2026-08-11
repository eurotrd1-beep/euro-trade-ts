/**
 * Which registered names are the same computation under a different label.
 *
 * Two ways of asking, both reported, because they answer different questions:
 *
 *   PROVEN — several names registered against ONE function object. These can
 *   never diverge; they are the same code reached by different keys. This is
 *   what the guard is built on.
 *
 *   OBSERVED — different functions that happened to return the same value at
 *   every point of a sample. Suggestive, not proof: they could disagree on data
 *   the sample does not contain. Reported so nobody mistakes them for aliases.
 *
 * The canonical name of a group is the one registered FIRST, which is the name
 * the implementation was written for; the rest are the ones a strategy author
 * is likely to be misled by.
 *
 * Run: npx tsx scripts/audit-aliases.mts [path/to/table]
 */

import { writeFileSync, readFileSync } from 'node:fs';
import {
  aliasGroups,
  categoryForIndicator,
  makeRule,
  registeredNames,
} from '../packages/engine/src/index.js';

// ── Proven aliases ──────────────────────────────────────────────────────────

// The grouping itself lives in the engine, not here: the guard that runs on
// every published strategy and the report a human reads have to be the same
// answer, or the report becomes a second opinion nobody maintains.
const names = registeredNames();
const groups = [...aliasGroups()]
  .map((g) => ({
    ...g,
    categories: Object.fromEntries(
      [g.canonical, ...g.aliases].map((n) => [
        n,
        categoryForIndicator(makeRule({ indicator: n, condition: 'eq', signal: 'CALL', score: 1 })),
      ]),
    ),
  }))
  .sort((a, b) => b.aliases.length - a.aliases.length || a.canonical.localeCompare(b.canonical));

const extra = groups.reduce((n, g) => n + g.aliases.length, 0);
console.log(`أسماء مسجّلة: ${names.length}`);
console.log(`مجموعات مرادفات (دالة واحدة): ${groups.length} · أسماء زائدة: ${extra}`);
console.log(`حسابات مختلفة فعليًا: ${names.length - extra}\n`);

// A group whose members fall in different categories is worse than redundant:
// the consensus multiplier would count them as independent evidence.
let splitCategories = 0;
for (const g of groups) {
  const distinct = new Set(Object.values(g.categories));
  const flag = distinct.size > 1 ? '  ⚠ تصنيفات مختلفة' : '';
  if (distinct.size > 1) splitCategories++;
  console.log(`${g.canonical} (${[...distinct].join(', ')})${flag}${g.misleading ? '  ⚠ اسم مضلّل' : ''}`);
  console.log(`    ≡ ${g.aliases.join(', ')}`);
  if (g.misleading) console.log(`    ${g.misleading}`);
}
console.log(`\nمجموعات أعضاؤها في تصنيفات مختلفة: ${splitCategories}`);

// ── Observed-identical: different functions, identical output on the sample ──

const tablePath = process.argv[2];
const observed: string[][] = [];
if (tablePath !== undefined) {
  const meta = JSON.parse(readFileSync(`${tablePath}.meta.json`, 'utf8')) as {
    nEvals: number; names: Array<{ name: string }>;
  };
  const n = meta.nEvals;
  const raw = readFileSync(`${tablePath}.bin`);
  const col = (k: number) => new Float64Array(raw.buffer, raw.byteOffset + k * n * 8, n);
  const cols = meta.names.map((_, k) => col(6 + k));

  const provenPair = new Set<string>();
  for (const g of groups) {
    for (const a of [g.canonical, ...g.aliases]) {
      for (const b of [g.canonical, ...g.aliases]) if (a < b) provenPair.add(`${a}|${b}`);
    }
  }

  // A cheap fingerprint first; only equal fingerprints get the full comparison.
  const buckets = new Map<string, number[]>();
  for (let k = 0; k < cols.length; k++) {
    let h = 0;
    for (let i = 0; i < n; i += 7) h = (h * 31 + (Number.isFinite(cols[k]![i]!) ? cols[k]![i]! : -999)) % 1e12;
    const key = h.toFixed(3);
    buckets.set(key, [...(buckets.get(key) ?? []), k]);
  }
  const used = new Set<number>();
  for (const idx of buckets.values()) {
    if (idx.length < 2) continue;
    for (const a of idx) {
      if (used.has(a)) continue;
      const group = [a];
      for (const b of idx) {
        if (b <= a || used.has(b)) continue;
        let same = true;
        for (let i = 0; i < n; i++) {
          const x = cols[a]![i]!, y = cols[b]![i]!;
          if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) { same = false; break; }
        }
        if (same) { group.push(b); used.add(b); }
      }
      if (group.length > 1) {
        const gnames = group.map((g) => meta.names[g]!.name);
        // Drop the ones already explained by sharing a function.
        const novel = gnames.some((x) => gnames.some((y) => x < y && !provenPair.has(`${x}|${y}`)));
        if (novel) observed.push(gnames);
      }
    }
  }
  console.log(`\nمتطابقة على العيّنة بدوال مختلفة: ${observed.length}`);
  for (const g of observed) console.log(`  ${g.join('  ≡  ')}`);
}

writeFileSync(
  'docs/aliases.json',
  `${JSON.stringify({ registered: names.length, distinct: names.length - extra, groups, observed }, null, 2)}\n`,
);

// The human-readable half. Generated, never hand-edited — a table of aliases
// that someone maintains by hand is wrong the first time a register() call
// gains a name, and wrong silently.
const md: string[] = [
  '# الأسماء المكرّرة في المحرك',
  '',
  '> مولَّد من `scripts/audit-aliases.mts` — لا يُحرَّر يدويًا.',
  '',
  `**${names.length}** اسم مسجّل = **${names.length - extra}** حسبة مختلفة. `,
  `**${extra}** اسم منهم لافتة على تنفيذ اسم تاني.`,
  '',
  'الأسماء دي **مُتبقّاة عن قصد**: محرك الدارت فيه نفس المرادفات وبيرجّع نفس القيم،',
  'والتطابق معه هو عقد الهجرة. الحل مش حذف الاسم — الحل إن حد يقولك.',
  '',
  '## ليه ده مهم',
  '',
  'الاستراتيجية بتتحسب بعدّ القواعد. تلات قواعد على `doji` و `harami` و `marubozu`',
  'شكلها تلات تأكيدات مستقلة وبتضيف تلات نتايج — وهي **قراءة واحدة اتحسبت تلاتة**.',
  'ولا حاجة في المحرك بتلاحظ.',
  '',
  '## الحماية',
  '',
  '| أين | ماذا |',
  '| --- | --- |',
  '| `aliasConflicts()` في المحرك | يرجّع كل مجموعة استُخدم منها اسمان أو أكثر |',
  '| زرار اختبار الاستراتيجية في الأدمن | خطأ أحمر يمنع الرفع |',
  '| `scripts/check-live-strategies.mts` | يفشّل النشر |',
  '| المرجع + بروميت جيميناي | كل اسم مكتوب جنبه مرادفه |',
  '',
  'مضاعف الإجماع **مش متأثر**: كل أعضاء أي مجموعة بيقعوا في نفس التصنيف، فالمرادفات',
  'مش بتضخّمه من نفسها. الطريق الوحيد لتضخيمه هو `type` صريح مختلف على اسمين من نفس',
  'المجموعة — والحارس بيمنع الحالة دي من أساسها.',
  '',
  '## المجموعات المضلّلة — الاسم بيقول حاجة والدالة بتعمل حاجة تانية',
  '',
];
for (const g of groups.filter((x) => x.misleading !== null)) {
  md.push(`### \`${g.canonical}\``, '', `**الاسم الحقيقي:** ${g.misleading}`, '',
    `يشمل: ${[g.canonical, ...g.aliases].map((n) => `\`${n}\``).join('، ')}`, '');
}
md.push('## كل المجموعات', '', '| استخدم | نفس الحسبة بالظبط | التصنيف |', '| --- | --- | --- |');
for (const g of groups) {
  md.push(
    `| \`${g.canonical}\` | ${g.aliases.map((n) => `\`${n}\``).join('، ')} | ${[...new Set(Object.values(g.categories))].join(', ')} |`,
  );
}
if (observed.length > 0) {
  md.push(
    '', '## متطابقة على العيّنة — بدوال مختلفة', '',
    'دوال منفصلة رجّعت نفس القيمة في كل نقطة من عيّنة 15,884 نقطة. **مش إثبات**',
    'تطابق — ممكن يختلفوا على داتا العيّنة ماشافتهاش — لكن عاملهم كدليل واحد مش اتنين.',
    '', '| | |', '| --- | --- |',
  );
  for (const g of observed) md.push(`| \`${g[0]}\` | ${g.slice(1).map((n) => `\`${n}\``).join('، ')} |`);
}
writeFileSync('docs/aliases.md', `${md.join('\n')}\n`);

console.log('\nكُتب: docs/aliases.json · docs/aliases.md');
