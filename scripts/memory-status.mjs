#!/usr/bin/env node
/**
 * memory-status.mjs -- read-only report on a memory store.
 *
 * Ranks every indexed memory by effective frecency score and shows its access
 * count, age, pin state and section, then names what is next to be evicted.
 *
 *   node scripts/memory-status.mjs [--path <dir>] [--pinned] [--json]
 *
 * Shares lib.mjs with the prune hook, so what it reports is exactly what the
 * hook would do.
 */

import fs from 'node:fs';
import {
  loadConfig,
  defaultStore,
  effective,
  isManuallyPinned,
  loadState,
  missingStoreMessage,
  normalizeArgs,
  parseIndex,
  resolveUserPath,
} from './lib.mjs';
import path from 'node:path';

const argv = normalizeArgs(process.argv.slice(2), {
  booleans: { pinned: '--pinned', json: '--json' },
  values: { path: '--path', store: '--path' },
});
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const explicit = val('--path', null);
const dir = explicit ? resolveUserPath(explicit) : defaultStore();
const pinnedOnly = has('--pinned');
const asJson = has('--json');

const indexPath = path.join(dir, 'MEMORY.md');
if (!fs.existsSync(indexPath)) {
  console.error(explicit ? `No MEMORY.md at ${dir}` : missingStoreMessage());
  process.exit(1);
}

const cfg = loadConfig(dir);
const { cap, halfLifeDays, pinReads } = cfg;
const { entries } = parseIndex(indexPath);
if (entries.length === 0) {
  console.log(`No memories indexed in ${indexPath}`);
  process.exit(0);
}

const indexed = [...new Set(entries.map((e) => e.file))];
const state = loadState(dir, path.join(dir, '.access.json'), indexed);
const now = Date.now();

let rows = entries.map((e) => {
  const st = state.get(e.file);
  const manual = isManuallyPinned(path.join(dir, e.file));
  const auto = st.count >= pinReads;
  return {
    score: Math.round(effective(st, now, halfLifeDays) * 100) / 100,
    reads: st.count,
    ageDays: Math.round((now - st.last) / 86400000),
    pin: manual ? 'MANUAL' : auto ? 'auto' : '',
    evictable: !manual && !auto,
    memory: e.file,
    section: e.section,
  };
});
rows.sort((a, b) => b.score - a.score);
if (pinnedOnly) rows = rows.filter((r) => r.pin);

const nManual = rows.filter((r) => r.pin === 'MANUAL').length;
const nAuto = rows.filter((r) => r.pin === 'auto').length;
const total = entries.length;
const free = cap === null ? null : cap - total;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        store: dir,
        configured: cfg.configured,
        active: cfg.active,
        hasCap: cfg.hasCap,
        cap,
        mode: cfg.mode,
        halfLifeDays,
        pinReads,
        total,
        free,
        rows,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const C = process.stdout.isTTY
  ? { dim: '\x1b[90m', red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', off: '\x1b[0m' }
  : { dim: '', red: '', yel: '', grn: '', off: '' };

console.log('');
console.log(`Memory store: ${dir}`);
if (cfg.configured) {
  const freeColor = free < 0 ? C.red : free <= 5 ? C.yel : C.grn;
  console.log(
    `${total} entries / cap ${cap}   ${freeColor}${free} free${C.off}   ` +
      `pinned: ${nManual} manual, ${nAuto} auto (${pinReads}+ reads)   ` +
      `half-life ${halfLifeDays}d   mode ${cfg.mode}`
  );
} else {
  const why = cfg.hasCap
    ? `capping OFF - cap ${cap} kept, nothing retired`
    : 'no cap set - nothing is retired';
  console.log(
    `${total} entries   ${C.yel}${why}${C.off}   ` +
      `pinned: ${nManual} manual, ${nAuto} auto (${pinReads}+ reads)   half-life ${halfLifeDays}d`
  );
}
console.log('');

const w = (s, n) => String(s).padEnd(n);
const r = (s, n) => String(s).padStart(n);
const memW = Math.max(6, ...rows.map((x) => x.memory.length));
const secW = Math.max(7, ...rows.map((x) => x.section.length));

console.log(`${r('Score', 6)} ${r('Reads', 5)} ${r('Age(d)', 6)} ${w('Pin', 6)} ${w('Memory', memW)} Section`);
console.log(`${'-'.repeat(6)} ${'-'.repeat(5)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(memW)} ${'-'.repeat(secW)}`);
for (const x of rows) {
  console.log(
    `${r(x.score.toFixed(2), 6)} ${r(x.reads, 5)} ${r(x.ageDays, 6)} ${w(x.pin, 6)} ${w(x.memory, memW)} ${x.section}`
  );
}
console.log('');

if (!pinnedOnly) {
  if (!cfg.configured) {
    console.log(
      cfg.hasCap
        ? `${C.yel}Capping is off. Resume with /memory-setup on (cap ${cap}, mode ${cfg.mode} are kept).${C.off}`
        : `${C.yel}No cap is set, so nothing is retired. Run /memory-setup to choose one.${C.off}`
    );
  } else {
    if (free < 0) process.stdout.write(`${C.red}OVER CAP by ${-free}.${C.off} `);
    const next = rows.filter((x) => x.evictable).slice(-3).reverse();
    if (next.length > 0) {
      const verb = cfg.mode === 'delete' ? 'deleted' : 'archived';
      console.log(`${C.dim}Next to be ${verb}: ${next.map((x) => x.memory).join(', ')}${C.off}`);
    } else {
      console.log(`${C.yel}Nothing can be retired - every entry is pinned.${C.off}`);
    }
  }
  console.log(`${C.dim}Pin a memory by adding  pinned: true  to its frontmatter.${C.off}`);
  console.log('');
}
