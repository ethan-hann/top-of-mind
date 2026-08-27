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
- Past the cap, the weakest memories are retired to `.archive/`.
- Pinned memories are never retired, however weak they get.

## Quick start

From inside a Claude Code session, add the marketplace, then install the
plugin:

```
/plugin marketplace add ethan-hann/top-of-mind
/plugin install top-of-mind@ethan-hann
/memory-setup
```

Or from a local clone of this repo, point the marketplace at the directory:

```
/plugin marketplace add /path/to/top-of-mind
/plugin install top-of-mind@ethan-hann
```

Either way the plugin id is `top-of-mind@ethan-hann` - the identifier is
`<plugin>@<marketplace>`, the plugin's name then the marketplace it came from.

The same two steps run from a shell, outside a session:

```
claude plugin marketplace add ethan-hann/top-of-mind
claude plugin install top-of-mind@ethan-hann
```

`marketplace add` takes the same sources here - a GitHub `owner/repo`, a git
URL, or a local path. Add `--yes` to `install` to skip the confirmation
prompt, and `--scope project` to install into the current project rather than
your user config - handy for scripts and CI.

Installing changes nothing on its own. There is no default cap, so nothing is
retired until you choose one. `/memory-setup` shows what each cap would retire
before you commit; a cap at your current store size retires nothing today and
bounds growth from here.

Two more things worth doing on day one:

- Add `pinned: true` to the frontmatter of any memory you cannot afford to
  lose. Pinned memories are never retired.
- If you would rather watch it work on a fake store first, see
  [Try it in a sandbox](#try-it-in-a-sandbox).

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

When the index outgrows its cap, the lowest-scoring entries are retired: the
file moves to `.archive/` and its index line is dropped. The index is what
costs context, so removing the line saves the same tokens as deleting the file,
and nothing is destroyed. Recover anything by moving it back and re-adding its
line.

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
treat it as a bonus rather than a guarantee. See
[What counting misses](#what-counting-misses).

If everything over the cap is pinned, nothing is retired, the index is allowed
to exceed the cap, and the hook reports it. An oversized index is easy to fix.

## Commands

| Command | Does |
| --- | --- |
| `/memory-setup` | Report what each cap would retire |
| `/memory-setup cap 100` | Apply a cap |
| `/memory-setup cap 100 delete` | Apply a cap, and delete instead of archive |
| `/memory-setup mode archive` | Change what retiring does |
| `/memory-setup off` | Stop retiring, keep your settings |
| `/memory-setup on` | Resume with the settings you had |
| `/memory-setup reset` | Discard settings entirely |
| `/memory-status` | Full ranking |
| `/memory-status pinned` | Pinned entries only |
| `/memory-status json` | Machine-readable output |
| `/memory-sandbox` | Build a throwaway store to try the plugin against |

With no `path`, both detect the store the current session uses, checking the
same places in the same order Claude Code does: an `autoMemoryDirectory` from
settings (project `.claude/settings.local.json`, then project
`.claude/settings.json`, then user `settings.json`), then the per-project
default at `<config>/projects/<project>/memory`, then the legacy global
`<config>/memory` — landing on the first that holds a `MEMORY.md`. When none
exists yet they name every path they checked. Pass `path <dir>` to target a
different store. Flag forms (`--cap`, `--mode`, `--on`, `--off`, `--reset`,
`--path`) work too, for scripting. Run them directly as
`node scripts/memory-status.mjs` or `scripts/memory-setup.mjs`.

```
Memory store: /home/you/.claude/memory
40 entries / cap 50   10 free   pinned: 1 manual, 0 auto (5+ reads)   half-life 30d   mode archive

 Score Reads Age(d) Pin    Memory                            Section
------ ----- ------ ------ --------------------------------- ---------------
  6.00     6      0 MANUAL memory-prune-hook.md              General
  1.00     1      0        bash-tool-halves-backslashes.md   General
  ...
  0.03     1    151        project_metronome.md              MetronomeApp

Next to be archived: project_metronome.md, feedback_role_planner.md
```

## Configuration

`/memory-setup` writes `.top-of-mind.json` into the store:

```json
{
  "version": 1,
  "active": true,
  "cap": 50,
  "halfLifeDays": 30,
  "pinReads": 5,
  "mode": "archive"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `active` | `true` | `false` stops retiring but keeps every other setting |
| `cap` | none | Maximum index entries. Unset means nothing is retired. |
| `halfLifeDays` | `30` | Days for a score to halve |
| `pinReads` | `5` | Accesses that auto-pin a memory |
| `mode` | `archive` | `archive` moves to `.archive/`, `delete` removes permanently |

Environment variables override the file, per store:
`TOP_OF_MIND_CAP`, `TOP_OF_MIND_HALF_LIFE_DAYS`, `TOP_OF_MIND_PIN_READS`,
`TOP_OF_MIND_MODE`, `TOP_OF_MIND_ACTIVE`.

The hook finds any directory named `memory` that sits under a `.claude`
directory and holds a `MEMORY.md`, which covers both the global store
(`autoMemoryDirectory`) and the per-project default at
`~/.claude/projects/<project>/memory`. Each store gets its own config file, so
a global store and a project store can carry different caps.

### Turning it off

`/memory-setup off` sets `active: false`. Retiring stops, ranking continues,
and your cap and mode stay on disk, so `/memory-setup on` picks up exactly
where you left off rather than asking you to choose again.

`/memory-setup reset` is the destructive one: it deletes the config file and
returns the store to observe-only, settings and all.

## Why there is no default cap

A default cap would be wrong for most people. If we shipped 50 and your store
holds 500, the next write would retire 450 memories before you knew the plugin
was running. So until you choose a cap, the plugin observes only: it scores and
re-ranks, but retires nothing, and says so once.

`/memory-setup` shows you what each cap would cost before you pick one:

```
Found 500 memories. No cap set.

  cap     retires now
  ------  -----------
  50      450
  200     300
  500     0            <- cap at current size
  550     0

Recommended: 500 (nothing retired today, bounded from here on).
```

## What counting misses

Hooks fire only on tool calls, so counting sees explicit Read, Write, and Edit
and nothing else. If Claude Code ever injects a recalled memory into context
through a `<system-reminder>`, no tool runs and that use goes unrecorded.

Measured across 82 transcripts on 2026-08-26, no such injection happens, so
counts currently capture every real access path. That could change, which is
why manual pinning exists and overrides counting.

## Safety

- No cap means nothing is retired. There is no default cap.
- `MEMORY.md` is never retired.
- Only files named by an index line can be retired. Orphaned `.md` files with
  no index line are left alone, because they signal a bug rather than garbage.
- Link targets containing a path separator or a colon are rejected, so a
  malformed index cannot point a retire outside the store.
- Retiring and re-ordering run only on write-shaped tools. A `Read` scores but
  never deletes and never rewrites the index.
- The index is rewritten only when its content actually changes.
- Any failure exits 0 without output, because a broken hook must never block a
  tool call.

## Try it in a sandbox

This plugin retires memories, so it is worth watching it work on a store you do
not care about before capping a real one.

Installing first is safe: with no cap set, the plugin observes and retires
nothing. So install it, then build the sandbox from inside any session:

```
/memory-sandbox
```

No repo checkout needed; the command ships with the plugin. It takes the same
plain arguments as the others: `memories 50`, `cap 10`, `path <dir>`. From a
repo checkout, `node test/sandbox.mjs` does the same thing.

Either way it builds a throwaway config directory, a seeded memory store, and a
launcher script, then prints the one command to run:

```
Sandbox:  /tmp/top-of-mind-sandbox
Store:    /tmp/top-of-mind-sandbox/.claude/memory
Seeded:   20 memories across 3 sections, 1 pinned
Cap:      none - starts in observe-only

Launch a sandboxed session (one command, isolation included):

  /tmp/top-of-mind-sandbox/launch.sh
```

Use the launcher rather than setting `CLAUDE_CONFIG_DIR` by hand. It is one
command because the isolation depends on it: a launch that misses the variable
comes up as a normal session against your real config, and its memory commands
then read your real store.

**The session will ask you to log in. That is the isolation working.** A
sandboxed session has its own config and no credentials. If it comes up already
logged in, it is not sandboxed: close it and use the launcher.

The seeded memories are spread from 0 to about 240 days old, so the ranking is
visible immediately rather than every entry scoring the same. One is pinned, to
show that pins survive.

Inside that session:

| Step | What to look for |
| --- | --- |
| `/memory-status` | The seeded store, ranked, oldest at the bottom |
| `/memory-setup` | What each cap would retire, before anything happens |
| `/memory-setup cap 10` | Applies a cap and lists what the next write will take |
| Edit any memory | The hook fires and archives down to the cap |
| `/memory-status` | What moved, and what is next |

From inside the sandbox you can also point the read-only commands at your real
store, to see what you have before enabling the plugin there for real:

```
/memory-status path "~/.claude/memory"    what is pinned, coldest, next out
/memory-setup  path "~/.claude/memory"    what each cap would retire
```

Both are read-only in these forms - `/memory-status` never writes, and
`/memory-setup` only writes when you give it a `cap`, `mode`, `on`, `off`, or
`reset` argument. The bare report changes nothing. A leading `~` expands to
your home directory, or give the full path.

Inspect or clean up from outside at any time:

```
node scripts/memory-status.mjs path /tmp/top-of-mind-sandbox/.claude/memory
ls /tmp/top-of-mind-sandbox/.claude/memory/.archive
rm -rf /tmp/top-of-mind-sandbox
```

| Option | Default | Meaning |
| --- | --- | --- |
| `path <dir>` | OS temp dir | Where to build the sandbox |
| `memories <n>` | `20` | How many memories to seed |
| `cap <n>` | none | Start with a cap already applied |

### Why a separate config directory

Isolation comes from `CLAUDE_CONFIG_DIR`, which gives the session its own
config, plugins, and memory. Nothing in `~/.claude` is read or written.

A separate memory path alone would not be enough. If you already run a memory
hook of your own, it matches on any `memory` directory under a `.claude`
directory, so it would fire on the test store too and fight over the same
state. A separate config directory means only the plugin under test is loaded.

The cost: a fresh config directory is not logged in, so you authenticate once
inside the sandbox. That login stays in the sandbox.

## Tests

```
node test/run-tests.mjs
```

75 tests covering store resolution (`CLAUDE_CONFIG_DIR` isolation, `~` and
absolute paths), observe-only mode, archive and delete modes, pause and resume,
config precedence, plain-word and flag arguments, path guards, traversal
rejection, log migration, scoring, retire order, both pin routes, the stall
path, index rebuilding, and recovery from corrupt or absent input. Each builds
a throwaway store under the OS temp directory. None touches a real one.

## License

MIT
