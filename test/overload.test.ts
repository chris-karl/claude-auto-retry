import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectOverload, overloadMatch } from '../src/patterns.ts';
import { loadConfig, DEFAULT_CONFIG, DEFAULT_OVERLOAD } from '../src/config.ts';
import type { Config, OverloadConfig } from '../src/config.ts';
import {
  createMonitorState, processOneTick,
  overloadBaseWaitMs, applyJitter, nextOverloadWaitMs,
} from '../src/monitor.ts';
import type { ScreenAdapter } from '../src/monitor.ts';
import type { StopFailureEvent } from '../src/events.ts';

const PATS = DEFAULT_OVERLOAD.patterns;

interface MockScreen extends ScreenAdapter {
  _sent: string[];
  _escaped: number;
  _event: StopFailureEvent | null;
  _cleared: boolean;
}

function mockScreen(
  screenContent = '',
  { failSend = false, event = null }: { failSend?: boolean; event?: StopFailureEvent | null } = {},
): MockScreen {
  const s: MockScreen = {
    _sent: [],
    _escaped: 0,
    _event: event,
    _cleared: false,
    capture: async () => screenContent,
    send: async (text: string) => {
      if (failSend) throw new Error('PTY destroyed');
      s._sent.push(text);
    },
    sendEscape: async () => { s._escaped++; },
    readEvent: async () => s._event,
    clearEvent: async () => { s._event = null; s._cleared = true; },
  };
  return s;
}

function makeEvent(error: string): StopFailureEvent {
  return { session: '12345', error, session_id: null, ts: Date.now() };
}

// Deterministic config: zero jitter so scheduled waits are exact.
function cfg(overrides: Partial<OverloadConfig> = {}): Config {
  return { ...DEFAULT_CONFIG, overload: { ...DEFAULT_OVERLOAD, jitterPct: 0, ...overrides } };
}

const NO_JITTER = (): number => 0.5; // factor = 1 + (0.5*2-1)*pct = 1 (no shift)

describe('detectOverload', () => {
  it('matches "API Error: 529"', () => assert.equal(detectOverload('API Error: 529 Overloaded', PATS), true));
  it('matches "API Error: 500 Internal server error"', () => assert.equal(detectOverload('API Error: 500 Internal server error', PATS), true));
  it('matches "API Error: 503 no healthy upstream" (plain-text edge body)', () => assert.equal(detectOverload('API Error: 503 no healthy upstream', PATS), true));
  it('matches "API Error: 502"', () => assert.equal(detectOverload('API Error: 502 Bad Gateway', PATS), true));
  it('matches "API Error: 504"', () => assert.equal(detectOverload('API Error: 504 Gateway Timeout', PATS), true));
  it('matches the overloaded_error JSON type', () => assert.equal(detectOverload('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', PATS), true));
  it('matches the dedicated API-429 render (no 3-digit code in the slot)', () => assert.equal(detectOverload('API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', PATS), true));
  it('tolerates missing space after the colon', () => assert.equal(detectOverload('API Error:529', PATS), true));
  it('is case-insensitive', () => assert.equal(detectOverload('api error: 529 OVERLOADED', PATS), true));
  it('detects through ANSI codes', () => assert.equal(detectOverload('\x1b[31mAPI Error: 529\x1b[0m \x1b[1mOverloaded\x1b[0m', PATS), true));
  it('returns false for normal output', () => assert.equal(detectOverload('Here is the code you asked for', PATS), false));
  it('returns false for empty patterns', () => assert.equal(detectOverload('API Error: 529', []), false));
  it('returns false for empty text', () => assert.equal(detectOverload('', PATS), false));

  // --- Regression (upstream): the exact false positives that injected "Continue
  //     where you left off." into live sessions. None are a terminal API error. ---
  it('does NOT match a bare status number ("got a 529 back")', () => assert.equal(detectOverload('got a 529 back', PATS), false));
  it('does NOT match Express code under edit (res.status(503))', () => assert.equal(detectOverload('      res.status(503).json({ status: "degraded", db: "down" });', PATS), false));
  it('does NOT match a Dockerfile HEALTHCHECK with 503/500 in a comment', () => assert.equal(detectOverload('# 500 Internal server error / 503 ... liveness check (200 even if DB down)', PATS), false));
  it('does NOT match a "status.claude.com" mention in prose/comments', () => assert.equal(detectOverload('see status.claude.com for incidents', PATS), false));
  it('does NOT match a bare "500 Internal server error" without the API Error frame', () => assert.equal(detectOverload('500 Internal server error · try again', PATS), false));

  // --- Self-referential: the phrase patterns must not fire when merely quoted or
  //     discussed in the session (a conversation explaining this tool, or about API
  //     errors). The real render always carries an `API Error` line nearby. ---
  it('does NOT match "temporarily limiting requests" in prose (no API Error nearby)', () => {
    assert.equal(detectOverload('the "temporarily limiting requests" pattern is a built-in overload signal', PATS), false);
  });
  it('does NOT match a quoted "overloaded_error" in prose (no API Error nearby)', () => {
    assert.equal(detectOverload('the overloaded_error JSON type is what we anchor on', PATS), false);
  });
  it('still matches the real API-429 render (API Error on the line)', () => {
    assert.equal(detectOverload('● API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', PATS), true);
  });
  it('still matches a multi-line overloaded_error body (API Error one line up)', () => {
    assert.equal(detectOverload('API Error: 529\n{"type":"error","error":{"type":"overloaded_error"}}', PATS), true);
  });

  // --- Tail-anchoring: an error that has scrolled up out of the live tail is no
  //     longer terminal (clean tail, an old status code sitting up in scrollback). ---
  it('does NOT match an API error buried above the 12-line tail', () => {
    const screen = ['API Error: 529 Overloaded', ...Array(15).fill('● Deleted workflow TEMP_fx_verify'), 'done.'].join('\n');
    assert.equal(detectOverload(screen, PATS), false);
  });
  it('matches an API error sitting in the live tail', () => {
    const screen = ['some earlier output', 'more output', 'API Error: 529 Overloaded'].join('\n');
    assert.equal(detectOverload(screen, PATS), true);
  });

  // --- Raw-distance bound: chrome-stripping lets the tail reach past a tall widget,
  //     but for the overload path anything reachable ONLY that way is stale
  //     scrollback, not a live terminal error (which sits just above the input box). ---
  it('does NOT match an API error buried >20 raw lines up behind a tall chrome widget', () => {
    const screen = [
      'API Error: 529 Overloaded',
      '  20 tasks (0 done, 20 open)',
      ...Array(22).fill('  □ pending task'),
      '───────────────', '❯ ',
    ].join('\n');
    assert.equal(detectOverload(screen, PATS), false);
  });
  it('still matches a terminal API error just above the input box', () => {
    const screen = ['API Error: 529 Overloaded', '───────────────', '❯ ', '───────────────', '  ⏵⏵ auto mode on'].join('\n');
    assert.equal(detectOverload(screen, PATS), true);
  });
});

describe('overloadMatch (observability)', () => {
  it('reports the matched pattern and offending line', () => {
    const m = overloadMatch('thinking…\nAPI Error: 529 Overloaded', PATS);
    assert.ok(m && /429\|500/.test(m.pattern));
    assert.equal(m.line, 'API Error: 529 Overloaded');
  });
  it('returns null when nothing matches', () => assert.equal(overloadMatch('res.status(503)', PATS), null));
  it('truncates a very long offending line to 200 chars', () => {
    const m = overloadMatch('API Error: 500 ' + 'x'.repeat(500), PATS);
    assert.ok(m && m.line.length <= 200);
  });
});

describe('DEFAULT_OVERLOAD config', () => {
  it('is present on DEFAULT_CONFIG with expected shape', () => {
    assert.equal(DEFAULT_CONFIG.overload.enabled, true);
    assert.deepEqual(DEFAULT_CONFIG.overload.backoffSeconds, [30, 60, 120, 240, 300]);
    assert.equal(DEFAULT_CONFIG.overload.steadyStateSeconds, 300);
    assert.equal(DEFAULT_CONFIG.overload.jitterPct, 15);
    assert.equal(DEFAULT_CONFIG.overload.maxTotalWaitMinutes, 120);
    assert.ok(DEFAULT_CONFIG.overload.patterns.includes('overloaded_error'));
    // Defaults must never carry a bare status number — that's the false-positive class.
    assert.ok(!DEFAULT_CONFIG.overload.patterns.some((p) => /^\d+$/.test(p)));
  });
});

async function loadFrom(obj: unknown): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), 'car-ovl-'));
  const f = join(dir, 'config.json');
  await writeFile(f, JSON.stringify(obj));
  try { return await loadConfig(f); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('overload config validation', () => {
  it('merges a partial overload block onto defaults', async () => {
    const c = await loadFrom({ overload: { maxTotalWaitMinutes: 30 } });
    assert.equal(c.overload.maxTotalWaitMinutes, 30);
    assert.deepEqual(c.overload.backoffSeconds, DEFAULT_OVERLOAD.backoffSeconds);
    assert.equal(c.overload.enabled, true);
  });
  it('clamps jitterPct to 0..100', async () => {
    assert.equal((await loadFrom({ overload: { jitterPct: 999 } })).overload.jitterPct, 100);
    assert.equal((await loadFrom({ overload: { jitterPct: -5 } })).overload.jitterPct, 0);
  });
  it('falls back on empty/invalid backoffSeconds', async () => {
    assert.deepEqual((await loadFrom({ overload: { backoffSeconds: [] } })).overload.backoffSeconds, DEFAULT_OVERLOAD.backoffSeconds);
    assert.deepEqual((await loadFrom({ overload: { backoffSeconds: 'soon' } })).overload.backoffSeconds, DEFAULT_OVERLOAD.backoffSeconds);
  });
  it('drops non-positive backoff entries but keeps valid ones', async () => {
    assert.deepEqual((await loadFrom({ overload: { backoffSeconds: [10, -1, 0, 20] } })).overload.backoffSeconds, [10, 20]);
  });
  it('falls back on bad maxTotalWaitMinutes', async () => {
    assert.equal((await loadFrom({ overload: { maxTotalWaitMinutes: -1 } })).overload.maxTotalWaitMinutes, DEFAULT_OVERLOAD.maxTotalWaitMinutes);
  });
  it('filters non-string patterns and falls back when none valid', async () => {
    assert.deepEqual((await loadFrom({ overload: { patterns: ['Boom', 42, ''] } })).overload.patterns, ['Boom']);
    assert.deepEqual((await loadFrom({ overload: { patterns: [1, 2] } })).overload.patterns, DEFAULT_OVERLOAD.patterns);
  });
  it('coerces a non-boolean enabled to the default', async () => {
    assert.equal((await loadFrom({ overload: { enabled: 'yes' } })).overload.enabled, true);
  });
});

describe('overload backoff schedule (pure)', () => {
  it('follows 30/60/120/240/300 then steady 300', () => {
    const o = DEFAULT_OVERLOAD;
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((i) => overloadBaseWaitMs(i, o) / 1000),
      [30, 60, 120, 240, 300, 300, 300]);
  });
  it('applyJitter stays within ±jitterPct', () => {
    for (let i = 0; i < 200; i++) {
      const out = applyJitter(100_000, 15);
      assert.ok(out >= 85_000 && out <= 115_000, `out=${out}`);
    }
  });
  it('applyJitter with pct=0 is exact', () => assert.equal(applyJitter(120_000, 0), 120_000));
  it('applyJitter is symmetric at rand extremes', () => {
    assert.equal(applyJitter(100_000, 10, () => 0), 90_000);   // rand=0 → -10%
    assert.equal(applyJitter(100_000, 10, () => 1), 110_000);  // rand=1 → +10%
    assert.equal(applyJitter(100_000, 10, () => 0.5), 100_000);
  });
  it('nextOverloadWaitMs composes base + jitter', () => {
    assert.equal(nextOverloadWaitMs(0, { ...DEFAULT_OVERLOAD, jitterPct: 0 }), 30_000);
  });
});

const near = (actual: number, expectedMs: number): boolean => Math.abs(actual - expectedMs) < 2000;

describe('processOneTick — overload path', () => {
  it('enters overload (not usage-wait) on a 529', async () => {
    const s = mockScreen('API Error: 529 Overloaded');
    const st = createMonitorState();
    const r = await processOneTick(st, s, cfg(), () => true, NO_JITTER);
    assert.equal(r, 'overload-detected');
    assert.equal(st.status, 'overload');
    assert.ok(near(st.overloadWaitUntil - Date.now(), 30_000));
    assert.equal(s._sent.length, 0);
  });

  it('does NOT enter overload while Claude is working', async () => {
    const s = mockScreen('API Error: 529 Overloaded\n· Cogitating… (esc to interrupt)');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'monitoring');
    assert.equal(st.status, 'monitoring');
  });

  it('does NOT enter overload while Claude is still internally retrying (colon form + suffix)', async () => {
    const s = mockScreen('API Error: 529 {"type":"error"} · Retrying in 5s · attempt 3/10');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'monitoring');
    assert.equal(st.status, 'monitoring');
    assert.equal(s._sent.length, 0);
  });

  it('does NOT retry a non-target error', async () => {
    const s = mockScreen('Here is the answer to your question. Done.');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'monitoring');
    assert.equal(s._sent.length, 0);
  });

  it('usage-limit takes precedence over a co-present overload pattern', async () => {
    const s = mockScreen('5-hour limit reached - resets 3pm (UTC)\nAPI Error: 529 Overloaded');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'waiting');
    assert.equal(st.status, 'waiting');
  });

  it('sends the overload retry when the backoff window expires', async () => {
    const s = mockScreen('API Error: 529 Overloaded');
    const st = createMonitorState();
    st.status = 'overload'; st.overloadWaitUntil = Date.now() - 1; st.overloadTotalWaitMs = 30_000;
    const r = await processOneTick(st, s, cfg(), () => true, NO_JITTER);
    assert.equal(r, 'overload-retried');
    assert.equal(s._sent.length, 1);
    assert.equal(s._sent[0], DEFAULT_OVERLOAD.retryMessage);
    assert.equal(st.overloadAttempts, 1);
    assert.ok(near(st.overloadWaitUntil - Date.now(), 60_000)); // next backoff = index 1
  });

  it('still consumes the slot when the retry send throws', async () => {
    const s = mockScreen('API Error: 529 Overloaded', { failSend: true });
    const st = createMonitorState();
    st.status = 'overload'; st.overloadWaitUntil = Date.now() - 1; st.overloadTotalWaitMs = 30_000;
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'overload-retry-failed');
    assert.equal(st.overloadAttempts, 1);              // attempt consumed despite failure
    assert.ok(st.overloadWaitUntil > Date.now());      // next window scheduled, no tight loop
  });

  it('walks the full 30→60→120→240→300→300 schedule across retries', async () => {
    const s = mockScreen('API Error: 529 Overloaded');
    const st = createMonitorState();
    // tick 1: detect → first 30s window
    await processOneTick(st, s, cfg(), () => true, NO_JITTER);
    const seen = [Math.round((st.overloadWaitUntil - Date.now()) / 1000)];
    for (let i = 0; i < 5; i++) {
      st.overloadWaitUntil = Date.now() - 1;                       // force expiry
      await processOneTick(st, s, cfg(), () => true, NO_JITTER);
      seen.push(Math.round((st.overloadWaitUntil - Date.now()) / 1000));
    }
    assert.deepEqual(seen, [30, 60, 120, 240, 300, 300]);
    assert.equal(s._sent.length, 5);
  });

  it('defers (overload-working) if Claude resumes work during the wait', async () => {
    const s = mockScreen('API Error: 529 Overloaded\nThinking… (esc to interrupt)');
    const st = createMonitorState();
    st.status = 'overload'; st.overloadWaitUntil = Date.now() - 1; st.overloadTotalWaitMs = 30_000;
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'overload-working');
    assert.equal(s._sent.length, 0);
    assert.equal(st.overloadAttempts, 0); // no attempt consumed
  });

  it('clears back to monitoring when the overload text is gone', async () => {
    const s = mockScreen('All good, here is your refactor.');
    const st = createMonitorState();
    st.status = 'overload'; st.overloadWaitUntil = Date.now() - 1; st.overloadAttempts = 2; st.overloadTotalWaitMs = 90_000;
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'overload-cleared');
    assert.equal(st.status, 'monitoring');
    assert.equal(st.overloadAttempts, 0);
  });

  it('gives up at the maxTotalWait cap', async () => {
    const s = mockScreen('API Error: 529 Overloaded');
    const c = cfg({ backoffSeconds: [30, 60], maxTotalWaitMinutes: 0.75 }); // cap = 45s
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, c, () => true, NO_JITTER), 'overload-detected'); // +30s (total 30)
    st.overloadWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, s, c, () => true, NO_JITTER), 'overload-retried');   // +60s (total 90 > cap)
    st.overloadWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, s, c, () => true, NO_JITTER), 'overload-gave-up');
    assert.equal(s._sent.length, 1);
  });

  it('switches to the usage path if a usage limit appears mid-overload', async () => {
    const s = mockScreen('5-hour limit reached - resets 3pm (UTC)');
    const st = createMonitorState();
    st.status = 'overload'; st.overloadWaitUntil = Date.now() - 1; st.overloadAttempts = 1; st.overloadTotalWaitMs = 60_000;
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'waiting');
    assert.equal(st.status, 'waiting');
    assert.equal(st.overloadAttempts, 0);
  });

  it('hands off to the usage path when the interactive limit menu appears mid-overload', async () => {
    const menu = [
      "You've hit your session limit · resets 3pm (UTC)",
      'What do you want to do?',
      '❯ 1. Stop and wait for limit to reset',
      '  2. Upgrade your plan',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    const s = mockScreen(menu);
    const st = createMonitorState();
    st.status = 'overload'; st.overloadWaitUntil = Date.now() - 1; st.overloadTotalWaitMs = 30_000;
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'waiting');
    assert.equal(st.status, 'waiting');
  });

  it('disabled overload block is ignored entirely', async () => {
    const s = mockScreen('API Error: 529 Overloaded');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg({ enabled: false }), () => true, NO_JITTER), 'monitoring');
    assert.equal(s._sent.length, 0);
  });
});

describe('processOneTick — StopFailure event path (authoritative)', () => {
  it('enters overload from a StopFailure marker with NO scraper match', async () => {
    const s = mockScreen('working on a /health endpoint res.status(503)', { event: makeEvent('overloaded') });
    const st = createMonitorState();
    const r = await processOneTick(st, s, cfg(), () => true, NO_JITTER);
    assert.equal(r, 'overload-detected');
    assert.equal(st.viaEvent, true);
    assert.equal(s._cleared, true);      // marker consumed
    assert.equal(s._sent.length, 0);     // no send yet — backoff first
    assert.ok(near(st.overloadWaitUntil - Date.now(), 30_000));
  });

  it('sends exactly once after the window, then returns to monitoring (edge-triggered)', async () => {
    const s = mockScreen('idle prompt');
    const st = createMonitorState();
    st.status = 'overload'; st.viaEvent = true; st.overloadWaitUntil = Date.now() - 1; st.overloadTotalWaitMs = 30_000;
    const r = await processOneTick(st, s, cfg(), () => true, NO_JITTER);
    assert.equal(r, 'overload-retried');
    assert.equal(s._sent[0], DEFAULT_OVERLOAD.retryMessage);
    assert.equal(st.status, 'monitoring');   // back to waiting for the next failure
    assert.equal(st.viaEvent, false);
    assert.equal(st.overloadAttempts, 1);
  });

  it('cancels the send if Claude self-recovered during the backoff', async () => {
    const s = mockScreen('Thinking… (esc to interrupt)');
    const st = createMonitorState();
    st.status = 'overload'; st.viaEvent = true; st.overloadWaitUntil = Date.now() - 1; st.overloadTotalWaitMs = 30_000;
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'overload-cleared');
    assert.equal(s._sent.length, 0);
    assert.equal(st.status, 'monitoring');
  });

  it('hands off to the usage path if a limit banner is up when the event window expires', async () => {
    const s = mockScreen("You've hit your session limit · resets 3pm (UTC)");
    const st = createMonitorState();
    st.status = 'overload'; st.viaEvent = true; st.overloadWaitUntil = Date.now() - 1; st.overloadTotalWaitMs = 30_000;
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'waiting');
    assert.equal(st.status, 'waiting');
    assert.equal(s._sent.length, 0);
  });

  it('treats an event as self-recovered if Claude is already working at detection', async () => {
    const s = mockScreen('Cogitating… (esc to interrupt)', { event: makeEvent('overloaded') });
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'overload-cleared');
    assert.equal(s._cleared, true);
    assert.equal(st.status, 'monitoring');
    assert.equal(s._sent.length, 0);
  });

  it('consumes-and-ignores a non-retryable marker (e.g. rate_limit from an outdated hook)', async () => {
    // Regression (upstream #31): settings.json freezes the hook's cli path + matcher at
    // install time, so an old hook binary can still write rate_limit markers after an
    // upgrade. The monitor must not enter overload backoff off it — just consume it so
    // it can't re-fire (the scraper still gets its normal shot on the next tick).
    for (const bad of ['rate_limit', 'billing_error', 'invalid_request']) {
      const s = mockScreen('idle prompt', { event: makeEvent(bad) });
      const st = createMonitorState();
      const r = await processOneTick(st, s, cfg(), () => true, NO_JITTER);
      assert.equal(r, 'event-ignored', bad);
      assert.equal(st.status, 'monitoring', bad);
      assert.equal(s._cleared, true, bad);      // consumed so it can't re-fire
      assert.equal(s._sent.length, 0, bad);
    }
  });

  // A transient API 429 emits no retryable marker, so only the scraper can catch
  // it — it must stay active after the hook has fired (it used to be permanently
  // disabled by the first marker, leaving a stuck 429 unretried).
  it('keeps the overload scraper active after the hook has fired (429 with no marker is still retried)', async () => {
    const st = createMonitorState();
    // 1. A retryable StopFailure fires — the hook is now known live for this session.
    const s1 = mockScreen('idle prompt', { event: makeEvent('server_error') });
    assert.equal(await processOneTick(st, s1, cfg(), () => true, NO_JITTER), 'overload-detected');
    st.status = 'monitoring';  // recovered from that incident, back to watching
    // 2. Later, a transient API 429 the event path can't emit (no marker) appears.
    const render = '● API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited\n\n✻ Cogitated for 37s\n\n❯ ';
    const s2 = mockScreen(render);
    assert.equal(await processOneTick(st, s2, cfg(), () => true, NO_JITTER), 'overload-detected');
    assert.equal(st.status, 'overload');
  });

  // After a viaEvent retry the banner is often still on screen (edge-triggered — no
  // clear-check); the scraper must not re-detect it and open a second backoff.
  it('does not re-fire the scraper on the same banner lingering after a viaEvent retry', async () => {
    const banner = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}';
    const st = createMonitorState();
    // in a viaEvent backoff whose window just elapsed, the banner still rendered
    st.status = 'overload'; st.viaEvent = true; st.overloadWaitUntil = Date.now() - 1; st.overloadTotalWaitMs = 30_000;
    const s1 = mockScreen(banner);
    assert.equal(await processOneTick(st, s1, cfg(), () => true, NO_JITTER), 'overload-retried'); // send #1
    assert.equal(st.status, 'monitoring');
    assert.equal(s1._sent.length, 1);
    assert.equal(st.overloadAttempts, 1);
    // next tick: same banner still present, no new marker → scraper must NOT re-detect it
    const s2 = mockScreen(banner);
    assert.equal(await processOneTick(st, s2, cfg(), () => true, NO_JITTER), 'monitoring');
    assert.equal(s2._sent.length, 0);         // no second injection
    assert.equal(st.overloadAttempts, 1);     // give-up budget not reset
  });

  it('works without event plumbing (adapter without readEvent falls back to the scraper)', async () => {
    const s = mockScreen('API Error: 529 Overloaded');
    delete s.readEvent;
    delete s.clearEvent;
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg(), () => true, NO_JITTER), 'overload-detected');
    assert.equal(st.status, 'overload');
  });
});
