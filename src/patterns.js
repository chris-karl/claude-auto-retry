// Full CSI sequence range per ECMA-48: parameter/intermediate bytes (0x20-0x3f) + final byte (0x40-0x7e)
// Covers standard, private-mode (\x1b[?25h), and extended sequences
const CSI_REGEX = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
// OSC sequences: \x1b] ... (terminated by BEL \x07 or ST \x1b\\)
// Covers hyperlinks (\x1b]8;;url\x1b\\), window titles (\x1b]0;title\x07), etc.
const OSC_REGEX = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// DCS sequences: \x1bP ... ST
const DCS_REGEX = /\x1bP[\s\S]*?(?:\x07|\x1b\\)/g;
// APC, SOS, PM sequences: \x1b[_X^] ... ST
const OTHER_ESC_REGEX = /\x1b[_X^][\s\S]*?(?:\x07|\x1b\\)/g;

export function stripAnsi(text) {
  return text
    .replace(OSC_REGEX, '')
    .replace(DCS_REGEX, '')
    .replace(OTHER_ESC_REGEX, '')
    .replace(CSI_REGEX, '');
}

// Claude Code renders rate limits across multiple lines in its TUI, e.g.:
//   "⚠ You've hit your limit"
//   "· resets 3pm (UTC)"
// Detection: find a "limit" line and a "resets" line within 6 lines of each other.

const LIMIT_PATTERNS = [
  // Allow any words (session / weekly / 5-hour / none) between "your|the" and
  // "limit" so newer wordings like "You've hit your session limit" and
  // "You've hit your weekly limit" match, not just the old "N-hour limit".
  /(?:hit|exceeded|reached).*(?:your|the)\s*(?:[\w-]+\s+)*limit/i,  // "hit/exceeded/reached your <…> limit"
  /\d+-hour limit/i,                                // "5-hour limit"
  /limit reached/i,                                  // "limit reached" / "Weekly limit reached"
  /session limit/i,                                  // "You've hit your session limit"
  /weekly limit/i,                                   // "You've hit your weekly limit"
  /usage limit/i,                                    // "usage limit"
  /out of.*usage/i,                                  // "out of extra usage"
  /rate limit/i,                                     // "rate limit"
  /try again in/i,                                   // "try again in X hours" (implies rate limiting)
];

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';

const RESET_PATTERNS = [
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,   // "resets 3pm" / "resets at 3:00 PM"
  /resets?\s+in[:\s]\s*\d/i,                                   // "resets in: 3 hours"
  /try again in \d+\s*(?:hours?|minutes?|h|m)/i,               // "try again in 5 hours"
  // Weekly-limit resets carry a calendar date, e.g.
  //   "resets May 28 at 7pm (Europe/Madrid)"
  //   "Resets by 4:00 AM Friday Apr 24"
  new RegExp(String.raw`resets?\b[^\n]*\b${MONTH}[a-z]*\.?\s+\d{1,2}\b`, 'i'),  // "resets … May 28"
  new RegExp(String.raw`resets?\b[^\n]*\b\d{1,2}\s+${MONTH}`, 'i'),             // "resets … 28 May"
];

// Newer Claude Code surfaces an interactive menu when a limit is hit, e.g.:
//   ❯ /rate-limit-options
//   You've hit your session limit · resets 6:50pm (Europe/London)
//   What do you want to do?
//   ❯ 1. Stop and wait for limit to reset
//     2. Upgrade your plan
//     3. Upgrade to Team plan
//   Enter to confirm · Esc to cancel
// The option ORDER VARIES between plans/versions (sometimes "Upgrade your plan"
// is the highlighted default), so pressing Enter is unsafe — it can confirm
// "Upgrade your plan". We detect the menu so the monitor can dismiss it with
// Escape and then submit the retry message once the limit resets. Markers are
// limit-specific so a generic "What do you want to do?" menu won't trip it.
const MENU_LIMIT_MARKERS = [
  /\/rate-limit-options/i,
  /Stop and wait for limit to reset/i,
  /Wait for limit to reset/i,
  /Adjust monthly spend limit/i,
];

export function isLimitMenuPrompt(text) {
  const stripped = stripAnsi(text);
  if (!/What do you want to do\?/i.test(stripped)) return false;
  return MENU_LIMIT_MARKERS.some((p) => p.test(stripped));
}

// "esc to interrupt" is Claude Code's stable "I'm processing" footer — shown
// while thinking/streaming regardless of the whimsical spinner word. If it's
// visible, Claude is actively working, so a rate-limit banner still lingering
// in the captured scrollback is stale and must not be treated as a fresh limit
// (which would interrupt the running task). Note: the limit menu shows "Esc to
// cancel", not "esc to interrupt", so this never collides with menu detection.
export function isClaudeBusy(text) {
  return /esc to interrupt/i.test(stripAnsi(text));
}

const WINDOW = 6;

function hasNearbyMatch(lines, idx, patterns) {
  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(lines.length, idx + WINDOW + 1);
  for (let j = start; j < end; j++) {
    if (patterns.some(p => p.test(lines[j]))) return true;
  }
  return false;
}

export function isRateLimited(text, customPatterns = []) {
  const lines = stripAnsi(text).split('\n');

  // Custom patterns: check full text (user controls their own regex)
  if (customPatterns.length > 0) {
    const full = lines.join('\n');
    const custom = customPatterns.map(p => typeof p === 'string' ? new RegExp(p, 'i') : p);
    if (custom.some(p => p.test(full))) return true;
  }

  // Find a "limit" line with a "resets" line nearby (works for both
  // single-line messages and multi-line TUI renders)
  for (let i = 0; i < lines.length; i++) {
    if (LIMIT_PATTERNS.some(p => p.test(lines[i]))) {
      if (hasNearbyMatch(lines, i, RESET_PATTERNS)) return true;
    }
  }

  return false;
}

export function findRateLimitMessage(text, customPatterns = []) {
  const lines = stripAnsi(text).split('\n');

  // Scan bottom-up so the most-recent reset line wins. Claude Code never clears
  // earlier banners from scrollback, so a stale "resets 11:30am" can linger
  // above a fresh "resets 4:30pm" — top-down would lock onto the stale one.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RESET_PATTERNS.some(p => p.test(lines[i]))) return lines[i].trim();
  }

  // Fallback: most-recent "limit" line.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (LIMIT_PATTERNS.some(p => p.test(lines[i]))) return lines[i].trim();
  }

  return null;
}
