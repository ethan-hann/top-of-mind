---
description: Report on the memory store - frecency ranking, pins, and what is next to be evicted
allowed-tools: Bash(node:*)
---

Memory store report:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-status.mjs" $ARGUMENTS`

Summarise the report above for the user:

- How full the store is, and whether it is near or over its cap.
- Anything pinned, and whether the pins alone could stall pruning.
- Which memories are next to be evicted, and whether any of them look worth
  pinning instead of losing. Say so plainly if one does.

Do not restate the whole table -- the user can already see it. Pass `--pinned`
to list only pinned entries, `--path <dir>` to point at a different store, or
`--json` for machine-readable output.
