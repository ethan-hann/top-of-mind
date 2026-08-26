#!/usr/bin/env node
/**
 * prune-memory.mjs -- frecency cap on Claude Code's file-based memory.
 *
 * Runs as a PostToolUse hook on Write|Edit|Read. Reads the hook payload from
 * stdin; if the touched file belongs to a memory store, scores that access,
 * caps the index, and re-ranks it.
 *
 * RANKING is frecency -- frequency AND recency in one number, not either
 * alone. Every access adds 1 point; banked points decay on a half-life. A
 * memory read 20 times stays hot for months; one read once cools in weeks.
 *
 *     effective = score * 0.5 ^ (daysSince(last) / halfLifeDays)
 *     on access: score = effective + 1; count += 1; last = now
 *
 * PINNING -- two independent routes to un-evictable:
 *   1. MANUAL (authoritative): `pinned: true` in the file's frontmatter.
 *      Never expires, never depends on counting.
 *   2. AUTOMATIC: accessed pinReads or more times. This leans on counts, and
 *      counts only rise on explicit tool calls -- a bonus, not a promise.
 *
 * When everything over cap is pinned, nothing is deleted, the index is allowed
 * to exceed the cap, and the hook reports it. An oversized index is
 * recoverable; a deleted memory is not.
 *
 * ORDERING: on a write the index is re-sorted by score, descending, but only
 * within each contiguous run of entry lines. Headings, blanks and prose stay
 * exactly where they are, so ## sections survive and each floats its own
 * hottest memory to the top.
 *
 * Exits 0 on any error: a broken hook must never block a tool call.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG,
  WRITE_TOOLS,
  effective,
  isManuallyPinned,
  loadState,
  parseIndex,
  resolveStore,
  saveState,
} from './lib.mjs';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const fp = payload?.tool_input?.file_path || payload?.tool_response?.filePath;
  if (!fp) return;

  const store = resolveStore(fp);
  if (!store) return;

  const { dir, indexPath, leaf, logPath } = store;
  const { cap, pinReads } = CONFIG;
  const now = Date.now();

  const { lines, entries } = parseIndex(indexPath);
  if (entries.length === 0) return;
  const indexed = [...new Set(entries.map((e) => e.file))];

  const state = loadState(dir, logPath, indexed);

  // --- record this access ----------------------------------------------
  if (leaf !== 'MEMORY.md' && !leaf.startsWith('.') && state.has(leaf)) {
    const st = state.get(leaf);
    st.score = effective(st, now) + 1;
    st.count += 1;
    st.last = now;
  }

  const isWrite = WRITE_TOOLS.has(payload.tool_name);

  // --- evict, but only on a write --------------------------------------
  const evicted = [];
  let stalled = 0;
  let nManual = 0;
  let nAuto = 0;
  const manualPin = new Map();

  if (isWrite) {
    // Frontmatter is only worth reading when eviction is actually on the table.
    if (indexed.length > cap) {
      for (const f of indexed) manualPin.set(f, isManuallyPinned(path.join(dir, f)));
      nManual = indexed.filter((f) => manualPin.get(f)).length;
      nAuto = indexed.filter((f) => !manualPin.get(f) && state.get(f).count >= pinReads).length;
    }
    for (;;) {
      const live = indexed.filter((f) => !evicted.includes(f));
      if (live.length <= cap) break;
      const cand = live.filter((f) => !manualPin.get(f) && state.get(f).count < pinReads);
      if (cand.length === 0) {
        stalled = live.length - cap;
        break;
      }
      cand.sort((a, b) => {
        const d = effective(state.get(a), now) - effective(state.get(b), now);
        return d !== 0 ? d : state.get(a).last - state.get(b).last;
      });
      const victim = cand[0];
      try {
        fs.rmSync(path.join(dir, victim), { force: true });
      } catch {}
      state.delete(victim);
      evicted.push(victim);
    }
  }

  // --- rebuild the index: drop evicted, rank within each run ------------
  if (isWrite) {
    const byLine = new Map(entries.map((e) => [e.line, e.file]));
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (!byLine.has(i)) {
        out.push(lines[i]);
        i++;
        continue;
      }
      const run = [];
      while (i < lines.length && byLine.has(i)) {
        const f = byLine.get(i);
        if (!evicted.includes(f)) run.push({ text: lines[i], file: f });
        i++;
      }
      run.sort((a, b) => effective(state.get(b.file), now) - effective(state.get(a.file), now));
      for (const r of run) out.push(r.text);
    }
    const next = out.join('\n').replace(/\s+$/, '') + '\n';
    const prev = lines.join('\n').replace(/\s+$/, '') + '\n';
    if (next !== prev) {
      try {
        fs.writeFileSync(indexPath, next, 'utf8');
      } catch {}
    }
  }

  try {
    saveState(logPath, state);
  } catch {}

  // --- report -----------------------------------------------------------
  const msgs = [];
  const ctx = [];
  if (evicted.length > 0) {
    const list = evicted.join(', ');
    msgs.push(`Memory pruned to ${cap} - deleted: ${list}`);
    ctx.push(
      `Memory hit its ${cap}-entry cap. These lowest-frecency memories were permanently deleted and removed from MEMORY.md: ${list}. Do not reference them; any [[wikilinks]] pointing at them are now dangling.`
    );
  }
  if (stalled > 0) {
    const why = `${nManual} pinned via frontmatter, ${nAuto} auto-pinned at ${pinReads}+ accesses`;
    msgs.push(
      `Memory is ${stalled} over the ${cap} cap and CANNOT prune - every evictable entry is pinned (${why}). Nothing was deleted. Unpin something, prune by hand, or raise TOP_OF_MIND_CAP.`
    );
    ctx.push(
      `Memory is ${stalled} entries over the ${cap} cap and nothing could be evicted: every remaining entry is pinned (${why}). The index will keep growing until the user unpins something, prunes by hand, or raises the cap. Mention this.`
    );
  }
  if (msgs.length > 0) {
    process.stdout.write(
      JSON.stringify({
        systemMessage: msgs.join(' | '),
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: ctx.join(' '),
        },
      })
    );
  }
}

try {
  main();
} catch {
  // deliberately silent -- never block the tool call
}
process.exit(0);
