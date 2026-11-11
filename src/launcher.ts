import { spawn } from 'node:child_process';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { runMonitor } from './monitor.ts';
import type { ScreenAdapter } from './monitor.ts';
import { spawnPty, createTerminal, readScreen, findClaudeBinary } from './pty.ts';
import { checkForUpdate } from './update-check.ts';

// Gap between typing the retry text and the submitting Enter. Claude Code's Ink
// TUI treats text + Enter arriving in one burst as a PASTE (the Enter becomes a
// literal newline in the composer instead of "submit"), so splitting them with a
// short delay makes the Enter register as a real keypress.
const SUBMIT_DELAY_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Optional launch wrapper. Set CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER to a prefix command
// (e.g. "caffeinate -i" on macOS to keep the machine awake, or "nice") and it is
// prepended to the claude invocation: `<wrapper> <claudeBin> <args…>`. Unset/blank
// spawns claude directly (unchanged default).
export function resolveLaunchCommand(
  claudeBin: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; cmdArgs: string[] } {
  const wrapper = (env.CLAUDE_AUTO_RETRY_LAUNCH_WRAPPER || '').trim();
  if (!wrapper) return { cmd: claudeBin, cmdArgs: args };
  const toks = wrapper.split(/\s+/);
  return { cmd: toks[0], cmdArgs: [...toks.slice(1), claudeBin, ...args] };
}

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
    const { cmd, cmdArgs } = resolveLaunchCommand(claudeBin, args);
    child = await spawnPty(cmd, cmdArgs, {
      cols, rows,
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
    });
  } catch (err) {
    process.stderr.write(`[claude-auto-retry] Failed to start PTY: ${(err as Error).message}\n`);
    process.stderr.write('[claude-auto-retry] Falling back to a plain (unmonitored) claude session.\n');
    return runPlain(claudeBin, args);
  }

  // Checked while the session runs, printed after it: a line written now would land
  // in Claude's TUI.
  const updateAbort = new AbortController();
  const updateNotice = config.updateCheck ? checkForUpdate(updateAbort.signal) : Promise.resolve(null);

  // PTY output -> real terminal + headless emulator (for screen detection).
  child.onData((data) => {
    process.stdout.write(data);
    term.write(data);
  });

  // Real terminal input -> PTY, in raw mode so every keystroke (incl. Ctrl-C) passes
  // through to Claude untouched. Forward the raw Buffer: a multibyte codepoint or a
  // paste can be split across two 'data' events, and decoding each chunk alone would
  // emit U+FFFD. node-pty copies the bytes verbatim (its write type says string).
  const stdin = process.stdin;
  const wasRaw = !!stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
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
    try { stdin.setRawMode(wasRaw); } catch { /* TTY gone */ }
    stdin.pause();
    process.stdout.off('resize', onResize);
  };

  // Terminal close / kill: tear down the child PTY. Ctrl-C arrives as a 0x03 byte
  // through the raw TTY, so SIGINT is not trapped. Trapping overrides Node's
  // default-terminate, so guarantee exit: restore the terminal and arm an unref'd
  // fallback that force-kills if the signal is slow.
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
  for (const sig of ['SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) process.on(sig, () => onSignal(sig));

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
  // Logging is best-effort: an unwritable log directory must not take the session down.
  logger.info(`Monitor started (claude PID: ${child.pid})`).catch(() => {});

  return new Promise((resolve) => {
    child.onExit(async ({ exitCode, signal }) => {
      exited = true;
      stopMonitor();
      if (signalFallback) { clearTimeout(signalFallback); signalFallback = null; }
      restoreTerminal();
      logger.info('Claude exited. Monitor shutting down.').catch(() => {});
      updateAbort.abort();   // don't hold the exit for a check still in flight
      const notice = await updateNotice;
      if (notice) process.stderr.write(`${notice}\n`);
      resolve(toExitCode(exitCode, signal));
    });
  });
}

// Run claude directly with inherited stdio: no monitoring, but a working session.
// Used for --print mode, piped stdio, and when the PTY can't be created.
function runPlain(claudeBin: string, args: string[]): Promise<number> {
  const { cmd, cmdArgs } = resolveLaunchCommand(claudeBin, args);
  const claude = spawn(cmd, cmdArgs, {
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

// Main — only when executed directly (`node launcher.ts …`), never when imported
// for its exported helpers (tests). Set process.exitCode rather than calling
// process.exit(): exit() would tear down the event loop before buffered (non-TTY)
// writes flush, truncating output.
if (/[/\\]launcher\.(ts|js)$/.test(process.argv[1] ?? '')) {
  const args = process.argv.slice(2);
  // Monitoring needs a real terminal on both ends: --print mode has no screen to
  // type into, and piped stdio would only pick up the PTY's CRLF line endings.
  const interactive = process.stdin.isTTY && process.stdout.isTTY
    && !args.includes('-p') && !args.includes('--print');
  process.exitCode = interactive ? await launchInteractive(args) : await runPlain(findClaudeBinary(), args);
}
