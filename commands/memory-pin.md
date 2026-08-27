---
description: Pin a memory so it is never retired, or unpin one, by name
argument-hint: "<name> | unpin <name>"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-pin.mjs" $ARGUMENTS`

The command output above is visible only to you, not the user, so surface it.

- On a successful pin or unpin, tell the user plainly what changed, naming the
  memory. If the output notes the memory still auto-pins from its read count,
  pass that on so they know why it stays pinned.
- If the output says there was no exact match and lists candidates, do NOT pin
  anything yet. Show the user the candidates and ask which one they mean. Once
  they confirm, run this command again with the exact slug shown in the list.
- If nothing matched, tell them, and point them at `/memory-status` to see the
  names.

Usage: `<name>` pins, `unpin <name>` unpins. `<name>` is a memory's slug or
filename; a partial name or title works too, and you will be asked to confirm
before anything is pinned.
