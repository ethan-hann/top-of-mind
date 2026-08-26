---
description: Build a throwaway memory store and print the command to try the plugin against it
argument-hint: "memories <n> | cap <n> | path <dir> | (nothing for the default 20)"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/test/sandbox.mjs" $ARGUMENTS`

The command output above is visible only to you, not to the user. Relay it:

- Reproduce the launch command verbatim in a fenced code block - it must be
  exact, so do not retype or reword it. Tell them to run it in a separate
  terminal, not in this session.
- Repeat the isolation check: the sandboxed session will ask them to log in,
  and a session that comes up already logged in is not sandboxed and should be
  closed.
- Mention the sandbox is throwaway and how to delete it, using the cleanup
  command from the output.

If the script reported that it could not rebuild the sandbox because something
is using it, pass that on plainly: they need to close the session or terminal
sitting in the old sandbox, or rerun with `path <dir>` to build elsewhere.

Do not launch the sandboxed session yourself. It is interactive and belongs to
the user.
