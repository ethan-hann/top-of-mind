#!/usr/bin/env node
/**
 * run-tests.mjs -- behavioral tests for the prune hook.
 *
 *   node test/run-tests.mjs
 *
 * Each test builds a throwaway store under the OS temp dir, feeds the hook a
 * synthetic payload on stdin, and asserts on what actually happened to the
 * files. Nothing touches a real memory store.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStore, projectSlug, storeCandidates } from '../scripts/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'scripts', 'prune-memory.mjs');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`);
  }
}

let seq = 0;
function newStore({ count = 0, pinned = [], bodyPin = [], altPin = [], sections = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'topofmind-'));
  const dir = path.join(root, '.claude', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  let idx = '# Memory\n\n';
  if (sections) idx += '## Alpha\n\n';
  for (let i = 1; i <= count; i++) {
    const id = String(i).padStart(2, '0');
    const file = `m-${id}.md`;
    let fm = `---\nname: m-${id}\n`;
    if (pinned.includes(id)) fm += 'pinned: true\n';
    if (altPin.includes(id)) fm += '  pinned: yes\n'; // indented, as the harness normalizes
    fm += '---\n\n';
    let body = `Body ${id}.\n`;
    if (bodyPin.includes(id)) body = 'pinned: true\n';
    fs.writeFileSync(path.join(dir, file), fm + body, 'utf8');
    if (sections && i === Math.ceil(count / 2)) idx += '\n## Beta\n\n';
    idx += `- [M ${id}](${file}) - hook ${id}\n`;
  }
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), idx, 'utf8');
  seq++;
  return { root, dir };
}

function runHook(dir, toolName, file, env = {}) {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: { file_path: path.join(dir, file) },
  });
  try {
    return execFileSync(process.execPath, [HOOK], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  } catch (e) {
    return String(e.stdout ?? '');
  }
}

const files = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
const idx = (dir) => fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
const entryCount = (dir) => (idx(dir).match(/^\s*-\s*\[/gm) || []).length;
const log = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.access.json'), 'utf8'));
const CAP5 = { TOP_OF_MIND_CAP: '5' };
const cfgPath = (dir) => path.join(dir, '.top-of-mind.json');
const writeCfg = (dir, o) => fs.writeFileSync(cfgPath(dir), JSON.stringify({ version: 1, ...o }), 'utf8');
const archived = (dir) => {
  try {
    return fs.readdirSync(path.join(dir, '.archive'));
  } catch {
    return [];
  }
};

console.log('\n--- path argument ---');
{
  const STATUS = path.join(HERE, '..', 'scripts', 'memory-status.mjs');
  const { dir } = newStore({ count: 3 });
  const runAt = (p) => {
    try {
      return execFileSync(process.execPath, [STATUS, 'json', 'path', p], { encoding: 'utf8' });
    } catch (e) {
      return String(e.stdout ?? '') + String(e.stderr ?? '');
    }
  };
  // An absolute --path lands exactly there.
  let j = null;
  try {
    j = JSON.parse(runAt(dir));
  } catch {}
  check('absolute --path resolves to that store', j?.store === path.resolve(dir), `store=${j?.store}`);

  // A leading ~ expands to the home directory, not a literal "~" folder under cwd.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const rel = path.relative(home, dir).split(path.sep).join('/');
    if (!rel.startsWith('..')) {
      let jt = null;
      try {
        jt = JSON.parse(runAt('~/' + rel));
      } catch {}
      check('~ in --path expands to home', jt?.store === path.resolve(dir), `store=${jt?.store}`);
    } else {
      // sandbox temp dir is not under home; assert ~ does not become a literal folder
      const out = runAt('~/definitely-nonexistent-tom-xyz');
      check('~ in --path is not treated literally', !out.includes(path.join(process.cwd(), '~')), out.slice(0, 80));
    }
  } else {
    check('~ test skipped (no HOME)', true);
  }
}

console.log('\n--- observe-only until configured ---');
{
  // The critical safety case: a big store, a fresh install, no cap anywhere.
  const { dir } = newStore({ count: 12 });
  const out = runHook(dir, 'Write', 'MEMORY.md'); // no CAP env, no config file
  check('unconfigured store retires nothing', files(dir).length === 12);
  check('  and keeps every index entry', entryCount(dir) === 12);
  check('  and says so once', /no cap is set/i.test(out), out.slice(0, 90));
  const out2 = runHook(dir, 'Write', 'MEMORY.md');
  check('  but does not repeat the notice', !/no cap is set/i.test(out2));
}
{
  // Ranking must still happen while unconfigured -- it is non-destructive.
  const { dir } = newStore({ count: 4 });
  const j = { version: 3, seen: {} };
  for (let i = 1; i <= 4; i++) {
    j.seen[`m-${String(i).padStart(2, '0')}.md`] = { count: 1, score: i, last: new Date().toISOString() };
  }
  fs.writeFileSync(path.join(dir, '.access.json'), JSON.stringify(j), 'utf8');
  runHook(dir, 'Write', 'MEMORY.md');
  const order = [...idx(dir).matchAll(/\(m-(\d+)\.md\)/g)].map((m) => Number(m[1]));
  check('unconfigured store still re-ranks', order[0] === 4 && order[3] === 1, JSON.stringify(order));
}
{
  const { dir } = newStore({ count: 8 });
  writeCfg(dir, { cap: 5, mode: 'delete' });
  runHook(dir, 'Write', 'MEMORY.md');
  check('config file enables capping', files(dir).length === 5);
}
{
  // Paused with a cap on disk: retire nothing, and do not nag either.
  const { dir } = newStore({ count: 8 });
  writeCfg(dir, { cap: 5, mode: 'delete', active: false });
  const out = runHook(dir, 'Write', 'MEMORY.md');
  check('inactive config retires nothing', files(dir).length === 8);
  check('  and does not nag about a missing cap', !/no cap is set/i.test(out), out.slice(0, 80));
}
{
  const { dir } = newStore({ count: 8 });
  writeCfg(dir, { cap: 5, active: false });
  runHook(dir, 'Write', 'MEMORY.md', { TOP_OF_MIND_ACTIVE: '1' });
  check('env can force capping back on', files(dir).length === 5, `files=${files(dir).length}`);
}
{
  const { dir } = newStore({ count: 8 });
  writeCfg(dir, { cap: 5 });
  runHook(dir, 'Write', 'MEMORY.md', { TOP_OF_MIND_ACTIVE: '0' });
  check('env can pause capping', files(dir).length === 8, `files=${files(dir).length}`);
}
{
  const { dir } = newStore({ count: 8 });
  writeCfg(dir, { cap: 99 });
  runHook(dir, 'Write', 'MEMORY.md', CAP5);
  check('env cap overrides the config file', files(dir).length === 5, `files=${files(dir).length}`);
}

console.log('\n--- archive mode ---');
{
  const { dir } = newStore({ count: 8 });
  writeCfg(dir, { cap: 5 }); // mode defaults to archive
  const out = runHook(dir, 'Write', 'MEMORY.md');
  check('archives rather than deletes by default', archived(dir).length === 3, `archived=${archived(dir).length}`);
  check('  removes them from the index', entryCount(dir) === 5);
  check('  leaves 5 live files', files(dir).length === 5);
  check('  reports archiving, not deletion', /archived/i.test(out) && !/deleted/i.test(out));
}
{
  const { dir } = newStore({ count: 8 });
  writeCfg(dir, { cap: 5, mode: 'delete' });
  const out = runHook(dir, 'Write', 'MEMORY.md');
  check('delete mode really deletes', archived(dir).length === 0 && files(dir).length === 5);
  check('  and reports deletion', /deleted/i.test(out));
}
{
  // An archived name colliding with a later memory of the same name.
  const { dir } = newStore({ count: 8 });
  fs.mkdirSync(path.join(dir, '.archive'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.archive', 'm-01.md'), 'older copy', 'utf8');
  writeCfg(dir, { cap: 7 });
  runHook(dir, 'Write', 'MEMORY.md');
  check('archive collision does not clobber', archived(dir).length === 2, JSON.stringify(archived(dir)));
  check('  original archived copy survives',
    fs.readFileSync(path.join(dir, '.archive', 'm-01.md'), 'utf8') === 'older copy');
}
{
  // Files inside .archive must never be treated as a store of their own.
  const { dir } = newStore({ count: 8 });
  writeCfg(dir, { cap: 5 });
  runHook(dir, 'Write', 'MEMORY.md');
  const before = archived(dir).length;
  const arch = path.join(dir, '.archive', archived(dir)[0]);
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: arch } });
  execFileSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8' });
  check('touching an archived file is ignored', archived(dir).length === before);
}

console.log('\n--- store resolution (the sandbox bug) ---');
{
  const STATUS = path.join(HERE, '..', 'scripts', 'memory-status.mjs');
  const runStatus = (args, env) => {
    try {
      return execFileSync(process.execPath, [STATUS, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
    } catch (e) {
      return String(e.stdout ?? '') + String(e.stderr ?? '');
    }
  };

  // A sandbox: config dir with settings.json pointing at its own store.
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'topofmind-cfg-'));
  const sbConfig = path.join(sandboxRoot, '.claude');
  const sbStore = path.join(sbConfig, 'memory');
  fs.mkdirSync(sbStore, { recursive: true });
  fs.writeFileSync(path.join(sbStore, 'only-here.md'), '---\nname: only-here\n---\n\nSandbox fact.\n', 'utf8');
  fs.writeFileSync(path.join(sbStore, 'MEMORY.md'), '# Memory\n\n- [Only here](only-here.md) - x\n', 'utf8');
  fs.writeFileSync(
    path.join(sbConfig, 'settings.json'),
    JSON.stringify({ autoMemoryDirectory: sbStore.split(path.sep).join('/') }),
    'utf8'
  );

  // With CLAUDE_CONFIG_DIR set and NO path argument, the commands must land
  // on the sandbox store -- never on the user's real one.
  const out = runStatus(['json'], { CLAUDE_CONFIG_DIR: sbConfig });
  let j = null;
  try {
    j = JSON.parse(out);
  } catch {}
  check('CLAUDE_CONFIG_DIR redirects the default store', j?.store === path.resolve(sbStore),
    `store=${j?.store}`);
  check('  and sees only the sandbox memories', j?.total === 1 && /only-here/.test(out));

  // Same, but the config dir has no settings.json: fall back to ITS memory
  // dir, never to ~/.claude.
  fs.rmSync(path.join(sbConfig, 'settings.json'), { force: true });
  const out2 = runStatus(['json'], { CLAUDE_CONFIG_DIR: sbConfig });
  let j2 = null;
  try {
    j2 = JSON.parse(out2);
  } catch {}
  check('bare config dir resolves to its own memory dir', j2?.store === path.resolve(sbStore),
    `store=${j2?.store}`);

  // A config dir with autoMemoryDirectory pointing somewhere custom.
  const custom = path.join(sandboxRoot, 'elsewhere');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, 'MEMORY.md'), '# Memory\n\n- [C](c.md) - x\n', 'utf8');
  fs.writeFileSync(path.join(custom, 'c.md'), '---\nname: c\n---\n\nC.\n', 'utf8');
  fs.writeFileSync(
    path.join(sbConfig, 'settings.json'),
    JSON.stringify({ autoMemoryDirectory: custom.split(path.sep).join('/') }),
    'utf8'
  );
  const out3 = runStatus(['json'], { CLAUDE_CONFIG_DIR: sbConfig });
  let j3 = null;
  try {
    j3 = JSON.parse(out3);
  } catch {}
  check('autoMemoryDirectory in the config dir wins', j3?.store === path.resolve(custom),
    `store=${j3?.store}`);

  // An explicit path argument still beats everything.
  const out4 = runStatus(['json', 'path', sbStore], { CLAUDE_CONFIG_DIR: sbConfig });
  let j4 = null;
  try {
    j4 = JSON.parse(out4);
  } catch {}
  check('an explicit path still wins', j4?.store === path.resolve(sbStore));
}

console.log('\n--- plain-word arguments ---');
{
  const SETUP = path.join(HERE, '..', 'scripts', 'memory-setup.mjs');
  const STATUS = path.join(HERE, '..', 'scripts', 'memory-status.mjs');
  const run = (script, args) => {
    try {
      return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    } catch (e) {
      return String(e.stdout ?? '') + String(e.stderr ?? '');
    }
  };
  const { dir } = newStore({ count: 6 });

  run(SETUP, ['cap', '4', 'path', dir]);
  let cfg = JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
  check('`cap 4` sets the cap', cfg.cap === 4, JSON.stringify(cfg));
  check('  and defaults to archive', cfg.mode === 'archive');

  run(SETUP, ['cap', '3', 'delete', 'path', dir]);
  cfg = JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
  check('`cap 3 delete` sets both', cfg.cap === 3 && cfg.mode === 'delete', JSON.stringify(cfg));

  run(SETUP, ['mode', 'archive', 'path', dir]);
  cfg = JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
  check('`mode archive` changes mode only', cfg.mode === 'archive' && cfg.cap === 3);

  // off must PAUSE, not forget: the whole point is that on restores settings.
  run(SETUP, ['cap', '9', 'delete', 'path', dir]);
  run(SETUP, ['off', 'path', dir]);
  cfg = JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
  check('`off` keeps the config file', fs.existsSync(cfgPath(dir)));
  check('  and preserves cap and mode', cfg.cap === 9 && cfg.mode === 'delete', JSON.stringify(cfg));
  check('  and marks it inactive', cfg.active === false);

  run(SETUP, ['on', 'path', dir]);
  cfg = JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
  check('`on` restores the same settings', cfg.active === true && cfg.cap === 9 && cfg.mode === 'delete');

  // mode changes while paused must not silently resume capping
  run(SETUP, ['off', 'path', dir]);
  run(SETUP, ['mode', 'archive', 'path', dir]);
  cfg = JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
  check('changing mode while off stays off', cfg.active === false && cfg.mode === 'archive');

  // setting a cap is an explicit intent to enforce it
  run(SETUP, ['cap', '6', 'path', dir]);
  cfg = JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
  check('`cap` re-activates', cfg.active === true && cfg.cap === 6);

  run(SETUP, ['reset', 'path', dir]);
  check('`reset` removes the config', !fs.existsSync(cfgPath(dir)));

  // flags must keep working for direct scripting
  const readCfg = () => {
    try {
      return JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
    } catch {
      return null;
    }
  };
  run(SETUP, ['--cap', '7', '--mode', 'delete', '--path', dir]);
  cfg = readCfg();
  check('flag form still works', cfg?.cap === 7 && cfg?.mode === 'delete', JSON.stringify(cfg));

  // a value that looks like a keyword must not be re-read as a subcommand
  run(SETUP, ['--path', dir, 'cap', '5', '--mode', 'archive']);
  cfg = readCfg();
  check('keyword-shaped flag values survive', cfg?.cap === 5 && cfg?.mode === 'archive', JSON.stringify(cfg));

  const bad = run(SETUP, ['cap', 'banana', 'path', dir]);
  check('rejects a non-numeric cap', /positive integer/.test(bad), bad.slice(0, 60));

  const help = run(SETUP, ['help']);
  check('`help` prints usage', /memory-setup cap <n>/.test(help));

  const j = run(STATUS, ['json', 'path', dir]);
  check('`json` gives parseable output', JSON.parse(j).total === 6, j.slice(0, 60));
  const p = run(STATUS, ['pinned', 'path', dir]);
  check('`pinned` filters', !/m-01\.md/.test(p) || /MANUAL/.test(p));
}

console.log('\n--- guards ---');
{
  const { root, dir } = newStore({ count: 3 });
  // a file outside any memory dir
  const outside = path.join(root, 'notes.md');
  fs.writeFileSync(outside, 'hi', 'utf8');
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: outside } });
  execFileSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8' });
  check('ignores files outside a memory dir', !fs.existsSync(path.join(dir, '.access.json')));
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'topofmind-'));
  const dir = path.join(root, '.claude', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.md'), 'hi', 'utf8'); // no MEMORY.md
  runHook(dir, 'Write', 'x.md');
  check('ignores a memory dir with no MEMORY.md', !fs.existsSync(path.join(dir, '.access.json')));
  check('  and leaves its files alone', fs.existsSync(path.join(dir, 'x.md')));
}
{
  const { dir } = newStore({ count: 2 });
  // malformed link target that tries to escape the store
  fs.appendFileSync(path.join(dir, 'MEMORY.md'), '- [Bad](../../evil.md) - x\n', 'utf8');
  const victim = path.join(dir, '..', '..', 'evil.md');
  fs.writeFileSync(victim, 'do not delete', 'utf8');
  runHook(dir, 'Write', 'MEMORY.md', CAP5);
  check('rejects a traversal link target', fs.existsSync(victim));
  fs.rmSync(victim, { force: true });
}

console.log('\n--- scoring ---');
{
  const { dir } = newStore({ count: 3 });
  // seed a v2-format log
  fs.writeFileSync(
    path.join(dir, '.access.json'),
    JSON.stringify({ seen: { 'm-01.md': new Date().toISOString() } }),
    'utf8'
  );
  runHook(dir, 'Read', 'm-01.md');
  const j = log(dir);
  check('migrates a v2 log to v3', j.version === 3 && typeof j.seen['m-01.md'] === 'object');
  check('  seeds every indexed entry', Object.keys(j.seen).length === 3);
}
{
  const { dir } = newStore({ count: 3 });
  for (let i = 0; i < 4; i++) runHook(dir, 'Read', 'm-01.md');
  const s = log(dir).seen['m-01.md'];
  check('count rises on each Read', s.count === 5, `count=${s.count}`);
  check('  score accumulates', s.score > 4 && s.score <= 5, `score=${s.score}`);
}
{
  const { dir } = newStore({ count: 3 });
  runHook(dir, 'Read', 'm-01.md');
  check('a Read never deletes', files(dir).length === 3);
}

console.log('\n--- eviction ---');
{
  const { dir } = newStore({ count: 8 });
  // make m-01/m-02 the coldest by far
  const j = { version: 3, seen: {} };
  for (let i = 1; i <= 8; i++) {
    const id = String(i).padStart(2, '0');
    j.seen[`m-${id}.md`] = {
      count: 1,
      score: 1,
      last: new Date(Date.now() - (i <= 2 ? 400 : 1) * 86400000).toISOString(),
    };
  }
  fs.writeFileSync(path.join(dir, '.access.json'), JSON.stringify(j), 'utf8');
  runHook(dir, 'Write', 'MEMORY.md', CAP5);
  check('caps the index', entryCount(dir) === 5, `entries=${entryCount(dir)}`);
  check('  deletes the files too', files(dir).length === 5);
  check('  evicts the coldest', !fs.existsSync(path.join(dir, 'm-01.md')));
  check('  keeps the warmest', fs.existsSync(path.join(dir, 'm-08.md')));
}
{
  // At exactly the cap nothing may be deleted. The index may still be
  // re-ranked -- that is the ordering pass, not eviction.
  const { dir } = newStore({ count: 5 });
  runHook(dir, 'Write', 'MEMORY.md', CAP5);
  check('deletes nothing at exactly the cap', files(dir).length === 5);
  check('  and keeps every index entry', entryCount(dir) === 5);
}

console.log('\n--- pinning ---');
{
  // 01 manual-pinned, 02 control, 03 body-only "pinned", 04 indented `pinned: yes`
  const { dir } = newStore({ count: 8, pinned: ['01'], bodyPin: ['03'], altPin: ['04'] });
  const j = { version: 3, seen: {} };
  for (let i = 1; i <= 8; i++) {
    const id = String(i).padStart(2, '0');
    // the four candidates are the coldest, and none has enough reads to auto-pin
    j.seen[`m-${id}.md`] = {
      count: 1,
      score: 1,
      last: new Date(Date.now() - (i <= 4 ? 500 : 1) * 86400000).toISOString(),
    };
  }
  fs.writeFileSync(path.join(dir, '.access.json'), JSON.stringify(j), 'utf8');
  runHook(dir, 'Write', 'MEMORY.md', CAP5);
  check('manual pin survives being coldest', fs.existsSync(path.join(dir, 'm-01.md')));
  check('unpinned control is evicted', !fs.existsSync(path.join(dir, 'm-02.md')));
  check('"pinned" in the body does NOT pin', !fs.existsSync(path.join(dir, 'm-03.md')));
  check('indented `pinned: yes` pins', fs.existsSync(path.join(dir, 'm-04.md')));
}
{
  const { dir } = newStore({ count: 8 });
  const j = { version: 3, seen: {} };
  for (let i = 1; i <= 8; i++) {
    const id = String(i).padStart(2, '0');
    j.seen[`m-${id}.md`] = {
      count: i === 1 ? 9 : 1, // m-01 auto-pinned, and coldest
      score: 0.0001,
      last: new Date(Date.now() - (9 - i) * 500 * 86400000).toISOString(),
    };
  }
  fs.writeFileSync(path.join(dir, '.access.json'), JSON.stringify(j), 'utf8');
  runHook(dir, 'Write', 'MEMORY.md', CAP5);
  check('auto-pin at 5+ reads survives being coldest', fs.existsSync(path.join(dir, 'm-01.md')));
}
{
  const { dir } = newStore({ count: 8, pinned: ['01', '02', '03', '04', '05', '06', '07', '08'] });
  const out = runHook(dir, 'Write', 'MEMORY.md', CAP5);
  check('all-pinned: nothing deleted', files(dir).length === 8);
  check('  index left over cap', entryCount(dir) === 8);
  check('  warns about the stall', /cannot shrink/i.test(out), out.slice(0, 80));
}

console.log('\n--- index rebuild ---');
{
  const { dir } = newStore({ count: 6, sections: true });
  const j = { version: 3, seen: {} };
  for (let i = 1; i <= 6; i++) {
    const id = String(i).padStart(2, '0');
    j.seen[`m-${id}.md`] = { count: 1, score: i, last: new Date().toISOString() }; // 06 hottest
  }
  fs.writeFileSync(path.join(dir, '.access.json'), JSON.stringify(j), 'utf8');
  runHook(dir, 'Write', 'MEMORY.md');
  const text = idx(dir);
  check('keeps the ## headings', (text.match(/^## /gm) || []).length === 2);
  check('  keeps the # title', /^# Memory/m.test(text));
  const [alpha, beta] = text.split('## Beta');
  const nums = (s) => [...s.matchAll(/\(m-(\d+)\.md\)/g)].map((m) => Number(m[1]));
  const alphaFiles = nums(alpha);
  const betaFiles = nums(beta);
  const desc = (a) => a.every((v, i2) => i2 === 0 || a[i2 - 1] >= v);
  check('  sorts descending within a section', desc(alphaFiles) && desc(betaFiles),
    `alpha=${alphaFiles} beta=${betaFiles}`);
  // the generator puts m-01..02 in Alpha and m-03..06 in Beta
  check('  does not move entries across sections',
    alphaFiles.length === 2 && betaFiles.length === 4 && Math.max(...alphaFiles) < Math.min(...betaFiles),
    `alpha=${alphaFiles} beta=${betaFiles}`);
}
{
  const { dir } = newStore({ count: 3 });
  runHook(dir, 'Write', 'MEMORY.md');
  const mtime1 = fs.statSync(path.join(dir, 'MEMORY.md')).mtimeMs;
  runHook(dir, 'Write', 'MEMORY.md');
  const mtime2 = fs.statSync(path.join(dir, 'MEMORY.md')).mtimeMs;
  check('does not rewrite an unchanged index', mtime1 === mtime2);
}

console.log('\n--- bad input ---');
{
  const { dir } = newStore({ count: 3 });
  fs.writeFileSync(path.join(dir, '.access.json'), '{ not json', 'utf8');
  runHook(dir, 'Read', 'm-01.md');
  check('recovers from a corrupt log', log(dir).version === 3);
}
{
  const out = execFileSync(process.execPath, [HOOK], { input: '', encoding: 'utf8' });
  check('survives empty stdin', out === '');
}
{
  const out = execFileSync(process.execPath, [HOOK], { input: 'not json at all', encoding: 'utf8' });
  check('survives non-JSON stdin', out === '');
}

console.log('\n--- store resolution ---');
{
  // Claude Code's project slug: every non-alphanumeric char becomes '-', no
  // collapsing of runs. These are real slugs observed on disk.
  check(
    'projectSlug matches Windows drive path',
    projectSlug('G:\\Development\\Github\\top-of-mind') === 'G--Development-Github-top-of-mind',
  );
  check(
    'projectSlug matches a spaced, dotted path',
    projectSlug('C:\\Users\\Ethan\\Documents\\.SCRIPTS\\P66 Billable') ===
      'C--Users-Ethan-Documents--SCRIPTS-P66-Billable',
  );
}
{
  // A fake config root, so nothing touches the real ~/.claude.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-cfg-'));
  const cwd = path.join(root, 'work', 'My Project');
  const slug = projectSlug(path.resolve(cwd));
  const projStore = path.join(root, 'projects', slug, 'memory');
  const globalStore = path.join(root, 'memory');
  const opts = { cwd, configDir: root, home: root };
  const seed = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Memory\n', 'utf8');
  };

  // Nothing exists yet: resolve to the project-scoped path a fresh session
  // would create -- not the legacy global guess. This is the reported bug.
  check(
    'first-run resolves to the project store',
    defaultStore(opts) === path.resolve(projStore),
    defaultStore(opts),
  );

  // Only a legacy global store exists: still found (backward compatible).
  seed(globalStore);
  check('an existing global store is found', defaultStore(opts) === path.resolve(globalStore));

  // Both exist: the more specific project store wins.
  seed(projStore);
  check('the project store wins over global', defaultStore(opts) === path.resolve(projStore));

  // An explicit autoMemoryDirectory in user settings.json beats both defaults.
  const configured = path.join(root, 'chosen-memory');
  seed(configured);
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({ autoMemoryDirectory: configured }),
    'utf8',
  );
  check(
    'autoMemoryDirectory overrides the defaults',
    defaultStore(opts) === path.resolve(configured),
    defaultStore(opts),
  );
  check(
    '  and leads the candidate list',
    storeCandidates(opts)[0].dir === path.resolve(configured),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed: ' + failures.join(', '));
  process.exit(1);
}
