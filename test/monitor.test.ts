import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, processOneTick } from '../src/monitor.ts';
import type { ScreenAdapter } from '../src/monitor.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { mockScreen } from './helpers.ts';

const MENU = [
  '❯ /rate-limit-options',
  "You've hit your session limit · resets 3pm (UTC)",
  'What do you want to do?',
  '❯ 1. Stop and wait for limit to reset',
  '  2. Upgrade your plan',
  'Enter to confirm · Esc to cancel',
].join('\n');

describe('processOneTick', () => {
  it('returns monitoring when no rate limit', async () => {
    const s = mockScreen('Normal output');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(s._sent.length, 0);
  });
  it('enters waiting on rate limit', async () => {
    const s = mockScreen('5-hour limit reached - resets 3pm (UTC)');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(st.waitUntil > Date.now());
  });
  it('exits when PID dead', async () => {
    const s = mockScreen('5-hour limit reached - resets 3pm (UTC)');
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => false), 'exit');
  });
  it('sends retry when wait expired and rate limit visible', async () => {
    const s = mockScreen('5-hour limit reached - resets 3pm (UTC)');
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(s._sent.length, 1);
    assert.equal(s._sent[0], DEFAULT_CONFIG.retryMessage);
    assert.equal(st.attempts, 1);
    assert.equal(st.retrySent, true);
    // Should stay in 'waiting' with a cooldown to let Claude process.
    assert.equal(st.status, 'waiting');
    assert.ok(st.waitUntil > Date.now());
  });
  it('returns retry-failed and still consumes the attempt when send throws', async () => {
    const s = mockScreen('5-hour limit reached - resets 3pm (UTC)', { failSend: true });
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'retry-failed');
    assert.equal(st.attempts, 1);          // attempt consumed despite failure
    assert.equal(st.retrySent, false);     // send did not actually go through
    assert.ok(st.waitUntil > Date.now());  // cooldown set, so no tight loop
  });
  it('reports retry-succeeded (not user-continued) when our retry cleared the limit', async () => {
    const s = mockScreen('Claude is working normally');
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting'; st.attempts = 1; st.retrySent = true;
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'retry-succeeded');
    assert.equal(st.attempts, 0);
    assert.equal(st.retrySent, false);
  });
  it('detects multi-line TUI rate limit', async () => {
    const s = mockScreen('⚠ You\'ve hit your limit\n· resets 3pm (UTC)');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(st.waitUntil > Date.now());
  });
  it('resets counter when rate limit disappears', async () => {
    const s = mockScreen('Claude is working normally');
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting'; st.attempts = 2;
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(st.attempts, 0);
  });
  it('stops retrying after max attempts and stays in waiting', async () => {
    const s = mockScreen('5-hour limit reached - resets 3pm (UTC)');
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting'; st.attempts = 5;
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'max-retries');
    // Should stay in 'waiting' to avoid re-detection loop.
    assert.equal(st.status, 'waiting');
    assert.ok(st.waitUntil > Date.now());
    assert.equal(s._sent.length, 0);
  });
  it('resets from max-retries when rate limit clears', async () => {
    const s = mockScreen('Claude is working normally');
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting'; st.attempts = 10;
    // Rate limit cleared → should detect user-continued before max-retries check.
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(st.attempts, 0);
  });

  it('never injects into a working session with a lingering banner (detect → resume cycle)', async () => {
    // Banner still on the rendered screen while Claude is actively streaming. The
    // monitoring path detects it ungated (a working gate would let transcript text
    // matching a WORKING_PATTERN suppress detection entirely); the waiting branch
    // then sees the session working and returns to monitoring without sending.
    const s = mockScreen('hit your limit · resets 3pm (UTC)\n✻ Working… (8s · esc to interrupt)');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(st.status, 'monitoring');
    assert.equal(s._sent.length, 0);
  });
  // A transcript line matching a working pattern ("Retrying in …"/"attempt N/M" in a
  // flaky deploy/test log) must not permanently suppress detection of a live limit.
  it('still detects a live limit when a "Retrying in / attempt" transcript line is in the tail', async () => {
    const s = mockScreen([
      '  ⎿  deploying… Retrying in 5s (attempt 2/3)...',
      '  ⎿  deploy failed after 3 attempts',
      "You've hit your session limit · resets 3pm (UTC)", '❯ ',
    ].join('\n'));
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(st.status, 'waiting');   // NOT suppressed by the transcript over-match
  });
  // Counter-repro: a genuinely limited, IDLE session whose scrollback contains a
  // finished agent's "Backgrounded agent" transcript line MUST still be retried.
  it('still retries a limited idle session with a finished-agent transcript in scrollback', async () => {
    const s = mockScreen([
      '● Task(build the parser)', '  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)',
      '● Done. The parser passes all 14 tests.',
      "You've hit your session limit · resets 3pm (UTC)", '❯ ',
    ].join('\n'));
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting'; st.attempts = 1;
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(s._sent.length, 1);   // NOT suppressed — the transcript line isn't "working"
  });
  it('treats Claude becoming busy mid-wait as a resume', async () => {
    const s = mockScreen('hit your limit · resets 3pm (UTC)\n✻ Working… (2s · esc to interrupt)');
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s._sent.length, 0);
  });
  // While the wait timer is still counting down, a session that resumed working (the
  // user manually continued to unstick a wrong/stale wait) must drop back to
  // monitoring immediately — otherwise the monitor is parked blind on the old timer
  // and never detects a SECOND, genuine limit that follows (upstream issue #39).
  it('drops out of the wait as soon as Claude resumes working, before the timer expires', async () => {
    const s = mockScreen('5-hour limit reached - resets 3pm (UTC)\n· Doing… (esc to interrupt)');
    const st = createMonitorState();
    st.status = 'waiting'; st.waitUntil = Date.now() + 60 * 60 * 1000; st.attempts = 1;
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(st.status, 'monitoring');
    assert.equal(st.attempts, 0);
    assert.equal(s._sent.length, 0);
  });
  it('enters waiting when the interactive limit menu appears', async () => {
    const s = mockScreen(MENU);
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(st.waitUntil > Date.now());
  });
  it('ignores menu text quoted in scrollback while Claude is working', async () => {
    // Menu text as *content* (e.g. editing this repo's tests) above a live
    // working footer. menuUp bypasses the busy gate, so a full-capture menu
    // match would park a live session in waiting and later inject into it.
    const s = mockScreen([MENU, ...Array(12).fill('● unrelated output'), '✻ Working… (8s · esc to interrupt)'].join('\n'));
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(st.status, 'monitoring');
    assert.equal(s._sent.length, 0);
  });
  it('dismisses the limit menu with Escape (not Enter) before submitting the retry', async () => {
    const s = mockScreen(MENU, { escapeShows: "You've hit your session limit · resets 3pm (UTC)" });
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(s._escaped, 1, 'should press Escape to dismiss the menu');
    assert.equal(s._sent.length, 1, 'should submit the retry message');
  });
  it('holds the retry when Escape fails to dismiss the menu, consuming an attempt', async () => {
    const s = mockScreen(MENU); // Escape leaves the menu on screen
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'menu-still-up');
    assert.equal(s._escaped, 1);
    assert.equal(s._sent.length, 0, 'must not type into a live menu');
    assert.equal(st.attempts, 1, 'the Escape counts as an attempt so a stuck menu cannot loop forever');
    assert.equal(st.status, 'waiting');
    assert.ok(st.waitUntil > Date.now(), 'cooldown set before the next dismissal try');
    // A menu that never closes ends in max-retries, not an endless Escape loop.
    for (let i = 1; i < DEFAULT_CONFIG.maxRetries; i++) { st.waitUntil = Date.now() - 1; await processOneTick(st, s, DEFAULT_CONFIG, () => true); }
    st.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'max-retries');
    assert.equal(s._escaped, DEFAULT_CONFIG.maxRetries);
  });
  it('does not press Escape when there is no menu (plain banner)', async () => {
    const s = mockScreen('5-hour limit reached - resets 3pm (UTC)');
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(s._escaped, 0);
  });

  // --- Chrome-aware detection: a LIVE limit banner pushed far up the screen by UI
  //     chrome (a tall task widget + input box + footer) must still be detected.
  //     Observed live upstream: a session-limit banner ~16 lines up behind a task
  //     list went unretried for ~54 min because a fixed 12-line tail never reached it. ---
  it('detects a live limit banner buried behind a task widget + input box + footer', async () => {
    const s = mockScreen([
      '● Agent "Map LI drop-point" finished · 1m 5s',
      "  └ You've hit your session limit · resets 2am (Europe/Zurich)",
      "     /usage-credits to finish what you're working on.",
      '',
      '✻ Brewed for 54m 35s',
      '',
      '  8 tasks (4 done, 1 in progress, 3 open)',
      '  ◼ FU-4(b): build + run per-order re-drive over remnant',
      '  □ FU-4(a): cache OD inventory map per country',
      '  □ FU-1: analyze tax-free/reverse-charge COGS netting',
      '  □ FU-2: LI routing gap fix',
      '  ✓ Restore sqlrun webhook for DB queries',
      '   … +3 completed',
      '                              new task? /clear to save 468.1k tokens',
      '',
      '───────────────────────────────',
      '❯ ',
      '───────────────────────────────',
      '  Opus 4.8 1M | automation-monorepo@dev | 5h 100% @02:00 | v2.1.201',
      '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
    ].join('\n'));
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(st.status, 'waiting');
  });
  // The /usage-credits backstop must not resurrect the scrollback false positive: a
  // resumed session shows the stale banner+companion with real work rendered below.
  it('does NOT enter a wait via the /usage-credits backstop when real work is below it', async () => {
    const s = mockScreen([
      "You've hit your session limit · resets 2am (Europe/Zurich)",
      "     /usage-credits to finish what you're working on.",
      ...Array(15).fill('● wrote some code after resuming'),
      '❯ ',
    ].join('\n'));
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(st.status, 'monitoring');
    assert.equal(s._sent.length, 0);
  });
  // A banner pushed far up by a ~90-line chrome block must still be inside the
  // capture window. Uses a capture that honours the requested line count (the
  // shared mockScreen ignores it).
  it('detects a limit banner behind a ~90-line chrome block (capture window)', async () => {
    const chrome = [
      ...Array.from({ length: 88 }, (_, i) => `  □ task item ${i}`),
      '   … +2 completed', '  ? for shortcuts', '  Opus 4.8 | repo@dev | v2.1.201',
    ];
    const full = ["You've hit your session limit · resets 4:40pm (UTC)", ...chrome].join('\n');
    const sent: string[] = [];
    const s: ScreenAdapter = {
      capture: async (n) => full.split('\n').slice(-n).join('\n'),
      send: async (t) => { sent.push(t); },
      sendEscape: async () => {},
    };
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(sent.length, 0);
  });
  // A session awaiting a subagent is progressing; a stale banner above it must not
  // drive an injection — the waiting-branch busy gate returns user-continued instead.
  it('does NOT inject into a session running a background agent (waiting branch gate)', async () => {
    const s = mockScreen([
      "You've hit your session limit · resets 3pm (Europe/Zurich)", '',
      '● gsd:gsd-executor(Execute plan 24.1-10)', '',
      '✻ Waiting for 1 background agent to finish', '',
      '───────────────', '❯ ', '───────────────', '  Fable 5 | repo@dev | 5h 9% @20:00 | v2.1.202',
    ].join('\n'));
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting'; st.attempts = 1;
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s._sent.length, 0);
  });
  // isWorking and isRateLimited must measure the same bottom: a live working footer
  // pushed up by a chrome stack was invisible to the raw-tail isWorking while the
  // chrome-aware isRateLimited still saw a lingering banner → retry text into a
  // mid-flight session.
  it('does NOT re-send when Claude is working above a chrome stack (banner still lingering)', async () => {
    const s = mockScreen([
      "You've hit your session limit · resets 3pm (UTC)",
      '✻ Cogitating… (12s · esc to interrupt)',
      '  10 tasks (2 done, 1 in progress, 7 open)',
      '  □ a', '  □ b', '  □ c', '  □ d', '  □ e', '  □ f', '  □ g',
      '   … +2 completed', '  new task? /clear to save 300k tokens', '',
      '───────────────', '❯ ', '───────────────',
      '  Opus 4.8 | repo@dev | v2.1.201',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ].join('\n'));   // working footer sits >12 raw lines above the bottom
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting'; st.attempts = 1;
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s._sent.length, 0);
    assert.equal(st.status, 'monitoring');
  });
});

describe('processOneTick — current Claude Code renders', () => {
  it('does not enter a wait on the live usage gauge variants', async () => {
    for (const gauge of [
      "You've used 98% of your session limit · resets 8:40pm (Europe/Berlin)",
      'Over 85% of your session limit used · resets 3:45pm',
      'Approaching session limit · resets 3:45pm',
    ]) {
      const st = createMonitorState();
      assert.equal(await processOneTick(st, mockScreen(`● Done.\n\n${gauge}\n❯ `), DEFAULT_CONFIG, () => true), 'monitoring', gauge);
    }
  });
  it('does not enter a wait on prose or tool output saying "try again in N minutes"', async () => {
    const s = mockScreen('● The deploy script said: too many requests, try again in 5 minutes. I will wait.\n❯ ');
    assert.equal(await processOneTick(createMonitorState(), s, DEFAULT_CONFIG, () => true), 'monitoring');
  });
  it('routes an API error beside the usage gauge to the API-error path, not an hours-long wait', async () => {
    const screen = [
      '● API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.',
      '',
      "You've used 85% of your session limit · resets 3:45pm",
      '❯ ',
    ].join('\n');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, mockScreen(screen), DEFAULT_CONFIG, () => true), 'error-detected');
    assert.equal(st.status, 'overload');
  });
  it('detects the terminal "Repeated 529" render as an overload', async () => {
    const screen = '● API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment. If it persists, check https://status.claude.com.\n❯ ';
    const st = createMonitorState();
    assert.equal(await processOneTick(st, mockScreen(screen), DEFAULT_CONFIG, () => true), 'error-detected');
    assert.equal(st.status, 'overload');
  });
  it('still enters the wait on the current status-row banner', async () => {
    const st = createMonitorState();
    assert.equal(await processOneTick(st, mockScreen('Usage limit reached · limit resets 3:45pm\n❯ '), DEFAULT_CONFIG, () => true), 'waiting');
    assert.equal(st.lastRateLimitMessage, 'Usage limit reached · limit resets 3:45pm');
  });
});

describe("processOneTick — Claude Code's own auto-continue", () => {
  const ARMED = ['Usage limit reached · limit resets 3:45pm', 'Continuing automatically at 3:45pm · Esc to cancel', '❯ '].join('\n');

  it('holds the retry while native auto-continue is armed, then stands down when it fires', async () => {
    const s = mockScreen(ARMED);
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'native-armed');
    assert.equal(s._sent.length, 0);
    assert.equal(s._escaped, 0, 'Escape would cancel the native wait');
    assert.equal(st.attempts, 0);
    assert.equal(st.status, 'waiting');
    assert.ok(st.waitUntil > Date.now());
    s._content = 'Usage limit reset · Continuing automatically\n✻ Working… (3s · esc to interrupt)';
    st.waitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(st.status, 'monitoring');
  });
  it('retries once the native row is gone but the banner remains (cancelled or capped)', async () => {
    const s = mockScreen(['Usage limit reached · limit resets 3:45pm', 'Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again', '❯ '].join('\n'));
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'retried');
  });
  it('does not mistake the lingering transcript notice for an armed auto-continue', async () => {
    const s = mockScreen(['Usage limit reached · continuing automatically at 3:45pm · esc to cancel', '● some work', 'Usage limit reached · limit resets 9:00pm', '❯ '].join('\n'));
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'retried');
  });
});
