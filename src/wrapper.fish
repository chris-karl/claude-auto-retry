# >>> claude-auto-retry >>>
# In fish an alias is a function, so this also replaces any `claude` alias.
function claude
  # Run the real binary inside a monitored session (the launcher exports
  # CLAUDE_AUTO_RETRY_ACTIVE to claude and its children) or once the package is gone.
  if test "$CLAUDE_AUTO_RETRY_ACTIVE" = "1"; or not test -e "__LAUNCHER_PATH__"
    command claude $argv
    return $status
  end
  env CLAUDE_AUTO_RETRY_ACTIVE=1 node "__LAUNCHER_PATH__" $argv
end
# <<< claude-auto-retry <<<
