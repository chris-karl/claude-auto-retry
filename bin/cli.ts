#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_LOG_DIR, todayFile } from '../src/logger.ts';
import { writeStopFailureEvent, isRetryableError } from '../src/events.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_DIR = join(__dirname, '..', 'src');
// Mirror our own extension: .ts next to launcher.ts in a source checkout, .js next
// to launcher.js in a compiled install (Node won't strip types under node_modules).
const MODULE_EXT = __filename.endsWith('.ts') ? '.ts' : '.js';
const LAUNCHER_PATH = join(SRC_DIR, `launcher${MODULE_EXT}`);
const WRAPPER_TEMPLATE = join(SRC_DIR, 'wrapper.sh');
export const FISH_WRAPPER_TEMPLATE = join(SRC_DIR, 'wrapper.fish');

export const MARKER_START = '# >>> claude-auto-retry >>>';
export const MARKER_END = '# <<< claude-auto-retry <<<';

// --- Wrapper injection ---

export async function injectWrapper(rcFile: string, launcherPath: string, templatePath: string = WRAPPER_TEMPLATE): Promise<void> {
  let content = '';
  try {
    content = await readFile(rcFile, 'utf-8');
  } catch {
    // File doesn't exist; it will be created.
  }

  const template = await readFile(templatePath, 'utf-8');
  const wrapper = template.replace(/__LAUNCHER_PATH__/g, launcherPath);

  // Remove an existing wrapper block if present.
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx !== -1 && endIdx !== -1) {
    const afterMarker = endIdx + MARKER_END.length;
    // Skip the newline after MARKER_END if present, but don't blindly +1.
    const skipTo = content[afterMarker] === '\n' ? afterMarker + 1
                 : content.slice(afterMarker, afterMarker + 2) === '\r\n' ? afterMarker + 2
                 : afterMarker;
    content = content.slice(0, startIdx) + content.slice(skipTo);
  }

  content = content.trimEnd() + '\n\n' + wrapper + '\n';
  await writeFile(rcFile, content);
}

export async function removeWrapper(rcFile: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(rcFile, 'utf-8');
  } catch {
    return;
  }

  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) return;

  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + MARKER_END.length).trimStart();
  content = before + (after ? '\n' + after : '\n');
  await writeFile(rcFile, content);
}

// --- PTY backend check ---

// node-pty is a native module; warn (don't fail) if it can't load so the user
// knows interactive monitoring won't work until build tools are available.
async function checkPty(): Promise<boolean> {
  try {
    await import('node-pty');
    return true;
  } catch (err) {
    console.warn('\nWarning: node-pty (the PTY backend) could not be loaded:');
    console.warn(`  ${(err as Error).message}`);
    console.warn('Interactive monitoring will be disabled until this is fixed.');
    console.warn('Reinstalling usually rebuilds it: npm i -g claude-auto-retry');
    console.warn('(Linux may need build tools, e.g. apt-get install build-essential python3)\n');
    return false;
  }
}

// --- CLI commands ---

// Fish reads $XDG_CONFIG_HOME/fish (default ~/.config/fish). The wrapper goes
// into config.fish, not conf.d/: conf.d files are sourced before config.fish,
// so a `claude` alias defined there would override a conf.d function — while a
// block appended to the end of config.fish always wins.
function fishConfigFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), '.config'), 'fish', 'config.fish');
}

async function cmdInstall(): Promise<void> {
  console.log('claude-auto-retry: installing...\n');

  if (await checkPty()) console.log('PTY backend OK');

  const shell = process.env.SHELL || '/bin/bash';
  const bashrc = join(homedir(), '.bashrc');
  const zshrc = join(homedir(), '.zshrc');
  const fishrc = fishConfigFile();

  const targets: Array<{ rc: string; template?: string }> = [];
  if (existsSync(bashrc) || shell.includes('bash')) targets.push({ rc: bashrc });
  if (existsSync(zshrc) || shell.includes('zsh')) targets.push({ rc: zshrc });
  if (existsSync(dirname(fishrc)) || shell.includes('fish')) targets.push({ rc: fishrc, template: FISH_WRAPPER_TEMPLATE });
  if (targets.length === 0) targets.push({ rc: bashrc });

  for (const { rc, template } of targets) {
    await mkdir(dirname(rc), { recursive: true });
    await injectWrapper(rc, LAUNCHER_PATH, template);
    console.log(`Shell function added to ${rc}`);
  }

  console.log(`\nInstalled! Launcher path: ${LAUNCHER_PATH}`);
  console.log('\nRestart your shell or run:');
  for (const { rc } of targets) { console.log(`  source ${rc}`); }
  console.log('\nNote: If you switch Node versions (nvm), re-run: claude-auto-retry install');
}

async function cmdUninstall(): Promise<void> {
  const bashrc = join(homedir(), '.bashrc');
  const zshrc = join(homedir(), '.zshrc');
  for (const rc of [bashrc, zshrc, fishConfigFile()]) { await removeWrapper(rc); }
  console.log('Shell function removed. Restart your shell to complete.');
}

async function cmdStatus(): Promise<void> {
  const logFile = todayFile();
  try {
    const content = await readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    console.log(`Log file: ${logFile}\n`);
    console.log('Last 10 entries:');
    console.log(lines.slice(-10).join('\n'));
  } catch {
    console.log('No activity today. Log directory:', DEFAULT_LOG_DIR);
  }
}

async function cmdLogs(): Promise<void> {
  const logFile = todayFile();
  if (!existsSync(logFile)) {
    console.log(`No log file for today: ${logFile}`);
    return;
  }
  const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
  tail.on('error', (err) => {
    console.error(`Failed to tail log: ${err.message}`);
  });
  await new Promise<void>((resolve) => {
    tail.on('exit', () => resolve());
    tail.on('error', () => resolve());
  });
}

// --- StopFailure hook (event-driven overload trigger) ---

const HOOK_MARKER = '_stopfailure-hook';

function stopFailureHookEntry(): { matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> } {
  // Matcher filters on the StopFailure error type; only the transient-overload classes.
  // rate_limit is intentionally omitted — a session/usage limit is an hours-scale wait
  // owned by the usage-wait path, not a seconds-scale event retry (see src/events.ts).
  return {
    matcher: 'overloaded|server_error',
    hooks: [{ type: 'command', command: `node ${__filename} ${HOOK_MARKER}`, timeout: 5 }],
  };
}

function resolveConfigDir(arg: string | undefined): string {
  return arg || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// Invoked BY Claude Code on a turn-ending API error. Reads the hook JSON on stdin and,
// for a retryable error, writes a session-keyed marker the monitor consumes. Must never
// disrupt the session: StopFailure output/exit is ignored, and we swallow all errors.
async function cmdStopFailureHook(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const sessionKey = process.env.CLAUDE_AUTO_RETRY_SESSION;
    if (sessionKey && isRetryableError(payload.error)) {
      await writeStopFailureEvent(sessionKey, payload);
    }
  } catch { /* swallow — never break the host session */ }
  process.exit(0);
}

async function cmdInstallHook(dirArg: string | undefined): Promise<void> {
  const settingsPath = join(resolveConfigDir(dirArg), 'settings.json');
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(await readFile(settingsPath, 'utf-8')); } catch { /* new file */ }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown>;
  const existing = Array.isArray(hooks.StopFailure) ? hooks.StopFailure : [];
  // Idempotent: drop any prior entry pointing at our handler, then add the current one.
  const kept = existing.filter((e) => !JSON.stringify(e).includes(HOOK_MARKER));
  kept.push(stopFailureHookEntry());
  hooks.StopFailure = kept;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`StopFailure hook installed in ${settingsPath}`);
  console.log('New Claude sessions launched via the wrapper will use event-driven detection.');
}

async function cmdUninstallHook(dirArg: string | undefined): Promise<void> {
  const settingsPath = join(resolveConfigDir(dirArg), 'settings.json');
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    if (Array.isArray(settings.hooks?.StopFailure)) {
      settings.hooks.StopFailure = settings.hooks.StopFailure.filter((e: unknown) => !JSON.stringify(e).includes(HOOK_MARKER));
      if (settings.hooks.StopFailure.length === 0) delete settings.hooks.StopFailure;
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
    console.log(`StopFailure hook removed from ${settingsPath}`);
  } catch { console.log('No settings file to modify.'); }
}

async function cmdVersion(): Promise<void> {
  try {
    const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf-8'));
    console.log(pkg.version);
  } catch {
    console.log('unknown');
  }
}

// --- Main ---

function printHelp(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(
    'claude-auto-retry - Auto-retry Claude Code on subscription rate limits\n\n' +
    'Usage:\n' +
    '  claude-auto-retry install            Install shell wrapper\n' +
    '  claude-auto-retry uninstall          Remove shell wrapper\n' +
    '  claude-auto-retry install-hook [dir] Install the StopFailure hook (event-driven\n' +
    '                                       overload detection) into <dir>/settings.json\n' +
    '                                       (default: $CLAUDE_CONFIG_DIR or ~/.claude)\n' +
    '  claude-auto-retry uninstall-hook [dir]  Remove the StopFailure hook\n' +
    '  claude-auto-retry status             Show monitor status\n' +
    "  claude-auto-retry logs               Tail today's log\n" +
    '  claude-auto-retry version            Print version\n'
  );
}

export async function main(command: string | undefined): Promise<void> {
  switch (command) {
    case 'install': await cmdInstall(); break;
    case 'uninstall': await cmdUninstall(); break;
    case 'install-hook': await cmdInstallHook(process.argv[3]); break;
    case 'uninstall-hook': await cmdUninstallHook(process.argv[3]); break;
    case HOOK_MARKER: await cmdStopFailureHook(); break;
    case 'status': await cmdStatus(); break;
    case 'logs': await cmdLogs(); break;
    case 'version': case '--version': case '-v': await cmdVersion(); break;
    case undefined: case 'help': case '--help': case '-h': printHelp(); break;
    default:
      printHelp(process.stderr);
      process.stderr.write(`\nUnknown command: ${command}\n`);
      process.exitCode = 1;
  }
}

// Run the dispatcher only when this file is executed directly, never when it is
// imported (e.g. by tests pulling in injectWrapper). realpathSync resolves the
// global-install symlink so argv[1] matches this module's resolved URL.
function invokedDirectly(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) await main(process.argv[2]);
