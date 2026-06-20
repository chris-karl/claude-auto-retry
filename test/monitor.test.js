import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorState, processOneTick } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function mockScreen(screenContent = '', { failSend = false } = {}) {
  const s = {
    _sent: [],
    capture: async () => screenContent,
    send: async (text) => {
      if (failSend) throw new Error('PTY destroyed');
      s._sent.push(text);
    },
  };
  return s;
}

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
    // Should stay in 'waiting' with a cooldown to let Claude process
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
    // Should stay in 'waiting' to avoid re-detection loop
    assert.equal(st.status, 'waiting');
    assert.ok(st.waitUntil > Date.now());
    assert.equal(s._sent.length, 0);
  });
  it('resets from max-retries when rate limit clears', async () => {
    const s = mockScreen('Claude is working normally');
    const st = createMonitorState();
    st.waitUntil = Date.now() - 1000; st.status = 'waiting'; st.attempts = 10;
    // Rate limit cleared → should detect user-continued before max-retries check
    assert.equal(await processOneTick(st, s, DEFAULT_CONFIG, () => true), 'user-continued');
    assert.equal(st.attempts, 0);
  });
});
