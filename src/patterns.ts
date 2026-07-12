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

const screenLines = (text: string): string[] => stripAnsi(text).split('\n');

// Companion line under a LIVE limit banner ("… /usage-credits to finish …").
// Doubles as chrome furniture and as the live-limit backstop signal below.
const USAGE_CREDITS = /\/usage-credits\b/i;

// Claude is mid-flight (streaming, or running its OWN internal API retry) — the
// screen is not in a terminal state and must not be acted on. (The limit menu
// shows "Esc to cancel", not "esc to interrupt", so no collision.) Defined up
// here because isChromeLine must never strip a live working footer.
const WORKING_PATTERNS: RegExp[] = [
  /esc to interrupt/i,        // the working/streaming footer ("… (esc to interrupt)")
  /\besc\b.*\binterrupt\b/i,  // tolerate reordering/spacing in the same footer
  /Retrying in\b/i,           // internal-retry suffix — retries not yet exhausted
  /\battempt\s+\d+\/\d+/i,    // "attempt 3/10" companion to the retry suffix
  // Blocked awaiting a subagent = working. Live-only render (gone the moment the
  // agent finishes) — the lingering "Backgrounded agent" transcript notice is NOT
  // working, or an idle limited session would never be retried.
  /waiting for \d+ background agents? to finish/i,
];
const isWorkingLine = (l: string): boolean => WORKING_PATTERNS.some((p) => p.test(l));

// --- Chrome-aware tail ---
// Claude Code renders UI chrome (input box, footer, task widget, spinner, hints)
// BELOW the content, so a tall widget pushes a live banner far up the screen and a
// fixed last-N-lines tail scrolls right past it. Stripping trailing chrome first
// makes the tail measure distance in CONTENT lines. Each entry must be anchored to
// the actual render, not a bare glyph: wrongly stripping content pulls a stale
// scrollback banner back into the window (a false retry).
const CHROME_LINE: RegExp[] = [
  /^\s*$/,                                // blank
  /^[\s─│╭╮╰╯┌┐└┘├┤┬┴┼▏▕|]+$/,             // box-drawing / rules
  /^\s*│\s*[>❯][^│]*│\s*$/,                // boxed input row "│ > … │" — needs the prompt glyph,
                                           // and [^│] rejects psql/duf table rows (content)
  /^\s*[❯>]\s*$/,                          // empty input prompt (bare, unboxed)
  /^\s*⏵⏵/,                                // mode footer ("⏵⏵ auto mode on…")
  /Allowed by auto mode/i,                // permission notice (bare "auto mode" matches prose)
  /shift\+tab to (?:cycle|select)/i,      // tab-cycle footer hint
  /^\s*\?\s+for shortcuts\b/i,             // "? for shortcuts" footer hint
  /\|\s*v\d+\.\d+\.\d+\b/,                 // footer version segment ("… | v2.1.201"), pipe-anchored
  /^\s+[□◻■◼▢▪◽◾✓✔☐☑]\s+\S/,                // INDENTED todo items (flush-left "✓ Fixed…" is content)
  /^\s*\d+\s+tasks?\s+\(/i,                 // task widget header — the "(" rejects prose
  /^\s*…\s*\+\d+\b/,                       // "… +N completed"
  /\/clear to save/i,                     // "new task? /clear to save …" hint
  USAGE_CREDITS,                           // live-limit companion hint (shared w/ the backstop)
  /^\s*[✻✢✽✳✴✶✷]\s/,                       // status spinner ("✻ Brewed for …")
  /Backgrounded agent \(|to manage · /i,   // background-agent notice — the "(" rejects prose
];
// A live working footer ("✻ Cogitating… (esc to interrupt)") matches the spinner
// glyph pattern, so exclude working lines — they are content, never furniture.
const isChromeLine = (l: string): boolean => !isWorkingLine(l) && CHROME_LINE.some((r) => r.test(l));

// Last `n` lines AFTER dropping trailing chrome. maxRaw additionally caps the reach
// above the raw bottom — the overload path uses it because anything reachable only
// past a tall widget is stale scrollback, not a live error.
function contentTail(lines: string[], n: number, maxRaw = Infinity): string[] {
  let end = lines.length;
  while (end > 0 && isChromeLine(lines[end - 1])) end--;
  const start = Math.max(0, end - n, lines.length - maxRaw);
  return lines.slice(start, end);
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

// Tail-anchored: a LIVE menu sits at the bottom of the screen, while the same
// text higher up is quoted content and must not drive Escape + retry injection.
// Chrome-aware so a menu pushed up by a tall widget is still seen (menu lines are
// not chrome, so contentTail keeps them); no raw bound.
export function isLimitMenuPrompt(text: string): boolean {
  const t = contentTail(screenLines(text), TAIL_LINES).join('\n');
  if (!/What do you want to do\?/i.test(t)) return false;
  return MENU_LIMIT_MARKERS.some((p) => p.test(t));
}

// Chrome-aware so isWorking measures the SAME bottom as the detectors — a live
// working footer above a tall chrome stack was invisible to a raw tail while the
// chrome-aware detectors still saw a lingering banner, letting retry text land in
// a mid-flight session.
export function isWorking(text: string): boolean {
  return contentTail(screenLines(text), TAIL_LINES).some(isWorkingLine);
}

// --- Tail anchoring (shared by the overload and safeguard paths) ---
// A *terminal* error or live status footer is the last thing on screen, sitting
// just above the input box (~5-6 variable lines: box borders + input row(s) +
// footer). A multi-line JSON error body adds a few more, so its anchor line can
// land ~10 rows from the bottom. 12 content lines cover that with margin while
// still trimming the top of the capture, where stale scrollback lives.
const TAIL_LINES = 12;
// Raw-distance cap: an error only reachable by chrome-stripping past a tall widget
// is stale scrollback, not a live terminal error. (The limit path has no such
// bound — its banner is pinned by the reset time.)
const OVERLOAD_MAX_RAW_LINES = 20;

function tail(text: string): string[] {
  return contentTail(screenLines(text), TAIL_LINES, OVERLOAD_MAX_RAW_LINES);
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

// tailLines > 0 restricts detection to the last N CONTENT lines (chrome-aware): a
// live banner sits at the prompt, while the same words higher up are quoted
// scrollback and must not drive a retry. 0 = scan everything (print mode).
export function isRateLimited(text: string, customPatterns: Array<string | RegExp> = [], tailLines = 0): boolean {
  const all = screenLines(text);
  const lines = tailLines > 0 ? contentTail(all, tailLines) : all;

  // Custom patterns test the RAW tail, not the chrome-stripped window: a pattern
  // keyed on footer text must still fire even though the built-in path strips the
  // footer as furniture. Same tailLines bound.
  if (customPatterns.length > 0) {
    const raw = tailLines > 0 ? all.slice(-tailLines) : all;
    const full = raw.join('\n');
    const custom = customPatterns.map((p) => (typeof p === 'string' ? new RegExp(p, 'i') : p));
    if (custom.some((p) => p.test(full))) return true;
  }

  // Backstop: a live limit prints the /usage-credits companion by the banner, so
  // companion + a reset line nearby catches a banner behind chrome the allowlist
  // doesn't recognize. Same liveness discipline as the main path: trusted only with
  // nothing but chrome below it (a resumed session's scrollback has real work under
  // the stale companion), and a reset line is required (a session merely explaining
  // /usage-credits has none).
  if (tailLines > 0) {
    const companionIdx = all.findLastIndex((l) => USAGE_CREDITS.test(l));
    if (companionIdx !== -1
        && all.slice(companionIdx + 1).every(isChromeLine)
        && hasNearbyMatch(all, companionIdx, RESET_PATTERNS)) {
      return true;
    }
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
  const lines = screenLines(text);

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

// Both a real overload and a real safeguard flag always render as an `API Error:`
// line; requiring one near the matched pattern keeps the phrases ("temporarily
// limiting requests", "overloaded_error", the AUP link) from firing when they are
// merely quoted or discussed in the session.
const API_ERROR_ANCHOR: RegExp[] = [/\bAPI Error\b/i];

// Returns { pattern, line } for the first pattern matching a tail line with an
// `API Error` line nearby, else null. Per-line so the log can report WHICH line
// tripped it — invaluable for diagnosing a future false positive.
function apiErrorAnchoredMatch(text: string, patterns: Array<string | RegExp>): PatternMatch | null {
  if (!patterns || patterns.length === 0) return null;
  const lines = tail(text);
  if (!lines.join('').trim()) return null;
  const regexes = toRegexes(patterns);
  for (let i = 0; i < lines.length; i++) {
    for (const r of regexes) {
      if (r.test(lines[i]) && hasNearbyMatch(lines, i, API_ERROR_ANCHOR)) {
        return { pattern: r.source, line: lines[i].trim().slice(0, 200) };
      }
    }
  }
  return null;
}

export function overloadMatch(text: string, patterns: Array<string | RegExp> = []): PatternMatch | null {
  return apiErrorAnchoredMatch(text, patterns);
}

export function detectOverload(text: string, patterns: Array<string | RegExp> = []): boolean {
  return overloadMatch(text, patterns) !== null;
}

// --- Safeguard / AUP false-positive detection ---
// A distinct failure mode from usage limits and 5xx overloads: the model's safeguards
// flag the message (often a false positive — the error itself says it "may flag safe,
// normal content"). It renders like:
//   ● API Error: <model>'s safeguards flagged this message (…/legal/aup). … Claude Code
//     can't respond to this request with <model>.
//     Double press esc to edit your last message, or try a different model with /model.
// Because the flag is semi-random, an immediate re-send frequently clears it — but it
// must be capped so a *sticky* flag doesn't loop forever.
export function safeguardMatch(text: string, patterns: Array<string | RegExp> = []): PatternMatch | null {
  return apiErrorAnchoredMatch(text, patterns);
}

export function detectSafeguard(text: string, patterns: Array<string | RegExp> = []): boolean {
  return safeguardMatch(text, patterns) !== null;
}
