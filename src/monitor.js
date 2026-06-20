import { isRateLimited, findRateLimitMessage } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';

// How many lines of the rendered screen to scan for the rate-limit banner.
// Kept small on purpose: Claude shows the banner right where it stops (just
// above the input composer), so the recent screen is enough. A small window
// also reflects the *current* screen and avoids re-matching a stale banner left
// behind in scrollback after the user already continued.
const DETECTION_LINES = 20;

// After exhausting retries with the banner still on screen, back off this many
// poll intervals before re-checking. Long enough that an exhausted state idles
// quietly instead of re-detecting the same banner on every tick.
const MAX_RETRIES_BACKOFF_INTERVALS = 12;

export function createMonitorState() {
  return { status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null, retrySent: false };
}

// One tick of the state machine.
//
// `screen` is an adapter over the PTY-hosted terminal:
//   - capture(lines): Promise<string>  -> rendered screen text (last N rows)
//   - send(text):     Promise<void>    -> type text + Enter into the PTY
//
// Because Claude now runs inside a PTY we own, there is no longer any need to
// guess whether Claude is the "foreground" process the way the tmux version
// did: the PTY's child is Claude, and `send()` writes straight to it.
export async function processOneTick(state, screen, config, isAlive) {
  if (!isAlive()) return 'exit';

  // patterns.js strips ANSI internally, so pass the raw rendered screen through.
  const screenText = await screen.capture(DETECTION_LINES);

  if (state.status === 'waiting') {
    if (Date.now() < state.waitUntil) return 'waiting';
    if (!isAlive()) return 'exit';

    // Always check if rate limit cleared FIRST — even when maxRetries
    // exhausted, the user (or time passing) may have resolved it.
    if (!isRateLimited(screenText, config.customPatterns)) {
      // Distinguish our own retry succeeding from the user resolving it
      // manually, so the log reflects what actually happened.
      const outcome = state.retrySent ? 'retry-succeeded' : 'user-continued';
      state.status = 'monitoring'; state.attempts = 0; state.retrySent = false;
      return outcome;
    }

    if (state.attempts >= config.maxRetries) {
      // Stay in 'waiting' to avoid re-detecting the stale rate limit
      // on the next tick and creating an infinite max-retries loop.
      state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * MAX_RETRIES_BACKOFF_INTERVALS);
      return 'max-retries';
    }

    // Increment attempts and set cooldown BEFORE send() so that a failure
    // (e.g. PTY destroyed) still consumes a retry and avoids tight-loop errors.
    state.attempts++;
    state.waitUntil = Date.now() + config.retryCooldownSeconds * 1000;
    try {
      await screen.send(config.retryMessage);
    } catch {
      // Surface the failure distinctly instead of collapsing into the generic
      // tick-error path; the attempt is still consumed (cooldown is set above).
      return 'retry-failed';
    }
    state.retrySent = true;
    return 'retried';
  }

  if (isRateLimited(screenText, config.customPatterns)) {
    const message = findRateLimitMessage(screenText, config.customPatterns);
    state.lastRateLimitMessage = message;
    const parsed = message ? parseResetTime(message) : null;
    state.waitUntil = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
    state.status = 'waiting';
    state.retrySent = false; // start of a fresh rate-limit episode
    return 'waiting';
  }

  return 'monitoring';
}

// Drive processOneTick on a timer against the given screen adapter.
// Returns a stop() function. Logging is delegated to the injected logger so
// the loop stays pure and testable.
export function runMonitor(screen, config, logger, isAlive) {
  const state = createMonitorState();
  let consecutiveErrors = 0;
  let maxRetriesLogged = false;
  let stopped = false;
  let timer = null;
  const MAX_CONSECUTIVE_ERRORS = 10;

  const log = (level, msg) => logger?.[level]?.(msg).catch(() => {});

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  const loop = async () => {
    if (stopped) return;
    try {
      const result = await processOneTick(state, screen, config, isAlive);
      consecutiveErrors = 0;

      // The launcher's onExit owns the "Claude exited" log line (it always
      // fires on exit and is what flips isAlive); here we just stop quietly so
      // a tick already in flight when Claude exits can't double-log it.
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
      log('error', `Monitor tick error: ${err.message}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log('error', `${MAX_CONSECUTIVE_ERRORS} consecutive errors. Stopping monitor.`);
        stop();
      }
    }
  };

  // Recursive setTimeout (not setInterval) so ticks never overlap when one
  // runs longer than the poll interval.
  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await loop();
      scheduleNext();
    }, config.pollIntervalSeconds * 1000);
  };

  loop().then(scheduleNext);
  return stop;
}
