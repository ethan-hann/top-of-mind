---
description: Report on the memory store - salience ranking, pins, and what is next to be retired
argument-hint: "pinned | json | path <dir> | (nothing for the full ranking)"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-status.mjs" $ARGUMENTS`

Summarize the report above for the user:

- Start with the store path from the report's first line, so the user can see
  at a glance whether the right store was read. Do not read any other memory
  directory yourself; the report is the source of truth.
- How full the store is, and whether it is near or over its cap. If no cap is
  set, say that nothing is being retired and point at `/memory-setup`.
- Anything pinned, and whether the pins alone could stop the store shrinking.
- Which memories are next to be retired, and whether any look worth pinning
  instead of losing. Say so plainly if one does.

Do not restate the whole table. The user can already see it.

Usage: `pinned` for pins only, `json` for machine-readable output,
`path <dir>` to target another store.
