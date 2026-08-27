#!/usr/bin/env node
/**
 * memory-setup.mjs -- choose a cap for a memory store.
 *
 *   node scripts/memory-setup.mjs [--path <dir>]                  report
 *   node scripts/memory-setup.mjs --cap <n> [--mode archive|delete] apply
 *   node scripts/memory-setup.mjs --off                            back to observe-only
 *
 * The report shows what each cap would actually cost before anything is
 * written, because retiring is not free and the right cap depends entirely on
 * how big the store already is.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ARCHIVE_DIR,
  CONFIG_FILE,
  DEFAULTS,
  defaultStore,
  effective,
  isManuallyPinned,
  loadConfig,
  loadState,
  missingStoreMessage,
  normalizeArgs,
  parseIndex,
  resolveUserPath,
  saveConfig,
} from './lib.mjs';

const argv = normalizeArgs(process.argv.slice(2), {
  booleans: { off: '--off', on: '--on', reset: '--reset', help: '--help' },
  values: { cap: '--cap', mode: '--mode', path: '--path', store: '--path' },
  bare: (w) => (w === 'archive' || w === 'delete' ? ['--mode', w] : null),
});
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

if (has('--help')) {
  console.log(`
memory-setup - choose a cap for a memory store

  memory-setup                      report: what each cap would retire
  memory-setup cap <n>              apply a cap
  memory-setup cap <n> delete       apply a cap, and delete instead of archive
  memory-setup mode archive|delete  change what retiring does
  memory-setup off                  stop retiring, keep your settings
  memory-setup on                   resume with the settings you had
  memory-setup reset                discard settings entirely

  path <dir>                        target a store other than the detected one

Flag forms (--cap, --mode, --off, --path) work too.
`);
  process.exit(0);
}

const explicit = val('--path', null);
const dir = explicit ? resolveUserPath(explicit) : defaultStore();
const indexPath = path.join(dir, 'MEMORY.md');
if (!fs.existsSync(indexPath)) {
  console.error(explicit ? `No MEMORY.md at ${dir}` : missingStoreMessage());
  process.exit(1);
}

const cfg = loadConfig(dir);
const { entries } = parseIndex(indexPath);
const indexed = [...new Set(entries.map((e) => e.file))];
const state = loadState(dir, path.join(dir, '.access.json'), indexed);
const now = Date.now();

const ranked = indexed
  .map((f) => ({
    file: f,
    salience: effective(state.get(f), now, cfg.halfLifeDays),
    pinned: isManuallyPinned(path.join(dir, f)) || state.get(f).count >= cfg.pinReads,
    last: state.get(f).last,
  }))
  .sort((a, b) => b.salience - a.salience);

const total = ranked.length;
const pinnedCount = ranked.filter((r) => r.pinned).length;

/** How many entries a given cap would retire, honoring pins. */
function retiredAt(cap) {
  let over = total - cap;
  if (over <= 0) return 0;
  const evictable = ranked.filter((r) => !r.pinned).length;
  return Math.min(over, evictable);
}

// --- pause / resume ---------------------------------------------------
if (has('--off') || has('--on')) {
  const turningOn = has('--on');
  if (!cfg.hasCap) {
    console.log(
      turningOn
        ? `No cap is set for ${dir}, so there is nothing to turn on. Use: memory-setup cap <n>`
        : `Capping is already off for ${dir} - no cap has ever been set.`
    );
    process.exit(0);
  }
  saveConfig(dir, {
    active: turningOn,
    cap: cfg.cap,
    halfLifeDays: cfg.halfLifeDays,
    pinReads: cfg.pinReads,
    mode: cfg.mode,
  });
  if (turningOn) {
    const n = retiredAt(cfg.cap);
    console.log(`Capping on for ${dir}, at cap ${cfg.cap} (mode ${cfg.mode}).`);
    if (n > 0) console.log(`The next write will retire ${n}.`);
    else console.log('Nothing to retire right now.');
  } else {
    console.log(`Capping off for ${dir}. Ranking continues; nothing will be retired.`);
    console.log(`Your settings are kept (cap ${cfg.cap}, mode ${cfg.mode}). Turn back on with: memory-setup on`);
  }
  process.exit(0);
}

// --- discard config entirely ------------------------------------------
if (has('--reset')) {
  const existed = fs.existsSync(path.join(dir, CONFIG_FILE));
  try {
    fs.rmSync(path.join(dir, CONFIG_FILE), { force: true });
  } catch {}
  console.log(
    existed
      ? `Removed ${CONFIG_FILE} from ${dir}. Back to observe-only, settings discarded.`
      : `No ${CONFIG_FILE} in ${dir}; nothing to remove.`
  );
  process.exit(0);
}

// --- change mode alone ------------------------------------------------
if (has('--mode') && !has('--cap')) {
  const modeArg = val('--mode', '');
  if (modeArg !== 'archive' && modeArg !== 'delete') {
    console.error('mode must be archive or delete');
    process.exit(1);
  }
  saveConfig(dir, {
    active: cfg.active, // changing mode must not silently resume capping
    cap: cfg.cap,
    halfLifeDays: cfg.halfLifeDays,
    pinReads: cfg.pinReads,
    mode: modeArg,
  });
  console.log(
    modeArg === 'delete'
      ? `Mode set to delete. Retired memories will be removed permanently.`
      : `Mode set to archive. Retired memories will move to ${ARCHIVE_DIR}/.`
  );
  if (!cfg.hasCap) console.log('No cap is set, so nothing is retired yet. Use: memory-setup cap <n>');
  else if (!cfg.active) console.log('Capping is off, so nothing is retired yet. Turn on with: memory-setup on');
  process.exit(0);
}

// --- apply ------------------------------------------------------------
if (has('--cap')) {
  const cap = Number.parseInt(val('--cap', ''), 10);
  if (!Number.isFinite(cap) || cap < 1) {
    console.error('cap needs a positive integer, for example: memory-setup cap 100');
    process.exit(1);
  }
  const modeArg = val('--mode', cfg.mode);
  if (modeArg !== 'archive' && modeArg !== 'delete') {
    console.error('--mode must be archive or delete');
    process.exit(1);
  }
  const written = saveConfig(dir, {
    active: true, // choosing a cap means you want it enforced
    cap,
    halfLifeDays: cfg.halfLifeDays,
    pinReads: cfg.pinReads,
    mode: modeArg,
  });
  const n = retiredAt(cap);
  const verb = modeArg === 'delete' ? 'deleted' : `moved to ${ARCHIVE_DIR}/`;
  console.log(`Wrote ${path.join(dir, CONFIG_FILE)}`);
  console.log(JSON.stringify(written, null, 2));
  console.log('');
  if (n === 0) {
    console.log(`Store holds ${total} memories, at or under the cap. Nothing will be retired now.`);
  } else {
    console.log(`Store holds ${total} memories. The next write will see ${n} ${verb}:`);
    for (const r of ranked.filter((x) => !x.pinned).slice(-n).reverse()) {
      console.log(`  ${r.salience.toFixed(2).padStart(6)}  ${r.file}`);
    }
  }
  process.exit(0);
}

// --- report -----------------------------------------------------------
console.log('');
console.log(`Memory store: ${dir}`);
console.log(`${total} memories indexed, ${pinnedCount} pinned.`);
console.log(
  cfg.configured
    ? `Current cap: ${cfg.cap}, mode ${cfg.mode}.`
    : cfg.hasCap
      ? `Capping is OFF. Settings kept: cap ${cfg.cap}, mode ${cfg.mode}. Resume with: memory-setup on`
      : 'No cap set. Ranking only; nothing is being retired.'
);
console.log('');

const oldest = ranked[ranked.length - 1];
if (oldest) {
  const days = Math.round((now - oldest.last) / 86400000);
  console.log(`Weakest memory: ${oldest.file} (untouched ${days}d)`);
  console.log('');
}

const candidates = [...new Set([50, 100, 200, 500, total, total + 50].filter((c) => c >= 1))].sort(
  (a, b) => a - b
);
console.log('  cap     retires now');
console.log('  ------  -----------');
for (const c of candidates) {
  const n = retiredAt(c);
  const note = c === total ? '  <- cap at current size' : n === 0 ? '' : '';
  console.log(`  ${String(c).padEnd(6)}  ${String(n).padEnd(11)}${note}`);
}
console.log('');
console.log(`Recommended: ${total} (nothing retired today, bounded from here on).`);
console.log('');
console.log('Apply with:');
console.log(`  node scripts/memory-setup.mjs --cap <n> [--mode archive|delete]`);
console.log('');
console.log(
  `Mode ${DEFAULTS.mode} is the default: retired memories move to ${ARCHIVE_DIR}/ and leave`
);
console.log('MEMORY.md, so they stop costing context but are still recoverable.');
console.log('');
