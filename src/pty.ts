// PTY host + headless terminal emulator (replaces the old tmux integration).
//
// Claude runs *inside* a pseudo-terminal we own (node-pty); its output is fed to
// a headless terminal emulator (@xterm/headless) which applies cursor moves,
// clears and redraws. Reading that rendered screen is far more reliable than
// scanning the raw byte stream for stale frames, and pty.write() gives a single
// place to inject the retry text.
//
// Both deps load lazily so `--print` mode and the CLI commands keep working even
// where the native node-pty binary is unavailable.

import type { Terminal } from '@xterm/headless';
import type { IPty } from 'node-pty';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// Fallback cap for readScreen() when no explicit line count is passed. The live
// monitor asks for a smaller window (CAPTURE_LINES in monitor.ts), so this only
// bounds ad-hoc/standalone readScreen() calls.
const DEFAULT_CAPTURE_LINES = 200;

// All three exec bits (0o111). node-pty's prebuilt spawn-helper ships 0o755; we
// only strictly need owner-exec, but restoring all three matches the original.
const EXEC_BITS = 0o111;

// Render the headless terminal's screen buffer to plain text: the last `maxLines`
// rows (viewport + recent scrollback), trailing whitespace trimmed per line.
export function readScreen(term: Terminal, maxLines: number = DEFAULT_CAPTURE_LINES): string {
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

// node-pty package root (the dir containing its package.json), or null.
function findNodePtyRoot(): string | null {
  try {
    // require.resolve('node-pty') -> <root>/lib/index.js (its package `main`).
    return dirname(dirname(require.resolve('node-pty')));
  } catch {
    return null; // not installed (e.g. --print mode on a stripped install)
  }
}

// Ensure node-pty's `spawn-helper` is executable.
//
// On Unix, node-pty launches a tiny `spawn-helper` binary to set up the
// controlling tty before exec'ing the target. If that file loses its exec bit —
// a recurring node-pty packaging hazard whenever node_modules is copied, zipped,
// or installed by a tool that drops permissions — the spawn fails with
// "posix_spawnp failed." and we silently degrade to an unmonitored session.
// Re-adding the bit keeps the wrapper a transparent, monitored mirror.
// Best-effort and idempotent.
export function ensureNativeHelperExecutable(root: string | null = findNodePtyRoot()): void {
  if (process.platform === 'win32') return; // conpty/winpty: no spawn-helper
  if (!root) return;
  // Mirror node-pty's own native-module search order (utils.loadNativeModule).
  const candidates = [
    join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(root, 'build', 'Release', 'spawn-helper'),
    join(root, 'build', 'Debug', 'spawn-helper'),
  ];
  for (const helper of candidates) {
    try {
      const { mode } = statSync(helper);
      if ((mode & EXEC_BITS) !== EXEC_BITS) chmodSync(helper, mode | EXEC_BITS);
    } catch { /* missing candidate or unwritable — best effort, keep going */ }
  }
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
  ensureNativeHelperExecutable();
  const { spawn } = await import('node-pty');
  return spawn(file, args, {
    name: 'xterm-256color',
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
    const out = execFileSync(which, ['claude'], { encoding: 'utf-8' })
      .split(/\r?\n/)[0]
      .trim();
    if (out) return out;
  } catch { /* not on PATH (e.g. installed only as a shell alias) — try known locations */ }
  for (const c of [join(homedir(), '.claude', 'local', 'claude'), join(homedir(), '.local', 'bin', 'claude')]) {
    if (existsSync(c)) return c;
  }
  return 'claude';
}
