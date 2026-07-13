import { isRateLimited, findRateLimitMessage, isLimitMenuPrompt, isWorking, overloadMatch, detectOverload, safeguardMatch, detectSafeguard } from './patterns.ts';
import type { PatternMatch } from './patterns.ts';
import { parseResetTime, calculateWaitMs } from './time-parser.ts';
import { isRetryableError } from './events.ts';
import type { StopFailureEvent } from './events.ts';
import type { Config, OverloadConfig } from './config.ts';
import type { Logger } from './logger.ts';

// Screen capture depth. A live banner can sit ~90 lines above the bottom behind a
// tall task widget. The detectors chrome-strip and tail-window the capture
// themselves, so extra lines are free headroom.
const CAPTURE_LINES = 120;

// Content-tail budget for the rate-limit detectors: a live banner sits within this
// many CONTENT lines of the bottom; the same words further up are quoted scrollback.
const RATE_LIMIT_TAIL_LINES = 12;

// After exhausting retries with the banner still on screen, back off this many
// poll intervals before re-checking, so an exhausted state idles quietly.
const MAX_RETRIES_BACKOFF_INTERVALS = 12;

// Pause after dismissing the interactive limit menu so Claude's TUI can repaint
// the input composer before we type the retry message into it.
const MENU_DISMISS_SETTLE_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface MonitorState {
  status: 'monitoring' | 'waiting' | 'overload' | 'safeguard';
  waitUntil: number;
  attempts: number;
  lastRateLimitMessage: string | null;
  retrySent: boolean;
  // Overload-retry sub-state, kept distinct from the usage-reset fields above.
  overloadAttempts: number;
  overloadTotalWaitMs: number;
  overloadWaitUntil: number;
  // Event-path give-up hold: while set, overloadWaitUntil is the hold's expiry;
  // a marker after expiry is a fresh incident with a fresh budget.
  overloadGaveUp: boolean;
  lastOverloadMatch: PatternMatch | null;
  // viaEvent marks the current backoff window as event-triggered (edge: one send
  // per failure). eventHandledBanner remembers the banner a viaEvent retry just
  // handled so the always-on scraper doesn't re-detect the same uncleared render.
  viaEvent: boolean;
  eventHandledBanner: string | null;
  lastIgnoredEventError: string | null;
  // Safeguard/AUP false-positive retry sub-state (bounded, seconds-scale).
  safeguardAttempts: number;
  safeguardWaitUntil: number;
  safeguardGaveUp: boolean;
  lastSafeguardMatch: PatternMatch | null;
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
  | 'retry-succeeded' | 'user-continued' | 'max-retries' | 'menu-still-up'
  | 'overload-detected' | 'overload-waiting' | 'overload-working' | 'overload-retried'
  | 'overload-retry-failed' | 'overload-cleared' | 'overload-gave-up' | 'event-ignored'
  | 'safeguard-detected' | 'safeguard-waiting' | 'safeguard-working' | 'safeguard-retried'
  | 'safeguard-retry-failed' | 'safeguard-cleared' | 'safeguard-gave-up' | 'safeguard-holding';

export function createMonitorState(): MonitorState {
  return {
    status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null, retrySent: false,
    overloadAttempts: 0, overloadTotalWaitMs: 0, overloadWaitUntil: 0, overloadGaveUp: false, lastOverloadMatch: null,
    viaEvent: false, eventHandledBanner: null, lastIgnoredEventError: null,
    safeguardAttempts: 0, safeguardWaitUntil: 0, safeguardGaveUp: false, lastSafeguardMatch: null,
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

// Identity of an on-screen overload banner, for deduplicating the event path
// against the scraper.
const bannerKey = (m: PatternMatch): string => `${m.pattern} ${m.line}`;

function resetOverload(state: MonitorState): void {
  state.overloadAttempts = 0;
  state.overloadTotalWaitMs = 0;
  state.overloadWaitUntil = 0;
  state.overloadGaveUp = false;
  state.viaEvent = false;
  state.eventHandledBanner = null;
}

function resetSafeguard(state: MonitorState): void {
  state.safeguardAttempts = 0;
  state.safeguardWaitUntil = 0;
  state.safeguardGaveUp = false;
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
  const screenText = await screen.capture(CAPTURE_LINES);

  // Newer Claude Code replaces the plain banner with an interactive
  // `/rate-limit-options` menu; that counts as a rate-limit indicator too.
  const menuUp = isLimitMenuPrompt(screenText);
  // If Claude is mid-flight (streaming, or running its own internal API retry)
  // and the menu isn't up, a rate-limit banner still on screen is stale and an
  // API error is not yet terminal.
  const busy = isWorking(screenText);
  const limited = menuUp || isRateLimited(screenText, config.customPatterns, RATE_LIMIT_TAIL_LINES);

  if (state.status === 'waiting') {
    // Keep counting down UNLESS the session has resumed working (the user manually
    // continued) — otherwise the monitor sits blind on the old timer and a SECOND,
    // genuine limit is masked until it expires (upstream #39). The resume branch
    // below returns us to monitoring.
    if (Date.now() < state.waitUntil && (!busy || menuUp)) return 'waiting';
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
      // send() ends with Enter, which on a still-open menu would confirm the
      // highlighted option. Only proceed once the Escape verifiably worked.
      if (isLimitMenuPrompt(await screen.capture(CAPTURE_LINES))) {
        state.waitUntil = Date.now() + config.retryCooldownSeconds * 1000;
        return 'menu-still-up';
      }
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
      // Remember the banner this retry handles so the always-on scraper doesn't
      // re-detect the same, uncleared render next tick and open a second backoff.
      const handled = overloadMatch(screenText, overload.patterns);
      state.eventHandledBanner = handled ? bannerKey(handled) : null;
      try {
        await screen.send(overload.retryMessage);
      } catch {
        return 'overload-retry-failed';
      }
      return 'overload-retried';
    }

    // Usage-limit takes precedence: hand off to the (hours-scale) reset path.
    // Ungated on busy, like the monitoring path — the waiting branch never
    // injects into a working session anyway.
    if (limited) {
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

  if (state.status === 'safeguard') {
    if (Date.now() < state.safeguardWaitUntil) return 'safeguard-waiting';
    if (!isAlive()) return 'exit';
    const safeguard = config.safeguard;

    // A usage limit appearing takes precedence (ungated on busy, like the
    // monitoring path).
    if (limited) {
      resetSafeguard(state);
      state.status = 'monitoring';
      return enterUsageWait(state, screenText, config);
    }
    // In flight (our retry, or the user typing continued things). Defer WITHOUT
    // consuming or resetting — a tick landing mid-retry must not zero the counter, or
    // a sticky flag re-enters with a fresh budget and the maxRetries bound never trips
    // (upstream verified: it retried indefinitely). Mirrors the overload branch.
    // Recovery is decided at the next idle tick: flag gone -> cleared; flag still
    // there -> the count stands.
    if (busy) {
      state.safeguardWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 2);
      return 'safeguard-working';
    }

    // Flag gone → recovered.
    if (!detectSafeguard(screenText, safeguard.patterns)) {
      resetSafeguard(state);
      state.status = 'monitoring';
      return 'safeguard-cleared';
    }

    // Sticky flag: give up loudly rather than loop. Long cooldown so we don't
    // re-detect the stale error every tick.
    if (state.safeguardAttempts >= safeguard.maxRetries) {
      state.safeguardWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * MAX_RETRIES_BACKOFF_INTERVALS);
      // Give up LOUDLY — once. Subsequent holds are silent for as long as the sticky
      // banner sits at the prompt.
      if (state.safeguardGaveUp) return 'safeguard-holding';
      state.safeguardGaveUp = true;
      return 'safeguard-gave-up';
    }

    // Increment + schedule BEFORE send so a send failure still consumes the slot.
    state.safeguardAttempts++;
    state.safeguardWaitUntil = Date.now() + (safeguard.retryDelaySeconds * 1000);
    try {
      await screen.send(safeguard.retryMessage);
    } catch {
      return 'safeguard-retry-failed';
    }
    return 'safeguard-retried';
  }

  // --- monitoring ---
  // Usage limits (hours-scale reset) take precedence over overload (seconds-scale).
  // No working gate here: WORKING_PATTERNS are not all live-only ("Retrying in …"/
  // "attempt N/M" match transcript text), so gating detection on them could suppress
  // a real limit entirely. The waiting branch's busy gate already stops injection;
  // the only cost is a harmless detect → wait → user-continued cycle.
  if (limited) {
    return enterUsageWait(state, screenText, config);
  }

  // Event-driven overload (authoritative and faster). A
  // StopFailure marker means the turn ended in a retryable API error — no scraping,
  // no ambiguity. It runs first but does NOT replace the scraper below: the event
  // path only covers overloaded/server_error.
  if (config.overload.enabled && screen.readEvent) {
    const ev = await screen.readEvent();
    if (ev) {
      // Consume-side guard: trust no writer. An OLDER installed hook (whose matcher
      // still includes rate_limit) can keep writing markers after an upgrade.
      // Consume-and-ignore anything non-retryable — a misclassified marker must not
      // start a backoff (the scraper still gets its shot on the next tick).
      if (!isRetryableError(ev.error)) {
        await screen.clearEvent?.();               // consume so it can't re-fire
        state.lastIgnoredEventError = ev.error;
        return 'event-ignored';
      }
      await screen.clearEvent?.();                 // consume
      if (busy) { resetOverload(state); return 'overload-cleared'; } // self-recovered
      const capMs = config.overload.maxTotalWaitMinutes * 60_000;
      if (state.overloadTotalWaitMs >= capMs) {
        // Give-up is a bounded hold, not a terminal state (the scraper path
        // self-heals on "text gone"; the event path has no such signal, so the
        // capped budget used to stick forever). A marker while the hold is fresh
        // is the same incident; one after expiry gets a fresh budget.
        if (!state.overloadGaveUp || Date.now() < state.overloadWaitUntil) {
          state.overloadGaveUp = true;
          state.overloadWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * MAX_RETRIES_BACKOFF_INTERVALS);
          return 'overload-gave-up';
        }
        resetOverload(state);
      }
      const w = nextOverloadWaitMs(state.overloadAttempts, config.overload, rand);
      state.overloadTotalWaitMs += w;
      state.overloadWaitUntil = Date.now() + w;
      state.status = 'overload';
      state.viaEvent = true;
      state.lastOverloadMatch = { pattern: 'StopFailure', line: `error=${ev.error}` };
      return 'overload-detected';
    }
  }

  // Sustained-overload scraper safety net: runs on every monitoring tick, even when
  // the hook is live — the event path can't emit some terminal renders (an API 429,
  // "temporarily limiting requests"). Only when Claude is idle (a terminal error is
  // the last thing on screen, never mid-flight).
  if (config.overload.enabled && !busy) {
    const match = overloadMatch(screenText, config.overload.patterns);
    if (match) {
      // The banner a viaEvent retry just handled is owned by the event path until
      // the render changes — re-firing would open a second backoff (extra injection
      // + resetOverload defeats the give-up cap).
      if (state.eventHandledBanner === bannerKey(match)) return 'monitoring';
      state.lastOverloadMatch = match;  // surfaced in the 'overload-detected' log line
      return enterOverload(state, config.overload, rand);
    }
    state.eventHandledBanner = null;  // banner gone → a future match is a fresh incident
  }

  // Safeguard/AUP false-positive: enter a bounded, seconds-scale retry loop.
  // Independent of the overload path (different render, different recovery). Only
  // when Claude is idle.
  if (config.safeguard.enabled && !busy) {
    const match = safeguardMatch(screenText, config.safeguard.patterns);
    if (match) {
      resetSafeguard(state);
      state.status = 'safeguard';
      state.safeguardWaitUntil = Date.now() + (config.safeguard.retryDelaySeconds * 1000);
      state.lastSafeguardMatch = match;
      return 'safeguard-detected';
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
      if (result === 'menu-still-up') log('warn', 'Limit menu still on screen after Escape — holding the retry (Enter could confirm the highlighted option). Will re-check after cooldown.');
      if (result === 'max-retries' && !maxRetriesLogged) {
        maxRetriesLogged = true;
        log('warn', `Max retries (${config.maxRetries}) reached. Monitor still active but will not send further retries until rate limit clears.`);
      }
      if (result === 'overload-detected') {
        overloadGaveUpLogged = false; // fresh episode → a later give-up logs loudly again
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
      if (result === 'safeguard-detected') {
        const m = state.lastSafeguardMatch;
        log('warn', `Safeguard/AUP flag detected${m ? ` [matched /${m.pattern}/ in: "${m.line}"]` : ''} — often a false positive. Will retry up to ${config.safeguard.maxRetries}x every ${config.safeguard.retryDelaySeconds}s.`);
      }
      if (result === 'safeguard-retried') log('info', `Safeguard retry sent (attempt ${state.safeguardAttempts}/${config.safeguard.maxRetries}).`);
      if (result === 'safeguard-retry-failed') log('warn', `Safeguard retry send failed (attempt ${state.safeguardAttempts}/${config.safeguard.maxRetries}); will retry after the delay.`);
      if (result === 'safeguard-cleared') log('info', 'Safeguard flag cleared. Resuming normal monitoring.');
      if (result === 'safeguard-gave-up') log('warn', `Safeguard flag persisted after ${config.safeguard.maxRetries} retries. Giving up — the flag is likely sticky for this content/model; try /model to switch models or rephrase. Will not retry until it clears.`);
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
