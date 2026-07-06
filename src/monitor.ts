import { isRateLimited, findRateLimitMessage, isLimitMenuPrompt, isWorking, overloadMatch, detectOverload } from './patterns.ts';
import type { PatternMatch } from './patterns.ts';
import { parseResetTime, calculateWaitMs } from './time-parser.ts';
import { isRetryableError } from './events.ts';
import type { StopFailureEvent } from './events.ts';
import type { Config, OverloadConfig } from './config.ts';
import type { Logger } from './logger.ts';

// How many lines of the rendered screen to scan for the rate-limit banner. Kept
// small on purpose: Claude shows the banner right where it stops (just above the
// input composer), so the recent screen is enough. A small window also reflects
// the *current* screen and avoids re-matching a stale banner left in scrollback
// after the user already continued.
const DETECTION_LINES = 20;

// After exhausting retries with the banner still on screen, back off this many
// poll intervals before re-checking, so an exhausted state idles quietly.
const MAX_RETRIES_BACKOFF_INTERVALS = 12;

// Pause after dismissing the interactive limit menu so Claude's TUI can repaint
// the input composer before we type the retry message into it.
const MENU_DISMISS_SETTLE_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface MonitorState {
  status: 'monitoring' | 'waiting' | 'overload';
  waitUntil: number;
  attempts: number;
  lastRateLimitMessage: string | null;
  retrySent: boolean;
  // Overload-retry sub-state, kept distinct from the usage-reset fields above.
  overloadAttempts: number;
  overloadTotalWaitMs: number;
  overloadWaitUntil: number;
  lastOverloadMatch: PatternMatch | null;
  // Event-driven overload: eventMode latches true once a StopFailure marker is ever
  // seen (proves the hook is live → stop trusting the scraper). viaEvent marks the
  // current backoff window as event-triggered (edge: one send per failure).
  eventMode: boolean;
  viaEvent: boolean;
  lastIgnoredEventError: string | null;
}

// Adapter over the PTY-hosted terminal the monitor drives. readEvent/clearEvent are
// optional plumbing for the StopFailure event channel (absent in --print mode/tests).
export interface ScreenAdapter {
  capture: (lines: number) => Promise<string>;   // rendered screen text (last N rows)
  send: (text: string) => Promise<void>;          // type text + Enter into the PTY
  sendEscape: () => Promise<void>;                // press Escape (dismiss the limit menu)
  readEvent?: () => Promise<StopFailureEvent | null>;  // fresh StopFailure marker, if any
  clearEvent?: () => Promise<void>;                    // consume the marker
}

export type TickResult =
  | 'exit' | 'monitoring' | 'waiting' | 'retried' | 'retry-failed'
  | 'retry-succeeded' | 'user-continued' | 'max-retries'
  | 'overload-detected' | 'overload-waiting' | 'overload-working' | 'overload-retried'
  | 'overload-retry-failed' | 'overload-cleared' | 'overload-gave-up' | 'event-ignored';

export function createMonitorState(): MonitorState {
  return {
    status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null, retrySent: false,
    overloadAttempts: 0, overloadTotalWaitMs: 0, overloadWaitUntil: 0, lastOverloadMatch: null,
    eventMode: false, viaEvent: false, lastIgnoredEventError: null,
  };
}

// --- Overload backoff schedule (pure, testable) ---
// Wait backoffSeconds[i] for attempt i; once the array is exhausted, steadyStateSeconds.
export function overloadBaseWaitMs(attemptIndex: number, overload: OverloadConfig): number {
  const { backoffSeconds, steadyStateSeconds } = overload;
  const secs = attemptIndex < backoffSeconds.length ? backoffSeconds[attemptIndex] : steadyStateSeconds;
  return secs * 1000;
}

export function applyJitter(ms: number, jitterPct: number, rand: () => number = Math.random): number {
  if (!jitterPct) return ms;
  const factor = 1 + (rand() * 2 - 1) * (jitterPct / 100);  // ±jitterPct%
  return Math.max(0, Math.round(ms * factor));
}

export function nextOverloadWaitMs(attemptIndex: number, overload: OverloadConfig, rand: () => number = Math.random): number {
  return applyJitter(overloadBaseWaitMs(attemptIndex, overload), overload.jitterPct, rand);
}

function resetOverload(state: MonitorState): void {
  state.overloadAttempts = 0;
  state.overloadTotalWaitMs = 0;
  state.overloadWaitUntil = 0;
  state.viaEvent = false;
}

// Shared entry into the (hours-scale) usage-reset wait, from plain monitoring or
// as the handoff when a usage limit appears mid-overload.
function enterUsageWait(state: MonitorState, screenText: string, config: Config): TickResult {
  const message = findRateLimitMessage(screenText);
  state.lastRateLimitMessage = message;
  const parsed = message ? parseResetTime(message) : null;
  state.waitUntil = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
  state.status = 'waiting';
  state.retrySent = false; // start of a fresh rate-limit episode
  return 'waiting';
}

function enterOverload(state: MonitorState, overload: OverloadConfig, rand: () => number): TickResult {
  const capMs = overload.maxTotalWaitMinutes * 60_000;
  resetOverload(state);
  state.status = 'overload';
  const w = nextOverloadWaitMs(0, overload, rand);
  if (w > capMs) {
    // Degenerate config (first backoff already exceeds the cap): force the cap to
    // trip on the next tick rather than entering a real retry loop.
    state.overloadTotalWaitMs = capMs;
    state.overloadWaitUntil = 0;
    return 'overload-detected';
  }
  state.overloadTotalWaitMs = w;
  state.overloadWaitUntil = Date.now() + w;
  return 'overload-detected';
}

// One tick of the state machine. Because Claude runs inside a PTY we own, there
// is no foreground-process guessing as in the tmux version: the PTY's child is
// Claude, and screen.send() writes straight to it.
export async function processOneTick(
  state: MonitorState,
  screen: ScreenAdapter,
  config: Config,
  isAlive: () => boolean,
  rand: () => number = Math.random,
): Promise<TickResult> {
  if (!isAlive()) return 'exit';

  // The patterns module strips ANSI internally, so pass the raw rendered screen through.
  const screenText = await screen.capture(DETECTION_LINES);

  // Newer Claude Code replaces the plain banner with an interactive
  // `/rate-limit-options` menu; that counts as a rate-limit indicator too.
  const menuUp = isLimitMenuPrompt(screenText);
  // If Claude is mid-flight (streaming, or running its own internal API retry)
  // and the menu isn't up, a rate-limit banner still on screen is stale and an
  // API error is not yet terminal.
  const busy = isWorking(screenText);
  const limited = menuUp || isRateLimited(screenText, config.customPatterns);

  if (state.status === 'waiting') {
    if (Date.now() < state.waitUntil) return 'waiting';
    if (!isAlive()) return 'exit';

    // Claude is actively working again (and not blocked on the menu) — it
    // resumed on its own. Stop waiting/re-sending against a lingering banner.
    if (busy && !menuUp) {
      const outcome = state.retrySent ? 'retry-succeeded' : 'user-continued';
      state.status = 'monitoring'; state.attempts = 0; state.retrySent = false;
      return outcome;
    }

    // Always check if the rate limit cleared FIRST — even when maxRetries is
    // exhausted, the user (or time passing) may have resolved it.
    if (!limited) {
      const outcome = state.retrySent ? 'retry-succeeded' : 'user-continued';
      state.status = 'monitoring'; state.attempts = 0; state.retrySent = false;
      return outcome;
    }

    if (state.attempts >= config.maxRetries) {
      // Stay in 'waiting' to avoid re-detecting the stale rate limit on the next
      // tick and creating an infinite max-retries loop.
      state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * MAX_RETRIES_BACKOFF_INTERVALS);
      return 'max-retries';
    }

    // If the interactive limit menu is blocking input, dismiss it with Escape
    // first — NOT Enter, whose highlighted option could confirm an upgrade.
    if (menuUp) {
      await screen.sendEscape();
      await sleep(MENU_DISMISS_SETTLE_MS);
    }

    // Increment attempts and set cooldown BEFORE send() so a failure (e.g. PTY
    // destroyed) still consumes a retry and avoids a tight error loop.
    state.attempts++;
    state.waitUntil = Date.now() + config.retryCooldownSeconds * 1000;
    try {
      await screen.send(config.retryMessage);
    } catch {
      return 'retry-failed';
    }
    state.retrySent = true;
    return 'retried';
  }

  if (state.status === 'overload') {
    if (Date.now() < state.overloadWaitUntil) return 'overload-waiting';
    if (!isAlive()) return 'exit';

    const overload = config.overload;
    const capMs = overload.maxTotalWaitMinutes * 60_000;

    // Event-triggered window: a StopFailure marker put us here. Edge-triggered — send
    // exactly once per failure, then return to monitoring to await the next marker. We
    // do NOT re-check the scraper for "still overloaded" (the marker was authoritative).
    if (state.viaEvent) {
      // Self-recovery: Claude resumed during the backoff → don't interrupt it.
      if (busy) { resetOverload(state); state.status = 'monitoring'; return 'overload-cleared'; }
      // A usage limit appearing mid-wait still takes precedence.
      if (limited) { resetOverload(state); return enterUsageWait(state, screenText, config); }

      state.overloadAttempts++;          // next failure backs off further
      state.viaEvent = false;
      state.status = 'monitoring';
      try {
        await screen.send(overload.retryMessage);
      } catch {
        return 'overload-retry-failed';
      }
      return 'overload-retried';
    }

    // Usage-limit takes precedence: hand off to the (hours-scale) reset path.
    if (limited && (menuUp || !busy)) {
      resetOverload(state);
      return enterUsageWait(state, screenText, config);
    }

    // Overload text gone → recovered. Back to plain monitoring.
    if (!detectOverload(screenText, overload.patterns)) {
      resetOverload(state);
      state.status = 'monitoring';
      return 'overload-cleared';
    }

    // Terminal-state gate: if Claude is actively working (its own internal retry
    // or a fresh response is streaming), the error is NOT terminal. Defer without
    // consuming an attempt so we never double-drive a live session.
    if (busy) {
      state.overloadWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 2);
      return 'overload-working';
    }

    // Mandatory cap: give up loudly rather than hammer a genuinely-down endpoint
    // or mask a real outage. Long cooldown to avoid re-detecting the stale error.
    if (state.overloadTotalWaitMs >= capMs) {
      state.overloadWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * MAX_RETRIES_BACKOFF_INTERVALS);
      return 'overload-gave-up';
    }

    // Increment + schedule the next backoff window BEFORE send() so a failure
    // still consumes the slot and avoids a tight error loop.
    state.overloadAttempts++;
    const w = nextOverloadWaitMs(state.overloadAttempts, overload, rand);
    state.overloadTotalWaitMs += w;
    state.overloadWaitUntil = Date.now() + w;
    try {
      await screen.send(overload.retryMessage);
    } catch {
      return 'overload-retry-failed';
    }
    return 'overload-retried';
  }

  // --- monitoring ---
  // Enter waiting on a fresh limit — but ignore a banner merely lingering while
  // Claude is actively working (unless the menu is blocking input). Usage limits
  // (hours-scale reset) take precedence over overload (seconds-scale).
  if (limited && (menuUp || !busy)) {
    return enterUsageWait(state, screenText, config);
  }

  // Event-driven overload (authoritative; see DESIGN-NOTES §1). A StopFailure marker
  // for this session means the turn ended in a retryable API error — no scraping, no
  // ambiguity. Latches eventMode so the scraper path is disabled once we know the
  // hook is live.
  if (config.overload.enabled && screen.readEvent) {
    const ev = await screen.readEvent();
    if (ev) {
      // Consume-side guard: trust no writer. The hook entry in settings.json freezes
      // the cli path + matcher at install time, so an OLDER hook binary (whose matcher
      // and RETRYABLE set still include rate_limit) can keep writing markers after an
      // upgrade. Consume-and-ignore anything non-retryable, and do NOT latch eventMode
      // off it — a misclassified marker must not start a backoff nor disable the
      // scraper path.
      if (!isRetryableError(ev.error)) {
        await screen.clearEvent?.();               // consume so it can't re-fire
        state.lastIgnoredEventError = ev.error;
        return 'event-ignored';
      }
      state.eventMode = true;
      await screen.clearEvent?.();                 // consume
      if (busy) { resetOverload(state); return 'overload-cleared'; } // self-recovered
      const capMs = config.overload.maxTotalWaitMinutes * 60_000;
      if (state.overloadTotalWaitMs >= capMs) return 'overload-gave-up';
      const w = nextOverloadWaitMs(state.overloadAttempts, config.overload, rand);
      state.overloadTotalWaitMs += w;
      state.overloadWaitUntil = Date.now() + w;
      state.status = 'overload';
      state.viaEvent = true;
      state.lastOverloadMatch = { pattern: 'StopFailure', line: `error=${ev.error}` };
      return 'overload-detected';
    }
  }

  // Sustained-overload scraper: only while eventMode hasn't latched (hook absent or
  // not yet fired), and only when Claude is idle (a terminal error is the last thing
  // on screen, never mid-flight).
  if (!state.eventMode && config.overload.enabled && !busy) {
    const match = overloadMatch(screenText, config.overload.patterns);
    if (match) {
      state.lastOverloadMatch = match;  // surfaced in the 'overload-detected' log line
      return enterOverload(state, config.overload, rand);
    }
  }

  return 'monitoring';
}

// Drive processOneTick on a timer against the given screen adapter. Returns a
// stop() function. Logging is delegated to the injected logger so the loop stays
// pure and testable.
export function runMonitor(
  screen: ScreenAdapter,
  config: Config,
  logger: Logger | null | undefined,
  isAlive: () => boolean,
): () => void {
  const state = createMonitorState();
  let consecutiveErrors = 0;
  let maxRetriesLogged = false;
  let overloadGaveUpLogged = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const MAX_CONSECUTIVE_ERRORS = 10;

  const log = (level: keyof Logger, msg: string): void => { logger?.[level]?.(msg).catch(() => {}); };

  function stop(): void {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await processOneTick(state, screen, config, isAlive);
      consecutiveErrors = 0;

      // The launcher's onExit owns the "Claude exited" log line; here we just
      // stop quietly so a tick already in flight when Claude exits can't double-log.
      if (result === 'exit') { stop(); return; }
      if (result === 'waiting' && state.lastRateLimitMessage) {
        const secs = Math.round((state.waitUntil - Date.now()) / 1000);
        log('info', `Rate limit detected: "${state.lastRateLimitMessage}". Waiting ${secs}s...`);
        state.lastRateLimitMessage = null;
      }
      if (result === 'retried') log('info', `Sent retry message (attempt ${state.attempts})`);
      if (result === 'retry-failed') log('warn', `Retry send failed (attempt ${state.attempts}); will retry after cooldown.`);
      if (result === 'retry-succeeded') { maxRetriesLogged = false; log('info', 'Auto-retry succeeded. Rate limit cleared. Attempt counter reset.'); }
      if (result === 'user-continued') { maxRetriesLogged = false; log('info', 'User already continued. Attempt counter reset.'); }
      if (result === 'max-retries' && !maxRetriesLogged) {
        maxRetriesLogged = true;
        log('warn', `Max retries (${config.maxRetries}) reached. Monitor still active but will not send further retries until rate limit clears.`);
      }
      if (result === 'overload-detected') {
        const secs = Math.round((state.overloadWaitUntil - Date.now()) / 1000);
        const m = state.lastOverloadMatch;
        const why = m ? ` [matched /${m.pattern}/ in: "${m.line}"]` : '';
        log('warn', `Overload/transient API error detected (sustained)${why}. Backing off ${secs}s before retry. NOTE: Claude Code retries 5xx/529 internally — this only fires on terminal overload.`);
      }
      if (result === 'overload-retried') {
        const secs = Math.round((state.overloadWaitUntil - Date.now()) / 1000);
        log('info', `Overload retry sent (attempt ${state.overloadAttempts}). Next backoff ${secs}s. Cumulative wait ${Math.round(state.overloadTotalWaitMs / 1000)}s.`);
      }
      if (result === 'overload-retry-failed') log('warn', `Overload retry send failed (attempt ${state.overloadAttempts}); will retry after the backoff window.`);
      if (result === 'overload-working') log('info', 'Overload text present but Claude is working (internal retry/streaming). Deferring — not terminal.');
      if (result === 'overload-cleared') { overloadGaveUpLogged = false; log('info', 'Overload cleared. Resuming normal monitoring.'); }
      if (result === 'overload-gave-up' && !overloadGaveUpLogged) {
        overloadGaveUpLogged = true;
        log('warn', `Overload backoff cap reached (maxTotalWaitMinutes=${config.overload.maxTotalWaitMinutes}). Giving up — endpoint may be genuinely down (check status.claude.com). Will not retry until the error clears.`);
      }
      if (result === 'event-ignored') log('warn', `Ignored StopFailure marker with non-retryable error="${state.lastIgnoredEventError}". If this is "rate_limit", an outdated hook is installed — re-run "claude-auto-retry install-hook".`);
    } catch (err) {
      consecutiveErrors++;
      log('error', `Monitor tick error: ${(err as Error).message}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log('error', `${MAX_CONSECUTIVE_ERRORS} consecutive errors. Stopping monitor.`);
        stop();
      }
    }
  };

  // Recursive setTimeout (not setInterval) so ticks never overlap when one runs
  // longer than the poll interval.
  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await loop();
      scheduleNext();
    }, config.pollIntervalSeconds * 1000);
  };

  loop().then(scheduleNext);
  return stop;
}
