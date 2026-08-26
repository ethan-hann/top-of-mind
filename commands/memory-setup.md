---
description: Choose a cap for the memory store, after seeing what each choice would retire
argument-hint: "cap <n> | mode archive|delete | on | off | reset | (nothing for a report)"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-setup.mjs" $ARGUMENTS`

Using the output above, help the user pick a cap. Start by naming the store
path from the report, so the user can see the right store was read; do not
read any other memory directory yourself.

If they ran it with no arguments, nothing has been changed yet. Tell them:

- How many memories they have, and whether a cap is already set.
- What each candidate cap would retire right now. Be concrete about the count.
- That a cap at or above the current size is the safe choice, because it
  retires nothing today and still bounds growth from here.

Warn plainly if a cap they are considering would retire a large share of the
store, and say the number out loud. Suggest pinning anything they cannot lose
first, with `pinned: true` in its frontmatter.

Apply only once they have chosen, with `memory-setup cap <n>`. Do not pick for
them.

Usage: `cap <n>`, `cap <n> delete`, `mode archive|delete`, `on`, `off`, `reset`,
`path <dir>` to target another store.
