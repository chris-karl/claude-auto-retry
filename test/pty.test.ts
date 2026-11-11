import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminal, writeToTerminal, readScreen } from '../src/pty.ts';

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
