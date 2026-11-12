import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const RELEASES_URL = 'https://github.com/chris-karl/claude-auto-retry/releases';
export const INSTALL_COMMAND = `npm i -g --allow-remote=root --allow-scripts=node-pty ${RELEASES_URL}/latest/download/claude-auto-retry.tgz`;

const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const STATE_PATH = join(homedir(), '.claude-auto-retry', 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 3600_000;
const FETCH_TIMEOUT_MS = 5000;
const VERSION = /^\d+\.\d+\.\d+$/;

export function isNewer(latest: string, current: string): boolean {
  if (!VERSION.test(latest) || !VERSION.test(current)) return false;
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// releases/latest redirects to releases/tag/<version>: the Location header is
// the answer, with no API rate limit and no body to parse.
async function fetchLatestVersion(signal?: AbortSignal): Promise<string | null> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(`${RELEASES_URL}/latest`, {
    method: 'HEAD',
    redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  return /\/tag\/(\d+\.\d+\.\d+)$/.exec(res.headers.get('location') ?? '')?.[1] ?? null;
}

interface Options {
  statePath?: string;
  current?: string;
  now?: number;
  fetchLatest?: (signal?: AbortSignal) => Promise<string | null>;
}

async function installedVersion(): Promise<string> {
  return JSON.parse(await readFile(PACKAGE_JSON, 'utf-8')).version as string;
}

// Resolves to the latest release, or null when GitHub can't be reached. An
// unwritable cache still returns the answer.
async function fetchAndCache(signal: AbortSignal | undefined, options: Options): Promise<string | null> {
  const { statePath = STATE_PATH, now = Date.now(), fetchLatest = fetchLatestVersion } = options;
  let latest: string | null = null;
  try {
    latest = await fetchLatest(signal);
    if (latest) {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify({ checkedAt: now, latest }));
    }
  } catch { /* offline, timed out, aborted or unwritable */ }
  return latest;
}

function updateNotice(latest: string, current: string): string {
  return `[claude-auto-retry] Version ${latest} is available (installed: ${current}). To update, run:\n  ${INSTALL_COMMAND}`;
}

// Resolves to a notice when a newer release exists, else null. Asks GitHub at most
// once a day and answers from the cached result in between. Never rejects: a
// failed or aborted check falls back to the cache.
export async function checkForUpdate(signal: AbortSignal, options: Options = {}): Promise<string | null> {
  const { statePath = STATE_PATH, now = Date.now() } = options;
  try {
    const current = options.current ?? await installedVersion();
    let checkedAt = 0;
    let latest = '';
    try {
      const state = JSON.parse(await readFile(statePath, 'utf-8'));
      if (typeof state?.checkedAt === 'number' && typeof state?.latest === 'string') ({ checkedAt, latest } = state);
    } catch { /* no usable state yet */ }

    if (!(now - checkedAt < CHECK_INTERVAL_MS)) latest = await fetchAndCache(signal, options) ?? latest;

    return isNewer(latest, current) ? updateNotice(latest, current) : null;
  } catch {
    return null;
  }
}

// The manual check: asks GitHub now, whatever the cache or the updateCheck setting
// says. Resolves to the message to print, or null when GitHub can't be reached.
export async function checkNow(options: Options = {}): Promise<string | null> {
  const current = options.current ?? await installedVersion();
  const latest = await fetchAndCache(undefined, options);
  if (!latest) return null;
  return isNewer(latest, current) ? updateNotice(latest, current) : `claude-auto-retry ${current} is up to date.`;
}
