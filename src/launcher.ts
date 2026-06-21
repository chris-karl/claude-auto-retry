import { spawn } from 'node:child_process';
import { isRateLimited } from './patterns.ts';
import { parseResetTime, calculateWaitMs } from './time-parser.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { runMonitor } from './monitor.ts';
import type { ScreenAdapter } from './monitor.ts';
import {
  spawnPty,
  createTerminal,
  readScreen,
  findClaudeBinary,
} from './pty.ts';

// Gap between typing the retry text and the submitting Enter. Claude Code's Ink
// TUI treats text + Enter arriving in one burst as a PASTE (the Enter becomes a
// literal newline in the composer instead of "submit"), so splitting them with a
// short delay makes the Enter register as a real keypress.
const SUBMIT_DELAY_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isPrintMode(args: string[]): boolean {
  return args.includes('-p') || args.includes('--print');
}

// Current terminal size, with sane fallbacks when stdout is not a TTY.
function termSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 30 };
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

// Map a child's {exitCode, signal} to a single conventional exit status: prefer a
// real non-zero code; if killed by a signal, use 128+signal (e.g. 130 for
// SIGINT); a clean exit stays 0, falling back to 1 only for an unrecognized
// signal with no exit code.
function toExitCode(code: number | null | undefined, signal: string | number | null | undefined): number {
  if (typeof code === 'number' && code !== 0) return code;
  const num = typeof signal === 'number' ? signal : signal ? SIGNAL_NUMBERS[signal] : undefined;
  if (num) return 128 + num;
  return code ?? (signal ? 1 : 0);
}

// Resolve buffered output to the underlying fd before the process exits. A bare
// process.stdout.write() to a pipe/file is async; exiting before it flushes
// truncates the tail. Awaiting the write callback makes the flush deterministic.
function writeFlush(stream: NodeJS.WritableStream, data: string): Promise<void> {
  return new Promise((resolve) => {
    if (!data) { resolve(); return; }
    stream.write(data, () => resolve());
  });
}

// Interactive mode: run Claude inside a PTY we own, mirror it to the real
// terminal, render its output into a headless emulator for detection, and let
// the monitor type the retry message straight into the PTY when needed.
async function launchInteractive(args: string[]): Promise<number> {
  const claudeBin = findClaudeBinary();
  const config = await loadConfig();
  const logger = createLogger();

  const { cols, rows } = termSize();

  let term, child;
  try {
    term = await createTerminal(cols, rows);
    child = await spawnPty(claudeBin, args, {
      cols, rows,
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
    });
  } catch (err) {
    process.stderr.write(`[claude-auto-retry] Failed to start PTY: ${(err as Error).message}\n`);
    process.stderr.write('[claude-auto-retry] Falling back to a plain (unmonitored) claude session.\n');
    return runPlain(claudeBin, args);
  }

  // PTY output -> real terminal + headless emulator (for screen detection).
  child.onData((data) => {
    process.stdout.write(data);
    term.write(data);
  });

  // Real terminal input -> PTY. Raw mode so keystrokes (incl. Ctrl-C) pass
  // through to Claude untouched.
  const stdin = process.stdin;
  const wasRaw = !!stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  // Forward the raw Buffer, not a per-chunk utf8 string: a multibyte codepoint
  // (or a paste) can be split across two 'data' events, and decoding each chunk
  // independently would emit U+FFFD for the partial bytes. node-pty copies the
  // bytes verbatim, keeping the mirror transparent (its write type says string,
  // but it accepts a Buffer at runtime).
  const onStdin = (d: Buffer): void => { try { child.write(d as unknown as string); } catch { /* PTY gone */ } };
  stdin.on('data', onStdin);

  // Keep PTY size in sync with the real terminal.
  const onResize = (): void => {
    const { cols: c, rows: r } = termSize();
    try { child.resize(c, r); } catch { /* PTY gone */ }
    try { term.resize(c, r); } catch { /* term gone */ }
  };
  process.stdout.on('resize', onResize);

  // Restore the real terminal and detach our listeners. Idempotent so the signal
  // handler and the onExit handler can both call it safely.
  let cleaned = false;
  const restoreTerminal = (): void => {
    if (cleaned) return;
    cleaned = true;
    stdin.off('data', onStdin);
    if (stdin.isTTY) { try { stdin.setRawMode(wasRaw); } catch { /* not a TTY */ } }
    stdin.pause();
    process.stdout.off('resize', onResize);
  };

  // Terminal close / kill: tear down the child PTY. In raw-TTY mode Ctrl-C
  // arrives as a 0x03 byte forwarded into the PTY, so we must NOT trap SIGINT
  // there. But when stdin is not a TTY (piped input) the terminal still raises
  // SIGINT to our process group, so we trap it to kill the child. Trapping
  // overrides Node's default-terminate, so we guarantee exit: restore the
  // terminal and arm an unref'd fallback that force-kills if the signal is slow.
  let signalFallback: ReturnType<typeof setTimeout> | null = null;
  const onSignal = (sig: NodeJS.Signals): void => {
    try { child.kill(sig); } catch { /* already dead */ }
    restoreTerminal();
    if (!signalFallback) {
      signalFallback = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
        process.exit(toExitCode(undefined, sig));
      }, 2000);
      signalFallback.unref();
    }
  };
  const signals: NodeJS.Signals[] = stdin.isTTY ? ['SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of signals) process.on(sig, () => onSignal(sig));

  let exited = false;
  const isAlive = (): boolean => !exited;

  const screen: ScreenAdapter = {
    capture: async (lines) => readScreen(term, lines),
    send: async (text) => {
      // Type the text and the submitting Enter as two writes (see SUBMIT_DELAY_MS)
      // so Claude's TUI doesn't mistake them for a paste.
      child.write(text);
      await sleep(SUBMIT_DELAY_MS);
      child.write('\r');
    },
    // Press Escape — dismisses Claude's interactive rate-limit menu before we
    // submit the retry (the menu's highlighted option varies, so a bare Enter
    // could confirm "Upgrade your plan").
    sendEscape: async () => { child.write('\x1b'); },
  };

  const stopMonitor = runMonitor(screen, config, logger, isAlive);
  await logger.info(`Monitor started (claude PID: ${child.pid})`);

  return new Promise((resolve) => {
    child.onExit(({ exitCode, signal }) => {
      exited = true;
      stopMonitor();
      if (signalFallback) { clearTimeout(signalFallback); signalFallback = null; }
      restoreTerminal();
      logger.info('Claude exited. Monitor shutting down.').catch(() => {});
      resolve(toExitCode(exitCode, signal));
    });
  });
}

// Last-resort fallback if the PTY can't be created: run claude directly with
// inherited stdio. No monitoring, but the user still gets a working session.
function runPlain(claudeBin: string, args: string[]): Promise<number> {
  const claude = spawn(claudeBin, args, {
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
    process.on(sig, () => { try { claude.kill(sig); } catch { /* already dead */ } });
  }
  return new Promise((resolve) => {
    claude.on('exit', (code, signal) => resolve(toExitCode(code, signal)));
    claude.on('error', (err) => {
      process.stderr.write(`[claude-auto-retry] Failed to start claude: ${err.message}\n`);
      resolve(1);
    });
  });
}

// --print mode: non-interactive. Buffer output, and if rate-limited, discard the
// partial output, wait, and re-run with the same args. No PTY needed.
async function launchPrintMode(args: string[]): Promise<number> {
  const claudeBin = findClaudeBinary();
  const config = await loadConfig();
  let retries = 0;

  for (;;) {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      const claude = spawn(claudeBin, args, {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
      });

      claude.stdout.on('data', (d) => chunks.push(d));
      claude.stderr.on('data', (d) => errChunks.push(d));
      claude.on('error', (err) => {
        resolve({ code: 1, stdout: '', stderr: err.message });
      });
      claude.on('exit', (code, signal) => {
        resolve({
          code: toExitCode(code, signal),
          stdout: Buffer.concat(chunks).toString(),
          stderr: Buffer.concat(errChunks).toString(),
        });
      });
    });

    const combined = result.stdout + result.stderr;

    if (!isRateLimited(combined, config.customPatterns)) {
      // Clean exit — write buffered output, flushing before we return so the tail
      // isn't truncated when stdout/stderr is a pipe or file.
      await writeFlush(process.stdout, result.stdout);
      await writeFlush(process.stderr, result.stderr);
      return result.code;
    }

    // Rate limited — discard buffer, wait and retry.
    retries++;
    if (retries > config.maxRetries) {
      process.stderr.write(`[claude-auto-retry] Max retries (${config.maxRetries}) reached.\n`);
      // Surface claude's own exit code where meaningful, but never report success
      // after giving up.
      return result.code || 1;
    }

    const parsed = parseResetTime(combined);
    const waitMs = calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);

    process.stderr.write(`[claude-auto-retry] Rate limited. Waiting ${Math.round(waitMs / 1000)}s before retry ${retries}/${config.maxRetries}...\n`);
    await sleep(waitMs);
  }
}

// Main. Set process.exitCode rather than calling process.exit(): exit() would
// tear down the event loop before buffered (non-TTY) writes flush. Letting the
// loop drain naturally exits with the right code without truncating output.
const args = process.argv.slice(2);

if (isPrintMode(args)) {
  process.exitCode = await launchPrintMode(args);
} else {
  process.exitCode = await launchInteractive(args);
}
