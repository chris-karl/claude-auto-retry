/* eslint-disable no-control-regex -- this module matches raw ANSI/control bytes (ESC, BEL, ST) by design */

// Full CSI sequence range per ECMA-48: parameter/intermediate bytes (0x20-0x3f) + final byte (0x40-0x7e).
// Covers standard, private-mode (\x1b[?25h), and extended sequences.
const CSI_REGEX = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
// OSC sequences \x1b] … terminated by BEL (\x07) or ST (\x1b\\): hyperlinks, window titles, etc.
const OSC_REGEX = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// DCS sequences \x1bP … ST.
const DCS_REGEX = /\x1bP[\s\S]*?(?:\x07|\x1b\\)/g;
// APC, SOS, PM sequences \x1b[_X^] … ST.
const OTHER_ESC_REGEX = /\x1b[_X^][\s\S]*?(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text
    .replace(OSC_REGEX, '')
    .replace(DCS_REGEX, '')
    .replace(OTHER_ESC_REGEX, '')
    .replace(CSI_REGEX, '');
}

// Claude Code renders rate limits across multiple lines in its TUI, e.g.:
//   "⚠ You've hit your limit"
//   "· resets 3pm (UTC)"
// Detection: find a "limit" line and a "resets" line within WINDOW lines of each other.

const LIMIT_PATTERNS: RegExp[] = [
  // Any words (session / weekly / 5-hour / none) between "your|the" and "limit"
  // so newer wordings ("hit your session limit", "hit your weekly limit") match.
  /(?:hit|exceeded|reached).*(?:your|the)\s*(?:[\w-]+\s+)*limit/i,
  /\d+-hour limit/i,     // "5-hour limit"
  /limit reached/i,      // "limit reached" / "Weekly limit reached"
  /session limit/i,
  /weekly limit/i,
  /usage limit/i,
  /out of.*usage/i,      // "out of extra usage"
  /rate limit/i,
  /try again in/i,       // implies rate limiting
];

// Claude Code shows a PASSIVE usage gauge in its footer as you approach a limit,
// e.g. "You've used 98% of your session limit · resets 8:40pm (Europe/Berlin)".
// That line carries both "session limit" and a "resets …" time, but you are NOT
// blocked yet, so it must be ignored. The real limit-HIT banner uses "hit"/
// "reached" wording and the blocking menu is detected separately.
const USAGE_GAUGE_PATTERNS: RegExp[] = [
  /used\s+\d+(?:\.\d+)?%\s+of\s+(?:your|the)\b/i,
];

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';

const RESET_PATTERNS: RegExp[] = [
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,   // "resets 3pm" / "resets at 3:00 PM"
  /resets?\s+in[:\s]\s*\d/i,                                // "resets in: 3 hours"
  /try again in \d+\s*(?:hours?|minutes?|h|m)/i,            // "try again in 5 hours"
  // Weekly resets carry a calendar date: "resets May 28 …" / "Resets by … Apr 24".
  new RegExp(String.raw`resets?\b[^\n]*\b${MONTH}[a-z]*\.?\s+\d{1,2}\b`, 'i'),  // "resets … May 28"
  new RegExp(String.raw`resets?\b[^\n]*\b\d{1,2}\s+${MONTH}`, 'i'),             // "resets … 28 May"
];

// Newer Claude Code surfaces an interactive menu when a limit is hit:
//   What do you want to do?
//   ❯ 1. Stop and wait for limit to reset
//     2. Upgrade your plan
// The highlighted option VARIES between plans/versions, so pressing Enter is
// unsafe (it could confirm "Upgrade your plan"). We detect the menu so the
// monitor can dismiss it with Escape and submit the retry once the limit resets.
// Markers are limit-specific so a generic "What do you want to do?" won't trip it.
const MENU_LIMIT_MARKERS: RegExp[] = [
  /\/rate-limit-options/i,
  /Stop and wait for limit to reset/i,
  /Wait for limit to reset/i,
  /Adjust monthly spend limit/i,
];

export function isLimitMenuPrompt(text: string): boolean {
  const stripped = stripAnsi(text);
  if (!/What do you want to do\?/i.test(stripped)) return false;
  return MENU_LIMIT_MARKERS.some((p) => p.test(stripped));
}

// Indicators that Claude is mid-flight (thinking/streaming or running its OWN
// internal API retry). While any of these shows, the screen is NOT in a terminal
// state: a rate-limit banner lingering above is stale, and an overload error
// still carries Claude's own backoff ("API Error (529 …) · Retrying in 5s ·
// attempt 3/10") — acting on it would interrupt that backoff. (The limit menu
// shows "Esc to cancel", not "esc to interrupt", so this never collides with
// menu detection.)
const WORKING_PATTERNS: RegExp[] = [
  /esc to interrupt/i,        // the working/streaming footer ("… (esc to interrupt)")
  /\besc\b.*\binterrupt\b/i,  // tolerate reordering/spacing in the same footer
  /Retrying in\b/i,           // internal-retry suffix — retries not yet exhausted
  /\battempt\s+\d+\/\d+/i,    // "attempt 3/10" companion to the retry suffix
];

export function isWorking(text: string): boolean {
  const lines = tail(text);
  return lines.some((line) => WORKING_PATTERNS.some((p) => p.test(line)));
}

// --- Tail anchoring (shared by isWorking and the overload path) ---
// A *terminal* error or live status footer is the last thing on screen, sitting
// just above the input box (~5-6 variable lines: box borders + input row(s) +
// footer). A multi-line JSON error body adds a few more, so its anchor line can
// land ~10 rows from the bottom. 12 covers that with margin while still trimming
// the top of the capture, where stale scrollback lives.
const TAIL_LINES = 12;

function tail(text: string): string[] {
  return stripAnsi(text).split('\n').slice(-TAIL_LINES);
}

// Compile a config pattern (string → case-insensitive RegExp) once per call.
// Invalid regexes are dropped rather than thrown (matches the usage-limit
// customPatterns path).
function toRegexes(patterns: Array<string | RegExp>): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    if (p instanceof RegExp) { out.push(p); continue; }
    if (typeof p !== 'string' || !p) continue;
    try { out.push(new RegExp(p, 'i')); } catch { /* skip invalid */ }
  }
  return out;
}

const WINDOW = 6;

function hasNearbyMatch(lines: string[], idx: number, patterns: RegExp[]): boolean {
  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(lines.length, idx + WINDOW + 1);
  for (let j = start; j < end; j++) {
    if (patterns.some((p) => p.test(lines[j]))) return true;
  }
  return false;
}

export function isRateLimited(text: string, customPatterns: Array<string | RegExp> = []): boolean {
  const lines = stripAnsi(text).split('\n');

  // Custom patterns: check full text (the user controls their own regex).
  if (customPatterns.length > 0) {
    const full = lines.join('\n');
    const custom = customPatterns.map((p) => (typeof p === 'string' ? new RegExp(p, 'i') : p));
    if (custom.some((p) => p.test(full))) return true;
  }

  // Find a "limit" line with a "resets" line nearby (works for single-line and
  // multi-line TUI renders). Skip the passive usage gauge — it carries both
  // "limit" and a "resets …" time but means you can still work.
  for (let i = 0; i < lines.length; i++) {
    if (USAGE_GAUGE_PATTERNS.some((p) => p.test(lines[i]))) continue;
    if (LIMIT_PATTERNS.some((p) => p.test(lines[i]))) {
      if (hasNearbyMatch(lines, i, RESET_PATTERNS)) return true;
    }
  }

  return false;
}

export function findRateLimitMessage(text: string): string | null {
  const lines = stripAnsi(text).split('\n');

  // Scan bottom-up so the most-recent reset line wins. Claude Code never clears
  // earlier banners from scrollback, so a stale "resets 11:30am" can linger
  // above a fresh "resets 4:30pm" — top-down would lock onto the stale one.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RESET_PATTERNS.some((p) => p.test(lines[i]))) return lines[i].trim();
  }

  // Fallback: most-recent "limit" line.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (LIMIT_PATTERNS.some((p) => p.test(lines[i]))) return lines[i].trim();
  }

  return null;
}

// --- Overload / transient API error detection (distinct from usage limits) ---
// Claude Code already retries 5xx/529 internally; this only fires on a *sustained*
// terminal error left on screen. Patterns are case-insensitive regexes (same as
// the usage-limit customPatterns), config-driven via `overload.patterns`. Kept
// entirely separate from the usage-limit path above so the two never collide.
//
// Two guards keep this from firing on ordinary content (the historical bug: a bare
// "503"/"529" in code under edit, an HTTP status in a quoted log, or "status.claude.com"
// in a comment all looked identical to a live error):
//   1. Patterns are ANCHORED to Claude Code's actual error render ("API Error: <code>"
//      or the "overloaded_error" JSON type) — never a bare status number.
//   2. Only the TAIL of the screen is inspected (see TAIL_LINES). A *terminal* error
//      is the last thing Claude printed; the same digits higher up the capture are
//      not an error.

export interface PatternMatch {
  pattern: string;
  line: string;
}

// Returns { pattern, line } for the first overload pattern matching a tail line,
// else null. Per-line (not whole-tail) so we can report WHICH line tripped it —
// invaluable for diagnosing a future false positive.
export function overloadMatch(text: string, patterns: Array<string | RegExp> = []): PatternMatch | null {
  if (!patterns || patterns.length === 0) return null;
  const lines = tail(text);
  if (!lines.join('').trim()) return null;
  const regexes = toRegexes(patterns);
  for (const line of lines) {
    for (const r of regexes) {
      if (r.test(line)) return { pattern: r.source, line: line.trim().slice(0, 200) };
    }
  }
  return null;
}

export function detectOverload(text: string, patterns: Array<string | RegExp> = []): boolean {
  return overloadMatch(text, patterns) !== null;
}
