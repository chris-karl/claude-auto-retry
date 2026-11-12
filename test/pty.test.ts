import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTerminal,
  writeToTerminal,
  readScreen,
  ensureSpawnHelperExecutable,
  spawnPty,
} from '../src/pty.ts';

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
    // Print a fake rate-limit, then clear the screen and redraw fresh output — a
    // raw byte buffer would still contain the stale message; the emulator must not.
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

describe('ensureSpawnHelperExecutable', () => {
  it('restores the exec bits on the prebuilt spawn-helper', { skip: process.platform === 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'car-pty-'));
    try {
      const dir = join(root, 'prebuilds', `${process.platform}-${process.arch}`);
      mkdirSync(dir, { recursive: true });
      const helper = join(dir, 'spawn-helper');
      writeFileSync(helper, '');
      chmodSync(helper, 0o644);
      ensureSpawnHelperExecutable(root);
      assert.equal(statSync(helper).mode & 0o777, 0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Only macOS loads node-pty's prebuilt binary without the install scripts CI skips.
describe('spawnPty', { skip: process.platform !== 'darwin' }, () => {
  it('runs a command through the installed node-pty', async () => {
    const child = await spawnPty('/bin/echo', ['pty-ok']);
    let out = '';
    child.onData((d) => { out += d; });
    const { exitCode } = await new Promise<{ exitCode: number }>((r) => child.onExit(r));
    assert.equal(exitCode, 0);
    assert.match(out, /pty-ok/);
  });
});
