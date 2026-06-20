import { spawn } from 'node:child_process';
import { isRateLimited } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { runMonitor } from './monitor.js';
import {
  spawnPty,
  createTerminal,
  readScreen,
  findClaudeBinary,
} from './pty.js';

function isPrintMode(args) {
  return args.includes('-p') || args.includes('--print');
}

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

// Map a child's {exitCode, signal} to a single conventional exit status, used
// uniformly by every launch path: prefer a real non-zero code; if the child was
// killed by a signal, use 128+signal (e.g. 130 for SIGINT); otherwise a clean
// exit stays 0, falling back to 1 only for the residual case of an unrecognized
// signal with no exit code.
function toExitCode(code, signal) {
  if (typeof code === 'number' && code !== 0) return code;
  const num = typeof signal === 'number' ? signal : SIGNAL_NUMBERS[signal];
  if (num) return 128 + num;
  return code ?? (signal ? 1 : 0);
}

// Resolve buffered output to the underlying fd before the process exits. A bare
// process.stdout.write() to a pipe/file is async; exiting before it flushes
// truncates the tail. The write callback fires once the data has been handed to
// the OS, so awaiting it makes the flush deterministic.
function writeFlush(stream, data) {
  return new Promise((resolve) => {
    if (!data) { resolve(); return; }
    stream.write(data, resolve);
  });
}

// Interactive mode: run Claude inside a PTY we own, mirror it to the real
// terminal, render its output into a headless emulator for detection, and let
// the monitor type the retry message straight into the PTY when needed.
async function launchInteractive(args) {
  const claudeBin = findClaudeBinary();
  const config = await loadConfig();
  const logger = createLogger();

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;

  let term, child;
  try {
    term = await createTerminal(cols, rows);
    child = await spawnPty(claudeBin, args, {
      cols, rows,
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
    });
  } catch (err) {
    process.stderr.write(`[claude-auto-retry] Failed to start PTY: ${err.message}\n`);
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
  // independently would emit U+FFFD for the partial bytes. node-pty.write takes
  // a Buffer and copies it byte-for-byte, keeping the mirror truly transparent.
  const onStdin = (d) => { try { child.write(d); } catch {} };
  stdin.on('data', onStdin);

  // Keep PTY size in sync with the real terminal.
  const onResize = () => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows || 30;
    try { child.resize(c, r); } catch {}
    try { term.resize(c, r); } catch {}
  };
  process.stdout.on('resize', onResize);

  // Restore the real terminal and detach our listeners. Idempotent so the
  // signal handler and the onExit handler can both call it safely.
  let cleaned = false;
  const restoreTerminal = () => {
    if (cleaned) return;
    cleaned = true;
    stdin.off('data', onStdin);
    if (stdin.isTTY) { try { stdin.setRawMode(wasRaw); } catch {} }
    stdin.pause();
    process.stdout.off('resize', onResize);
  };

  // Terminal close / kill: tear down the child PTY. In raw-TTY mode Ctrl-C
  // arrives as a 0x03 byte forwarded into the PTY above, so we must NOT trap
  // SIGINT there (it would break pass-through). But when stdin is not a TTY
  // (e.g. piped input) the terminal still raises SIGINT to our process group,
  // so we trap it to kill the child instead of orphaning it. Trapping a signal
  // overrides Node's default-terminate, so we must guarantee we still exit:
  // restore the terminal immediately and arm an unref'd fallback that force-
  // kills the child (and us) if it ignores or is slow to handle the signal.
  let signalFallback = null;
  const onSignal = (sig) => {
    try { child.kill(sig); } catch {}
    restoreTerminal();
    if (!signalFallback) {
      signalFallback = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        process.exit(toExitCode(undefined, sig));
      }, 2000);
      signalFallback.unref();
    }
  };
  const signals = stdin.isTTY ? ['SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of signals) process.on(sig, () => onSignal(sig));

  let exited = false;
  const isAlive = () => !exited;

  const screen = {
    capture: async (lines) => readScreen(term, lines),
    send: async (text) => { child.write(text + '\r'); },
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
function runPlain(claudeBin, args) {
  const claude = spawn(claudeBin, args, {
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { claude.kill(sig); } catch {} });
  }
  return new Promise((resolve) => {
    claude.on('exit', (code, signal) => resolve(toExitCode(code, signal)));
    claude.on('error', (err) => {
      process.stderr.write(`[claude-auto-retry] Failed to start claude: ${err.message}\n`);
      resolve(1);
    });
  });
}

// --print mode: non-interactive. Buffer output, and if rate-limited, discard
// the partial output, wait, and re-run with the same args. No PTY needed.
async function launchPrintMode(args) {
  const claudeBin = findClaudeBinary();
  const config = await loadConfig();
  let retries = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await new Promise((resolve) => {
      const chunks = [];
      const errChunks = [];
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
      // Clean exit — write buffered output, flushing before we return so the
      // tail isn't truncated when stdout/stderr is a pipe or file.
      await writeFlush(process.stdout, result.stdout);
      await writeFlush(process.stderr, result.stderr);
      return result.code;
    }

    // Rate limited — discard buffer, wait and retry
    retries++;
    if (retries > config.maxRetries) {
      process.stderr.write(`[claude-auto-retry] Max retries (${config.maxRetries}) reached.\n`);
      // Surface claude's own exit code where it's meaningful, but never report
      // success after giving up.
      return result.code || 1;
    }

    const parsed = parseResetTime(combined);
    const waitMs = calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);

    process.stderr.write(`[claude-auto-retry] Rate limited. Waiting ${Math.round(waitMs / 1000)}s before retry ${retries}/${config.maxRetries}...\n`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// Main
const args = process.argv.slice(2);

// Set exitCode rather than calling process.exit(): exit() would tear down the
// event loop before any buffered (non-TTY) stdout/stderr writes flush. Letting
// the loop drain naturally — after the interactive path has stopped the
// monitor, paused stdin, and restored the terminal — exits with the right code
// without truncating output.
if (isPrintMode(args)) {
  process.exitCode = await launchPrintMode(args);
} else {
  process.exitCode = await launchInteractive(args);
}
