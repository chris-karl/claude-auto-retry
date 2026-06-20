// PTY host + headless terminal emulator.
//
// This replaces the old tmux integration. Instead of asking an external
// multiplexer to `capture-pane` / `send-keys`, we run Claude *inside* a
// pseudo-terminal we own (node-pty) and render its output into a headless
// terminal emulator (@xterm/headless). That gives us:
//   - the real, post-render screen contents (cursor moves, clears, redraws
//     are all applied) — exactly what tmux capture-pane used to return, and
//     far more reliable than scanning the raw byte stream for stale frames.
//   - a single place to inject the retry text via pty.write().
//
// Both deps are loaded lazily so that `--print` mode and the CLI commands
// keep working even on a platform where the native node-pty binary is
// unavailable.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// Fallback cap for readScreen() when no explicit line count is passed. The live
// monitor asks for a much smaller window (see DETECTION_LINES in monitor.js) so
// detection reflects the *current* screen rather than deep scrollback; this
// default only bounds ad-hoc/standalone readScreen() calls.
export const DEFAULT_CAPTURE_LINES = 200;

// All three exec bits (0o111). node-pty's prebuilt spawn-helper ships as
// 0o755; we only strictly need owner-exec, but restoring all three matches the
// original and is harmless.
const EXEC_BITS = 0o111;

/**
 * Render the headless terminal's screen buffer to plain text.
 * Returns the last `maxLines` rows (viewport + recent scrollback), with
 * trailing whitespace trimmed per line — the same shape tmux capture-pane
 * produced, so the detection logic in patterns.js is unchanged.
 */
export function readScreen(term, maxLines = DEFAULT_CAPTURE_LINES) {
  const buf = term.buffer.active;
  const total = buf.length;
  const lines = [];
  for (let i = 0; i < total; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  // The active buffer always spans the full viewport height, so a screen that
  // isn't full has blank rows below the cursor. Drop those trailing blanks
  // before taking the last `maxLines`, otherwise sparse content (e.g. a
  // rate-limit message a few rows from the top) gets sliced out of view.
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  const trimmed = lines.slice(0, end);
  return trimmed.slice(Math.max(0, trimmed.length - maxLines)).join('\n');
}

/**
 * Write data into the emulator and resolve once it has been parsed. Intended
 * for tests/standalone callers that need to await xterm parsing before reading
 * the screen; the live launcher deliberately uses fire-and-forget term.write().
 */
export function writeToTerminal(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

/** Create a headless xterm terminal sized to the given dimensions. */
export async function createTerminal(cols, rows) {
  const mod = await import('@xterm/headless');
  const Terminal = mod.Terminal || mod.default?.Terminal;
  return new Terminal({
    cols: cols || 80,
    rows: rows || 30,
    scrollback: 1000,
    allowProposedApi: true,
  });
}

/** node-pty package root (the dir containing its package.json), or null. */
function findNodePtyRoot() {
  try {
    // require.resolve('node-pty') -> <root>/lib/index.js (its package `main`).
    return dirname(dirname(require.resolve('node-pty')));
  } catch {
    return null; // not installed (e.g. --print mode on a stripped install)
  }
}

/**
 * Ensure node-pty's `spawn-helper` is executable.
 *
 * On Unix, node-pty (>=1.x) launches a tiny `spawn-helper` binary to set up the
 * controlling tty before exec'ing the target. If that file has lost its exec
 * bit — a recurring node-pty packaging hazard whenever node_modules is copied,
 * zipped, or installed by a tool that drops permissions — node-pty's native
 * posix_spawn of it fails with "posix_spawnp failed." and we silently degrade
 * to an unmonitored session. Re-adding the bit before spawning keeps the
 * wrapper a transparent, *monitored* mirror. Best-effort and idempotent.
 *
 * @param {string} [root] node-pty package root; resolved automatically if omitted.
 */
export function ensureNativeHelperExecutable(root = findNodePtyRoot()) {
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

/** Spawn a command inside a real PTY. Thin wrapper around node-pty. */
export async function spawnPty(file, args, { cols, rows, env, cwd } = {}) {
  ensureNativeHelperExecutable();
  const mod = await import('node-pty');
  const pty = mod.default || mod;
  return pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 30,
    cwd: cwd || process.cwd(),
    env: env || process.env,
  });
}

/** Resolve the absolute path to the `claude` binary (falls back to PATH). */
export function findClaudeBinary() {
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
