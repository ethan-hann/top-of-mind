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

export const CONFIG_FILE = '.top-of-mind.json';
export const ARCHIVE_DIR = '.archive';

/**
 * Resolve a user-supplied path, expanding a leading ~ to the home directory
 * first. path.resolve alone treats ~ as a literal directory name, so a natural
 * `~/.claude/memory` would land under the current directory instead.
 */
export function resolveUserPath(p) {
  if (typeof p !== 'string') return p;
  let out = p.trim();
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    out = path.join(home, out.slice(1));
  }
  return path.resolve(out);
}

export const DEFAULTS = { halfLifeDays: 30, pinReads: 5, mode: 'archive' };

/**
 * Per-store config, in precedence order: environment, then the store's
 * .top-of-mind.json, then defaults.
 *
 * `cap` deliberately has no default. Until someone sets one, the hook runs in
 * observe-only mode: it scores and re-ranks but never evicts. A default cap
 * would silently destroy the memories of anyone whose store is larger than the
 * number we happened to pick.
 */
export function loadConfig(dir) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8')) ?? {};
  } catch {}

  const envCap = int(process.env.TOP_OF_MIND_CAP, 0);
  const fileCap = int(file.cap, 0);
  const cap = envCap || fileCap || null;

  // Paused, not forgotten. Turning capping off keeps cap and mode on disk, so
  // switching back on restores the settings rather than asking for them again.
  const envActive = process.env.TOP_OF_MIND_ACTIVE;
  const active =
    envActive === '0' || envActive === 'false'
      ? false
      : envActive === '1' || envActive === 'true'
        ? true
        : file.active !== false;

  const mode =
    process.env.TOP_OF_MIND_MODE === 'delete' || process.env.TOP_OF_MIND_MODE === 'archive'
      ? process.env.TOP_OF_MIND_MODE
      : file.mode === 'delete' || file.mode === 'archive'
        ? file.mode
        : DEFAULTS.mode;

  return {
    cap,
    active,
    // hasCap: a cap exists on disk. configured: a cap exists AND capping is on.
    // Only `configured` may retire anything; the split lets callers tell
    // "never set up" apart from "set up but paused".
    hasCap: cap !== null,
    configured: cap !== null && active,
    halfLifeDays: int(process.env.TOP_OF_MIND_HALF_LIFE_DAYS, int(file.halfLifeDays, DEFAULTS.halfLifeDays)),
    pinReads: int(process.env.TOP_OF_MIND_PIN_READS, int(file.pinReads, DEFAULTS.pinReads)),
    mode,
  };
}

export function saveConfig(dir, cfg) {
  const out = {
    version: 1,
    active: cfg.active !== false,
    cap: cfg.cap,
    halfLifeDays: cfg.halfLifeDays,
    pinReads: cfg.pinReads,
    mode: cfg.mode,
  };
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}

/**
 * Retire one memory: move it to .archive/ or delete it outright.
 * Archiving keeps the file but drops it from MEMORY.md, which is what actually
 * costs context, so the token saving is the same and nothing is destroyed.
 */
export function evictFile(dir, file, mode) {
  const src = path.join(dir, file);
  if (mode === 'delete') {
    fs.rmSync(src, { force: true });
    return;
  }
  const archDir = path.join(dir, ARCHIVE_DIR);
  fs.mkdirSync(archDir, { recursive: true });
  let dest = path.join(archDir, file);
  if (fs.existsSync(dest)) {
    const base = file.replace(/\.md$/, '');
    let n = 2;
    while (fs.existsSync(path.join(archDir, `${base}.${n}.md`))) n++;
    dest = path.join(archDir, `${base}.${n}.md`);
  }
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
}

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const ENTRY_RE = /^\s*-\s*\[([^\]]*)\]\(([^)]+)\)/;
const HEADING_RE = /^#{2,}\s*(.+?)\s*$/;
const PIN_RE = /^\s*pinned\s*:\s*(true|yes|1)\s*$/i;

/**
 * Effective score now: banked points decayed since they were banked.
 * Negative ages (clock skew) are clamped so they cannot inflate a score.
 */
export function effective(st, now, halfLifeDays = DEFAULTS.halfLifeDays) {
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

  // Normally the store sits under a .claude directory. When CLAUDE_CONFIG_DIR
  // relocates the config, that directory can be named anything, so accept
  // paths under it as well. Without this the plugin silently ignores the
  // memory of anyone who has moved their config.
  let inConfig = norm.includes('/.claude/');
  if (!inConfig && process.env.CLAUDE_CONFIG_DIR) {
    const cfgRoot = path.resolve(process.env.CLAUDE_CONFIG_DIR).split(path.sep).join('/');
    inConfig = norm === cfgRoot || norm.startsWith(cfgRoot.replace(/\/$/, '') + '/');
  }
  if (!inConfig) return null;

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
export function readLog(logPath) {
  try {
    return JSON.parse(fs.readFileSync(logPath, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

export function loadState(dir, logPath, indexed) {
  const state = new Map();
  if (fs.existsSync(logPath)) {
    try {
      const j = readLog(logPath);
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

export function saveState(logPath, state, meta = {}) {
  const seen = {};
  for (const [k, v] of state) {
    seen[k] = {
      count: v.count,
      last: new Date(v.last).toISOString(),
      score: Math.round(v.score * 10000) / 10000,
    };
  }
  fs.writeFileSync(logPath, JSON.stringify({ version: 3, seen, meta }), 'utf8');
}

/**
 * Translate plain subcommand syntax into the flag form the scripts parse:
 *
 *   memory-setup cap 100 delete   ->  --cap 100 --mode delete
 *   memory-setup off              ->  --off
 *   memory-status pinned          ->  --pinned
 *
 * Slash commands read better as words than as flags, and the words are what
 * people actually type. Explicit flags still pass through untouched, so the
 * scripts stay scriptable.
 *
 * spec.booleans maps a word to a flag. spec.values maps a word to a flag that
 * consumes the next token. spec.bare handles a lone word that implies a flag
 * and its value, such as `delete` meaning `--mode delete`.
 */
export function normalizeArgs(argv, spec = {}) {
  const valueFlags = new Set(Object.values(spec.values ?? {}));
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) {
      out.push(a);
      // A flag that takes a value swallows the next token untouched, so a
      // value that happens to be a keyword (`--mode delete`, or a --path
      // ending in "off") is never re-read as a subcommand.
      if (valueFlags.has(a) && argv[i + 1] !== undefined) out.push(argv[++i]);
      continue;
    }
    const w = a.toLowerCase();
    if (spec.booleans?.[w]) {
      out.push(spec.booleans[w]);
      continue;
    }
    if (spec.values?.[w]) {
      out.push(spec.values[w]);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) out.push(argv[++i]);
      continue;
    }
    const bare = spec.bare?.(w);
    if (bare) {
      out.push(...bare);
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Slugify an absolute path the way Claude Code names its per-project
 * directories under <config>/projects: every character that is not a letter
 * or digit becomes '-', with no collapsing of runs. So `G:\Dev\My App`
 * becomes `G--Dev-My-App`. This is how we find the project-scoped store a
 * default (unconfigured) session writes to.
 */
export function projectSlug(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/** autoMemoryDirectory from a settings.json, resolved, or null if absent. */
function autoMemoryFrom(settingsPath) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (typeof s?.autoMemoryDirectory === 'string' && s.autoMemoryDirectory.trim()) {
      return resolveUserPath(s.autoMemoryDirectory);
    }
  } catch {}
  return null;
}

/**
 * Every directory a running session might keep its auto-memory store in, most
 * specific first, each tagged with a human label for diagnostics. Mirrors how
 * Claude Code resolves the store:
 *
 *   1. an explicit autoMemoryDirectory, checked across the same settings files
 *      the session merges -- project .claude/settings.local.json, then project
 *      .claude/settings.json, then user settings.json (nearest wins);
 *   2. otherwise the project-scoped default, <config>/projects/<slug>/memory,
 *      which is where an unconfigured session actually writes; and
 *   3. the legacy global <config>/memory as the final fallback, so stores
 *      created by older versions still resolve.
 *
 * CLAUDE_CONFIG_DIR relocates the whole config root (a sandboxed session does
 * this); when set we never consult ~/.claude, matching the session itself.
 * Overridable inputs keep this testable without touching env or the real cwd.
 */
export function storeCandidates({
  cwd = process.cwd(),
  configDir = process.env.CLAUDE_CONFIG_DIR,
  home = process.env.HOME || process.env.USERPROFILE || '',
} = {}) {
  const root = configDir ? path.resolve(configDir) : path.join(home, '.claude');
  const absCwd = path.resolve(cwd);

  const out = [];
  const seen = new Set();
  const add = (label, dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push({ label, dir: resolved });
  };

  add(
    'autoMemoryDirectory (.claude/settings.local.json)',
    autoMemoryFrom(path.join(absCwd, '.claude', 'settings.local.json')),
  );
  add(
    'autoMemoryDirectory (.claude/settings.json)',
    autoMemoryFrom(path.join(absCwd, '.claude', 'settings.json')),
  );
  add('autoMemoryDirectory (user settings.json)', autoMemoryFrom(path.join(root, 'settings.json')));
  add('project store', path.join(root, 'projects', projectSlug(absCwd), 'memory'));
  add('global store', path.join(root, 'memory'));

  return out;
}

/**
 * The store a report/setup command should operate on: the first candidate that
 * actually holds a MEMORY.md, so an existing store is found wherever it lives
 * -- project-scoped, a configured directory, or the legacy global path. When
 * none exist yet, fall back to the most specific candidate, the project-scoped
 * path a fresh session would create, rather than the old global guess.
 */
export function defaultStore(opts = {}) {
  const candidates = storeCandidates(opts);
  const found = candidates.find((c) => fs.existsSync(path.join(c.dir, 'MEMORY.md')));
  return (found ?? candidates[0]).dir;
}

/**
 * A multi-line, self-diagnosing message for when no default store was found:
 * every candidate path that was checked, most specific first, each marked
 * found/missing, so the reason is visible without guessing. Used by the
 * report/setup commands when they resolve the store themselves (no --path).
 */
export function missingStoreMessage(opts = {}) {
  const lines = ['No MEMORY.md found. Checked, most specific first:'];
  for (const c of storeCandidates(opts)) {
    const mark = fs.existsSync(path.join(c.dir, 'MEMORY.md')) ? 'found  ' : 'missing';
    lines.push(`  [${mark}] ${c.dir}  (${c.label})`);
  }
  lines.push('');
  lines.push(
    'Save a memory in the project store above to start one, or set autoMemoryDirectory in settings.json to choose the location.',
  );
  return lines.join('\n');
}
