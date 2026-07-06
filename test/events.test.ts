import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isRetryableError, writeStopFailureEvent, readStopFailureEvent, clearStopFailureEvent,
} from '../src/events.ts';

describe('isRetryableError', () => {
  it('accepts the transient-overload classes', () => {
    for (const e of ['overloaded', 'server_error', 'OVERLOADED']) {
      assert.equal(isRetryableError(e), true, e);
    }
  });
  it('rejects rate_limit (a session/usage limit is an hours-scale wait, not an overload)', () => {
    // Regression (upstream #31): routing rate_limit through the event/overload path made
    // the monitor fire futile seconds-scale "Continue" retries into a session-limited
    // screen and fight the usage-wait path. Session limits are owned by the usage path.
    assert.equal(isRetryableError('rate_limit'), false);
  });
  it('rejects permanent / unknown classes', () => {
    for (const e of ['authentication_failed', 'billing_error', 'invalid_request', '', undefined, null, 42]) {
      assert.equal(isRetryableError(e), false, String(e));
    }
  });
});

describe('StopFailure event markers', () => {
  let dir: string;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'car-ev-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('round-trips a session-keyed marker', async () => {
    await writeStopFailureEvent('12345', { error: 'overloaded', session_id: 'abc' }, dir);
    const ev = await readStopFailureEvent('12345', 60_000, dir);
    assert.ok(ev);
    assert.equal(ev.error, 'overloaded');
    assert.equal(ev.session, '12345');
    assert.equal(ev.session_id, 'abc');
    assert.equal(typeof ev.ts, 'number');
  });

  it('sanitizes an unsafe key into the filename', async () => {
    await writeStopFailureEvent('%7', { error: 'server_error' }, dir);
    const files = await readdir(dir);
    assert.ok(files.includes('_7.json'), files.join(','));
  });

  it('returns null for an absent marker', async () => {
    assert.equal(await readStopFailureEvent('99999', 60_000, dir), null);
  });

  it('treats a marker past maxAge as stale', async () => {
    await writeStopFailureEvent('30003', { error: 'overloaded' }, dir);
    assert.equal(await readStopFailureEvent('30003', -1, dir), null);  // negative age → always stale
  });

  it('ignores an unparseable marker file', async () => {
    await writeFile(join(dir, '40004.json'), 'not json');
    assert.equal(await readStopFailureEvent('40004', 60_000, dir), null);
  });

  it('clear() consumes the marker', async () => {
    await writeStopFailureEvent('50005', { error: 'rate_limit' }, dir);
    await clearStopFailureEvent('50005', dir);
    assert.equal(await readStopFailureEvent('50005', 60_000, dir), null);
  });

  it('write is a no-op without a session key', async () => {
    assert.equal(await writeStopFailureEvent('', { error: 'overloaded' }, dir), null);
  });
});
