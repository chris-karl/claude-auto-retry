import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.ts';
import { loadFromRaw } from './helpers.ts';

describe('DEFAULT_CONFIG', () => {
  it('has expected defaults', () => {
    assert.equal(DEFAULT_CONFIG.maxRetries, 5);
    assert.equal(DEFAULT_CONFIG.pollIntervalSeconds, 5);
    assert.equal(DEFAULT_CONFIG.marginSeconds, 60);
    assert.equal(DEFAULT_CONFIG.fallbackWaitHours, 5);
    assert.equal(DEFAULT_CONFIG.retryCooldownSeconds, 30);
    assert.equal(typeof DEFAULT_CONFIG.retryMessage, 'string');
    assert.deepEqual(DEFAULT_CONFIG.customPatterns, []);
    assert.equal(DEFAULT_CONFIG.updateCheck, true);
  });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const config = await loadConfig('/nonexistent/path/.claude-auto-retry.json');
    assert.deepEqual(config, DEFAULT_CONFIG);
  });
  it('merges partial config with defaults', async () => {
    const config = await loadFromRaw(JSON.stringify({ maxRetries: 10 }));
    assert.equal(config.maxRetries, 10);
    assert.equal(config.pollIntervalSeconds, 5);
  });
  it('returns defaults for invalid JSON or a non-object payload', async () => {
    assert.deepEqual(await loadFromRaw('not json{{{'), DEFAULT_CONFIG);
    assert.deepEqual(await loadFromRaw('42'), DEFAULT_CONFIG);
  });
  it('rejects string values and falls back to defaults', async () => {
    const config = await loadFromRaw(JSON.stringify({ maxRetries: "never", pollIntervalSeconds: "fast" }));
    assert.equal(config.maxRetries, 5);
    assert.equal(config.pollIntervalSeconds, 5);
  });
  it('filters invalid customPatterns entries', async () => {
    // "" compiles as a regex but matches every line, so it is dropped like the
    // non-strings and the uncompilable "[invalid".
    const config = await loadFromRaw(JSON.stringify({ customPatterns: ["valid", 42, null, "", "[invalid"] }));
    assert.deepEqual(config.customPatterns, ["valid"]);
  });
  it('honors updateCheck only as a boolean', async () => {
    assert.equal((await loadFromRaw(JSON.stringify({ updateCheck: false }))).updateCheck, false);
    assert.equal((await loadFromRaw(JSON.stringify({ updateCheck: 'no' }))).updateCheck, true);
  });
  it('rejects negative numbers and falls back to defaults', async () => {
    const config = await loadFromRaw(JSON.stringify({ maxRetries: -1, marginSeconds: -10 }));
    assert.equal(config.maxRetries, 5);
    assert.equal(config.marginSeconds, 60);
  });
  it('honors a valid retryCooldownSeconds and rejects an invalid one', async () => {
    assert.equal((await loadFromRaw(JSON.stringify({ retryCooldownSeconds: 90 }))).retryCooldownSeconds, 90);
    assert.equal((await loadFromRaw(JSON.stringify({ retryCooldownSeconds: 0 }))).retryCooldownSeconds, 30); // < 1 → default
  });
});
