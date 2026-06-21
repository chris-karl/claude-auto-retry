#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_LOG_DIR, todayFile } from '../src/logger.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_DIR = join(__dirname, '..', 'src');
const LAUNCHER_PATH = join(SRC_DIR, 'launcher.ts');
const WRAPPER_TEMPLATE = join(SRC_DIR, 'wrapper.sh');

export const MARKER_START = '# >>> claude-auto-retry >>>';
export const MARKER_END = '# <<< claude-auto-retry <<<';

// --- Wrapper injection ---

export async function injectWrapper(rcFile: string, launcherPath: string): Promise<void> {
  let content = '';
  try {
    content = await readFile(rcFile, 'utf-8');
  } catch {
    // File doesn't exist; it will be created.
  }

  const template = await readFile(WRAPPER_TEMPLATE, 'utf-8');
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

async function cmdInstall(): Promise<void> {
  console.log('claude-auto-retry: installing...\n');

  if (await checkPty()) console.log('PTY backend OK');

  const shell = process.env.SHELL || '/bin/bash';
  if (shell.includes('fish')) {
    console.error('\nFish shell detected. Automatic install not supported.');
    console.error('Add manually to ~/.config/fish/config.fish:');
    console.error('  function claude');
    console.error('    if test "$CLAUDE_AUTO_RETRY_ACTIVE" = "1"');
    console.error('      command claude $argv');
    console.error('      return $status');
    console.error('    end');
    console.error(`    env CLAUDE_AUTO_RETRY_ACTIVE=1 node "${LAUNCHER_PATH}" $argv`);
    console.error('  end');
    process.exit(1);
  }

  const rcFiles: string[] = [];
  const bashrc = join(homedir(), '.bashrc');
  const zshrc = join(homedir(), '.zshrc');

  if (existsSync(bashrc) || shell.includes('bash')) rcFiles.push(bashrc);
  if (existsSync(zshrc) || shell.includes('zsh')) rcFiles.push(zshrc);
  if (rcFiles.length === 0) rcFiles.push(bashrc);

  for (const rc of rcFiles) {
    await injectWrapper(rc, LAUNCHER_PATH);
    console.log(`Shell function added to ${rc}`);
  }

  console.log(`\nInstalled! Launcher path: ${LAUNCHER_PATH}`);
  console.log('\nRestart your shell or run:');
  for (const rc of rcFiles) { console.log(`  source ${rc}`); }
  console.log('\nNote: If you switch Node versions (nvm), re-run: claude-auto-retry install');
}

async function cmdUninstall(): Promise<void> {
  const bashrc = join(homedir(), '.bashrc');
  const zshrc = join(homedir(), '.zshrc');
  for (const rc of [bashrc, zshrc]) { await removeWrapper(rc); }
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
    '  claude-auto-retry install     Install shell wrapper\n' +
    '  claude-auto-retry uninstall   Remove shell wrapper\n' +
    '  claude-auto-retry status      Show monitor status\n' +
    "  claude-auto-retry logs        Tail today's log\n" +
    '  claude-auto-retry version     Print version\n'
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
