import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorMatch } from '../src/patterns.ts';
import { DEFAULT_CONFIG, DEFAULT_OVERLOAD, DEFAULT_SAFEGUARD } from '../src/config.ts';
import type { Config, RetryConfig } from '../src/config.ts';
import { createMonitorState, processOneTick, backoffMs } from '../src/monitor.ts';
import { mockScreen, loadFrom } from './helpers.ts';

const OVERLOAD = DEFAULT_OVERLOAD.patterns;
const SAFEGUARD = DEFAULT_SAFEGUARD.patterns;
const detect = (text: string, patterns: string[]): boolean => apiErrorMatch(text, patterns) !== null;

// The real safeguard render, verbatim-ish.
const FLAG = [
  '❯ continue',
  '',
  "● API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). They may flag safe, normal content as well. Claude Code can't respond to this request with Fable 5.",
  '  Double press esc to edit your last message, or try a different model with /model.',
  '  Request ID: req_011Ccfhw8avogXF48ed42Xjt',
  '❯ ',
].join('\n');

function cfg(kind: 'overload' | 'safeguard', overrides: Partial<RetryConfig> = {}): Config {
  return { ...DEFAULT_CONFIG, [kind]: { ...DEFAULT_CONFIG[kind], ...overrides } };
}

const near = (actual: number, expectedMs: number): boolean => Math.abs(actual - expectedMs) < 2000;

describe('apiErrorMatch — overload renders', () => {
  it('matches the terminal 5xx/529 renders', () => {
    for (const line of [
      'API Error: 529 Overloaded',
      'API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.',
      'API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.',
      'API Error: 503 no healthy upstream',
      'API Error: 502 Bad Gateway',
      'API Error: 504 Gateway Timeout',
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      'API Error:529',
      'api error: 529 OVERLOADED',
      '\x1b[31mAPI Error: 529\x1b[0m \x1b[1mOverloaded\x1b[0m',
    ]) assert.equal(detect(line, OVERLOAD), true, line);
  });
  it('matches the dedicated API-429 render (no status code in the slot)', () => {
    assert.equal(detect('● API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', OVERLOAD), true);
  });
  it('matches a multi-line overloaded_error body (API Error one line up)', () => {
    assert.equal(detect('API Error: 529\n{"type":"error","error":{"type":"overloaded_error"}}', OVERLOAD), true);
  });
  it('returns false for normal output, empty patterns and empty text', () => {
    assert.equal(detect('Here is the code you asked for', OVERLOAD), false);
    assert.equal(detect('API Error: 529', []), false);
    assert.equal(detect('', OVERLOAD), false);
  });
  // Regression (upstream): the false positives that injected "Continue where you
  // left off." into live sessions. None are a terminal API error.
  it('does NOT match bare status numbers in code, comments or prose', () => {
    for (const line of [
      'got a 529 back',
      '      res.status(503).json({ status: "degraded", db: "down" });',
      '# 500 Internal server error / 503 ... liveness check (200 even if DB down)',
      'see status.claude.com for incidents',
      '500 Internal server error · try again',
      'the "temporarily limiting requests" pattern is a built-in overload signal',
      'the overloaded_error JSON type is what we anchor on',
    ]) assert.equal(detect(line, OVERLOAD), false, line);
  });
  // Tail anchoring: an error that scrolled up out of the live tail is not terminal.
  it('does NOT match an API error buried above the 12-line tail', () => {
    const screen = ['API Error: 529 Overloaded', ...Array(15).fill('● Deleted workflow TEMP_fx_verify'), 'done.'].join('\n');
    assert.equal(detect(screen, OVERLOAD), false);
  });
  it('does NOT match an API error >20 raw lines up behind a tall chrome widget', () => {
    const screen = ['API Error: 529 Overloaded', '  20 tasks (0 done, 20 open)', ...Array(22).fill('  □ pending task'), '───────────────', '❯ '].join('\n');
    assert.equal(detect(screen, OVERLOAD), false);
  });
  it('matches a terminal API error just above the input box', () => {
    const screen = ['API Error: 529 Overloaded', '───────────────', '❯ ', '───────────────', '  ⏵⏵ auto mode on'].join('\n');
    assert.equal(detect(screen, OVERLOAD), true);
  });
  it('reports the matched pattern and offending line, truncated to 200 chars', () => {
    const m = apiErrorMatch('thinking…\nAPI Error: 529 Overloaded', OVERLOAD);
    assert.ok(m && /429\|500/.test(m.pattern));
    assert.equal(m.line, 'API Error: 529 Overloaded');
    assert.ok(apiErrorMatch('API Error: 500 ' + 'x'.repeat(500), OVERLOAD)!.line.length <= 200);
    assert.equal(apiErrorMatch('res.status(503)', OVERLOAD), null);
  });
});

describe('apiErrorMatch — safeguard renders', () => {
  it('matches the safeguards-flagged render, also wrapped across lines', () => {
    assert.equal(detect(FLAG, SAFEGUARD), true);
    assert.equal(detect(['● API Error: Fable', "  5's safeguards flagged", '  this message (https://www.anthropic.com/legal/aup).'].join('\n'), SAFEGUARD), true);
    assert.equal(detect('API ERROR: SAFEGUARDS FLAGGED THIS MESSAGE', SAFEGUARD), true);
  });
  // Regression (upstream): Claude ANSWERING a question about AUP flags must not retry.
  it('does NOT fire on the phrases without the API Error render nearby', () => {
    assert.equal(detect('see https://www.anthropic.com/legal/aup for the policy', SAFEGUARD), false);
    assert.equal(detect("Claude Code can't respond to this request with Opus 4.8.", SAFEGUARD), false);
    assert.equal(detect(['discussing safeguards flagged this message', ...Array(15).fill('● unrelated work'), '❯ '].join('\n'), SAFEGUARD), false);
  });
});

describe('retry config validation', () => {
  it('has the documented defaults', () => {
    assert.deepEqual(DEFAULT_CONFIG.overload.backoffSeconds, [30, 60, 120, 240, 300]);
    assert.equal(DEFAULT_CONFIG.overload.maxRetries, 20);
    assert.deepEqual(DEFAULT_CONFIG.safeguard.backoffSeconds, [8]);
    assert.equal(DEFAULT_CONFIG.safeguard.maxRetries, 3);
    // Defaults must never carry a bare status number — that's the false-positive class.
    assert.ok(!DEFAULT_OVERLOAD.patterns.some((p) => /^\d+$/.test(p)));
  });
  it('merges a partial block onto its defaults', async () => {
    const c = await loadFrom({ overload: { maxRetries: 2 }, safeguard: { retryMessage: 'go on' } });
    assert.equal(c.overload.maxRetries, 2);
    assert.deepEqual(c.overload.backoffSeconds, DEFAULT_OVERLOAD.backoffSeconds);
    assert.equal(c.safeguard.retryMessage, 'go on');
    assert.equal(c.safeguard.maxRetries, 3);
  });
  it('falls back on bad values and drops unusable entries', async () => {
    const c = await loadFrom({ overload: { backoffSeconds: [10, -1, 0, 20], maxRetries: -1, enabled: 'yes', patterns: ['Boom', 42, ''] } });
    assert.deepEqual(c.overload.backoffSeconds, [10, 20]);
    assert.equal(c.overload.maxRetries, DEFAULT_OVERLOAD.maxRetries);
    assert.equal(c.overload.enabled, true);
    assert.deepEqual(c.overload.patterns, ['Boom']);
    const d = await loadFrom({ safeguard: { backoffSeconds: 'soon', patterns: [1, 2] } });
    assert.deepEqual(d.safeguard.backoffSeconds, DEFAULT_SAFEGUARD.backoffSeconds);
    assert.deepEqual(d.safeguard.patterns, DEFAULT_SAFEGUARD.patterns);
  });
});

describe('backoffMs', () => {
  it('walks the schedule and repeats the last entry', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((i) => backoffMs(i, DEFAULT_OVERLOAD.backoffSeconds) / 1000), [30, 60, 120, 240, 300, 300, 300]);
    assert.equal(backoffMs(7, [8]), 8000);
  });
});

describe('processOneTick — API error path', () => {
  const ERROR = 'API Error: 529 Overloaded';

  it('enters the overload backoff (not usage-wait) on a 529, without sending yet', async () => {
    const s = mockScreen(ERROR);
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg('overload'), () => true), 'error-detected');
    assert.equal(st.status, 'overload');
    assert.ok(near(st.waitUntil - Date.now(), 30_000));
    assert.equal(s._sent.length, 0);
  });
  it('enters the safeguard wait on the flag render', async () => {
    const s = mockScreen(FLAG);
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg('safeguard'), () => true), 'error-detected');
    assert.equal(st.status, 'safeguard');
    assert.ok(near(st.waitUntil - Date.now(), 8_000));
    assert.equal(s._sent.length, 0);
  });
  it('does NOT enter either path while Claude is working or still retrying internally', async () => {
    for (const text of [`${ERROR}\n· Cogitating… (esc to interrupt)`, `${FLAG}\n· Cooking… (esc to interrupt)`]) {
      const st = createMonitorState();
      assert.equal(await processOneTick(st, mockScreen(text), DEFAULT_CONFIG, () => true), 'monitoring', text);
      assert.equal(st.status, 'monitoring');
    }
  });
  it('a usage limit takes precedence over a co-present error', async () => {
    const st = createMonitorState();
    assert.equal(await processOneTick(st, mockScreen(`5-hour limit reached - resets 3pm (UTC)\n${ERROR}`), DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(st.status, 'waiting');
  });
  it('a disabled block is ignored entirely', async () => {
    const s = mockScreen(ERROR);
    assert.equal(await processOneTick(createMonitorState(), s, cfg('overload', { enabled: false }), () => true), 'monitoring');
    assert.equal(s._sent.length, 0);
  });

  it('sends the retry when the window expires and schedules the next backoff', async () => {
    const s = mockScreen(ERROR);
    const st = createMonitorState();
    st.status = 'overload'; st.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, s, cfg('overload'), () => true), 'error-retried');
    assert.deepEqual(s._sent, [DEFAULT_OVERLOAD.retryMessage]);
    assert.equal(st.attempts, 1);
    assert.ok(near(st.waitUntil - Date.now(), 60_000));
  });
  it('sends the safeguard retry message after its delay', async () => {
    const s = mockScreen(FLAG);
    const st = createMonitorState();
    st.status = 'safeguard'; st.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, s, cfg('safeguard'), () => true), 'error-retried');
    assert.deepEqual(s._sent, ['continue']);
  });
  it('still consumes the slot when the send throws', async () => {
    const s = mockScreen(ERROR, { failSend: true });
    const st = createMonitorState();
    st.status = 'overload'; st.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, s, cfg('overload'), () => true), 'error-retry-failed');
    assert.equal(st.attempts, 1);
    assert.ok(st.waitUntil > Date.now());
  });
  it('walks the full 30→60→120→240→300→300 schedule across retries', async () => {
    const s = mockScreen(ERROR);
    const st = createMonitorState();
    const c = cfg('overload');
    await processOneTick(st, s, c, () => true);
    const seen = [Math.round((st.waitUntil - Date.now()) / 1000)];
    for (let i = 0; i < 5; i++) {
      st.waitUntil = Date.now() - 1;
      await processOneTick(st, s, c, () => true);
      seen.push(Math.round((st.waitUntil - Date.now()) / 1000));
    }
    assert.deepEqual(seen, [30, 60, 120, 240, 300, 300]);
    assert.equal(s._sent.length, 5);
  });
  it('defers while Claude is working WITHOUT consuming or resetting the count', async () => {
    // Regression (upstream #33): a tick landing mid-retry used to reset the counter,
    // so a sticky flag re-entered with a fresh budget and never tripped the cap.
    const s = mockScreen(`${FLAG}\n✻ Thinking… (esc to interrupt)`);
    const st = createMonitorState();
    st.status = 'safeguard'; st.waitUntil = Date.now() - 1; st.attempts = 2;
    assert.equal(await processOneTick(st, s, cfg('safeguard'), () => true), 'error-working');
    assert.equal(st.attempts, 2);
    assert.equal(st.status, 'safeguard');
    assert.equal(s._sent.length, 0);
  });
  it('clears back to monitoring when the error text is gone', async () => {
    const st = createMonitorState();
    st.status = 'overload'; st.waitUntil = Date.now() - 1; st.attempts = 2;
    assert.equal(await processOneTick(st, mockScreen('All good, here is your refactor.'), DEFAULT_CONFIG, () => true), 'error-cleared');
    assert.equal(st.status, 'monitoring');
    assert.equal(st.attempts, 0);
  });
  it('is BOUNDED: gives up after maxRetries, stays quiet, never resets on working ticks', async () => {
    const c = cfg('safeguard', { maxRetries: 2, backoffSeconds: [1] });
    const st = createMonitorState();
    await processOneTick(st, mockScreen(FLAG), c, () => true);
    let sent = 0;
    for (let i = 0; i < 10; i++) {
      st.waitUntil = Date.now() - 1;
      const idle = mockScreen(FLAG);
      const r = await processOneTick(st, idle, c, () => true);
      sent += idle._sent.length;
      st.waitUntil = Date.now() - 1;
      const working = mockScreen(`${FLAG}\n✻ Thinking… (esc to interrupt)`);
      await processOneTick(st, working, c, () => true);
      sent += working._sent.length;
      if (r === 'error-gave-up') break;
    }
    assert.equal(sent, 2);
    assert.equal(st.attempts, 2);
    st.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, mockScreen(FLAG), c, () => true), 'error-gave-up');
    assert.ok(st.waitUntil > Date.now(), 'long cooldown before re-checking the stale error');
  });
  it('hands off to the usage path when a limit appears mid-error', async () => {
    for (const kind of ['overload', 'safeguard'] as const) {
      const st = createMonitorState();
      st.status = kind; st.waitUntil = Date.now() - 1; st.attempts = 1;
      assert.equal(await processOneTick(st, mockScreen("You've hit your session limit · resets 3pm (UTC)"), DEFAULT_CONFIG, () => true), 'waiting');
      assert.equal(st.status, 'waiting');
      assert.equal(st.attempts, 0);
    }
  });
  it('hands off to the usage path when the limit menu appears mid-overload', async () => {
    const menu = ["You've hit your session limit · resets 3pm (UTC)", 'What do you want to do?', '❯ 1. Stop and wait for limit to reset', '  2. Upgrade your plan', 'Enter to confirm · Esc to cancel'].join('\n');
    const st = createMonitorState();
    st.status = 'overload'; st.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, mockScreen(menu), DEFAULT_CONFIG, () => true), 'waiting');
  });
  it('does not inject into a healthy session whose reply mentions the AUP link', async () => {
    const screen = ['● The safeguard error you saw means the model flagged the message. See', '  https://www.anthropic.com/legal/aup for the policy. It can be a false positive.', '', '❯ '].join('\n');
    const s = mockScreen(screen);
    assert.equal(await processOneTick(createMonitorState(), s, DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(s._sent.length, 0);
  });
});
