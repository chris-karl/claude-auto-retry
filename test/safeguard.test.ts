import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectSafeguard, safeguardMatch } from '../src/patterns.ts';
import { loadConfig, DEFAULT_CONFIG, DEFAULT_SAFEGUARD } from '../src/config.ts';
import type { Config, SafeguardConfig } from '../src/config.ts';
import { createMonitorState, processOneTick } from '../src/monitor.ts';
import type { ScreenAdapter } from '../src/monitor.ts';

const PATS = DEFAULT_SAFEGUARD.patterns;

interface MockScreen extends ScreenAdapter {
  _sent: string[];
  _escaped: number;
}

function mockScreen(screenContent = '', { failSend = false }: { failSend?: boolean } = {}): MockScreen {
  const s: MockScreen = {
    _sent: [],
    _escaped: 0,
    capture: async () => screenContent,
    send: async (text: string) => {
      if (failSend) throw new Error('PTY destroyed');
      s._sent.push(text);
    },
    sendEscape: async () => { s._escaped++; },
  };
  return s;
}

function cfg(overrides: Partial<SafeguardConfig> = {}): Config {
  return { ...DEFAULT_CONFIG, safeguard: { ...DEFAULT_SAFEGUARD, ...overrides } };
}

// The real render, verbatim-ish.
const FLAG = [
  '❯ continue',
  '',
  "● API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). They may flag safe, normal content as well. Claude Code can't respond to this request with Fable 5.",
  '  Double press esc to edit your last message, or try a different model with /model.',
  '  Request ID: req_011Ccfhw8avogXF48ed42Xjt',
  '❯ ',
].join('\n');

describe('detectSafeguard', () => {
  it('matches the safeguards-flagged render', () => assert.equal(detectSafeguard(FLAG, PATS), true));
  it('matches the "can\'t respond to this request with" phrasing next to the API Error line', () =>
    assert.equal(detectSafeguard([
      "● API Error: Fable 5's safeguards flagged this message",
      "  (https://www.anthropic.com/legal/aup). Claude Code can't respond to this request with Fable 5.",
    ].join('\n'), PATS), true));
  it('matches a wrapped render (phrase on a different physical line than "API Error")', () =>
    assert.equal(detectSafeguard([
      '● API Error: Fable',
      "  5's safeguards flagged",
      '  this message (https://www.anthropic.com/legal/aup).',
    ].join('\n'), PATS), true));
  it('is case-insensitive', () =>
    assert.equal(detectSafeguard('API ERROR: SAFEGUARDS FLAGGED THIS MESSAGE', PATS), true));
  it('does NOT fire on the phrases without the API Error render nearby (anti false-positive anchor)', () => {
    // Regression (upstream): Claude ANSWERING a question about AUP flags must not
    // trigger a retry.
    assert.equal(detectSafeguard('see https://www.anthropic.com/legal/aup for the policy', PATS), false);
    assert.equal(detectSafeguard("Claude Code can't respond to this request with Opus 4.8.", PATS), false);
    assert.equal(detectSafeguard('they said safeguards flagged this message yesterday', PATS), false);
  });
  it('returns false for normal output', () => assert.equal(detectSafeguard('Here is the refactor you asked for.', PATS), false));
  it('returns false for empty patterns/text', () => {
    assert.equal(detectSafeguard(FLAG, []), false);
    assert.equal(detectSafeguard('', PATS), false);
  });
  it('does NOT fire on the phrase quoted far up in scrollback (tail-anchored)', () => {
    const screen = ['discussing safeguards flagged this message', ...Array(15).fill('● unrelated work'), '❯ '].join('\n');
    assert.equal(detectSafeguard(screen, PATS), false);
  });
  it('reports the matched pattern + line', () => {
    const m = safeguardMatch(FLAG, PATS);
    assert.ok(m && /safeguards flagged/.test(m.pattern));
    assert.ok(m.line.length <= 200);
  });
});

describe('safeguard config validation', () => {
  async function loadFrom(obj: unknown): Promise<Config> {
    const dir = await mkdtemp(join(tmpdir(), 'car-sg-'));
    const f = join(dir, 'config.json');
    await writeFile(f, JSON.stringify(obj));
    try { return await loadConfig(f); } finally { await rm(dir, { recursive: true, force: true }); }
  }
  it('is present on DEFAULT_CONFIG with a small retry cap', () => {
    assert.equal(DEFAULT_CONFIG.safeguard.enabled, true);
    assert.equal(DEFAULT_CONFIG.safeguard.maxRetries, 3);
    assert.ok(DEFAULT_CONFIG.safeguard.patterns.includes('safeguards flagged this message'));
  });
  it('merges a partial block onto defaults', async () => {
    const c = await loadFrom({ safeguard: { maxRetries: 1 } });
    assert.equal(c.safeguard.maxRetries, 1);
    assert.deepEqual(c.safeguard.patterns, DEFAULT_SAFEGUARD.patterns);
  });
  it('falls back on bad values', async () => {
    const c = await loadFrom({ safeguard: { maxRetries: -1, retryDelaySeconds: 0, patterns: [42] } });
    assert.equal(c.safeguard.maxRetries, DEFAULT_SAFEGUARD.maxRetries);
    assert.equal(c.safeguard.retryDelaySeconds, DEFAULT_SAFEGUARD.retryDelaySeconds);
    assert.deepEqual(c.safeguard.patterns, DEFAULT_SAFEGUARD.patterns);
  });
});

const near = (actual: number, expectedMs: number): boolean => Math.abs(actual - expectedMs) < 2000;

describe('processOneTick — safeguard path', () => {
  it('enters the safeguard wait on detection (no send yet)', async () => {
    const s = mockScreen(FLAG);
    const st = createMonitorState();
    const r = await processOneTick(st, s, cfg(), () => true);
    assert.equal(r, 'safeguard-detected');
    assert.equal(st.status, 'safeguard');
    assert.equal(s._sent.length, 0);
    assert.ok(near(st.safeguardWaitUntil - Date.now(), DEFAULT_SAFEGUARD.retryDelaySeconds * 1000));
  });

  it('sends the retry once the delay elapses', async () => {
    const s = mockScreen(FLAG);
    const st = createMonitorState();
    st.status = 'safeguard'; st.safeguardWaitUntil = Date.now() - 1;
    const r = await processOneTick(st, s, cfg(), () => true);
    assert.equal(r, 'safeguard-retried');
    assert.equal(s._sent[0], 'continue');
    assert.equal(st.safeguardAttempts, 1);
  });

  it('still consumes the slot when the retry send throws', async () => {
    const s = mockScreen(FLAG, { failSend: true });
    const st = createMonitorState();
    st.status = 'safeguard'; st.safeguardWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, s, cfg(), () => true), 'safeguard-retry-failed');
    assert.equal(st.safeguardAttempts, 1);           // attempt consumed despite failure
    assert.ok(st.safeguardWaitUntil > Date.now());   // next window scheduled, no tight loop
  });

  it('is BOUNDED — gives up after maxRetries instead of looping', async () => {
    const s = mockScreen(FLAG);
    const st = createMonitorState();
    const c = cfg({ maxRetries: 2, retryDelaySeconds: 1 });
    // detect
    await processOneTick(st, s, c, () => true);
    // two retries
    for (let i = 0; i < 2; i++) { st.safeguardWaitUntil = Date.now() - 1; await processOneTick(st, s, c, () => true); }
    assert.equal(st.safeguardAttempts, 2);
    assert.equal(s._sent.length, 2);
    // third pass → give up, no further send
    st.safeguardWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, s, c, () => true), 'safeguard-gave-up');
    assert.equal(s._sent.length, 2);
  });

  it('clears back to monitoring when the flag is gone', async () => {
    const s = mockScreen('All good — here is your answer.');
    const st = createMonitorState();
    st.status = 'safeguard'; st.safeguardWaitUntil = Date.now() - 1; st.safeguardAttempts = 1;
    assert.equal(await processOneTick(st, s, cfg(), () => true), 'safeguard-cleared');
    assert.equal(st.status, 'monitoring');
    assert.equal(st.safeguardAttempts, 0);
  });

  it('defers while Claude is working — WITHOUT resetting the attempt counter', async () => {
    // Regression (upstream #33): a tick landing while the retried request is in flight
    // used to reset safeguardAttempts to 0 via the clear path, so a sticky flag
    // re-entered with a fresh budget every cycle and the maxRetries bound never
    // tripped. Mirror the overload branch: defer without consuming or resetting.
    const s = mockScreen(FLAG + '\n✻ Thinking… (esc to interrupt)');
    const st = createMonitorState();
    st.status = 'safeguard'; st.safeguardWaitUntil = Date.now() - 1; st.safeguardAttempts = 2;
    assert.equal(await processOneTick(st, s, cfg(), () => true), 'safeguard-working');
    assert.equal(st.safeguardAttempts, 2);   // NOT reset
    assert.equal(st.status, 'safeguard');    // still owns the flag
    assert.equal(s._sent.length, 0);
  });

  it('stays BOUNDED even when working ticks interleave between retries (sticky flag)', async () => {
    const c = cfg({ maxRetries: 2, retryDelaySeconds: 1 });
    const flagged = mockScreen(FLAG);
    const st = createMonitorState();
    await processOneTick(st, flagged, c, () => true);            // detect
    let sent = 0;
    for (let i = 0; i < 10; i++) {
      // alternate: retry tick at idle-with-flag, then a mid-flight (working) tick
      st.safeguardWaitUntil = Date.now() - 1;
      const idle = mockScreen(FLAG);
      const r1 = await processOneTick(st, idle, c, () => true);
      sent += idle._sent.length;
      st.safeguardWaitUntil = Date.now() - 1;
      const working = mockScreen(FLAG + '\n✻ Thinking… (esc to interrupt)');
      await processOneTick(st, working, c, () => true);
      sent += working._sent.length;
      if (r1 === 'safeguard-gave-up' || r1 === 'safeguard-holding') break;
    }
    assert.equal(sent, 2);                  // exactly maxRetries sends, ever
    assert.equal(st.safeguardAttempts, 2);
  });

  it('gives up loudly ONCE, then holds quietly', async () => {
    const c = cfg({ maxRetries: 1 });
    const s = mockScreen(FLAG);
    const st = createMonitorState();
    st.status = 'safeguard'; st.safeguardWaitUntil = Date.now() - 1; st.safeguardAttempts = 1;
    assert.equal(await processOneTick(st, s, c, () => true), 'safeguard-gave-up');
    st.safeguardWaitUntil = Date.now() - 1;
    assert.equal(await processOneTick(st, s, c, () => true), 'safeguard-holding');
    assert.equal(s._sent.length, 0);
  });

  it('does not inject into a healthy session whose reply mentions the AUP link at an idle prompt', async () => {
    // Regression (upstream): unanchored patterns fired on Claude ANSWERING a question
    // about AUP flags.
    const screen = [
      '● The safeguard error you saw means the model flagged the message. See',
      '  https://www.anthropic.com/legal/aup for the policy. It can be a false positive.',
      '',
      '❯ ',
    ].join('\n');
    const s = mockScreen(screen);
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg(), () => true), 'monitoring');
    assert.equal(s._sent.length, 0);
  });

  it('usage-limit takes precedence over a co-present safeguard flag', async () => {
    const s = mockScreen(FLAG + "\nYou've hit your session limit · resets 3pm (UTC)");
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg(), () => true), 'waiting');
    assert.equal(st.status, 'waiting');
  });

  it('hands off to the usage path if a limit appears mid-safeguard', async () => {
    const s = mockScreen("You've hit your session limit · resets 3pm (UTC)");
    const st = createMonitorState();
    st.status = 'safeguard'; st.safeguardWaitUntil = Date.now() - 1; st.safeguardAttempts = 1;
    assert.equal(await processOneTick(st, s, cfg(), () => true), 'waiting');
    assert.equal(st.status, 'waiting');
    assert.equal(st.safeguardAttempts, 0);
  });

  it('does not enter safeguard while Claude is working', async () => {
    const s = mockScreen(FLAG + '\n· Cooking… (esc to interrupt)');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg(), () => true), 'monitoring');
  });

  it('disabled safeguard block is ignored', async () => {
    const s = mockScreen(FLAG);
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, cfg({ enabled: false }), () => true), 'monitoring');
    assert.equal(s._sent.length, 0);
  });
});
