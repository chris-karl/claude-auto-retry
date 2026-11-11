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
  /\besc\b.*\binterrupt\b/i,   // the working/streaming footer ("… (esc to interrupt)")
  // Claude Code's own API retry: "API Error (529 …) · Retrying in 5s · attempt 3/10".
  // The middle dots anchor to that render; a test runner's "Retrying in 5s" has none.
  /· Retrying in \d/i,
  /· attempt \d+\/\d+/i,
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
// above the raw bottom — the API-error path uses it because anything reachable only
// past a tall widget is stale scrollback, not a live error.
function contentTail(lines: string[], n: number, maxRaw = Infinity): string[] {
  let end = lines.length;
  while (end > 0 && isChromeLine(lines[end - 1])) end--;
  const start = Math.max(0, end - n, lines.length - maxRaw);
  return lines.slice(start, end);
}

// Claude Code renders a hit limit as a status row, e.g.
//   "Usage limit reached · limit resets 3:45pm"
//   "You've hit your weekly limit · resets Oct 9, 10am (Europe/Berlin)"
// or across two lines ("⚠ You've hit your limit" / "· resets 3pm (UTC)").
// Detection: a "limit" line with a "resets" line within WINDOW lines of it.

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
];

// Lines that carry "limit" words but are not a hit banner. The passive usage gauge
// ("You've used 98% of your session limit · resets 8:40pm", "Over 85% of your … used",
// "Approaching session limit", "You're close to your usage limit") means you can
// still work; and an API error line is never the usage banner (the API-level 429
// render reads "… (not your usage limit) · Rate limited").
const NOT_A_LIMIT_LINE: RegExp[] = [
  /\b(?:used\s+\d+(?:\.\d+)?%\s+of|over\s+\d+%\s+of|approaching|close to)\b.*\blimit\b/i,
  /\bAPI Error\b/i,
];

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';

const RESET_PATTERNS: RegExp[] = [
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,   // "resets 3pm" / "resets at 3:00 PM"
  /resets?\s+in[:\s]\s*\d/i,                                // "resets in: 3 hours"
  /try again in \d+\s*(?:hours?|minutes?|h|m)/i,            // "try again in 5 hours"
  // Weekly resets carry a calendar date: "resets Oct 9, 10am" / "Resets by … Apr 24".
  new RegExp(String.raw`resets?\b[^\n]*\b${MONTH}[a-z]*\.?\s+\d{1,2}\b`, 'i'),  // "resets … May 28"
  new RegExp(String.raw`resets?\b[^\n]*\b\d{1,2}\s+${MONTH}`, 'i'),             // "resets … 28 May"
];

// Claude Code surfaces an interactive menu when a limit is hit:
//   What do you want to do?
//   ❯ 1. Wait here, then continue automatically at 3:45pm
//     2. Stop and wait for limit to reset
//     3. Upgrade your plan
// The highlighted option VARIES between plans/versions, so pressing Enter is
// unsafe (it could confirm "Upgrade your plan"). We detect the menu so the
// monitor can dismiss it with Escape and submit the retry once the limit resets.
// Markers are limit-specific so a generic "What do you want to do?" won't trip it.
const MENU_LIMIT_MARKERS: RegExp[] = [
  /\/rate-limit-options/i,
  /Wait here, then continue automatically/i,
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

// --- Tail anchoring (shared by the limit and API-error paths) ---
// A *terminal* error or live status footer is the last thing on screen, sitting
// just above the input box (~5-6 variable lines: box borders + input row(s) +
// footer). A multi-line JSON error body adds a few more, so its anchor line can
// land ~10 rows from the bottom. 12 content lines cover that with margin while
// still trimming the top of the capture, where stale scrollback lives.
const TAIL_LINES = 12;
// Raw-distance cap: an error only reachable by chrome-stripping past a tall widget
// is stale scrollback, not a live terminal error. (The limit path has no such
// bound — its banner is pinned by the reset time.)
const API_ERROR_MAX_RAW_LINES = 20;

// Compile a config pattern (string → case-insensitive RegExp) once per call.
// Invalid regexes are dropped rather than thrown.
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

// The nearest line within WINDOW of idx matching any pattern (the line itself first,
// then alternating below/above), or null. Nearest-first so a stale reset time a few
// lines up never wins over the one on the live banner.
function nearbyMatch(lines: string[], idx: number, patterns: RegExp[]): string | null {
  for (let d = 0; d <= WINDOW; d++) {
    for (const j of d === 0 ? [idx] : [idx + d, idx - d]) {
      if (j >= 0 && j < lines.length && patterns.some((p) => p.test(lines[j]))) return lines[j].trim();
    }
  }
  return null;
}

// The live rate-limit line within the last `tailLines` CONTENT lines (chrome-aware),
// or null; 0 scans everything. Returns the line carrying the reset time when there
// is one, so the caller parses exactly what was detected. The same words further up
// the screen are quoted scrollback and must not drive a retry.
export function findRateLimit(text: string, customPatterns: Array<string | RegExp> = [], tailLines = 0): string | null {
  const all = screenLines(text);
  const lines = tailLines > 0 ? contentTail(all, tailLines) : all;

  // Custom patterns test the RAW tail, not the chrome-stripped window: a pattern
  // keyed on footer text must still fire even though the built-in path strips the
  // footer as furniture.
  if (customPatterns.length > 0) {
    const regexes = toRegexes(customPatterns);
    const hit = (tailLines > 0 ? all.slice(-tailLines) : all).findLast((l) => regexes.some((p) => p.test(l)));
    if (hit !== undefined) return hit.trim();
  }

  // Backstop: a live limit prints the /usage-credits companion by the banner, so
  // companion + a reset line nearby catches a banner behind chrome the allowlist
  // doesn't recognize. Trusted only with nothing but chrome below it (a resumed
  // session's scrollback has real work under the stale companion), and a reset line
  // is required (a session merely explaining /usage-credits has none).
  if (tailLines > 0) {
    const companionIdx = all.findLastIndex((l) => USAGE_CREDITS.test(l));
    if (companionIdx !== -1 && all.slice(companionIdx + 1).every(isChromeLine)) {
      const reset = nearbyMatch(all, companionIdx, RESET_PATTERNS);
      if (reset !== null) return reset;
    }
  }

  // A "limit" line with a "resets" line nearby, scanned bottom-up so the freshest
  // banner wins when a stale one lingers above it.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (NOT_A_LIMIT_LINE.some((p) => p.test(lines[i]))) continue;
    if (!LIMIT_PATTERNS.some((p) => p.test(lines[i]))) continue;
    const reset = nearbyMatch(lines, i, RESET_PATTERNS);
    if (reset !== null) return reset;
  }

  return null;
}

// --- API error detection (overload and safeguard renders; distinct from usage limits) ---
// Claude Code already retries 5xx/529 internally; this only fires on a *sustained*
// terminal error left on screen. Patterns are case-insensitive regexes from config.
//
// Two guards keep this from firing on ordinary content (the historical bug: a bare
// "503" in code under edit or a quoted log looked identical to a live error):
//   1. A match only counts near an `API Error` line, i.e. Claude Code's actual render.
//   2. Only the TAIL of the screen is inspected (see TAIL_LINES). A *terminal* error
//      is the last thing Claude printed; the same words higher up are not an error.

export interface PatternMatch {
  pattern: string;
  line: string;
}

const API_ERROR_ANCHOR: RegExp[] = [/\bAPI Error\b/i];

// Returns { pattern, line } for the first pattern matching a tail line with an
// `API Error` line nearby, else null. Per-line so the log can report WHICH line
// tripped it — invaluable for diagnosing a future false positive.
export function apiErrorMatch(text: string, patterns: Array<string | RegExp>): PatternMatch | null {
  if (!patterns || patterns.length === 0) return null;
  const lines = contentTail(screenLines(text), TAIL_LINES, API_ERROR_MAX_RAW_LINES);
  if (!lines.join('').trim()) return null;
  const regexes = toRegexes(patterns);
  for (let i = 0; i < lines.length; i++) {
    for (const r of regexes) {
      if (r.test(lines[i]) && nearbyMatch(lines, i, API_ERROR_ANCHOR) !== null) {
        return { pattern: r.source, line: lines[i].trim().slice(0, 200) };
      }
    }
  }
  return null;
}

// Claude Code's own auto-continue is armed: the live status row reads "Continuing
// automatically at 3:45pm · Esc to cancel" or "Continuing shortly · Esc to cancel".
// Capital C on purpose: the transcript notice it leaves behind ("Usage limit reached
// · continuing automatically … · esc to cancel") lingers after it has fired.
export function isNativeContinuing(text: string): boolean {
  return contentTail(screenLines(text), TAIL_LINES).some((l) => /\bContinuing (?:automatically|shortly)\b.*\b[Ee]sc to cancel\b/.test(l));
}
