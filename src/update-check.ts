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
async function fetchLatestVersion(signal: AbortSignal): Promise<string | null> {
  const res = await fetch(`${RELEASES_URL}/latest`, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
  });
  return /\/tag\/(\d+\.\d+\.\d+)$/.exec(res.headers.get('location') ?? '')?.[1] ?? null;
}

interface Options {
  statePath?: string;
  current?: string;
  now?: number;
  fetchLatest?: (signal: AbortSignal) => Promise<string | null>;
}

// Resolves to a notice when a newer release exists, else null. Asks GitHub at most
// once a day and answers from the cached result in between. Never rejects: a
// failed or aborted check falls back to the cache.
export async function checkForUpdate(signal: AbortSignal, options: Options = {}): Promise<string | null> {
  const { statePath = STATE_PATH, now = Date.now(), fetchLatest = fetchLatestVersion } = options;
  try {
    const current = options.current ?? (JSON.parse(await readFile(PACKAGE_JSON, 'utf-8')).version as string);
    let checkedAt = 0;
    let latest = '';
    try {
      const state = JSON.parse(await readFile(statePath, 'utf-8'));
      if (typeof state?.checkedAt === 'number' && typeof state?.latest === 'string') ({ checkedAt, latest } = state);
    } catch { /* no usable state yet */ }

    if (!(now - checkedAt < CHECK_INTERVAL_MS)) {
      try {
        const fetched = await fetchLatest(signal);
        if (fetched) {
          latest = fetched;
          await mkdir(dirname(statePath), { recursive: true });
          await writeFile(statePath, JSON.stringify({ checkedAt: now, latest }));
        }
      } catch { /* offline, timed out or aborted */ }
    }

    if (!isNewer(latest, current)) return null;
    return `[claude-auto-retry] Version ${latest} is available (installed: ${current}). To update, run:\n  ${INSTALL_COMMAND}`;
  } catch {
    return null;
  }
}
