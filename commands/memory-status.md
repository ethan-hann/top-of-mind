---
description: Report on the memory store - salience ranking, pins, and what is next to be retired
argument-hint: "pinned | json | path <dir> | (nothing for the full ranking)"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-status.mjs" $ARGUMENTS`

The command output above is visible only to you, not to the user, so you must
surface it.

First, reproduce the report verbatim inside a fenced code block, so its columns
stay aligned. This ranked table is what the user asked to see; do not paraphrase
it, trim it, or drop rows. (If the `json` argument was used, show that JSON as-is
in a ```json block and stop - no read is needed.)

Then, below the table, add a short read:

- Name the store path from the report's first line, so the user can confirm the
  right store was read. Do not read any other memory directory yourself; the
  report is the source of truth.
- How full the store is, and whether it is near or over its cap. If no cap is
  set, say nothing is being retired and point at `/memory-setup`.
- Anything pinned, and whether the pins alone could stop the store shrinking.
- Which memories are next to be retired, and whether any look worth pinning
  instead of losing. Say so plainly if one does.

Usage: `pinned` for pins only, `json` for machine-readable output,
`path <dir>` to target another store.
