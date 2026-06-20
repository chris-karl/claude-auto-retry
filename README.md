# claude-auto-retry

> Automatically retry Claude Code sessions when you hit Anthropic subscription rate limits.

When Claude Code shows *"5-hour limit reached - resets 3pm"*, this tool waits for the reset and sends "continue" automatically. You come back to find your work done.

**No workflow change. Just install and forget.**

[![npm version](https://img.shields.io/npm/v/claude-auto-retry.svg)](https://www.npmjs.com/package/claude-auto-retry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

## The Problem

You're in the middle of a complex task with Claude Code. After a while, you see:

```
You've hit your limit · resets 3pm (Europe/Dublin)
```

Claude stops. You have to wait hours, come back, and type "continue". If you're running long tasks overnight or while AFK, this kills your productivity.

## The Solution

```bash
npm i -g claude-auto-retry
claude-auto-retry install
```

That's it. Type `claude` as you always do. When the rate limit hits, the tool:

1. Detects the rate limit message on screen
2. Parses the reset time (timezone-aware)
3. Waits until the limit resets + 60s margin
4. Types "continue" straight into Claude

You come back to find your task completed.

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
  Shell function (injected in .bashrc/.zshrc)
       │
       ▼
  Launcher hosts claude inside a PTY (node-pty)
       │
       ├─ stdin  ──▶ PTY ──▶ claude          (your keystrokes pass through)
       ├─ claude ──▶ PTY ──▶ stdout          (full TUI, mirrored to you)
       └─ claude ──▶ PTY ──▶ headless xterm   (rendered screen, for detection)

  MONITOR (in-process, every 5s):
       │
       ├─ Reads the rendered screen
       ├─ Detects rate limit text
       ├─ Parses reset time from the message
       ├─ Waits until reset + safety margin
       └─ Types "continue" into the PTY
```

### Why a PTY (not tmux)?

Earlier versions drove Claude through **tmux** (`capture-pane` / `send-keys`).
That meant a hard dependency on tmux, transparently spawning tmux sessions, and
brittle heuristics to figure out whether Claude was really the foreground
process before injecting keys.

Hosting Claude in a PTY we own is simpler and portable:

- **No external multiplexer** — works the same whether or not you use tmux/screen.
- **Accurate screen reads** — a real terminal emulator applies cursor moves,
  clears and redraws, so we read the *current* screen instead of guessing from a
  noisy byte stream (the source of past "stale frame" false positives).
- **Direct, unambiguous input** — the retry text is written to the PTY, which
  goes to Claude. No foreground-process guessing.
- **Cross-platform** — [`node-pty`](https://github.com/microsoft/node-pty) is the
  same PTY layer VS Code's terminal uses, with prebuilt binaries for macOS and
  Windows (ConPTY) and source build on Linux.

> **Surviving disconnects:** unlike the old tmux integration, the PTY lives with
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
- **`--print` mode support** — buffers output, retries cleanly for piped/scripted usage
- **Configurable** — retry count, wait margin, custom patterns, retry message
- **Config validation** — bad config values fall back to safe defaults instead of crashing

## Rate Limit Patterns Detected

The tool detects these real-world Claude Code messages:

| Pattern | Example |
|---------|---------|
| N-hour limit reached | `5-hour limit reached - resets 3pm (UTC)` |
| Usage limit | `Claude usage limit reached. Resets at 2pm` |
| Out of extra usage | `You're out of extra usage · resets 3pm` |
| Try again | `Please try again in 5 hours` |
| Hit your limit | `You've hit your limit · resets 3pm (Europe/Dublin)` |
| Rate limit | `Rate limit hit. Resets at 4pm` |

Custom patterns can be added via config for future message format changes.

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

All fields optional. Invalid values fall back to defaults automatically.

## CLI Commands

```bash
claude-auto-retry install     # Install shell wrapper
claude-auto-retry uninstall   # Remove shell wrapper
claude-auto-retry status      # Show monitor activity + last log entries
claude-auto-retry logs        # Tail today's log file in real-time
claude-auto-retry version     # Print version
```

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

- **Node.js** >= 18
- **node-pty** — installed automatically as a dependency. Ships prebuilt binaries
  for macOS and Windows; on Linux it compiles on install, which needs a C/C++
  toolchain and Python (e.g. `apt-get install -y build-essential python3`).

### Shell Support

| Shell | Status |
|-------|--------|
| bash | Full (auto-install to `~/.bashrc`) |
| zsh | Full (auto-install to `~/.zshrc`) |
| fish | Manual setup (instructions printed on `install`) |

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
git clone https://github.com/cheapestinference/claude-auto-retry.git
cd claude-auto-retry
npm install         # builds node-pty (Linux needs build tools)
npm test            # Run all tests
```

Then install the CLI globally from your local checkout, either way:

```bash
npm link            # dev install: symlinks the global bin to this dir,
                    # so source edits take effect with no reinstall

npm install -g .    # production-style install: packs this dir (per the
                    # package.json "files" list) and installs it globally
                    # exactly like `npm i -g claude-auto-retry` would —
                    # a real copy, runs node-pty's build. Re-run after edits.
```

After either, run `claude-auto-retry install` to inject the shell wrapper.

### Project Structure

```
claude-auto-retry/
├── bin/cli.js              # CLI: install/uninstall/status/logs/version
├── src/
│   ├── patterns.js         # Rate limit detection + ANSI stripping
│   ├── time-parser.js      # Reset time parsing with timezone support
│   ├── config.js           # Config loading + validation
│   ├── logger.js           # File-based logging with rotation
│   ├── pty.js              # PTY host + headless terminal emulator (node-pty + @xterm/headless)
│   ├── monitor.js          # Core monitoring loop + retry logic
│   ├── launcher.js         # Process orchestration + I/O mirroring
│   ├── postinstall.js      # Restores node-pty spawn-helper exec bit after npm install
│   └── wrapper.sh          # Shell function template
├── test/                   # Tests
├── package.json
├── LICENSE
└── README.md
```

### Architecture Decisions

- **PTY-hosted Claude** — Claude runs inside a `node-pty` pseudo-terminal so it gets a real TTY (full TUI), while the tool mirrors I/O and can inject the retry directly.
- **Headless terminal emulator** — output is fed to `@xterm/headless`, giving the real rendered screen for detection instead of a noisy raw byte stream. This eliminates the foreground-process guessing and stale-frame false positives the tmux version had to work around.
- **Iterative DST correction** — timezone offset is computed via 3-iteration convergence loop, not a single-shot formula that breaks at DST boundaries.
- **Config validation** — invalid user config values fall back to safe defaults instead of producing NaN/undefined behavior.

### Running Tests

```bash
npm test                              # All tests
node --test test/patterns.test.js     # Single file
node --test --watch test/             # Watch mode
```

### Submitting Changes

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests first (TDD)
4. Make your changes
5. Ensure all tests pass (`npm test`)
6. Submit a Pull Request

### Areas for Contribution

- **New rate limit patterns** — If you see a Claude Code rate limit message that isn't detected, open an issue with the exact text.
- **Fish shell support** — Auto-install for fish shell (currently manual).
- **Notification integration** — Desktop/Slack notification when rate limit detected or when Claude resumes.

## Related Projects

- [claude-code-queue](https://github.com/JCSnap/claude-code-queue) — Queue-based task system for Claude Code with rate limit handling
- [opencode-claude-quota](https://github.com/nguyenngothuong/opencode-claude-quota) — Rate limit quota monitoring (display only)

## FAQ

**Q: Does this work with Claude Max/Pro/Team?**
A: Yes. It works with any Anthropic subscription that has usage-based rate limits.

**Q: Do I need tmux?**
A: No. Claude runs in a PTY the tool owns, so tmux is no longer required or installed. If you *want* the session to survive a disconnect, run `claude` inside your own `tmux`/`screen` — it works transparently.

**Q: What if I continue manually before the retry fires?**
A: The monitor checks if the rate limit is still on screen before sending. If you already continued, it resets and keeps watching.

**Q: What if Claude exits while the monitor is waiting?**
A: When the PTY child exits, the monitor shuts down cleanly and the wrapper returns Claude's exit code.

**Q: Does it work on Windows?**
A: Yes, natively. `node-pty` uses Windows ConPTY and ships a prebuilt binary, so no WSL is required.

**Q: Can it accidentally type into the wrong program?**
A: No. The retry is written into the PTY hosting Claude, and only when a rate-limit message is currently on screen.

## License

MIT — see [LICENSE](LICENSE) for details.

---

Made with care by [CheapestInference](https://github.com/cheapestinference).
