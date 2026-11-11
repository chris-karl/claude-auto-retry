> **Note:** This repository is a fork of
> [cheapestinference/claude-auto-retry](https://github.com/cheapestinference/claude-auto-retry).
> It replaces the tmux dependency with a pseudo-terminal the tool owns (`node-pty`),
> so it works in any terminal without a multiplexer.

# claude-auto-retry

> Continue Claude Code past the usage limits and API errors it won't continue on its own.

Claude Code already waits out the **5-hour session limit** and continues by itself
(`autoContinueAtUsageLimit`, on by default for claude.ai subscriptions). It does not do
that for everything. This tool runs `claude` inside a pseudo-terminal, watches the
rendered screen, and types a continue message when the session is stuck on one of these:

| Situation | Claude Code on its own | This tool |
|---|---|---|
| **Weekly limit** (reset more than 24 hours out) | Opens the `/rate-limit-options` menu and waits for you | Waits until the printed reset time, dismisses the menu, continues |
| Model-family limit (e.g. Opus) while running another model | Same menu | Same |
| **Terminal API overload** (`API Error: 529 …`, 5xx) after its own retries gave up | Stops | Re-sends with an exponential backoff |
| **Safeguard false positive** (`… safeguards flagged this message …`) | Stops | Re-sends a few times |
| 5-hour limit on Claude Code older than 2.1.234 | Stops | Waits and continues |

When Claude Code's own auto-continue is armed (`Continuing automatically at 3:45pm ·
Esc to cancel`), the tool stands back and lets it run.

Same `claude` command, same TUI, nothing to remember.

## Install

```bash
npm i -g --allow-remote=root --allow-scripts=node-pty https://github.com/chris-karl/claude-auto-retry/releases/latest/download/claude-auto-retry.tgz
claude-auto-retry install
```

Open a new terminal and run `claude` as usual. The second command adds a `claude`
shell function to `~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish` and, on
Windows, the PowerShell profile. The function starts the monitored launcher.

Requirements: Node.js 20 or newer on macOS, Linux or Windows. macOS and Windows use
prebuilt `node-pty` binaries; on Linux it compiles during install and needs a C/C++
toolchain and Python (`apt-get install build-essential python3`). `--allow-remote=root` and `--allow-scripts=node-pty` are
needed on current npm versions and ignored by older ones.

To update, run the `npm i -g …` command again. To pin a version, replace
`latest/download` in the URL with `download/<tag>`.

Once a day the launcher asks GitHub for the latest release number. When a newer
version exists, it prints one notice after your `claude` session ends. Nothing is
installed automatically; set `"updateCheck": false` in the configuration to turn
the check off.

## How it works

```
claude  ─▶  shell function  ─▶  launcher hosts claude in a PTY (node-pty)
                                  ├─ your keystrokes ─▶ claude        (pass-through)
                                  ├─ claude's output ─▶ your terminal (mirrored)
                                  └─ claude's output ─▶ headless xterm, read every 5 s
```

Every 5 seconds the monitor reads the rendered screen (the last few content lines,
UI chrome stripped). On a usage limit it parses the reset time, waits until reset
plus a margin, presses Escape if the `/rate-limit-options` menu is open (never
Enter, whose highlighted option may be an upgrade), and types the retry message.
On an API error at an idle prompt it waits out a backoff and re-sends. It never
types while Claude is working, and it stands down as soon as the session resumes
for any other reason.

`claude -p …`, piped input and captured output run `claude` directly, unmonitored.

## What it detects

Usage limits (any of these next to a `resets …` time, or the `/rate-limit-options` menu):

```
Usage limit reached · limit resets 3:45pm
You've hit your weekly limit · resets Oct 9, 10am (Europe/Berlin)
You've hit your session limit · resets 6:50pm (Europe/London)
5-hour limit reached - resets 3pm (UTC)
```

The usage gauge (`You've used 85% of your session limit · resets 3:45pm`, `Over 85%
of …`, `Approaching …`) is recognised and ignored: you can still work.

API errors (only next to an `API Error` line, only at an idle prompt):

```
API Error: 529 Overloaded …                                   overload
API Error: Repeated 529 Overloaded errors …                   overload
API Error: 500 / 502 / 503 / 504 …                            overload
API Error: Server is temporarily limiting requests … · Rate limited   overload
API Error: <model>'s safeguards flagged this message (…/legal/aup) …  safeguard
```

## Configuration

Optional. Create `~/.claude-auto-retry.json`; every key is optional and invalid
values fall back to the defaults shown:

```json
{
  "maxRetries": 5,
  "pollIntervalSeconds": 5,
  "marginSeconds": 60,
  "fallbackWaitHours": 5,
  "retryCooldownSeconds": 30,
  "retryMessage": "Continue where you left off. The previous attempt was rate limited.",
  "customPatterns": [],
  "updateCheck": true,
  "overload": {
    "enabled": true,
    "patterns": ["API Error:.*\\b(429|500|502|503|504|529)\\b", "overloaded_error", "temporarily limiting requests"],
    "backoffSeconds": [30, 60, 120, 240, 300],
    "maxRetries": 20,
    "retryMessage": "Continue where you left off."
  },
  "safeguard": {
    "enabled": true,
    "patterns": ["safeguards flagged this message", "can't respond to this request with", "legal/aup"],
    "backoffSeconds": [8],
    "maxRetries": 3,
    "retryMessage": "continue"
  }
}
```

| Key | Meaning |
|---|---|
| `maxRetries` | Continue attempts per usage-limit episode |
| `pollIntervalSeconds` | How often the screen is read |
| `marginSeconds` | Extra wait after the printed reset time |
| `fallbackWaitHours` | Wait when no reset time can be parsed |
| `retryCooldownSeconds` | Pause after a sent retry before the screen is re-checked |
| `retryMessage` | Text typed into Claude after a usage limit |
| `customPatterns` | Extra case-insensitive regexes that count as a usage limit |
| `updateCheck` | Daily check for a newer release, with a notice after the session |
| `overload`, `safeguard` | One API-error path each: `patterns` (regexes matched near an `API Error` line), `backoffSeconds` (wait before each send, the last entry repeats), `maxRetries`, `retryMessage` |

Set `CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER` to prefix the `claude` process with another
command, for example `export CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER="caffeinate -i"` to keep
a Mac awake during a session.

## Commands

```bash
claude-auto-retry install     # add the claude shell function
claude-auto-retry uninstall   # remove it
claude-auto-retry status      # last log entries
claude-auto-retry logs        # follow today's log
claude-auto-retry version
```

Logs go to `~/.claude-auto-retry/logs/YYYY-MM-DD.log` and are kept for 7 days:

```
[2026-11-09 02:10:05] [INFO] Monitor started (claude PID: 12345)
[2026-11-09 02:31:10] [INFO] Rate limit detected: "You've hit your weekly limit · resets Nov 13, 10am". Waiting 373740s...
[2026-11-13 10:01:12] [INFO] Sent retry message (attempt 1/5)
```

## Uninstall

```bash
claude-auto-retry uninstall
npm uninstall -g claude-auto-retry
```

If you remove the package first, the leftover shell function simply runs `claude`
directly until you remove it.

## Limitations

- **The session lives with your terminal.** If the window closes or an SSH
  connection drops, the wait ends with it. For unattended runs start your terminal
  session inside `tmux` or `screen` yourself; the tool works unchanged inside them.
- **The retry is plain text.** If Claude was waiting for a confirmation or in a
  special input mode, the message may not read as a continuation.
- **Windows needs a console.** Use PowerShell in Windows Terminal or the console
  host. Under mintty (the Git Bash default window) there is no console, so `claude`
  runs unmonitored there.

## Development

```bash
git clone https://github.com/chris-karl/claude-auto-retry.git
cd claude-auto-retry
npm install
npm run check             # typecheck + lint + knip + tests
node bin/cli.ts version   # runs the TypeScript directly (Node 24)
npm run build             # compile to dist/ as a release install ships it
```

```
bin/cli.ts          install / uninstall / status / logs / version
src/launcher.ts     hosts claude in the PTY, mirrors I/O, starts the monitor
src/monitor.ts      the state machine: usage-limit wait, API-error re-send
src/patterns.ts     screen detectors (chrome-aware tail, ANSI stripping)
src/time-parser.ts  reset-time parsing (clock, date, timezone, DST)
src/config.ts       ~/.claude-auto-retry.json loading and validation
src/pty.ts          node-pty + @xterm/headless glue
src/update-check.ts daily check for a newer release
src/wrapper.*       shell function templates
```

Dependabot PRs merge on their own once the checks pass; only a major bump of a
runtime dependency waits for a human. Releases are cut by the Auto-Release
workflow and numbered `YYYY.M.N`, N counting the month's releases from 0: dispatch
it in release mode for your own changes; Dependabot merges that change shipped
content release automatically.

## License

MIT, see [LICENSE](LICENSE).
