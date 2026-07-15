> **Note:** This repository is a fork of
> [cheapestinference/claude-auto-retry](https://github.com/cheapestinference/claude-auto-retry).
> On top of the upstream project, it replaces the tmux dependency with a self-hosted
> pseudo-terminal (`node-pty`), which adds native Windows and prebuilt macOS support.
> It also adds API-overload backoff, event-driven detection, and a safeguard-flag retry path.

# claude-auto-retry

> Automatically retry Claude Code sessions when you hit Anthropic subscription rate limits.

When Claude Code shows *"You've hit your session limit · resets 3pm"* (or the weekly limit, or the interactive `/rate-limit-options` menu), this tool waits for the reset and sends "continue" automatically. Sustained API overload (`API Error: 529 … overloaded_error`, 500/502/503/504) gets an exponential backoff, and safeguard/AUP false positives ("safeguards flagged this message") get a bounded immediate re-send. You come back to find your work done.

**No workflow change. Just install and forget.**

[![Latest release](https://img.shields.io/github/v/release/chris-karl/claude-auto-retry?sort=semver&display_name=tag&label=release)](https://github.com/chris-karl/claude-auto-retry/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

---

## The Problem

You're in the middle of a complex task with Claude Code. After a while, you see:

```
You've hit your limit · resets 3pm (Europe/Dublin)
```

Claude stops. You have to wait hours, come back, and type "continue". If you're running long tasks overnight or while AFK, this kills your productivity.

## The Solution

```bash
npm i -g --allow-remote=root https://github.com/chris-karl/claude-auto-retry/releases/latest/download/claude-auto-retry.tgz
claude-auto-retry install
```

That's it. Type `claude` as you always do. When the rate limit hits, the tool:

1. Detects the rate limit message on screen
2. Parses the reset time (timezone-aware)
3. Waits until the limit resets + 60s margin
4. Types "continue" straight into Claude

You come back to find your task completed.

## Installation

This tool is distributed **straight from GitHub** — there is no npm-registry
package to install. Every release ships a ready-built npm tarball, and one
command works on every supported npm version:

```bash
npm i -g --allow-remote=root https://github.com/chris-karl/claude-auto-retry/releases/latest/download/claude-auto-retry.tgz
```

To pin a version instead of following the latest release, use the versioned
asset on that release's page, e.g.:

```bash
npm i -g --allow-remote=root https://github.com/chris-karl/claude-auto-retry/releases/download/v1.1.3/claude-auto-retry-1.1.3.tgz
```

`--allow-remote=root` opts in to installing the named package from a URL on
npm ≥ 12, which disables all non-registry sources by default; dependencies
still come from the npm registry. npm 11 knows the setting and accepts it,
npm 10 ignores it — the command is the same everywhere.

### Shell integration

Then wire it up once:

```bash
claude-auto-retry install        # inject the `claude` shell wrapper
claude-auto-retry install-hook   # optional: event-driven overload detection
```

The release tarball ships compiled JavaScript — nothing builds at install
time. Recent npm versions print advisory `allow-scripts` warnings naming
`claude-auto-retry` and `node-pty`; install scripts still run, the warning
only notes that no explicit policy covers them yet. Silence it with npm's
suggested `--allow-scripts=...` flag, or ignore it.
**Requirements:** Node.js ≥ 20, plus a C/C++ toolchain on Linux for `node-pty`
(macOS and Windows use prebuilt binaries — see
[Platform Support](#platform-support)).

To **update**, re-run your install command (the `latest` URL always serves
the newest release). To **uninstall**, `npm uninstall -g claude-auto-retry`
(the package is always named `claude-auto-retry`, whichever source you
fetched).

## How it Works

Claude runs inside a **pseudo-terminal (PTY)** that the tool owns. Your keystrokes
pass straight through to Claude and its output is mirrored back to your real
terminal — so it looks and feels exactly like running `claude` normally. In the
background, the same output is rendered into a headless terminal emulator so the
tool can read *what's actually on screen* and inject the retry when needed.

```
You type "claude"
       │
       ▼
  Shell function (injected in .bashrc/.zshrc/config.fish)
       │
       ▼
  Launcher hosts claude inside a PTY (node-pty)
       │
       ├─ stdin  ──▶ PTY ──▶ claude          (your keystrokes pass through)
       ├─ claude ──▶ PTY ──▶ stdout          (full TUI, mirrored to you)
       └─ claude ──▶ PTY ──▶ headless xterm   (rendered screen, for detection)

  MONITOR (in-process, every 5s):
       │
       ├─ Reads the rendered screen (and StopFailure event markers, if hooked)
       ├─ Detects usage limits / overload errors / safeguard flags
       ├─ Waits until reset (usage) or backs off exponentially (overload)
       └─ Types "continue" into the PTY
```

### Why a PTY (not tmux)?

Earlier versions (and the upstream project) drove Claude through **tmux**
(`capture-pane` / `send-keys`). That meant a hard dependency on tmux,
transparently spawning tmux sessions, and brittle heuristics to figure out
whether Claude was really the foreground process before injecting keys.

Hosting Claude in a PTY we own is simpler and portable:

- **No external multiplexer** — works the same whether or not you use tmux/screen.
- **Accurate screen reads** — a real terminal emulator applies cursor moves,
  clears and redraws, so we read the *current* screen instead of guessing from a
  noisy byte stream (the source of past "stale frame" false positives).
- **Direct, unambiguous input** — the retry text is written to the PTY, which
  goes to Claude. No foreground-process guessing, and the retry can never leak
  into a shell or another app.
- **Cross-platform** — [`node-pty`](https://github.com/microsoft/node-pty) is the
  same PTY layer VS Code's terminal uses, with prebuilt binaries for macOS and
  Windows (ConPTY) and source build on Linux.

> **Surviving disconnects:** unlike a tmux integration, the PTY lives with
> your shell — if you close the terminal or your SSH session drops, the session
> ends. For long AFK/overnight runs, start your terminal inside `tmux` or
> `screen` yourself and run `claude` in there. The tool is a transparent wrapper,
> so it works perfectly inside an existing multiplexer.

## Features

- **Zero workflow change** — same `claude` command, same TUI, same everything
- **Cross-platform** — macOS, Linux, and native Windows (no WSL required)
- **Timezone-aware** — parses reset times with full IANA timezone support (including half-hour offsets)
- **DST-safe** — iterative offset correction handles daylight saving transitions
- **Accurate detection** — reads the real rendered screen via a headless terminal emulator
- **Overload backoff** — detects sustained API overload (`429/500/502/503/504/529`) and retries on a configurable exponential backoff with jitter and a cumulative-wait cap, distinct from the usage-reset path ([details](#overload-backoff))
- **Event-driven detection** — optional `StopFailure` hook gives an exact, scrape-free overload trigger ([details](#event-driven-detection-recommended--no-scraping))
- **Safeguard retry** — auto-continues past an AUP-safeguard false-positive (often transient), capped at a few tries so a sticky flag can't loop ([details](#safeguard-retry))
- **`--print` mode support** — buffers output, retries cleanly for piped/scripted usage
- **Configurable** — retry count, wait margin, custom patterns, retry message
- **Config validation** — bad config values fall back to safe defaults instead of crashing

## Messages Detected (verbatim)

The tool acts on these real-world Claude Code renders — if you landed here after
pasting one of these errors into a search engine or an AI assistant: yes, this tool
automates the wait-and-retry for all of them.

### Usage / session limits — waits until the printed reset, then continues

| Render | Example |
|--------|---------|
| N-hour limit | `5-hour limit reached - resets 3pm (UTC)` |
| Session limit | `You've hit your session limit · resets 6:50pm (Europe/London)` |
| Weekly limit | `You've hit your weekly limit · resets May 28 at 7pm (Europe/Madrid)` |
| Usage limit | `Claude usage limit reached. Resets at 2pm` |
| Out of extra usage | `You're out of extra usage · resets 3pm` |
| Try again | `Please try again in 5 hours` |
| Hit your limit | `You've hit your limit · resets 3pm (Europe/Dublin)` |
| Rate limit | `Rate limit hit. Resets at 4pm` |

The passive usage gauge (`You've used 98% of your session limit · resets 8:40pm`)
is recognized and **ignored** — it means you can still work.

Custom patterns can be added via config for future message format changes.

### The interactive `/rate-limit-options` menu

Newer Claude Code versions don't just print a banner — they pop an interactive
menu:

```
What do you want to do?
❯ 1. Stop and wait for limit to reset
  2. Upgrade your plan
  3. Upgrade to Team plan
  Enter to confirm · Esc to cancel
```

The highlighted option **varies** (sometimes "Upgrade your plan" is the default),
so the tool never presses Enter blindly. Instead, once the limit resets it
presses **Escape** to dismiss the menu, then submits the retry message — so it
can never accidentally confirm an upgrade.

### Weekly limits

Weekly (7-day) limits report a calendar date, e.g. `resets May 28 at 7pm
(Europe/Madrid)`. The tool parses the full date and waits until it actually
resets, however many days away that is.

The reset time is parsed whether or not it carries an `am`/`pm` suffix — a
24-hour clock such as `resets May 28 at 19:00 (Europe/Madrid)` is understood
just the same. A bare 1–12 hour with no suffix (e.g. `at 7`) is treated as
ambiguous and resolved to the soonest still-future time.

### API overload / transient errors — exponential backoff with jitter

| Render | Example |
|--------|---------|
| Terminal API error (colon form) | `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}` |
| 5xx family | `API Error: 500 / 502 / 503 / 504 …` (including bodyless renders like `503 no healthy upstream`) |
| API-level 429 | `API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited` |

### Safeguard false positives — bounded immediate re-send

```
API Error: <model>'s safeguards flagged this message (https://www.anthropic.com/legal/aup).
They may flag safe, normal content as well. … Claude Code can't respond to this request with <model>.
```

## Configuration

Optional. Create `~/.claude-auto-retry.json`:

```json
{
  "maxRetries": 5,
  "pollIntervalSeconds": 5,
  "marginSeconds": 60,
  "fallbackWaitHours": 5,
  "retryCooldownSeconds": 30,
  "retryMessage": "Continue where you left off. The previous attempt was rate limited.",
  "customPatterns": ["my custom pattern"]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `maxRetries` | `5` | Max retry attempts per rate-limit event |
| `pollIntervalSeconds` | `5` | How often to check the screen (seconds) |
| `marginSeconds` | `60` | Extra wait after reset time (seconds) |
| `fallbackWaitHours` | `5` | Wait time if reset time can't be parsed |
| `retryCooldownSeconds` | `30` | Pause after sending a retry before re-checking the screen (seconds) |
| `retryMessage` | `"Continue where..."` | Message sent to Claude on retry |
| `customPatterns` | `[]` | Additional regex patterns to detect rate limits |

All fields optional. Invalid values fall back to defaults automatically. The
`overload` and `safeguard` blocks below are configured in the same file.

### Launch wrapper

Set `CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER` to a prefix command and it's prepended to
each interactive session — useful for keeping a machine awake while Claude works,
or any other per-process wrapper:

```sh
# macOS: don't sleep while a session runs
export CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER="caffeinate -i"
```

Generic (not macOS-specific — e.g. `nice` works too). Unset or blank spawns
`claude` directly, unchanged.

## Overload backoff

Separate from subscription rate limits, the tool also detects **sustained API
overload** — Claude Code's own terminal `API Error: <code>` line for the retryable
set (`429 / 500 / 502 / 503 / 504 / 529`, or an `overloaded_error` JSON body) — and
retries on an **exponential backoff** instead of waiting for a usage reset. The two
paths never collide; usage limits always take precedence.

> **Sustained only.** Claude Code already retries transient 5xx/529 internally
> with its own backoff. This feature fires only when those internal retries are
> exhausted and a *terminal* error is left on screen. It should rarely trigger.

> **Terminal vs. transient.** Claude Code renders an in-progress retry as the
> *parens* form `API Error (529 …) · Retrying in 5s · attempt 3/10`, and the final
> exhausted error as the *colon* form `API Error: 529 …`. Detection requires the
> colon form **and** suppresses the `· Retrying…` / `attempt n/m` suffix, so the tool
> never interrupts Claude's own backoff.

> **Anchored, tail-only matching (why it won't fire on your code).** Patterns are
> case-insensitive **regexes** matched against only the **last 12 content lines**
> of the rendered screen (trailing UI chrome like the input box, footer, and task
> widget is stripped first, bounded to 20 raw lines) — never the full scrollback.
> Every match additionally requires an `API Error` line nearby, matching Claude
> Code's actual render, so a bare `503` in code you're editing
> (`res.status(503)`), a port number, a quoted log, a `status.claude.com` link, or
> the phrase "temporarily limiting requests" in conversation will **not** trip
> detection. The one residual: a live screen tail that literally contains
> `API Error: 529` (e.g. editing this tool, or docs about Claude errors) will
> match — set `"enabled": false` while doing that. For a structured,
> ambiguity-free trigger see the event-driven mode below.

Configured under an `overload` block (shown with its defaults):

```json
{
  "overload": {
    "enabled": true,
    "patterns": ["API Error:\\s*(429|500|502|503|504|529)\\b", "overloaded_error", "temporarily limiting requests"],
    "backoffSeconds": [30, 60, 120, 240, 300],
    "steadyStateSeconds": 300,
    "jitterPct": 15,
    "maxTotalWaitMinutes": 120,
    "eventMaxAgeSeconds": 120,
    "retryMessage": "Continue where you left off."
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Turn the overload path on/off |
| `patterns` | (see above) | Case-insensitive **regexes** matching a terminal overload error in the screen tail (last 12 content lines, near an `API Error` line) |
| `backoffSeconds` | `[30,60,120,240,300]` | Wait before each retry; index `i` for attempt `i` |
| `steadyStateSeconds` | `300` | Wait once the `backoffSeconds` array is exhausted |
| `jitterPct` | `15` | ±% jitter applied to every wait (clamped 0–100) |
| `maxTotalWaitMinutes` | `120` | Cumulative-wait cap — give up loudly past this |
| `eventMaxAgeSeconds` | `120` | StopFailure markers older than this are ignored |
| `retryMessage` | `"Continue where you left off."` | Sent to Claude on each retry |

The waits go `30 → 60 → 120 → 240 → 300 → 300 …`, each with ±15% jitter, until the
error clears (success) or the cumulative wait reaches `maxTotalWaitMinutes` (give
up — the cap guards against hammering a genuinely-down endpoint or masking a real
outage; check [status.claude.com](https://status.claude.com)).

### Event-driven detection (recommended — no scraping)

The scraper above is a heuristic over terminal output. For an exact, ambiguity-free
trigger, install the **`StopFailure` hook** — Claude Code fires it precisely when a
turn ends in an API error, with a typed error class:

```sh
claude-auto-retry install-hook                  # into $CLAUDE_CONFIG_DIR or ~/.claude
claude-auto-retry install-hook /path/to/config  # repeat per CLAUDE_CONFIG_DIR you use
```

This adds a `StopFailure` hook (matcher `overloaded|server_error`) that writes a
session-keyed marker the monitor consumes — no screen scraping, so it cannot
false-positive on code or scrollback. Sessions launched via the wrapper **after**
installing the hook use it automatically. The anchored scraper stays active
alongside the event path as a safety net (the hook can't emit some terminal
renders, e.g. an API 429 "temporarily limiting requests"), deduplicated so both
never act on the same incident; sessions without the hook rely on the scraper
alone. Remove with `uninstall-hook`.

> **Why not `rate_limit`?** The event path handles only *transient overloads*
> (seconds-scale backoff). A `rate_limit` is the subscription **session/usage limit** —
> an hours-scale wait until a printed reset time — so it's handled by the usage-wait
> path above, not the overload path. Routing it through the hook would fire premature
> retries against a session that's simply out of quota.

## Safeguard retry

A third failure mode, separate from usage limits and 5xx overloads: the model's
**safeguards flag your message** and Claude Code can't respond. It renders like:

```
● API Error: <model>'s safeguards flagged this message (…/legal/aup). They may flag
  safe, normal content as well. … Claude Code can't respond to this request with <model>.
  Double press esc to edit your last message, or try a different model with /model.
```

These flags are **often false positives** (the message says so) and semi-random, so an
immediate re-send frequently clears them. When the tool sees this render at an idle
prompt, it sends a short retry message (`continue` by default), waits a few seconds, and
repeats — but only up to `maxRetries` times, then **gives up loudly** (logged) rather
than looping. A sticky flag means the content/model combination is genuinely blocked;
switch models with `/model` or rephrase.

Detection is tail-anchored (last 12 content lines) like the overload path, and a match
additionally requires the `API Error` render line nearby — so the phrases appearing in
scrollback or in a conversation *about* safeguards won't trigger it.

Configured under a `safeguard` block (defaults shown):

```json
{
  "safeguard": {
    "enabled": true,
    "patterns": ["safeguards flagged this message", "can't respond to this request with", "legal/aup"],
    "maxRetries": 3,
    "retryDelaySeconds": 8,
    "retryMessage": "continue"
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Turn the safeguard-retry path on/off |
| `patterns` | (see above) | Case-insensitive regexes marking the safeguard render (matched in the screen tail, near an `API Error` line) |
| `maxRetries` | `3` | Re-send attempts before giving up — kept small; retrying a sticky flag won't help |
| `retryDelaySeconds` | `8` | Wait between re-sends |
| `retryMessage` | `"continue"` | Message sent to nudge past the flag |

Usage limits always take precedence; the safeguard path only acts when Claude is
idle (no `esc to interrupt` footer).

## CLI Commands

```bash
claude-auto-retry install            # Install shell wrapper
claude-auto-retry uninstall          # Remove shell wrapper
claude-auto-retry install-hook       # Install the StopFailure hook (event-driven overload detection)
claude-auto-retry uninstall-hook     # Remove the StopFailure hook
claude-auto-retry status             # Show monitor activity + last log entries
claude-auto-retry logs               # Tail today's log file in real-time
claude-auto-retry version            # Print version
```

## For AI Agents

If you are an AI agent (Claude Code, Codex, etc.) installing this for your user, the
full setup is non-interactive:

```bash
npm install -g --allow-remote=root https://github.com/chris-karl/claude-auto-retry/releases/latest/download/claude-auto-retry.tgz
claude-auto-retry install        # shell wrapper
claude-auto-retry install-hook   # recommended: event-driven, scrape-free overload detection
```

The `--allow-remote=root` flag is required on npm ≥ 12 and harmless on older
versions; see [Installation](#installation) for pinned installs.

Notes for agents:

- The wrapper takes effect in **new** shells — have the user `source` their shell rc or
  open a new terminal. No tmux is required: sessions run inside a PTY the tool owns.
- Verify with `claude-auto-retry status` (monitor activity) and `claude-auto-retry logs`.
- Configuration is optional and defaults are safe. To change it, write
  `~/.claude-auto-retry.json` (see [Configuration](#configuration)); invalid values fall
  back to defaults instead of crashing.
- If the user runs multiple `CLAUDE_CONFIG_DIR`s, repeat `claude-auto-retry install-hook <path>` per dir.
- Clean removal: `claude-auto-retry uninstall` and `claude-auto-retry uninstall-hook`.

## Platform Support

### Operating Systems

| OS | PTY backend | Status |
|----|-------------|--------|
| macOS | prebuilt `node-pty` binary | Fully supported |
| Ubuntu / Debian | builds from source (`build-essential`, `python3`) | Fully supported |
| CentOS / RHEL / Fedora / Rocky / Amazon Linux | builds from source | Fully supported |
| Arch Linux | builds from source | Fully supported |
| Alpine | builds from source | Fully supported |
| Windows (native, ConPTY) | prebuilt `node-pty` binary | Supported |

### Requirements

- **Node.js** >= 20.
- **node-pty** — installed automatically. Ships prebuilt binaries for macOS and
  Windows; on Linux it compiles on install, needing a C/C++ toolchain and Python
  (e.g. `apt-get install -y build-essential python3`).

### Shell Support

| Shell | Status |
|-------|--------|
| bash | Full (auto-install to `~/.bashrc`) |
| zsh | Full (auto-install to `~/.zshrc`) |
| fish | Full (auto-install to `~/.config/fish/config.fish`) |

## `--print` Mode

For scripted/piped usage (`claude -p "..." | jq`), the tool:

1. Buffers all output (nothing goes to stdout until done)
2. If rate-limited: discards partial output, waits, re-executes with same args
3. Consumer receives a single clean response

```bash
# This just works — retries transparently if rate-limited
claude -p "Generate a JSON schema" | jq .
```

(Print mode is non-interactive, so it doesn't use a PTY — it just buffers and
re-runs.)

## Logging

Logs are written to `~/.claude-auto-retry/logs/YYYY-MM-DD.log`:

```
[2026-03-18 15:00:05] [INFO] Monitor started (claude PID: 12345)
[2026-03-18 15:32:10] [INFO] Rate limit detected: "5-hour limit reached - resets 3pm". Waiting 3547s...
[2026-03-18 16:01:10] [INFO] Sent retry message (attempt 1)
```

Logs rotate daily. Files older than 7 days are cleaned automatically.

## Uninstall

```bash
claude-auto-retry uninstall
claude-auto-retry uninstall-hook   # if you installed the StopFailure hook
npm uninstall -g claude-auto-retry
```

This removes the shell function from your rc files.

## Known Limitations

1. **Retry message context** — The retry message is sent as plain text. If Claude was mid-confirmation or in a special input state, it may not interpret it as a continuation. You can customize the message via config.

2. **Node version lock** — The launcher path is resolved at install time. If you switch Node versions with nvm, re-run `claude-auto-retry install`.

3. **Session-bound** — The PTY lives with your terminal. If the terminal closes or an SSH session drops, the session ends. For long AFK runs, start `claude` inside `tmux`/`screen` yourself (see [Why a PTY](#why-a-pty-not-tmux)).

## Contributing

Contributions are welcome! Here's how to get started:

### Development Setup

```bash
git clone https://github.com/chris-karl/claude-auto-retry.git
cd claude-auto-retry
npm install         # installs deps (Linux builds node-pty) and runs the
                    # `prepare` build once, compiling src/ + bin/ into dist/
npm run check       # type-check + lint + dead-code scan + tests
```

Day-to-day the TypeScript runs **directly** via Node's type stripping, so no
build is needed to iterate:

```bash
node bin/cli.ts version     # run any CLI command straight from source
npm test                    # tests import the .ts sources as-is
```

`npm run build` transpiles `src/` + `bin/` to `dist/` (emit-only via
`tsconfig.build.json`) and `prepare` runs it automatically — the packaging build
that lets an install ship compiled `.js`. To install the CLI globally from your
checkout:

```bash
npm pack . && npm i -g ./claude-auto-retry-*.tgz
                    # a real copy, like a GitHub install; re-run after edits
npm link            # symlinks the global bin to dist/bin/cli.js — re-run
                    # `npm run build` after edits (or run `node bin/cli.ts`)
```

(`npm install -g .` is no longer an option: modern npm symlinks directory
installs, making it identical to `npm link`.)

After either, run `claude-auto-retry install` to inject the shell wrapper.

### Project Structure

```
claude-auto-retry/
├── bin/cli.ts                # CLI: install/uninstall/hooks/status/logs/version
├── src/
│   ├── patterns.ts           # Usage-limit + overload + safeguard detection + ANSI stripping
│   ├── time-parser.ts        # Reset time parsing with timezone support
│   ├── config.ts             # Config loading + validation
│   ├── logger.ts             # File-based logging with rotation
│   ├── events.ts             # StopFailure event markers (event-driven overload trigger)
│   ├── pty.ts                # PTY host + headless terminal emulator (node-pty + @xterm/headless)
│   ├── monitor.ts            # Core monitoring loop + retry logic (usage/overload/safeguard paths)
│   ├── launcher.ts           # Process orchestration + I/O mirroring
│   ├── wrapper.sh            # Shell function template (bash/zsh)
│   └── wrapper.fish          # Shell function template (fish)
├── scripts/
│   ├── postinstall.mjs       # Restores node-pty spawn-helper exec bit after npm install
│   └── copy-assets.mjs       # Copies wrapper templates + package.json into dist/ during build
├── test/                     # Tests (node:test, *.test.ts)
├── tsconfig.json             # Type-check config (tsc --noEmit)
├── tsconfig.build.json       # Packaging build: emit dist/ with .ts→.js import rewrite
├── dist/                     # Compiled JS shipped on install (git-ignored; built by `prepare`)
├── eslint.config.js          # ESLint flat config (typescript-eslint)
├── knip.json                 # Dead-code / unused-dependency config
├── .github/                  # CI (run-checks.yml: typecheck + lint + knip + tests +
│                             # packaging build) and Dependabot auto-merge/auto-release
├── package.json
├── LICENSE
└── README.md
```

### Architecture Decisions

- **PTY-hosted Claude + headless emulator** — Claude runs in a `node-pty` PTY (real TTY, full TUI) while `@xterm/headless` renders the same output into a screen the tool can read. Rationale: [How it Works](#how-it-works) and [Why a PTY](#why-a-pty-not-tmux).
- **Anchored, tail-only error matching** — overload/safeguard detection matches Claude Code's actual `API Error` render in the screen tail, never bare status numbers in scrollback (the upstream false-positive class).
- **Event-driven when possible** — the `StopFailure` hook is the authoritative overload trigger, with the anchored scraper as a deduplicated safety net.
- **Iterative DST correction** — timezone offset is computed via a convergence loop, not a single-shot formula that breaks at DST boundaries.
- **Config validation** — invalid config values fall back to safe defaults instead of producing NaN/undefined behavior.
- **TypeScript sources, compiled only for packaging** — a checkout runs the `.ts` directly via Node's type stripping (>= 22.18); installs run `dist/` built by the emit-only `prepare` step, since Node won't strip types under `node_modules`.

### Running Tests

```bash
npm test                              # All tests
node --test test/patterns.test.ts     # Single file
node --test --watch test/             # Watch mode

npm run typecheck                     # tsc --noEmit (type errors only)
npm run lint                          # eslint
npm run knip                          # unused files / exports / dependencies
npm run check                         # typecheck + lint + knip + tests
```

### Submitting Changes

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests first (TDD)
4. Make your changes
5. Ensure everything passes (`npm run check` — typecheck, lint, knip, tests)
6. Submit a Pull Request

### Areas for Contribution

- **New rate limit patterns** — If you see a Claude Code rate limit message that isn't detected, open an issue with the exact text.
- **Notification integration** — Desktop/Slack notification when rate limit detected or when Claude resumes.

## Related Projects

- [cheapestinference/claude-auto-retry](https://github.com/cheapestinference/claude-auto-retry) — The upstream project this fork is based on (tmux-based, zero-dependency)
- [claude-code-queue](https://github.com/JCSnap/claude-code-queue) — Queue-based task system for Claude Code with rate limit handling
- [opencode-claude-quota](https://github.com/nguyenngothuong/opencode-claude-quota) — Rate limit quota monitoring (display only)

## FAQ

**Q: Does this work with Claude Max/Pro/Team?**
A: Yes. It works with any Anthropic subscription that has usage-based rate limits.

**Q: Do I need tmux?**
A: No. Claude runs in a PTY the tool owns, so tmux is not required or installed. If you *want* the session to survive a disconnect, run `claude` inside your own `tmux`/`screen` — it works transparently.

**Q: What if I continue manually before the retry fires?**
A: The monitor checks if the rate limit is still on screen before sending. If you already continued, it resets and keeps watching.

**Q: What if Claude exits while the monitor is waiting?**
A: When the PTY child exits, the monitor shuts down cleanly and the wrapper returns Claude's exit code.

**Q: Does it work on Windows?**
A: Yes, natively. `node-pty` uses Windows ConPTY and ships a prebuilt binary, so no WSL is required.

**Q: Can it accidentally type into the wrong program?**
A: No. The retry is written into the PTY hosting Claude, and only when a rate-limit message, terminal API error, or safeguard flag is currently on screen (or a StopFailure event fired).

## License

MIT — see [LICENSE](LICENSE) for details.
