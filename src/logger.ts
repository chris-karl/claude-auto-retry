import { appendFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface Logger {
  info: (msg: string) => Promise<void>;
  warn: (msg: string) => Promise<void>;
  error: (msg: string) => Promise<void>;
}

export const DEFAULT_LOG_DIR = join(homedir(), '.claude-auto-retry', 'logs');
const MAX_AGE_DAYS = 7;
const CLEANUP_INTERVAL_MS = 3600_000;
let lastCleanup = 0;

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// Path to today's log file. Exported so the CLI readers (status/logs) use the
// exact same directory + filename layout as the writer, with no risk of drift.
export function todayFile(dir: string = DEFAULT_LOG_DIR): string {
  return join(dir, `${new Date().toISOString().split('T')[0]}.log`);
}

async function cleanup(dir: string): Promise<void> {
  if (Date.now() - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = Date.now();
  try {
    const files = await readdir(dir);
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      const s = await stat(join(dir, file));
      if (s.mtimeMs < cutoff) await unlink(join(dir, file));
    }
  } catch { /* ignore */ }
}

export function createLogger(dir: string = DEFAULT_LOG_DIR): Logger {
  let dirCreated = false;
  async function ensureDir(): Promise<void> {
    if (!dirCreated) { await mkdir(dir, { recursive: true }); dirCreated = true; }
  }
  async function log(level: string, message: string): Promise<void> {
    await ensureDir();
    await appendFile(todayFile(dir), `[${timestamp()}] [${level}] ${message}\n`);
    cleanup(dir);
  }
  return {
    info: (msg) => log('INFO', msg),
    warn: (msg) => log('WARN', msg),
    error: (msg) => log('ERROR', msg),
  };
}
