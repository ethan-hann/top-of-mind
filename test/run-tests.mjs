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
  check('  warns about the stall', /CANNOT prune/.test(out), out.slice(0, 80));
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed: ' + failures.join(', '));
  process.exit(1);
}
