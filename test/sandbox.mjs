#!/usr/bin/env node
/**
 * sandbox.mjs -- build a throwaway Claude Code config and memory store for
 * trying the plugin end to end, without going near a real store.
 *
 *   /memory-sandbox [memories <n>] [cap <n>] [path <dir>]     (installed)
 *   node test/sandbox.mjs [--memories <n>] [--cap <n>]        (repo checkout)
 *
 * Isolation comes from CLAUDE_CONFIG_DIR, which gives the session its own
 * config, its own plugins, and its own memory. Nothing in ~/.claude is read or
 * written, so an accident in here cannot touch real memories.
 *
 * The config directory is named .claude on purpose: the hook's store guard
 * looks for that, and keeping the sandbox on the same path shape as a real
 * install means the test exercises the same code path.
 *
 * A fresh config directory is not logged in. Expect to authenticate once in
 * the sandbox session; that login stays inside the sandbox.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeArgs, resolveUserPath } from '../scripts/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');

const argv = normalizeArgs(process.argv.slice(2), {
  values: { path: '--path', memories: '--memories', cap: '--cap' },
});
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const root = resolveUserPath(val('--path', path.join(os.tmpdir(), 'top-of-mind-sandbox')));
const count = Number.parseInt(val('--memories', '20'), 10);
const cap = val('--cap', null);

const configDir = path.join(root, '.claude');
const store = path.join(configDir, 'memory');
const project = path.join(root, 'project');

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch (e) {
  // Windows refuses to remove a directory some process is sitting in --
  // usually a still-open session or terminal from a previous sandbox run.
  console.error(`Cannot rebuild ${root}: something is still using it (${e.code}).`);
  console.error('Close any session or terminal inside it, or build elsewhere with --path <dir>.');
  process.exit(1);
}
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(project, { recursive: true });

// Seed memories spread across sections and ages, so ranking is visible at a
// glance rather than every entry scoring the same.
const sections = ['General', 'ProjectA', 'ProjectB'];
let index = '# Memory\n';
const ages = [];
for (let s = 0; s < sections.length; s++) {
  index += `\n## ${sections[s]}\n\n`;
  const n = Math.ceil(count / sections.length);
  for (let i = 0; i < n && ages.length < count; i++) {
    const id = String(ages.length + 1).padStart(2, '0');
    const file = `memory-${id}.md`;
    const ageDays = Math.round(ages.length * (240 / count)); // 0 .. ~240 days
    const pinned = ages.length === 0; // one pinned example
    fs.writeFileSync(
      path.join(store, file),
      `---\nname: memory-${id}\ndescription: Sample memory ${id}\n${pinned ? 'pinned: true\n' : ''}---\n\n` +
        `Sample memory ${id}, seeded ${ageDays} days old.\n`,
      'utf8'
    );
    const t = Date.now() - ageDays * 86400000;
    fs.utimesSync(path.join(store, file), new Date(t), new Date(t));
    index += `- [Memory ${id}](${file}) - sample ${id}${pinned ? ' (pinned)' : ''}\n`;
    ages.push({ file, t });
  }
}
fs.writeFileSync(path.join(store, 'MEMORY.md'), index, 'utf8');

// Point memory at the sandbox store explicitly, so the session cannot fall
// back to a per-project default outside it.
fs.writeFileSync(
  path.join(configDir, 'settings.json'),
  JSON.stringify({ autoMemoryDirectory: store.split(path.sep).join('/') }, null, 2) + '\n',
  'utf8'
);

if (cap) {
  fs.writeFileSync(
    path.join(store, '.top-of-mind.json'),
    JSON.stringify({ version: 1, cap: Number(cap), halfLifeDays: 30, pinReads: 5, mode: 'archive' }, null, 2) + '\n',
    'utf8'
  );
}

// One launcher per platform, written into the sandbox. A single command
// cannot forget to set CLAUDE_CONFIG_DIR; three manual steps once did, and
// the un-isolated session that resulted pointed straight at a real store.
const ps1 = path.join(root, 'launch.ps1');
fs.writeFileSync(
  ps1,
  [
    '# Launches Claude Code fully isolated inside this sandbox.',
    `$env:CLAUDE_CONFIG_DIR = "${configDir}"`,
    `Set-Location "${project}"`,
    `claude --plugin-dir "${PLUGIN}" @args`,
    '',
  ].join('\r\n'),
  'utf8'
);
const sh = path.join(root, 'launch.sh');
fs.writeFileSync(
  sh,
  [
    '#!/bin/sh',
    '# Launches Claude Code fully isolated inside this sandbox.',
    `CLAUDE_CONFIG_DIR="${configDir}" exec claude --plugin-dir "${PLUGIN}" --add-dir "${project}" "$@"`,
    '',
  ].join('\n'),
  'utf8'
);
try {
  fs.chmodSync(sh, 0o755);
} catch {}

const q = (s) => (s.includes(' ') ? `"${s}"` : s);
const isWin = process.platform === 'win32';

console.log('');
console.log(`Sandbox:  ${root}`);
console.log(`Store:    ${store}`);
console.log(`Seeded:   ${ages.length} memories across ${sections.length} sections, 1 pinned`);
console.log(`Cap:      ${cap ? cap + ' (archive)' : 'none - starts in observe-only'}`);
console.log('');
console.log('Launch a sandboxed session (one command, isolation included):');
console.log('');
console.log(isWin ? `  & ${q(ps1)}` : `  ${q(sh)}`);
console.log('');
console.log('The session will ask you to log in: that proves it is isolated.');
console.log('If it comes up already logged in, it is NOT sandboxed - close it.');
console.log('');
console.log('Then, inside that session:');
console.log('');
console.log('  /memory-status              see the seeded store ranked');
console.log('  /memory-setup               see what each cap would retire');
console.log('  /memory-setup cap 10        apply a cap and watch it archive');
console.log('  /memory-status              confirm what moved');
console.log('');
console.log('Inspect from outside at any time:');
console.log(`  node ${q(path.join(PLUGIN, 'scripts', 'memory-status.mjs'))} path ${q(store)}`);
console.log(`  ls ${q(path.join(store, '.archive'))}`);
console.log('');
console.log('Throw it away with:');
console.log(isWin ? `  Remove-Item -Recurse -Force ${q(root)}` : `  rm -rf ${q(root)}`);
console.log('');
