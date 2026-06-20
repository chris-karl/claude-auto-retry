# >>> claude-auto-retry >>>
# Claude Code's installer may register `claude` as an alias. Defining a
# same-named shell function then fails to parse (zsh expands the alias at parse
# time -> "syntax error near unexpected token `('"). Drop any existing alias
# first so the function definition below is valid.
unalias claude 2>/dev/null || true
claude() {
  # Recursion guard: if we're already inside a monitored session (the launcher
  # exports CLAUDE_AUTO_RETRY_ACTIVE to claude and its children), run the real
  # binary directly so nested `claude` calls aren't wrapped again.
  if [ "${CLAUDE_AUTO_RETRY_ACTIVE}" = "1" ]; then
    command claude "$@"
    return $?
  fi
  # Set the guard only in the launcher's environment (a prefix assignment), not
  # the interactive shell's. Nothing to clean up afterwards and no trap to
  # save/restore — so the user's own INT/TERM traps and shell state are left
  # untouched, in bash and zsh alike.
  CLAUDE_AUTO_RETRY_ACTIVE=1 node "__LAUNCHER_PATH__" "$@"
}
# <<< claude-auto-retry <<<
