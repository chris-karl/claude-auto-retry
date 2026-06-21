import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, processOneTick } from '../src/monitor.ts';
import type { ScreenAdapter } from '../src/monitor.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

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

  it('ignores a stale banner that lingers while Claude is working', async () => {
    // Banner still on the rendered screen, but Claude is actively streaming.
    const s = mockScreen('hit your limit · resets 3pm (UTC)\n✻ Working… (8s · esc to interrupt)');
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'monitoring');
    assert.equal(st.status, 'monitoring');
  });
  it('treats Claude becoming busy mid-wait as a resume', async () => {
    const s = mockScreen('hit your limit · resets 3pm (UTC)\n✻ Working… (2s · esc to interrupt)');
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(s._sent.length, 0);
  });
  it('enters waiting when the interactive limit menu appears', async () => {
    const s = mockScreen(MENU);
    const st = createMonitorState();
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(st.waitUntil > Date.now());
  });
  it('dismisses the limit menu with Escape (not Enter) before submitting the retry', async () => {
    const s = mockScreen(MENU);
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(s._escaped, 1, 'should press Escape to dismiss the menu');
    assert.equal(s._sent.length, 1, 'should submit the retry message');
  });
  it('does not press Escape when there is no menu (plain banner)', async () => {
    const s = mockScreen('5-hour limit reached - resets 3pm (UTC)');
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting';
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'retried');
    assert.equal(s._escaped, 0);
  });
});
