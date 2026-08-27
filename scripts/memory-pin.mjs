#!/usr/bin/env node
/**
 * memory-pin.mjs -- pin or unpin a memory from the command line.
 *
 *   node scripts/memory-pin.mjs <name>            pin a memory
 *   node scripts/memory-pin.mjs unpin <name>      unpin a memory
 *   node scripts/memory-pin.mjs --unpin <name>    the same, flag form
 *   node scripts/memory-pin.mjs [--path <dir>] .. target another store
 *
 * Pinning is a `pinned: true` line in the memory's frontmatter, which the hook
 * never retires. This is the same edit you would make by hand, without opening
 * the file.
 *
 * On an exact name match (a slug or filename) it applies straight away. On a
 * fuzzy match it applies nothing: it prints the candidates so the caller can
 * confirm which memory was meant, then run again with the exact slug.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  defaultStore,
  isManuallyPinned,
  loadConfig,
  loadState,
  missingStoreMessage,
  normalizeArgs,
  parseIndex,
  resolveMemoryQuery,
  resolveUserPath,
  setManualPin,
} from './lib.mjs';

// A leading `pin`/`unpin` word is the plain-language form of the flag.
let raw = process.argv.slice(2);
let unpinLead = false;
if (raw[0] === 'unpin') {
  raw = raw.slice(1);
  unpinLead = true;
} else if (raw[0] === 'pin') {
  raw = raw.slice(1);
}

const argv = normalizeArgs(raw, {
  booleans: { unpin: '--unpin', help: '--help' },
  values: { path: '--path', store: '--path' },
});
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

if (has('--help')) {
  console.log(`
memory-pin - pin or unpin a memory so the hook never retires it

  memory-pin <name>          pin a memory
  memory-pin unpin <name>    unpin a memory

  path <dir>                 target a store other than the detected one

<name> is a memory's slug or filename. A partial name or title also works; when
it is not an exact match you are shown the candidates to confirm before anything
is pinned. Run memory-status to see the names.
`);
  process.exit(0);
}

const unpin = unpinLead || has('--unpin');

const explicit = val('--path', null);
const dir = explicit ? resolveUserPath(explicit) : defaultStore();
const indexPath = path.join(dir, 'MEMORY.md');
if (!fs.existsSync(indexPath)) {
  console.error(explicit ? `No MEMORY.md at ${dir}` : missingStoreMessage());
  process.exit(1);
}

// The query is every non-flag word, minus the value that belongs to --path.
const query = argv
  .filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--path')
  .join(' ')
  .trim();

const verb = unpin ? 'unpin' : 'pin';
if (!query) {
  console.error(`Which memory? Usage: memory-${verb} <name>`);
  console.error('Run memory-status to see the memory names.');
  process.exit(1);
}

const { entries } = parseIndex(indexPath);
const { exact, candidates } = resolveMemoryQuery(entries, query);

// Nothing matched at all.
if (!exact && candidates.length === 0) {
  console.error(`No memory matches "${query}" in ${dir}.`);
  console.error('Run memory-status to see the memory names, then try again.');
  process.exit(1);
}

// Fuzzy: never apply. Surface the candidates for confirmation.
if (!exact) {
  const many = candidates.length > 1;
  console.log(`No exact match for "${query}". ${candidates.length} possible ${many ? 'matches' : 'match'}:`);
  console.log('');
  for (const e of candidates.slice(0, 10)) {
    const flag = isManuallyPinned(path.join(dir, e.file)) ? '  [pinned]' : '';
    console.log(`  ${e.file}${flag}  -  ${e.title}  (${e.section || 'no section'})`);
  }
  if (candidates.length > 10) console.log(`  ... and ${candidates.length - 10} more`);
  console.log('');
  console.log(`Nothing was ${verb}ned. Confirm which memory you mean, then run:  memory-${verb} <slug>`);
  console.log('(the slug is the name before .md in the list above)');
  process.exit(0);
}

// Exact: apply.
const target = exact.file;
const filePath = path.join(dir, target);
const result = setManualPin(filePath, !unpin);

if (!unpin) {
  if (result === 'already-pinned') {
    console.log(`${target} is already pinned. No change.`);
  } else {
    console.log(`Pinned ${target}. It will never be retired while pinned: true stays in its frontmatter.`);
  }
} else {
  if (result === 'not-pinned') {
    console.log(`${target} was not manually pinned. No change.`);
  } else {
    console.log(`Unpinned ${target}. Removed pinned: true from its frontmatter.`);
  }
  // A memory can also auto-pin from its read count; unpinning does not touch that.
  const cfg = loadConfig(dir);
  const indexed = [...new Set(entries.map((e) => e.file))];
  const state = loadState(dir, path.join(dir, '.access.json'), indexed);
  const st = state.get(target);
  if (st && st.count >= cfg.pinReads) {
    console.log(
      `Note: ${target} still auto-pins. It has ${st.count} reads (auto-pin at ${cfg.pinReads}+), ` +
        'so it stays pinned until its read count is below that.'
    );
  }
}
process.exit(0);
