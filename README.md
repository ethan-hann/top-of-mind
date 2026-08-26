# top-of-mind

Long-term memory for Claude Code. What you use stays at the front of Claude's
mind. What you never touch fades, and eventually gets dropped.

Claude Code keeps memory as one Markdown file per fact, plus a `MEMORY.md`
index that loads into context every session. That index is a flat list: every
note weighted the same, kept forever, costing tokens on every turn.

`top-of-mind` ranks it:

- Reading a memory raises its score.
- A score halves for every 30 days the memory goes untouched.
- The index is re-sorted so the strongest memory in each section sits at its
  top, where Claude reads it first.
- Past the cap, the weakest memories are deleted.
- Pinned memories are never deleted, however weak they get.

## Install

```
/plugin marketplace add ethan-hann/top-of-mind
/plugin install top-of-mind@top-of-mind
```

Nothing to configure. The hook finds any directory named `memory` that sits
under a `.claude` directory and holds a `MEMORY.md`, which covers both the
global store (`autoMemoryDirectory`) and the per-project default at
`~/.claude/projects/<project>/memory`.

Requires Node, which Claude Code already depends on. Runs on Windows, macOS,
and Linux.

## How recall works

Score combines frequency and recency in one number. Each access adds a point,
and banked points decay on a half-life. This is the shape of the Ebbinghaus
forgetting curve: repetition strengthens a memory, time weakens it.

```
salience   = score * 0.5 ^ (daysSince(last) / halfLifeDays)
on recall:   score = salience + 1;  count += 1;  last = now
```

A memory read 20 times stays near the front for months. A memory read once
slips back within weeks.

When the index outgrows its cap, the lowest-scoring entries are removed: the
`.md` file is deleted and its index line dropped. Deletion is permanent. There
is no archive, so pin anything you cannot afford to lose.

On a write, the index is re-sorted by score, descending, but only within each
contiguous run of entry lines. Headings, blank lines, and prose stay where they
are, so `##` sections survive and each floats its own strongest memory to the
top.

## Pinning

Two independent routes to permanence.

**Manual, and authoritative.** Add `pinned: true` to a memory's frontmatter:

```yaml
---
name: my-memory
pinned: true
---
```

It never expires and never depends on access counting. Claude Code normalizes
frontmatter on save and may move the key under `metadata:`. Both forms work,
because the key is matched at any indentation. The same text in the body is
ignored.

**Automatic.** Any memory accessed 5 or more times. This depends on counts, so
treat it as a bonus rather than a guarantee. See the counting limit below.

If everything over the cap is pinned, nothing is deleted, the index is allowed
to exceed the cap, and the hook reports it. An oversized index is recoverable.
A deleted memory is not.

## /memory-status

| Command | Shows |
| --- | --- |
| `/memory-status` | Full ranking |
| `/memory-status --pinned` | Pinned entries only |
| `/memory-status --json` | Machine-readable output |

Run it directly with `node scripts/memory-status.mjs [--path <dir>] [--pinned]
[--json]`.

```
Memory store: /home/you/.claude/memory
40 entries / cap 50   10 free   pinned: 1 manual, 0 auto (5+ reads)   half-life 30d

 Score Reads Age(d) Pin    Memory                            Section
------ ----- ------ ------ --------------------------------- ---------------
  6.00     6      0 MANUAL memory-prune-hook.md              General
  1.00     1      0        bash-tool-halves-backslashes.md   General
  ...
  0.03     1    151        project_metronome.md              MetronomeApp

Next to be evicted: project_metronome.md, feedback_role_planner.md
```

## Configuration

All optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TOP_OF_MIND_CAP` | `50` | Maximum index entries |
| `TOP_OF_MIND_HALF_LIFE_DAYS` | `30` | Days for a score to halve |
| `TOP_OF_MIND_PIN_READS` | `5` | Accesses that auto-pin a memory |

## What counting misses

Hooks fire only on tool calls, so counting sees explicit Read, Write, and Edit
and nothing else. If Claude Code ever injects a recalled memory into context
through a `<system-reminder>`, no tool runs and that use goes unrecorded.

Measured across 82 transcripts on 2026-08-26, no such injection happens, so
counts currently capture every real access path. That could change, which is
why manual pinning exists and overrides counting.

## Safety

- `MEMORY.md` is never deleted.
- Only files named by an index line can be deleted. Orphaned `.md` files with
  no index line are left alone, because they signal a bug rather than garbage.
- Link targets containing a path separator or a colon are rejected, so a
  malformed index cannot point a delete outside the store.
- Deletion and re-ordering run only on write-shaped tools. A `Read` scores but
  never deletes and never rewrites the index.
- The index is rewritten only when its content actually changes.
- Any failure exits 0 without output, because a broken hook must never block a
  tool call.

## Tests

```
node test/run-tests.mjs
```

31 tests covering path guards, traversal rejection, log migration, scoring,
eviction order, both pin routes, the stall path, index rebuilding, and recovery
from corrupt or absent input. Each builds a throwaway store under the OS temp
directory. None touches a real one.

## License

MIT
