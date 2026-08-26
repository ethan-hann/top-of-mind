/**
 * lib.mjs -- shared core for top-of-mind.
 *
 * The prune hook and the status report both need the same constants, the same
 * scoring maths, and the same view of the index and the access log. They live
 * here so the two can never disagree about what is pinned or what ranks where.
 */

import fs from 'node:fs';
import path from 'node:path';

function int(v, d) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** Tunable via env so users need not edit the source. */
export const CONFIG = {
  cap: int(process.env.TOP_OF_MIND_CAP, 50),
  halfLifeDays: int(process.env.TOP_OF_MIND_HALF_LIFE_DAYS, 30),
  pinReads: int(process.env.TOP_OF_MIND_PIN_READS, 5),
};

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const ENTRY_RE = /^\s*-\s*\[([^\]]*)\]\(([^)]+)\)/;
const HEADING_RE = /^#{2,}\s*(.+?)\s*$/;
const PIN_RE = /^\s*pinned\s*:\s*(true|yes|1)\s*$/i;

/**
 * Effective score now: banked points decayed since they were banked.
 * Negative ages (clock skew) are clamped so they cannot inflate a score.
 */
export function effective(st, now, halfLifeDays = CONFIG.halfLifeDays) {
  const days = Math.max(0, (now - st.last) / 86400000);
  return st.score * Math.pow(0.5, days / halfLifeDays);
}

/**
 * True when the file's YAML frontmatter carries `pinned: true` (or yes/1).
 * Matched at any indentation, because Claude Code normalizes frontmatter on
 * save and may relocate the key under `metadata:`. Only the frontmatter block
 * counts -- the same text in the body is ignored.
 */
export function isManuallyPinned(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    if (lines[0]?.trim() !== '---') return false;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') break;
      if (PIN_RE.test(lines[i])) return true;
    }
  } catch {}
  return false;
}

/**
 * Resolve a touched file to the memory store that owns it, or null.
 * A store is a directory named "memory", under a .claude dir, holding a
 * MEMORY.md. That covers the global store (autoMemoryDirectory) and the
 * per-project default alike, with no configuration.
 */
export function resolveStore(filePath) {
  const full = path.resolve(filePath);
  const norm = full.split(path.sep).join('/');
  if (!norm.includes('/.claude/')) return null;
  const dir = path.dirname(full);
  if (path.basename(dir) !== 'memory') return null;
  const indexPath = path.join(dir, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) return null;
  return { dir, indexPath, leaf: path.basename(full), logPath: path.join(dir, '.access.json') };
}

/**
 * Parse MEMORY.md into its entry lines. Returns { lines, entries } where each
 * entry is { line, file, title, section }. Link targets are accepted only as
 * bare .md filenames, so a malformed index can never point an operation
 * outside the store.
 */
export function parseIndex(indexPath) {
  const lines = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/);
  const entries = [];
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING_RE.exec(lines[i]);
    if (h) {
      section = h[1];
      continue;
    }
    const m = ENTRY_RE.exec(lines[i]);
    if (!m) continue;
    const file = m[2].trim();
    if (/[\\/:]/.test(file)) continue;
    if (!file.endsWith('.md')) continue;
    if (file === 'MEMORY.md') continue;
    entries.push({ line: i, file, title: m[1], section });
  }
  return { lines, entries };
}

/**
 * Load the access log and reconcile it against the index: unrecorded entries
 * are seeded from file mtime as a single access (so a newly written memory
 * ranks as recent, not as an eviction candidate), and entries no longer in the
 * index are dropped. Accepts a v2 log ({file: "<ISO>"}) and migrates it.
 */
export function loadState(dir, logPath, indexed) {
  const state = new Map();
  if (fs.existsSync(logPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      for (const [file, v] of Object.entries(j?.seen ?? {})) {
        if (typeof v === 'string') {
          const t = Date.parse(v);
          if (Number.isFinite(t)) state.set(file, { count: 1, score: 1, last: t });
        } else if (v && typeof v === 'object') {
          const t = Date.parse(v.last);
          if (Number.isFinite(t)) {
            state.set(file, { count: Number(v.count) || 1, score: Number(v.score) || 1, last: t });
          }
        }
      }
    } catch {}
  }
  for (const f of indexed) {
    if (state.has(f)) continue;
    let mt = 0;
    try {
      mt = fs.statSync(path.join(dir, f)).mtimeMs;
    } catch {}
    state.set(f, { count: 1, score: 1, last: mt });
  }
  for (const k of [...state.keys()]) if (!indexed.includes(k)) state.delete(k);
  return state;
}

export function saveState(logPath, state) {
  const seen = {};
  for (const [k, v] of state) {
    seen[k] = {
      count: v.count,
      last: new Date(v.last).toISOString(),
      score: Math.round(v.score * 10000) / 10000,
    };
  }
  fs.writeFileSync(logPath, JSON.stringify({ version: 3, seen }), 'utf8');
}

/** Default global store location, matching autoMemoryDirectory's default. */
export function defaultStore() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.claude', 'memory');
}
