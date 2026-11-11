#!/usr/bin/env node

import { readFile, writeFile, mkdir, stat, open } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_LOG_DIR, todayFile } from '../src/logger.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_DIR = join(__dirname, '..', 'src');
// Mirror our own extension: .ts next to launcher.ts in a source checkout, .js next
// to launcher.js in a compiled install (Node won't strip types under node_modules).
const MODULE_EXT = __filename.endsWith('.ts') ? '.ts' : '.js';
const LAUNCHER_PATH = join(SRC_DIR, `launcher${MODULE_EXT}`);
export const WRAPPER_TEMPLATE = join(SRC_DIR, 'wrapper.sh');
export const FISH_WRAPPER_TEMPLATE = join(SRC_DIR, 'wrapper.fish');
export const PS_WRAPPER_TEMPLATE = join(SRC_DIR, 'wrapper.ps1');

export const MARKER_START = '# >>> claude-auto-retry >>>';
export const MARKER_END = '# <<< claude-auto-retry <<<';

const INSTALL_COMMAND = 'npm i -g --allow-remote=root --allow-scripts=node-pty https://github.com/chris-karl/claude-auto-retry/releases/latest/download/claude-auto-retry.tgz';

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

// --- Shell rc files ---

// Fish reads $XDG_CONFIG_HOME/fish (default ~/.config/fish). The wrapper goes
// into config.fish, not conf.d/: conf.d files are sourced before config.fish,
// so a `claude` alias defined there would override a conf.d function — while a
// block appended to the end of config.fish always wins.
function fishConfigFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), '.config'), 'fish', 'config.fish');
}

// $PROFILE.CurrentUserAllHosts of each installed PowerShell (7 = pwsh, 5.1 = powershell).
function powershellProfiles(): string[] {
  const out: string[] = [];
  for (const exe of ['pwsh', 'powershell']) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', '$PROFILE.CurrentUserAllHosts'], { encoding: 'utf-8' });
    const p = r.status === 0 ? r.stdout.trim() : '';
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

interface RcFile { rc: string; template: string; shell: string }

// Every rc file the wrapper can live in; install picks the ones in use.
function allRcFiles(): RcFile[] {
  const files: RcFile[] = [
    { rc: join(homedir(), '.bashrc'), template: WRAPPER_TEMPLATE, shell: 'bash' },
    { rc: join(homedir(), '.zshrc'), template: WRAPPER_TEMPLATE, shell: 'zsh' },
    { rc: fishConfigFile(), template: FISH_WRAPPER_TEMPLATE, shell: 'fish' },
  ];
  if (process.platform === 'win32') {
    files.push(...powershellProfiles().map((rc) => ({ rc, template: PS_WRAPPER_TEMPLATE, shell: 'powershell' })));
  }
  return files;
}

// --- PTY backend check ---

// node-pty is a native module; warn (don't fail) if it can't load. Sessions fall
// back to plain claude until it is fixed.
async function checkPty(): Promise<void> {
  try {
    await import('node-pty');
  } catch (err) {
    console.warn('\nWarning: node-pty (the PTY backend) could not be loaded:');
    console.warn(`  ${(err as Error).message}`);
    console.warn('claude will run unmonitored until it is fixed. Reinstalling usually rebuilds it');
    console.warn('(Linux needs build tools, e.g. apt-get install build-essential python3):');
    console.warn(`  ${INSTALL_COMMAND}\n`);
  }
}

// --- CLI commands ---

async function cmdInstall(): Promise<void> {
  console.log('claude-auto-retry: installing...\n');
  await checkPty();

  const shell = process.env.SHELL || '';
  const all = allRcFiles();
  let targets = all.filter((f) => f.shell === 'powershell'
    || existsSync(f.shell === 'fish' ? dirname(f.rc) : f.rc)
    || shell.includes(f.shell));
  if (targets.length === 0) targets = [all[0]];

  for (const { rc, template } of targets) {
    await mkdir(dirname(rc), { recursive: true });
    await injectWrapper(rc, LAUNCHER_PATH, template);
    console.log(`Shell function added to ${rc}`);
  }

  console.log('\nInstalled. Open a new terminal or run:');
  for (const { rc, shell: sh } of targets) { console.log(`  ${sh === 'powershell' ? '.' : 'source'} ${rc}`); }
}

async function cmdUninstall(): Promise<void> {
  for (const { rc } of allRcFiles()) { await removeWrapper(rc); }
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

// Print today's log and keep following appended lines (a portable `tail -f`).
async function cmdLogs(): Promise<void> {
  const logFile = todayFile();
  if (!existsSync(logFile)) {
    console.log(`No log file for today: ${logFile}`);
    return;
  }
  let offset = 0;
  for (;;) {
    const { size } = await stat(logFile);
    if (size > offset) {
      const fh = await open(logFile, 'r');
      try {
        const { buffer, bytesRead } = await fh.read(Buffer.alloc(size - offset), 0, size - offset, offset);
        process.stdout.write(buffer.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
      offset = size;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
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
    'claude-auto-retry - Continue Claude Code past usage limits and API errors\n\n' +
    'Usage:\n' +
    '  claude-auto-retry install            Install shell wrapper\n' +
    '  claude-auto-retry uninstall          Remove shell wrapper\n' +
    '  claude-auto-retry status             Show monitor status\n' +
    "  claude-auto-retry logs               Tail today's log\n" +
    '  claude-auto-retry version            Print version\n'
  );
}

export async function main(command: string | undefined): Promise<void> {
  switch (command) {
    case 'install': await cmdInstall(); break;
    case 'uninstall': await cmdUninstall(); break;
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
