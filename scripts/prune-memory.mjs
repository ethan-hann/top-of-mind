#!/usr/bin/env node
/**
 * prune-memory.mjs -- salience ranking and capping for Claude Code memory.
 *
 * Runs as a PostToolUse hook on Write|Edit|Read. Reads the hook payload from
 * stdin; if the touched file belongs to a memory store, scores that access,
 * re-ranks the index, and retires the weakest entries once the store is over
 * its cap.
 *
 * RANKING combines frequency and recency in one number. Every access adds a
 * point; banked points decay on a half-life.
 *
 *     salience   = score * 0.5 ^ (daysSince(last) / halfLifeDays)
 *     on recall:   score = salience + 1; count += 1; last = now
 *
 * OBSERVE-ONLY UNTIL CONFIGURED. There is no default cap. Until a store has
 * one, this scores and re-ranks but never retires anything, and says so once.
 * Shipping a default cap would silently destroy the memories of anyone whose
 * store is bigger than the number we picked.
 *
 * RETIRING defaults to archiving into .archive/ rather than deleting. The
 * index is what costs context, so dropping the line saves the same tokens
 * either way, and nothing is destroyed. Set mode "delete" to remove outright.
 *
 * PINNING -- two independent routes to permanence:
 *   1. MANUAL (authoritative): `pinned: true` in the file's frontmatter.
 *   2. AUTOMATIC: accessed pinReads or more times. This depends on counts,
 *      which only rise on explicit tool calls, so it is a bonus not a promise.
 *
 * When everything over the cap is pinned, nothing is retired, the index is
 * allowed to exceed the cap, and the hook reports it.
 *
 * Exits 0 on any error: a broken hook must never block a tool call.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  WRITE_TOOLS,
  effective,
  evictFile,
  isManuallyPinned,
  loadConfig,
  loadState,
  parseIndex,
  readLog,
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
  const cfg = loadConfig(dir);
  const now = Date.now();

  const { lines, entries } = parseIndex(indexPath);
  if (entries.length === 0) return;
  const indexed = [...new Set(entries.map((e) => e.file))];

  const meta = readLog(logPath).meta ?? {};
  const state = loadState(dir, logPath, indexed);

  // --- record this access ----------------------------------------------
  if (leaf !== 'MEMORY.md' && !leaf.startsWith('.') && state.has(leaf)) {
    const st = state.get(leaf);
    st.score = effective(st, now, cfg.halfLifeDays) + 1;
    st.count += 1;
    st.last = now;
  }

  const isWrite = WRITE_TOOLS.has(payload.tool_name);

  // --- retire the weakest, but only on a write and only once configured --
  const retired = [];
  let stalled = 0;
  let nManual = 0;
  let nAuto = 0;
  const manualPin = new Map();

  if (isWrite && cfg.configured) {
    // Frontmatter is only worth reading when retirement is actually on the table.
    if (indexed.length > cfg.cap) {
      for (const f of indexed) manualPin.set(f, isManuallyPinned(path.join(dir, f)));
      nManual = indexed.filter((f) => manualPin.get(f)).length;
      nAuto = indexed.filter((f) => !manualPin.get(f) && state.get(f).count >= cfg.pinReads).length;
    }
    for (;;) {
      const live = indexed.filter((f) => !retired.includes(f));
      if (live.length <= cfg.cap) break;
      const cand = live.filter((f) => !manualPin.get(f) && state.get(f).count < cfg.pinReads);
      if (cand.length === 0) {
        stalled = live.length - cfg.cap;
        break;
      }
      cand.sort((a, b) => {
        const d =
          effective(state.get(a), now, cfg.halfLifeDays) -
          effective(state.get(b), now, cfg.halfLifeDays);
        return d !== 0 ? d : state.get(a).last - state.get(b).last;
      });
      const victim = cand[0];
      try {
        evictFile(dir, victim, cfg.mode);
      } catch {}
      state.delete(victim);
      retired.push(victim);
    }
  }

  // --- rebuild the index: drop retired, rank within each run -------------
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
        if (!retired.includes(f)) run.push({ text: lines[i], file: f });
        i++;
      }
      run.sort(
        (a, b) =>
          effective(state.get(b.file), now, cfg.halfLifeDays) -
          effective(state.get(a.file), now, cfg.halfLifeDays)
      );
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

  // --- report -----------------------------------------------------------
  const msgs = [];
  const ctx = [];

  // Say once, per store, that nothing is being capped yet.
  // Only nag when no cap was ever chosen. A store that has one and is paused
  // is a deliberate choice, not something to prompt about.
  let announced = meta.observeAnnounced === true;
  if (!cfg.hasCap && !announced) {
    announced = true;
    msgs.push(
      `top-of-mind is tracking ${indexed.length} memories but no cap is set, so nothing will be retired. Run /memory-setup to choose one.`
    );
    ctx.push(
      `top-of-mind is in observe-only mode on this store: it is ranking ${indexed.length} memories but will never retire any until a cap is set. Tell the user to run /memory-setup to pick a cap, and make clear nothing has been or will be removed until they do.`
    );
  }

  if (retired.length > 0) {
    const list = retired.join(', ');
    const verb = cfg.mode === 'delete' ? 'deleted' : 'archived to .archive/';
    msgs.push(`Memory capped at ${cfg.cap} - ${verb}: ${list}`);
    ctx.push(
      `Memory hit its ${cfg.cap}-entry cap. These lowest-salience memories were ${verb} and removed from MEMORY.md: ${list}. Do not reference them; any [[wikilinks]] pointing at them are now dangling.`
    );
  }

  if (stalled > 0) {
    const why = `${nManual} pinned via frontmatter, ${nAuto} auto-pinned at ${cfg.pinReads}+ accesses`;
    msgs.push(
      `Memory is ${stalled} over the ${cfg.cap} cap and cannot shrink - every remaining entry is pinned (${why}). Nothing was removed. Unpin something or raise the cap with /memory-setup.`
    );
    ctx.push(
      `Memory is ${stalled} entries over the ${cfg.cap} cap and nothing could be retired: every remaining entry is pinned (${why}). The index will keep growing until the user unpins something or raises the cap. Mention this.`
    );
  }

  try {
    saveState(logPath, state, { ...meta, observeAnnounced: announced });
  } catch {}

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
