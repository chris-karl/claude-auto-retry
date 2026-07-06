import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.ts';
import type { Config } from '../src/config.ts';

async function loadFromRaw(raw: string): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), 'car-cfg-'));
  const f = join(dir, 'config.json');
  await writeFile(f, raw);
  try { return await loadConfig(f); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('DEFAULT_CONFIG', () => {
  it('has expected defaults', () => {
    assert.equal(DEFAULT_CONFIG.maxRetries, 5);
    assert.equal(DEFAULT_CONFIG.pollIntervalSeconds, 5);
    assert.equal(DEFAULT_CONFIG.marginSeconds, 60);
    assert.equal(DEFAULT_CONFIG.fallbackWaitHours, 5);
    assert.equal(DEFAULT_CONFIG.retryCooldownSeconds, 30);
    assert.equal(typeof DEFAULT_CONFIG.retryMessage, 'string');
    assert.deepEqual(DEFAULT_CONFIG.customPatterns, []);
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
  it('returns defaults for invalid JSON', async () => {
    const config = await loadFromRaw('not json{{{');
    assert.deepEqual(config, DEFAULT_CONFIG);
  });
  it('rejects string values and falls back to defaults', async () => {
    const config = await loadFromRaw(JSON.stringify({ maxRetries: "never", pollIntervalSeconds: "fast" }));
    assert.equal(config.maxRetries, 5);
    assert.equal(config.pollIntervalSeconds, 5);
  });
  it('filters invalid customPatterns entries', async () => {
    const config = await loadFromRaw(JSON.stringify({ customPatterns: ["valid", 42, null, "[invalid"] }));
    assert.deepEqual(config.customPatterns, ["valid"]);
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
