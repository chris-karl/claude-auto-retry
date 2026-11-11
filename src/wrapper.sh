# >>> claude-auto-retry >>>
# Claude Code's installer may register `claude` as an alias; a same-named function
# would then fail to parse, so drop the alias first.
unalias claude 2>/dev/null || true
claude() {
  # Run the real binary inside a monitored session (the launcher exports
  # CLAUDE_AUTO_RETRY_ACTIVE to claude and its children) or once the package is gone.
  if [ "${CLAUDE_AUTO_RETRY_ACTIVE}" = "1" ] || [ ! -e "__LAUNCHER_PATH__" ]; then
    command claude "$@"
    return $?
  fi
  # Prefix assignment: the guard reaches the launcher only, not the interactive shell.
  CLAUDE_AUTO_RETRY_ACTIVE=1 node "__LAUNCHER_PATH__" "$@"
}
# <<< claude-auto-retry <<<
