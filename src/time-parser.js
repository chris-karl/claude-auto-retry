const RESET_TIME_REGEX = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const RELATIVE_TIME_REGEX = /(?:try again|wait|resets?\s+in)[:\s]\s*(?:for\s+)?(?:in\s+)?(\d+)\s*(hours?|minutes?|mins?|h|m)\b/i;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH_DAY_REGEX = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;  // "May 28"
const DAY_MONTH_REGEX = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;     // "28 May"
const CLOCK_REGEX = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;  // "7pm" / "4:00 AM" (am/pm required here)

// Weekly limits report a calendar date, e.g.
//   "You've hit your weekly limit · resets May 28 at 7pm (Europe/Madrid)"
//   "Resets by 4:00 AM Friday Apr 24"
// Parse the month/day and the clock time separately so the day number isn't
// mistaken for the hour.
function parseDatedReset(text) {
  if (!/reset/i.test(text)) return null;

  let month, day, dateStr;
  let m = text.match(MONTH_DAY_REGEX);
  if (m) { month = MONTHS[m[1].slice(0, 3).toLowerCase()]; day = parseInt(m[2], 10); dateStr = m[0]; }
  else {
    m = text.match(DAY_MONTH_REGEX);
    if (m) { day = parseInt(m[1], 10); month = MONTHS[m[2].slice(0, 3).toLowerCase()]; dateStr = m[0]; }
  }
  if (month === undefined) return null;

  // Strip the matched date so its day number can't be read as the clock hour.
  const t = text.replace(dateStr, ' ').match(CLOCK_REGEX);
  let hour = 0, minute = 0;
  if (t) {
    hour = parseInt(t[1], 10);
    minute = t[2] ? parseInt(t[2], 10) : 0;
    const ampm = t[3].toLowerCase();
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  }
  const tzMatch = text.match(/\(([^)]+)\)/);
  return { hasDate: true, month, day, hour, minute, timezone: tzMatch ? tzMatch[1] : null };
}

export function parseResetTime(text) {
  // Dated (weekly) reset first: "resets May 28 at 7pm (Europe/Madrid)"
  const dated = parseDatedReset(text);
  if (dated) return dated;

  // Try absolute time next: "resets at 3pm (UTC)"
  const absMatch = text.match(RESET_TIME_REGEX);
  if (absMatch) {
    let hour = parseInt(absMatch[1], 10);
    const minute = absMatch[2] ? parseInt(absMatch[2], 10) : 0;
    const ampm = absMatch[3]?.toLowerCase() || null;
    const timezone = absMatch[4] || null;

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const ambiguous = !ampm && hour >= 1 && hour <= 12;
    return { hour, minute, timezone, ambiguous };
  }

  // Try relative time: "try again in 5 minutes" / "wait 2 hours"
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

export function calculateWaitMs(parsed, marginSeconds = 60, fallbackHours = 5, now = new Date()) {
  if (!parsed) return (fallbackHours * 3600 + marginSeconds) * 1000;

  // Handle relative times: "try again in 5 minutes"
  if (parsed.relative) {
    return parsed.waitMs + marginSeconds * 1000;
  }

  let tz;
  try {
    tz = parsed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Validate timezone early to avoid cryptic errors later
    Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    // Invalid timezone (possibly garbled by TUI capture) — use fallback
    return (fallbackHours * 3600 + marginSeconds) * 1000;
  }

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const g = (parts, type) => parseInt(parts.find(p => p.type === type).value, 10);

  // Resolve the UTC timestamp for a given wall-clock h:m on a given calendar
  // day in the target timezone. `dateOverride` (for dated weekly resets) pins
  // the month/day (and optionally year); otherwise today's date in tz is used.
  //
  // The initial guess is anchored to the target tz's actual UTC offset at
  // `now` (offset = tz wall-clock interpreted as UTC, minus real UTC). This
  // avoids the old bug where the wall-clock was treated as UTC, pushing UTC+
  // zones a full day forward (e.g. 8pm Asia/Tokyo computed as tomorrow). The
  // short correction loop then nudges for any DST offset change, normalizing
  // each step to the nearest day so it never overshoots by ~24h.
  function getTargetTimestamp(h, m, dateOverride = null) {
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

  // Dated weekly reset: compute the exact future instant. If this year's date
  // is well in the past it's a year boundary (e.g. "Jan 2" seen in December) —
  // advance a year. A date that only just elapsed is a stale banner for a reset
  // that already happened, so leave it as-is (wait ≈ 0) rather than waiting ~12
  // months.
  if (parsed.hasDate) {
    let candidate = getTargetTimestamp(parsed.hour, parsed.minute, { month: parsed.month, day: parsed.day });
    if (candidate < now.getTime() - 2 * 86400_000) {
      const yNow = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(now), 10);
      candidate = getTargetTimestamp(parsed.hour, parsed.minute, { year: yNow + 1, month: parsed.month, day: parsed.day });
    }
    return Math.max(0, candidate - now.getTime()) + marginSeconds * 1000;
  }

  if (parsed.ambiguous) {
    const t1 = getTargetTimestamp(parsed.hour, parsed.minute);
    const t2 = getTargetTimestamp(parsed.hour + 12, parsed.minute);
    const d1 = t1 - now.getTime();
    const d2 = t2 - now.getTime();

    let target;
    if (d1 > 0 && d2 > 0) target = Math.min(d1, d2);
    else if (d1 > 0) target = d1;
    else if (d2 > 0) target = d2;
    else target = d1 + 86400_000; // tomorrow

    return Math.max(0, target) + marginSeconds * 1000;
  }

  let diff = getTargetTimestamp(parsed.hour, parsed.minute) - now.getTime();
  if (diff < 0) diff += 86400_000; // tomorrow

  return diff + marginSeconds * 1000;
}
