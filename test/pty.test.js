import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTerminal,
  writeToTerminal,
  readScreen,
  ensureNativeHelperExecutable,
} from '../src/pty.js';

describe('readScreen', () => {
  it('renders written lines as plain text', async () => {
    const term = await createTerminal(80, 24);
    await writeToTerminal(term, 'hello\r\n');
    await writeToTerminal(term, '5-hour limit reached - resets 3pm (UTC)\r\n');
    const screen = readScreen(term, 200);
    assert.ok(screen.includes('hello'));
    assert.ok(screen.includes('5-hour limit reached - resets 3pm (UTC)'));
  });

  it('reflects redraws, not stale frames (the reason for the emulator)', async () => {
    const term = await createTerminal(80, 24);
    // Print a fake rate-limit, then clear the screen and redraw fresh output —
    // a raw byte buffer would still contain the stale message; the emulator
    // must not.
    await writeToTerminal(term, 'You\'ve hit your limit · resets 3pm (UTC)\r\n');
    await writeToTerminal(term, '\x1b[2J\x1b[H'); // clear screen + home cursor
    await writeToTerminal(term, 'Working on your task...\r\n');
    const screen = readScreen(term, 200);
    assert.ok(screen.includes('Working on your task'));
    assert.ok(!screen.includes('hit your limit'));
  });

  it('returns only the last maxLines rows', async () => {
    const term = await createTerminal(80, 24);
    for (let i = 0; i < 50; i++) await writeToTerminal(term, `line-${i}\r\n`);
    const screen = readScreen(term, 5);
    const rows = screen.split('\n');
    assert.ok(rows.length <= 5);
    assert.ok(screen.includes('line-49'));
    assert.ok(!screen.includes('line-10'));
  });
});

describe('ensureNativeHelperExecutable', () => {
  const unix = { skip: process.platform === 'win32' };

  // Build a throwaway node-pty layout: <root>/<dir>/spawn-helper at `mode`.
  function fakePty(dir, mode) {
    const root = mkdtempSync(join(tmpdir(), 'car-pty-'));
    const helperDir = join(root, dir);
    mkdirSync(helperDir, { recursive: true });
    const helper = join(helperDir, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\n');
    chmodSync(helper, mode);
    return { root, helper };
  }

  it('restores the exec bit on a non-executable prebuilt spawn-helper', unix, () => {
    const { root, helper } = fakePty(`prebuilds/${process.platform}-${process.arch}`, 0o644);
    try {
      ensureNativeHelperExecutable(root);
      assert.equal(statSync(helper).mode & 0o111, 0o111, 'all exec bits restored');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('also covers a build/Release spawn-helper', unix, () => {
    const { root, helper } = fakePty('build/Release', 0o600);
    try {
      ensureNativeHelperExecutable(root);
      assert.ok(statSync(helper).mode & 0o100, 'owner exec bit set');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves an already-executable helper untouched (idempotent)', unix, () => {
    const { root, helper } = fakePty(`prebuilds/${process.platform}-${process.arch}`, 0o755);
    try {
      ensureNativeHelperExecutable(root);
      assert.equal(statSync(helper).mode & 0o777, 0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not throw when the root has no spawn-helper', () => {
    const root = mkdtempSync(join(tmpdir(), 'car-pty-'));
    try {
      assert.doesNotThrow(() => ensureNativeHelperExecutable(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
