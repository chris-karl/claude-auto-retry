// StopFailure event channel: the authoritative, scrape-free overload trigger.
//
// Claude Code's `StopFailure` hook fires only when a turn ends in an API error, with
// a typed `error` (matcher-filtered to overloaded/server_error). The hook runs as a
// CHILD of claude, so it inherits the env the launcher stamped onto claude —
// including CLAUDE_AUTO_RETRY_SESSION (the launcher's PID). It writes a marker keyed
// by that session; the monitor, which runs inside the launcher and knows its own key,
// reads it directly. No session-id plumbing needed.
//
// Markers are short-lived (consumed on action, ignored past eventMaxAge) so a
// recycled launcher PID can't replay a stale failure.

import { mkdir, writeFile, readFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const EVENTS_DIR = join(homedir(), '.claude-auto-retry', 'events');

// Error types the event path treats as a *transient overload* (seconds-scale backoff).
// NOTE: `rate_limit` is deliberately EXCLUDED. For a subscription it is the session/
// usage limit — an HOURS-scale wait until a printed reset time, not a seconds-scale
// retry. Routing it here (as upstream once did) made the monitor fire futile
// "Continue" retries into a session-limited screen and fight the (correct) usage-wait
// path, which reliably reads the persistent "…resets <time>" banner and waits.
// Permanent errors (auth/billing/invalid) never retry.
const RETRYABLE = new Set(['overloaded', 'server_error']);

export function isRetryableError(errorType: unknown): boolean {
  return typeof errorType === 'string' && RETRYABLE.has(errorType.toLowerCase());
}

export interface StopFailureEvent {
  session: string;
  error: string;
  session_id: string | null;
  ts: number;
}

// Keep the marker filename to a safe charset whatever the key looks like.
function fileFor(sessionKey: string, dir: string): string {
  const safe = String(sessionKey).replace(/[^A-Za-z0-9_-]/g, '_');
  return join(dir, `${safe}.json`);
}

// Hook side: write a marker for the session. Atomic (tmp + rename) so the monitor
// never reads a half-written file.
export async function writeStopFailureEvent(
  sessionKey: string,
  payload: { error?: unknown; session_id?: string | null } | null | undefined,
  dir: string = EVENTS_DIR,
): Promise<string | null> {
  if (!sessionKey) return null;
  const error = typeof payload?.error === 'string' ? payload.error : 'unknown';
  await mkdir(dir, { recursive: true });
  const file = fileFor(sessionKey, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ session: String(sessionKey), error, session_id: payload?.session_id ?? null, ts: Date.now() });
  await writeFile(tmp, body);
  await rename(tmp, file);
  return file;
}

// Monitor side: return a fresh marker for the session, or null (absent /
// unparseable / stale).
export async function readStopFailureEvent(
  sessionKey: string,
  maxAgeMs: number,
  dir: string = EVENTS_DIR,
): Promise<StopFailureEvent | null> {
  if (!sessionKey) return null;
  try {
    const ev = JSON.parse(await readFile(fileFor(sessionKey, dir), 'utf-8')) as StopFailureEvent;
    if (typeof ev.ts !== 'number' || Date.now() - ev.ts > maxAgeMs) return null;
    return ev;
  } catch { return null; }
}

export async function clearStopFailureEvent(sessionKey: string, dir: string = EVENTS_DIR): Promise<void> {
  try { await unlink(fileFor(sessionKey, dir)); } catch { /* already gone */ }
}
