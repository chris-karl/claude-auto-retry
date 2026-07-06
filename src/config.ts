import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Transient API-error backoff (529 Overloaded / 500 / 503). Separate block from
// the usage-limit knobs: those wait in *hours* until a reset, these wait in
// *seconds* on an exponential backoff. See README "Overload backoff".
export interface OverloadConfig {
  enabled: boolean;
  patterns: string[];
  backoffSeconds: number[];
  steadyStateSeconds: number;
  jitterPct: number;
  maxTotalWaitMinutes: number;
  eventMaxAgeSeconds: number;
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
  overload: OverloadConfig;
}

export const DEFAULT_OVERLOAD: OverloadConfig = {
  enabled: true,
  // Anchored to Claude Code's actual TERMINAL error render — NOT bare status numbers.
  // A bare "503"/"529" matches ordinary code (res.status(503)), ports, byte counts and
  // quoted logs, which is what caused false "Continue where you left off." injections
  // upstream. Matched as case-insensitive regexes against only the screen tail
  // (see overloadMatch in patterns.ts).
  //
  // Claude Code (verified against the v2.1.x binary) has TWO render forms:
  //   terminal (retries exhausted):  "API Error: 529 {…}"  / "API Error: 503 no healthy upstream"
  //   transient (still retrying):     "API Error (529 …) · Retrying in 5s · attempt 3/10"
  // We REQUIRE the colon form to skip the parens form, and the retry SUFFIX
  // ("· Retrying in…" / "attempt n/m") is separately suppressed by the working gate
  // in patterns.ts — together they ensure we never interrupt Claude's own backoff.
  patterns: [
    // Terminal error line. Covers the full retryable set (429+5xx) in the colon form.
    'API Error:\\s*(429|500|502|503|504|529)\\b',
    // JSON error.type for a sustained overload (survives the collapsed non-JSON render).
    'overloaded_error',
    // API-level 429 uses a dedicated render with no 3-digit code in the generic slot:
    //   "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
    'temporarily limiting requests',
  ],
  backoffSeconds: [30, 60, 120, 240, 300],
  steadyStateSeconds: 300,
  jitterPct: 15,
  maxTotalWaitMinutes: 120,
  // StopFailure event markers older than this are ignored (guards against a stale
  // marker left behind by an earlier session replaying a failure).
  eventMaxAgeSeconds: 120,
  retryMessage: 'Continue where you left off.',
};

export const DEFAULT_CONFIG: Config = {
  maxRetries: 5,
  pollIntervalSeconds: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  retryCooldownSeconds: 30,
  retryMessage: 'Continue where you left off. The previous attempt was rate limited.',
  customPatterns: [],
  overload: DEFAULT_OVERLOAD,
};

const CONFIG_PATH = join(homedir(), '.claude-auto-retry.json');

function validNumber(val: unknown, min: number, fallback: number): number {
  return typeof val === 'number' && Number.isFinite(val) && val >= min ? val : fallback;
}

function clamp(val: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.min(hi, Math.max(lo, val));
}

// Keep only non-empty strings that actually compile as regexes, so a typo'd
// pattern can't crash a monitor tick.
function validPatterns(raw: unknown, fallback: string[]): string[] {
  const pats = Array.isArray(raw)
    ? raw.filter((p): p is string => {
        if (typeof p !== 'string' || p.length === 0) return false;
        try { new RegExp(p); return true; } catch { return false; }
      })
    : [];
  return pats.length > 0 ? pats : [...fallback];
}

function validateOverload(raw: unknown): OverloadConfig {
  // Shallow-merge so a partial user block keeps the documented defaults for the
  // keys it omits.
  const o = { ...DEFAULT_OVERLOAD, ...(raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}) } as OverloadConfig;

  o.enabled = typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_OVERLOAD.enabled;
  o.patterns = validPatterns(o.patterns, DEFAULT_OVERLOAD.patterns);

  const backoff = Array.isArray(o.backoffSeconds)
    ? o.backoffSeconds.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : [];
  o.backoffSeconds = backoff.length > 0 ? backoff : [...DEFAULT_OVERLOAD.backoffSeconds];

  o.steadyStateSeconds = validNumber(o.steadyStateSeconds, 1, DEFAULT_OVERLOAD.steadyStateSeconds);
  o.jitterPct = clamp(o.jitterPct, 0, 100, DEFAULT_OVERLOAD.jitterPct);
  o.maxTotalWaitMinutes = validNumber(o.maxTotalWaitMinutes, 0.1, DEFAULT_OVERLOAD.maxTotalWaitMinutes);
  o.eventMaxAgeSeconds = validNumber(o.eventMaxAgeSeconds, 1, DEFAULT_OVERLOAD.eventMaxAgeSeconds);

  if (typeof o.retryMessage !== 'string' || !o.retryMessage) {
    o.retryMessage = DEFAULT_OVERLOAD.retryMessage;
  }
  return o;
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
    overload: validateOverload(raw.overload),
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
