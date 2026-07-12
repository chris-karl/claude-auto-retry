export interface ParsedReset {
  hour?: number;
  minute?: number;
  timezone?: string | null;
  ambiguous?: boolean;
  relative?: boolean;
  waitMs?: number;
  hasDate?: boolean;
  month?: number;
  day?: number;
}

const RESET_TIME_REGEX = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const RELATIVE_TIME_REGEX = /(?:try again|wait|resets?\s+in)[:\s]\s*(?:for\s+)?(?:in\s+)?(\d+)\s*(hours?|minutes?|mins?|h|m)\b/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH_DAY_REGEX = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;  // "May 28"
const DAY_MONTH_REGEX = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;     // "28 May"
const CLOCK_REGEX = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;  // "7pm" / "4:00 AM" / "19:00"

// Weekly limits report a calendar date, e.g. "resets May 28 at 7pm (Europe/Madrid)"
// or "Resets by 4:00 AM Friday Apr 24". Parse the month/day and the clock time
// separately so the day number isn't mistaken for the hour. The clock's am/pm is
// optional: a 24-hour value is taken verbatim, while a bare 1-12 hour is marked
// ambiguous (resolved in calculateWaitMs).
function parseDatedReset(text: string): ParsedReset | null {
  if (!/reset/i.test(text)) return null;

  let month: number | undefined;
  let day: number | undefined;
  let dateStr: string | undefined;
  let m = text.match(MONTH_DAY_REGEX);
  if (m) { month = MONTHS[m[1].slice(0, 3).toLowerCase()]; day = parseInt(m[2], 10); dateStr = m[0]; }
  else {
    m = text.match(DAY_MONTH_REGEX);
    if (m) { day = parseInt(m[1], 10); month = MONTHS[m[2].slice(0, 3).toLowerCase()]; dateStr = m[0]; }
  }
  if (month === undefined || day === undefined || dateStr === undefined) return null;

  const tzMatch = text.match(/\(([^)]+)\)/);

  // Strip the matched date AND the parenthesized timezone before reading the
  // clock, so neither the day number nor a digit-bearing zone like "(GMT+5:30)"
  // is mistaken for the time (am/pm no longer anchors the clock match).
  let rest = text.replace(dateStr, ' ');
  if (tzMatch) rest = rest.replace(tzMatch[0], ' ');
  const t = rest.match(CLOCK_REGEX);

  let hour = 0, minute = 0, ambiguous = false;
  if (t) {
    hour = parseInt(t[1], 10);
    minute = t[2] ? parseInt(t[2], 10) : 0;
    // An out-of-range clock (a stray number the regex grabbed) is no clock at all —
    // keep the (valid) date and fall back to midnight rather than a nonsense time.
    if (hour > 23 || minute > 59) { hour = 0; minute = 0; }
    else {
      const ampm = t[3] ? t[3].toLowerCase() : null;
      if (ampm === 'pm' && hour !== 12) hour += 12;
      else if (ampm === 'am' && hour === 12) hour = 0;
      // No am/pm on a 1-12 hour is ambiguous; a 24-hour value (>=13, or 0) is taken as-is.
      else if (!ampm && hour >= 1 && hour <= 12) ambiguous = true;
    }
  }
  return { hasDate: true, month, day, hour, minute, timezone: tzMatch ? tzMatch[1] : null, ambiguous };
}

export function parseResetTime(text: string): ParsedReset | null {
  // Dated (weekly) reset first: "resets May 28 at 7pm (Europe/Madrid)"
  const dated = parseDatedReset(text);
  if (dated) return dated;

  // Absolute time next: "resets at 3pm (UTC)"
  const absMatch = text.match(RESET_TIME_REGEX);
  if (absMatch) {
    let hour = parseInt(absMatch[1], 10);
    const minute = absMatch[2] ? parseInt(absMatch[2], 10) : 0;
    const ampm = absMatch[3]?.toLowerCase() || null;
    const timezone = absMatch[4] || null;

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    // Reject an out-of-range clock (e.g. a bare "resets 30"): a bad hour/minute
    // would silently compute a nonsense wait. null → fallback.
    if (hour > 23 || hour < 0 || minute > 59) return null;

    const ambiguous = !ampm && hour >= 1 && hour <= 12;
    return { hour, minute, timezone, ambiguous };
  }

  // Relative time: "try again in 5 minutes" / "wait 2 hours"
  const relMatch = text.match(RELATIVE_TIME_REGEX);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const isMinutes = unit.startsWith('m');
    const ms = amount * (isMinutes ? 60_000 : 3_600_000);
    return { relative: true, waitMs: ms };
  }

  return null;
}

// Reset-boundary grace window: a parsed reset time in the recent PAST almost always
// means the reset just happened (the monitor can settle on the banner well after it),
// so retry promptly (wait = margin) instead of rolling a full day forward and parking
// the session ~24h. Only a reset further back plausibly means tomorrow.
const RESET_GRACE_MS = 60 * 60 * 1000; // 1 hour

function rollPastReset(diffMs: number): number {
  if (diffMs >= 0) return diffMs;
  return diffMs > -RESET_GRACE_MS ? 0 : diffMs + 86400_000;
}

export function calculateWaitMs(
  parsed: ParsedReset | null,
  marginSeconds = 60,
  fallbackHours = 5,
  now: Date = new Date(),
): number {
  if (!parsed) return (fallbackHours * 3600 + marginSeconds) * 1000;

  // Relative times: "try again in 5 minutes"
  if (parsed.relative) {
    return (parsed.waitMs ?? 0) + marginSeconds * 1000;
  }

  let tz: string;
  try {
    tz = parsed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Validate the timezone early to avoid cryptic errors later.
    Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    // Invalid timezone (possibly garbled by TUI capture) — use fallback.
    return (fallbackHours * 3600 + marginSeconds) * 1000;
  }

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const g = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number =>
    parseInt(parts.find((p) => p.type === type)!.value, 10);

  // Resolve the UTC timestamp for a wall-clock h:m on a calendar day in the
  // target timezone. `dateOverride` (for dated weekly resets) pins month/day
  // (and optionally year); otherwise today's date in tz is used.
  //
  // The initial guess is anchored to the tz's actual UTC offset at `now`, which
  // avoids the old bug where the wall-clock was treated as UTC and pushed UTC+
  // zones a full day forward. The correction loop then nudges for any DST offset
  // change, normalizing each step to the nearest day so it never overshoots ~24h.
  function getTargetTimestamp(
    h: number,
    m: number,
    dateOverride: { year?: number; month: number; day: number } | null = null,
  ): number {
    const nowParts = fmt.formatToParts(now);
    let y = g(nowParts, 'year');
    let mo = g(nowParts, 'month') - 1;
    let d = g(nowParts, 'day');
    const offset = Date.UTC(y, mo, d, g(nowParts, 'hour') % 24, g(nowParts, 'minute'), g(nowParts, 'second')) - now.getTime();

    if (dateOverride) {
      if (dateOverride.year != null) y = dateOverride.year;
      mo = dateOverride.month;
      d = dateOverride.day;
    }

    let candidate = Date.UTC(y, mo, d, h, m, 0) - offset;
    for (let i = 0; i < 4; i++) {
      const cp = fmt.formatToParts(new Date(candidate));
      const ch = g(cp, 'hour') % 24;
      const cm = g(cp, 'minute');
      let diffMin = (h - ch) * 60 + (m - cm);
      diffMin = ((diffMin % 1440) + 1440) % 1440;  // nearest occurrence, not next-day
      if (diffMin > 720) diffMin -= 1440;
      if (diffMin === 0) break;
      candidate += diffMin * 60_000;
    }
    return candidate;
  }

  const hour = parsed.hour ?? 0;
  const minute = parsed.minute ?? 0;

  // Dated weekly reset: compute the exact future instant. If this year's date is
  // well in the past it's a year boundary (e.g. "Jan 2" seen in December) —
  // advance a year. A date that only just elapsed is a stale banner for a reset
  // that already happened, so leave it (wait ≈ 0) rather than waiting ~12 months.
  if (parsed.hasDate) {
    const month = parsed.month ?? 0;
    const day = parsed.day ?? 1;
    const datedCandidate = (h: number, m: number): number => {
      let c = getTargetTimestamp(h, m, { month, day });
      if (c < now.getTime() - 2 * 86400_000) {
        const yNow = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(now), 10);
        c = getTargetTimestamp(h, m, { year: yNow + 1, month, day });
      }
      return c;
    };

    // An ambiguous clock yields two readings 12h apart; pick the soonest still-
    // future one. If neither is future (a stale banner), fall back to the most
    // recent → wait ≈ 0.
    const candidates = parsed.ambiguous
      ? [datedCandidate(hour, minute), datedCandidate((hour + 12) % 24, minute)]  // %24: 12 → 0, not next-day 24
      : [datedCandidate(hour, minute)];
    const future = candidates.filter((c) => c > now.getTime());
    const chosen = future.length ? Math.min(...future) : Math.max(...candidates);
    return Math.max(0, chosen - now.getTime()) + marginSeconds * 1000;
  }

  if (parsed.ambiguous) {
    const t1 = getTargetTimestamp(hour, minute);
    const t2 = getTargetTimestamp((hour + 12) % 24, minute);  // %24: 12 → 0 (midnight), never hour 24
    const d1 = t1 - now.getTime();
    const d2 = t2 - now.getTime();

    let target: number;
    if (d1 > 0 && d2 > 0) target = Math.min(d1, d2);
    else if (d1 > 0) target = d1;
    else if (d2 > 0) target = d2;
    else {
      // Both interpretations are past. Grace-check the MOST RECENT one (just passed?);
      // if rolling to tomorrow, roll the EARLIEST occurrence forward (t1 < t2 always),
      // not the later pm one — otherwise we wait ~12h longer than necessary.
      const recent = Math.max(d1, d2);
      target = recent > -RESET_GRACE_MS ? 0 : Math.min(d1, d2) + 86400_000;
    }

    return Math.max(0, target) + marginSeconds * 1000;
  }

  const diff = rollPastReset(getTargetTimestamp(hour, minute) - now.getTime());

  return diff + marginSeconds * 1000;
}
