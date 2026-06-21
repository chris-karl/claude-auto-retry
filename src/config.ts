import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface Config {
  maxRetries: number;
  pollIntervalSeconds: number;
  marginSeconds: number;
  fallbackWaitHours: number;
  retryCooldownSeconds: number;
  retryMessage: string;
  customPatterns: string[];
}

export const DEFAULT_CONFIG: Config = {
  maxRetries: 5,
  pollIntervalSeconds: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  retryCooldownSeconds: 30,
  retryMessage: 'Continue where you left off. The previous attempt was rate limited.',
  customPatterns: [],
};

const CONFIG_PATH = join(homedir(), '.claude-auto-retry.json');

function validNumber(val: unknown, min: number, fallback: number): number {
  return typeof val === 'number' && Number.isFinite(val) && val >= min ? val : fallback;
}

// Build a clean Config from arbitrary JSON: every field is range-checked and
// falls back to its default, so a malformed config can never produce NaN/
// undefined behavior downstream.
function validate(raw: Record<string, unknown>): Config {
  const customPatterns = Array.isArray(raw.customPatterns)
    ? raw.customPatterns.filter((p): p is string => {
        if (typeof p !== 'string') return false;
        try { new RegExp(p); return true; } catch { return false; }
      })
    : DEFAULT_CONFIG.customPatterns;

  return {
    maxRetries: validNumber(raw.maxRetries, 1, DEFAULT_CONFIG.maxRetries),
    pollIntervalSeconds: validNumber(raw.pollIntervalSeconds, 1, DEFAULT_CONFIG.pollIntervalSeconds),
    marginSeconds: validNumber(raw.marginSeconds, 0, DEFAULT_CONFIG.marginSeconds),
    fallbackWaitHours: validNumber(raw.fallbackWaitHours, 0.1, DEFAULT_CONFIG.fallbackWaitHours),
    retryCooldownSeconds: validNumber(raw.retryCooldownSeconds, 1, DEFAULT_CONFIG.retryCooldownSeconds),
    retryMessage: typeof raw.retryMessage === 'string' && raw.retryMessage
      ? raw.retryMessage
      : DEFAULT_CONFIG.retryMessage,
    customPatterns,
  };
}

export async function loadConfig(path: string = CONFIG_PATH): Promise<Config> {
  try {
    const raw = await readFile(path, 'utf-8');
    // Spreading over DEFAULT_CONFIG neutralizes a non-object payload (a bare
    // number/null parses but spreads to nothing) before validation.
    return validate({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
