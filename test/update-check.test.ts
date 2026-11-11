import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate, isNewer } from '../src/update-check.ts';

const DAY = 24 * 3600_000;
const T0 = 20_000 * DAY;
const signal = new AbortController().signal;

async function withStateFile(fn: (statePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'car-upd-'));
  // Nested, so the check has to create the directory itself.
  try { await fn(join(dir, 'state', 'update-check.json')); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('isNewer', () => {
  it('compares the parts numerically', () => {
    assert.equal(isNewer('2026.11.1', '2026.11.0'), true);
    assert.equal(isNewer('2026.12.0', '2026.11.9'), true);
    assert.equal(isNewer('2026.11.10', '2026.11.9'), true);
    assert.equal(isNewer('2027.1.0', '2026.12.3'), true);
    assert.equal(isNewer('2026.11.0', '2026.11.0'), false);
    assert.equal(isNewer('2026.11.0', '2026.11.1'), false);
  });
  it('is false for anything that is not a plain version', () => {
    assert.equal(isNewer('', '2026.11.0'), false);
    assert.equal(isNewer('latest', '2026.11.0'), false);
    assert.equal(isNewer('2026.11.1', 'unknown'), false);
  });
});

describe('checkForUpdate', () => {
  it('reports a newer release and caches it', () => withStateFile(async (statePath) => {
    const notice = await checkForUpdate(signal, { statePath, current: '2026.11.0', now: T0, fetchLatest: async () => '2026.11.1' });
    assert.match(notice ?? '', /Version 2026\.11\.1 is available \(installed: 2026\.11\.0\)/);
    assert.match(notice ?? '', /npm i -g /);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf-8')), { checkedAt: T0, latest: '2026.11.1' });
  }));

  it('stays quiet when the installed version is current or ahead', () => withStateFile(async (statePath) => {
    const fetchLatest = async () => '2026.11.1';
    assert.equal(await checkForUpdate(signal, { statePath, current: '2026.11.1', now: T0, fetchLatest }), null);
    assert.equal(await checkForUpdate(signal, { statePath, current: '2026.12.0', now: T0 + DAY, fetchLatest }), null);
  }));

  it('answers from the cache within a day, then asks again', () => withStateFile(async (statePath) => {
    let calls = 0;
    const fetchLatest = async () => { calls++; return calls === 1 ? '2026.11.1' : '2026.11.2'; };
    const opts = { statePath, current: '2026.11.0', fetchLatest };
    await checkForUpdate(signal, { ...opts, now: T0 });
    assert.match(await checkForUpdate(signal, { ...opts, now: T0 + DAY - 1 }) ?? '', /2026\.11\.1 is available/);
    assert.equal(calls, 1);
    assert.match(await checkForUpdate(signal, { ...opts, now: T0 + DAY }) ?? '', /2026\.11\.2 is available/);
    assert.equal(calls, 2);
  }));

  it('falls back to the cache when the check fails, and retries next time', () => withStateFile(async (statePath) => {
    const opts = { statePath, current: '2026.11.0' };
    const failing = async () => { throw new Error('offline'); };
    assert.equal(await checkForUpdate(signal, { ...opts, now: T0, fetchLatest: failing }), null);
    await checkForUpdate(signal, { ...opts, now: T0 + 5, fetchLatest: async () => '2026.11.1' });
    assert.match(await checkForUpdate(signal, { ...opts, now: T0 + 5 + DAY, fetchLatest: failing }) ?? '', /2026\.11\.1 is available/);
    assert.equal(JSON.parse(await readFile(statePath, 'utf-8')).checkedAt, T0 + 5);
  }));

  it('ignores an unparsable answer and a corrupt state file', () => withStateFile(async (statePath) => {
    const opts = { statePath, current: '2026.11.0', now: T0 };
    assert.equal(await checkForUpdate(signal, { ...opts, fetchLatest: async () => null }), null);
    for (const corrupt of ['not json', 'null', '{"checkedAt":"soon","latest":5}']) {
      await writeFile(statePath, corrupt).catch(() => {});
      assert.equal(await checkForUpdate(signal, { ...opts, fetchLatest: async () => null }), null);
    }
  }));
});
