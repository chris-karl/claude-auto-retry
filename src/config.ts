import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// One bounded re-send path for an API error Claude Code leaves on screen. Two
// instances share it: `overload` (5xx/529 left after Claude Code's own retries,
// minutes-scale backoff) and `safeguard` (a safeguards false positive, quick
// re-send). Both are separate from the hours-scale usage-limit wait.
export interface RetryConfig {
  enabled: boolean;
  patterns: string[];        // case-insensitive regexes, matched near an `API Error` line in the screen tail
  backoffSeconds: number[];  // wait before each send; the last entry repeats
  maxRetries: number;
  retryMessage: string;
}

export interface Config {
  maxRetries: number;
  pollIntervalSeconds: number;
  marginSeconds: number;
  fallbackWaitHours: number;
  retryCooldownSeconds: number;
  retryMessage: string;
  customPatterns: string[];
  updateCheck: boolean;
  overload: RetryConfig;
  safeguard: RetryConfig;
}

export const DEFAULT_OVERLOAD: RetryConfig = {
  enabled: true,
  // Anchored to Claude Code's terminal error render, never a bare status number: a
  // bare "503" matches ordinary code and quoted logs. The in-progress form
  // "API Error (529 …) · Retrying in 5s" has no colon and trips the working gate.
  patterns: [
    'API Error:.*\\b(429|500|502|503|504|529)\\b',   // also "API Error: Repeated 529 Overloaded errors…"
    'overloaded_error',
    'temporarily limiting requests',   // API-level 429 render, no status code in the slot
  ],
  backoffSeconds: [30, 60, 120, 240, 300],
  maxRetries: 20,
  retryMessage: 'Continue where you left off.',
};

export const DEFAULT_SAFEGUARD: RetryConfig = {
  enabled: true,
  // "API Error: <model>'s safeguards flagged this message (…/legal/aup). … Claude Code
  // can't respond to this request with <model>." Match the stable phrases, not the model.
  patterns: ['safeguards flagged this message', "can't respond to this request with", 'legal/aup'],
  backoffSeconds: [8],
  maxRetries: 3,   // a flag that survives three re-sends is sticky; retrying won't help
  retryMessage: 'continue',
};

export const DEFAULT_CONFIG: Config = {
  maxRetries: 5,
  pollIntervalSeconds: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  retryCooldownSeconds: 30,
  retryMessage: 'Continue where you left off. The previous attempt was rate limited.',
  customPatterns: [],
  updateCheck: true,
  overload: DEFAULT_OVERLOAD,
  safeguard: DEFAULT_SAFEGUARD,
};

const CONFIG_PATH = join(homedir(), '.claude-auto-retry.json');

function validNumber(val: unknown, min: number, fallback: number): number {
  return typeof val === 'number' && Number.isFinite(val) && val >= min ? val : fallback;
}

// A pattern is usable only if it's a non-empty string that compiles as a regex: a
// typo can't then crash a monitor tick, and an empty string (which compiles but
// matches every line) can't turn into a permanent false positive.
function isUsablePattern(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0) return false;
  try { new RegExp(p); return true; } catch { return false; }
}

function validateRetry(raw: unknown, defaults: RetryConfig): RetryConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const patterns = Array.isArray(r.patterns) ? r.patterns.filter(isUsablePattern) : [];
  const backoff = Array.isArray(r.backoffSeconds)
    ? r.backoffSeconds.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : [];
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : defaults.enabled,
    patterns: patterns.length > 0 ? patterns : [...defaults.patterns],
    backoffSeconds: backoff.length > 0 ? backoff : [...defaults.backoffSeconds],
    maxRetries: validNumber(r.maxRetries, 1, defaults.maxRetries),
    retryMessage: typeof r.retryMessage === 'string' && r.retryMessage ? r.retryMessage : defaults.retryMessage,
  };
}

// Build a clean Config from arbitrary JSON: every field is range-checked and falls
// back to its default, so a malformed config can never produce NaN downstream.
function validate(raw: Record<string, unknown>): Config {
  return {
    maxRetries: validNumber(raw.maxRetries, 1, DEFAULT_CONFIG.maxRetries),
    pollIntervalSeconds: validNumber(raw.pollIntervalSeconds, 1, DEFAULT_CONFIG.pollIntervalSeconds),
    marginSeconds: validNumber(raw.marginSeconds, 0, DEFAULT_CONFIG.marginSeconds),
    fallbackWaitHours: validNumber(raw.fallbackWaitHours, 0.1, DEFAULT_CONFIG.fallbackWaitHours),
    retryCooldownSeconds: validNumber(raw.retryCooldownSeconds, 1, DEFAULT_CONFIG.retryCooldownSeconds),
    retryMessage: typeof raw.retryMessage === 'string' && raw.retryMessage ? raw.retryMessage : DEFAULT_CONFIG.retryMessage,
    customPatterns: Array.isArray(raw.customPatterns) ? raw.customPatterns.filter(isUsablePattern) : [],
    updateCheck: typeof raw.updateCheck === 'boolean' ? raw.updateCheck : DEFAULT_CONFIG.updateCheck,
    overload: validateRetry(raw.overload, DEFAULT_OVERLOAD),
    safeguard: validateRetry(raw.safeguard, DEFAULT_SAFEGUARD),
  };
}

export async function loadConfig(path: string = CONFIG_PATH): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    return validate(raw && typeof raw === 'object' ? raw : {});
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
