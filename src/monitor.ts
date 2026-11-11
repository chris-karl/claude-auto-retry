import { findRateLimit, isLimitMenuPrompt, isNativeContinuing, isWorking, apiErrorMatch } from './patterns.ts';
import type { PatternMatch } from './patterns.ts';
import { parseResetTime, calculateWaitMs } from './time-parser.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';

// Screen capture depth. A live banner can sit ~90 lines above the bottom behind a
// tall task widget. The detectors chrome-strip and tail-window the capture
// themselves, so extra lines are free headroom.
const CAPTURE_LINES = 120;

// Content-tail budget for the rate-limit detectors: a live banner sits within this
// many CONTENT lines of the bottom; the same words further up are quoted scrollback.
const RATE_LIMIT_TAIL_LINES = 12;

// After exhausting retries with the banner or error still on screen, back off this
// many poll intervals before re-checking, so an exhausted state idles quietly.
const MAX_RETRIES_BACKOFF_INTERVALS = 12;

// Pause after dismissing the interactive limit menu so Claude's TUI can repaint
// the input composer before we type the retry message into it.
const MENU_DISMISS_SETTLE_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The two API-error re-send paths share one state machine; config[kind] holds
// their patterns, backoff and retry cap.
type ErrorKind = 'overload' | 'safeguard';

export interface MonitorState {
  status: 'monitoring' | 'waiting' | ErrorKind;
  waitUntil: number;       // next tick that may act, for whichever path is active
  attempts: number;        // sends in the current episode
  retrySent: boolean;      // usage path: tells our retry from a manual continue
  lastRateLimitMessage: string | null;   // set on entering the wait, cleared once logged
  lastError: { kind: ErrorKind; match: PatternMatch } | null;
}

// Adapter over the PTY-hosted terminal the monitor drives.
export interface ScreenAdapter {
  capture: (lines: number) => Promise<string>;   // rendered screen text (last N rows)
  send: (text: string) => Promise<void>;          // type text + Enter into the PTY
  sendEscape: () => Promise<void>;                // press Escape (dismiss the limit menu)
}

export type TickResult =
  | 'exit' | 'monitoring' | 'waiting' | 'native-armed' | 'retried' | 'retry-failed'
  | 'retry-succeeded' | 'user-continued' | 'max-retries' | 'menu-still-up'
  | 'error-detected' | 'error-waiting' | 'error-working' | 'error-retried'
  | 'error-retry-failed' | 'error-cleared' | 'error-gave-up';

export function createMonitorState(): MonitorState {
  return { status: 'monitoring', waitUntil: 0, attempts: 0, retrySent: false, lastRateLimitMessage: null, lastError: null };
}

// Wait before send number `attempt` (0 = the wait right after detection); the last
// entry repeats once the schedule is exhausted.
export function backoffMs(attempt: number, backoffSeconds: number[]): number {
  return backoffSeconds[Math.min(attempt, backoffSeconds.length - 1)] * 1000;
}

function toMonitoring(state: MonitorState): void {
  state.status = 'monitoring'; state.attempts = 0; state.retrySent = false; state.waitUntil = 0;
}

// Entry into the (hours-scale) usage-reset wait, from plain monitoring or as the
// handoff when a usage limit appears mid-error.
function enterUsageWait(state: MonitorState, message: string | null, config: Config): TickResult {
  const parsed = message ? parseResetTime(message) : null;
  state.status = 'waiting';
  state.attempts = 0;
  state.retrySent = false;
  state.lastRateLimitMessage = message ?? 'limit menu without a reset time on screen';
  state.waitUntil = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
  return 'waiting';
}

// One tick of the state machine. Claude runs inside a PTY we own, so screen.send()
// writes straight to it: no foreground-process guessing.
export async function processOneTick(
  state: MonitorState,
  screen: ScreenAdapter,
  config: Config,
  isAlive: () => boolean,
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
  const limit = findRateLimit(screenText, config.customPatterns, RATE_LIMIT_TAIL_LINES);
  const limited = menuUp || limit !== null;

  if (state.status === 'waiting') {
    // Keep counting down UNLESS the session has resumed working (the user manually
    // continued) — otherwise the monitor sits blind on the old timer and a SECOND,
    // genuine limit is masked until it expires (upstream #39).
    if (Date.now() < state.waitUntil && (!busy || menuUp)) return 'waiting';

    // Claude is working again (and not blocked on the menu), or the limit cleared.
    // Checked BEFORE the maxRetries gate: the user (or time) may have resolved it.
    if ((busy && !menuUp) || !limited) {
      const outcome = state.retrySent ? 'retry-succeeded' : 'user-continued';
      toMonitoring(state);
      return outcome;
    }

    // Claude Code's own auto-continue is armed ("Continuing automatically at 3:45pm ·
    // Esc to cancel"): let it fire, it resumes with a better prompt than ours. Re-check
    // after the cooldown; if it is cancelled or gives up, the banner stays and we retry.
    if (isNativeContinuing(screenText)) {
      state.waitUntil = Date.now() + config.retryCooldownSeconds * 1000;
      return 'native-armed';
    }

    if (state.attempts >= config.maxRetries) {
      // Stay in 'waiting' so the stale banner isn't re-detected into an endless loop.
      state.waitUntil = Date.now() + config.pollIntervalSeconds * 1000 * MAX_RETRIES_BACKOFF_INTERVALS;
      return 'max-retries';
    }

    // Consume the attempt and set the cooldown BEFORE acting, so a failed send or a
    // menu that refuses to close still burns a retry instead of looping.
    state.attempts++;
    state.waitUntil = Date.now() + config.retryCooldownSeconds * 1000;

    // The interactive limit menu blocks input: dismiss it with Escape — NOT Enter,
    // whose highlighted option could confirm an upgrade — and type only once it is
    // verifiably gone, because send() ends with Enter.
    if (menuUp) {
      await screen.sendEscape();
      await sleep(MENU_DISMISS_SETTLE_MS);
      if (isLimitMenuPrompt(await screen.capture(CAPTURE_LINES))) return 'menu-still-up';
    }
    try {
      await screen.send(config.retryMessage);
    } catch {
      return 'retry-failed';
    }
    state.retrySent = true;
    return 'retried';
  }

  if (state.status === 'overload' || state.status === 'safeguard') {
    const retry = config[state.status];
    if (Date.now() < state.waitUntil) return 'error-waiting';

    // A usage limit takes precedence: hand off to the hours-scale reset path.
    if (limited) return enterUsageWait(state, limit, config);

    // In flight (our retry, or the user): defer without consuming or resetting, so a
    // sticky error can't re-enter with a fresh budget (upstream #33). The next idle
    // tick decides: error gone -> cleared; still there -> the count stands.
    if (busy) {
      state.waitUntil = Date.now() + config.pollIntervalSeconds * 1000 * 2;
      return 'error-working';
    }

    if (!apiErrorMatch(screenText, retry.patterns)) {
      toMonitoring(state);
      return 'error-cleared';
    }

    // Give up rather than hammer a down endpoint or a sticky flag. Long cooldown so
    // the stale error isn't re-detected every tick.
    if (state.attempts >= retry.maxRetries) {
      state.waitUntil = Date.now() + config.pollIntervalSeconds * 1000 * MAX_RETRIES_BACKOFF_INTERVALS;
      return 'error-gave-up';
    }

    state.attempts++;
    state.waitUntil = Date.now() + backoffMs(state.attempts, retry.backoffSeconds);
    try {
      await screen.send(retry.retryMessage);
    } catch {
      return 'error-retry-failed';
    }
    return 'error-retried';
  }

  // --- monitoring ---
  // Usage limits (hours-scale) take precedence over API errors (seconds-scale). No
  // working gate here: the waiting branch's busy gate already stops injection, and
  // detecting a lingering banner only costs a harmless detect -> resume cycle.
  if (limited) return enterUsageWait(state, limit, config);

  // API errors count only while Claude is idle: a terminal error is the last thing
  // on screen, never mid-flight (Claude Code retries 5xx/529 internally first).
  if (!busy) {
    for (const kind of ['overload', 'safeguard'] as const) {
      const retry = config[kind];
      if (!retry.enabled) continue;
      const match = apiErrorMatch(screenText, retry.patterns);
      if (!match) continue;
      state.status = kind;
      state.attempts = 0;
      state.lastError = { kind, match };
      state.waitUntil = Date.now() + backoffMs(0, retry.backoffSeconds);
      return 'error-detected';
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
  let gaveUpLogged = false;   // one loud give-up per episode; holds stay quiet
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
      const secs = Math.round((state.waitUntil - Date.now()) / 1000);
      const kind = state.lastError?.kind ?? 'overload';
      const label = kind === 'overload' ? 'Overload/transient API error' : 'Safeguard flag';
      const cap = config[kind].maxRetries;

      switch (result) {
        // The launcher's onExit owns the "Claude exited" line; stop quietly so a tick
        // in flight when Claude exits can't double-log.
        case 'exit': stop(); return;
        case 'waiting':
          if (state.lastRateLimitMessage) {
            log('info', `Rate limit detected: "${state.lastRateLimitMessage}". Waiting ${secs}s...`);
            state.lastRateLimitMessage = null;
          }
          break;
        case 'native-armed': log('info', 'Claude Code\'s own auto-continue is armed; holding our retry.'); break;
        case 'retried': log('info', `Sent retry message (attempt ${state.attempts}/${config.maxRetries})`); break;
        case 'retry-failed': log('warn', `Retry send failed (attempt ${state.attempts}); will retry after cooldown.`); break;
        case 'retry-succeeded': gaveUpLogged = false; log('info', 'Auto-retry succeeded. Rate limit cleared.'); break;
        case 'user-continued': gaveUpLogged = false; log('info', 'Session continued on its own (user or Claude Code). Back to monitoring.'); break;
        case 'menu-still-up': log('warn', 'Limit menu still on screen after Escape; holding the retry (Enter could confirm the highlighted option).'); break;
        case 'max-retries':
          if (!gaveUpLogged) { gaveUpLogged = true; log('warn', `Max retries (${config.maxRetries}) reached. Monitor still active but will not send further retries until the rate limit clears.`); }
          break;
        case 'error-detected': {
          gaveUpLogged = false;
          const m = state.lastError?.match;
          log('warn', `${label} detected${m ? ` [matched /${m.pattern}/ in: "${m.line}"]` : ''}. Backing off ${secs}s before retry (up to ${cap}).`);
          break;
        }
        case 'error-retried': log('info', `${label} retry sent (attempt ${state.attempts}/${cap}). Next check in ${secs}s.`); break;
        case 'error-retry-failed': log('warn', `${label} retry send failed (attempt ${state.attempts}/${cap}); will retry after the backoff.`); break;
        case 'error-working': log('info', `${label} text present but Claude is working. Deferring.`); break;
        case 'error-cleared': gaveUpLogged = false; log('info', `${label} cleared. Resuming normal monitoring.`); break;
        case 'error-gave-up':
          if (!gaveUpLogged) { gaveUpLogged = true; log('warn', `${label} persisted after ${cap} retries. Giving up until it clears (overload: check status.claude.com; safeguard: try /model or rephrase).`); }
          break;
      }
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
