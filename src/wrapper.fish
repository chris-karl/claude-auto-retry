# >>> claude-auto-retry >>>
# In fish an alias is just a function, so this definition also replaces any
# `claude` alias registered earlier (e.g. by Claude Code's installer).
function claude
  # Recursion guard: the launcher exports CLAUDE_AUTO_RETRY_ACTIVE to claude
  # and its children, so nested `claude` calls run the real binary unwrapped.
  if test "$CLAUDE_AUTO_RETRY_ACTIVE" = "1"
    command claude $argv
    return $status
  end
  # `env` scopes the guard to the launcher's environment only (fish gained the
  # VAR=1 cmd prefix form in 3.1; `env` works everywhere).
  env CLAUDE_AUTO_RETRY_ACTIVE=1 node "__LAUNCHER_PATH__" $argv
end
# <<< claude-auto-retry <<<
