# >>> claude-auto-retry >>>
function claude {
  # Run the real binary inside a monitored session (the launcher sets
  # CLAUDE_AUTO_RETRY_ACTIVE for claude and its children) or once the package is gone.
  if ($env:CLAUDE_AUTO_RETRY_ACTIVE -eq '1' -or -not (Test-Path -LiteralPath '__LAUNCHER_PATH__')) {
    $real = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $real) { Write-Error 'claude: command not found'; return }
    & $real.Source @args
    return
  }
  $env:CLAUDE_AUTO_RETRY_ACTIVE = '1'
  try { node '__LAUNCHER_PATH__' @args }
  finally { Remove-Item Env:\CLAUDE_AUTO_RETRY_ACTIVE -ErrorAction SilentlyContinue }
}
# <<< claude-auto-retry <<<
