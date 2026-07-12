# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

This release ports the applicable upstream work through `v0.6.0` (upstream) onto
the fork's PTY architecture. Upstream's tmux-only features (the `reconcile` /
`install-timer` monitor-coverage machinery, the tmux status-bar indicator, and
their systemd/launchd units) are intentionally not ported: the fork's monitor
lives in the launcher process and dies with it, so there is nothing to re-arm
and no tmux status bar to feed.

### Added
- **Chrome-aware detection** (upstream PR #34/#38): Claude Code renders UI
  chrome (input box, footer, task widget, spinner, hints) below the meaningful
  content, so a live limit banner behind a tall widget could sit outside the
  fixed detection tail and go unretried. Detectors now strip trailing chrome
  first and measure the tail in content lines; the monitor captures 120 lines
  (was 20). A `/usage-credits` companion backstop catches banners behind
  unrecognized chrome, with the same liveness discipline as the main path. The
  overload/safeguard tail is additionally capped at 20 raw lines.
- `CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER` (upstream #47): prefix the interactive
  `claude` launch with a wrapper command, e.g. `caffeinate -i` on macOS.
- "Waiting for N background agents to finish" counts as working, so a stale
  banner above a session blocked on a subagent is never acted on.

### Changed
- The overload scraper stays active alongside the StopFailure event path
  instead of being disabled by the first marker: the hook can't emit some
  terminal renders (an API 429 "temporarily limiting requests"), which were
  never retried once event mode latched. Scraper and event path are
  deduplicated per banner so they never act on the same incident twice.
- Limit detection is no longer gated on the session being idle — the working
  patterns can match transcript text ("Retrying in …", "attempt N/M" in a
  flaky deploy log), which could suppress detection entirely. Injection is
  still gated: nothing is ever sent into a working session.

### Fixed
- A reset time that had just passed (the monitor can settle on a banner minutes
  after the reset) no longer rolls a full day forward and parks the session
  ~24h; within a one-hour grace window the retry is prompt. For an ambiguous
  clock with both readings past, the roll targets the earliest occurrence, not
  the pm one ~12h later.
- Out-of-range reset clocks ("resets 30") are rejected instead of computing a
  nonsense wait, and an ambiguous hour of 12 rolls to midnight instead of
  "hour 24" (the wrong day for date-pinned weekly resets).
- Overload phrase patterns ("temporarily limiting requests",
  "overloaded_error") require an `API Error` line nearby, so quoting or
  discussing them in a session can't trigger a retry.
- The waiting countdown ends as soon as the session resumes working (upstream
  #39), so a manually-continued session isn't parked blind on a stale timer
  that would mask the next genuine limit.

## [0.6.0] - 2026-07-06

This release unifies two lines of development: the upstream (tmux-based) feature
work through `0.5.1` and this fork's node-pty rewrite. The result is a single
codebase with upstream's detection/retry engine on the fork's architecture.

### Changed
- **tmux replaced by a PTY.** Claude now runs inside a `node-pty` pseudo-terminal
  the tool owns, with a headless terminal emulator (`@xterm/headless`) providing
  the real rendered screen for detection. tmux is no longer required or
  installed, foreground-process guessing is gone (a send can never leak into a
  shell), and the tool works transparently inside or outside any multiplexer.
- **TypeScript, no build step.** All modules are TypeScript run directly via
  Node's type stripping (Node >= 23.6), type-checked with `tsc --noEmit` and
  covered by ESLint + knip + CI.
- The `/rate-limit-options` menu is dismissed with **Escape** before submitting
  the retry, instead of navigating it with arrow keys + Enter — the highlighted
  option varies by version, so Escape can never confirm "Upgrade your plan".
- StopFailure event markers are keyed by a launcher-stamped session env
  (`CLAUDE_AUTO_RETRY_SESSION`) instead of a tmux pane id.

### Added
- Safeguard/AUP false-positive auto-retry (upstream #33): when the model's
  safeguards flag a message ("safeguards flagged this message"), re-send a short
  retry up to `safeguard.maxRetries` times, then give up loudly once. Detection
  is anchored to the `API Error` render (mentioning the phrases in conversation
  can't trigger it), and the retry budget is kept across working ticks so a
  sticky flag stays bounded.
- Weekly-limit resets with a calendar date ("resets May 28 at 7pm") are parsed
  fully, with or without an am/pm suffix, and waited out however many days away.
- The passive usage gauge ("You've used 98% of your session limit · resets …")
  is recognized and ignored — it does not mean you are blocked.

### Fixed
- `rate_limit` StopFailure events are no longer routed through the seconds-scale
  overload path (upstream #31) — a session/usage limit is an hours-scale wait
  owned by the usage path, and the misroute made the two fight (futile
  `Continue` retries into a session-limited screen). The marker error type is
  validated at the consumer too, so an outdated installed hook can't
  reintroduce it.

## [0.5.1] - 2026-06-30

**Upgrade if you installed `0.5.0` from npm.** The `0.5.0` npm artifact was built
before #29 was merged and shipped without the usage-retry anti-spam fix. `0.5.1`
includes it. (The git tag `v0.5.0` already contained #29; only the npm tarball was
behind.)

### Fixed
- Stop the usage-retry path from spamming an already-resumed session: a lingering
  limit banner in scrollback no longer re-injects `Continue…` every poll. Detection
  is now anchored to the live tail, and an `isWorking` gate stops the moment Claude
  resumes (#29).

## [0.5.0] - 2026-06-30

This release rolls up everything merged since `0.2.2`, including the API
overload backoff engine and interactive `/rate-limit-options` menu navigation.

### Added
- Detect sustained API overload (`529`/`500`/`503`) and retry with exponential
  backoff, including an event-driven (`StopFailure`) mode (#20, hardened).
- Interactive navigation of the `/rate-limit-options` menu, driving it to
  "Stop and wait" across any menu layout (#19, #26).
- Enable mouse scroll and vi copy-mode in tmux sessions created by the tool (#25).

### Fixed
- Require Claude to be in the foreground before driving the
  `/rate-limit-options` menu, preventing keystrokes from leaking into the wrong
  pane (#28).
- Reliable retry submission plus session/weekly rate-limit detection (#7, #15, #22).
- Correct an off-by-a-day wait when parsing reset times in offset timezones (#6, #23).
- Unalias `claude` before defining the wrapper, fixing a zsh/bash `source` error (#10, #24).
- Skip send-keys correctly when the foreground process is the shell, not Claude (#1).

## [0.2.2] - 2026-03-31

- Last published baseline release.
