import { isRateLimited, findRateLimitMessage, isLimitMenuPrompt, isClaudeBusy } from './patterns.ts';
import { parseResetTime, calculateWaitMs } from './time-parser.ts';
import type { Config } from './config.ts';
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
  status: 'monitoring' | 'waiting';
  waitUntil: number;
  attempts: number;
  lastRateLimitMessage: string | null;
  retrySent: boolean;
}

// Adapter over the PTY-hosted terminal the monitor drives.
export interface ScreenAdapter {
  capture: (lines: number) => Promise<string>;   // rendered screen text (last N rows)
  send: (text: string) => Promise<void>;          // type text + Enter into the PTY
  sendEscape: () => Promise<void>;                // press Escape (dismiss the limit menu)
}

export type TickResult =
  | 'exit' | 'monitoring' | 'waiting' | 'retried' | 'retry-failed'
  | 'retry-succeeded' | 'user-continued' | 'max-retries';

export function createMonitorState(): MonitorState {
  return { status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null, retrySent: false };
}

// One tick of the state machine. Because Claude runs inside a PTY we own, there
// is no foreground-process guessing as in the tmux version: the PTY's child is
// Claude, and screen.send() writes straight to it.
export async function processOneTick(
  state: MonitorState,
  screen: ScreenAdapter,
  config: Config,
  isAlive: () => boolean,
): Promise<TickResult> {
  if (!isAlive()) return 'exit';

  // The patterns module strips ANSI internally, so pass the raw rendered screen through.
  const screenText = await screen.capture(DETECTION_LINES);

  // Newer Claude Code replaces the plain banner with an interactive
  // `/rate-limit-options` menu; that counts as a rate-limit indicator too.
  const menuUp = isLimitMenuPrompt(screenText);
  // If the "I'm working" footer is showing (and the menu isn't), a rate-limit
  // banner still on screen is stale and must not be treated as a fresh limit.
  const busy = isClaudeBusy(screenText);
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

  // Enter waiting on a fresh limit — but ignore a banner merely lingering while
  // Claude is actively working (unless the menu is blocking input).
  if (limited && (menuUp || !busy)) {
    const message = findRateLimitMessage(screenText);
    state.lastRateLimitMessage = message;
    const parsed = message ? parseResetTime(message) : null;
    state.waitUntil = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
    state.status = 'waiting';
    state.retrySent = false; // start of a fresh rate-limit episode
    return 'waiting';
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
