// PTY host + headless terminal emulator.
//
// Claude runs *inside* a pseudo-terminal we own (node-pty); its output is fed to
// a headless terminal emulator (@xterm/headless) which applies cursor moves,
// clears and redraws. Reading that rendered screen is far more reliable than
// scanning the raw byte stream for stale frames, and pty.write() gives a single
// place to inject the retry text.
//
// Both deps load lazily so plain (unmonitored) runs and the CLI commands keep
// working even where the native node-pty binary is unavailable.

import type { Terminal } from '@xterm/headless';
import type { IPty } from 'node-pty';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Render the headless terminal's screen buffer to plain text: the last `maxLines`
// rows (viewport + recent scrollback), trailing whitespace trimmed per line.
export function readScreen(term: Terminal, maxLines: number): string {
  const buf = term.buffer.active;
  const total = buf.length;
  const lines: string[] = [];
  for (let i = 0; i < total; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  // The active buffer always spans the full viewport height, so a screen that
  // isn't full has blank rows below the cursor. Drop those trailing blanks before
  // taking the last `maxLines`, otherwise sparse content (e.g. a rate-limit
  // message near the top) gets sliced out of view.
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  const trimmed = lines.slice(0, end);
  return trimmed.slice(Math.max(0, trimmed.length - maxLines)).join('\n');
}

// Write data into the emulator and resolve once it has been parsed. For tests/
// standalone callers that must await parsing before reading; the live launcher
// deliberately uses fire-and-forget term.write().
export function writeToTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

// Create a headless xterm terminal sized to the given dimensions. The package is
// CJS/UMD: under Node's ESM interop the constructor lives on `default`, while its
// type declarations expose it as a named export — so try both.
export async function createTerminal(cols: number, rows: number): Promise<Terminal> {
  const mod = await import('@xterm/headless');
  const TerminalCtor = mod.Terminal ?? mod.default?.Terminal;
  if (!TerminalCtor) throw new Error('@xterm/headless: Terminal constructor not found');
  return new TerminalCtor({
    cols: cols || 80,
    rows: rows || 30,
    scrollback: 1000,
    allowProposedApi: true,
  });
}

interface SpawnPtyOptions {
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

// Spawn a command inside a real PTY. Thin wrapper around node-pty.
export async function spawnPty(
  file: string,
  args: string[],
  { cols, rows, env, cwd }: SpawnPtyOptions = {},
): Promise<IPty> {
  const { spawn } = await import('node-pty');
  return spawn(file, args, {
    // node-pty replaces TERM with `name`; pass the real one through so claude still
    // recognizes the hosting terminal (Ghostty, kitty, …).
    name: process.env.TERM || 'xterm-256color',
    cols: cols || 80,
    rows: rows || 30,
    cwd: cwd || process.cwd(),
    // node-pty types env as Record<string, string>; process.env values are
    // string | undefined, but node-pty handles missing values fine.
    env: (env || process.env) as Record<string, string>,
  });
}

// Resolve the absolute path to the `claude` binary (falls back to PATH).
export function findClaudeBinary(): string {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, ['claude'], { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
    if (out) return out;
  } catch { /* not on PATH (e.g. installed only as a shell alias) — try known locations */ }
  for (const c of [join(homedir(), '.claude', 'local', 'claude'), join(homedir(), '.local', 'bin', 'claude')]) {
    if (existsSync(c)) return c;
  }
  return 'claude';
}
