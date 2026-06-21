import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetTime, calculateWaitMs } from '../src/time-parser.ts';

describe('parseResetTime', () => {
  it('parses "resets 3pm (Europe/Dublin)"', () => {
    const r = parseResetTime('5-hour limit reached - resets 3pm (Europe/Dublin)')!;
    assert.equal(r.hour, 15); assert.equal(r.minute, 0);
    assert.equal(r.timezone, 'Europe/Dublin');
  });
  it('parses "resets at 2pm (America/New_York)"', () => {
    const r = parseResetTime('Usage limit. Resets at 2pm (America/New_York)')!;
    assert.equal(r.hour, 14); assert.equal(r.timezone, 'America/New_York');
  });
  it('parses "resets 15:30 (Asia/Kolkata)"', () => {
    const r = parseResetTime('resets 15:30 (Asia/Kolkata)')!;
    assert.equal(r.hour, 15); assert.equal(r.minute, 30);
  });
  it('parses 12pm as noon', () => {
    const r = parseResetTime('resets 12pm (UTC)')!;
    assert.equal(r.hour, 12);
  });
  it('parses 12am as midnight', () => {
    const r = parseResetTime('resets 12am (UTC)')!;
    assert.equal(r.hour, 0);
  });
  it('handles no timezone', () => {
    const r = parseResetTime('resets 3pm')!;
    assert.equal(r.hour, 15); assert.equal(r.timezone, null);
  });
  it('returns null for unparseable text', () => {
    assert.equal(parseResetTime('some random text'), null);
  });
  it('parses "try again in 5 minutes" as relative time', () => {
    const r = parseResetTime('try again in 5 minutes')!;
    assert.ok(r.relative);
    assert.equal(r.waitMs, 5 * 60_000);
  });
  it('parses "try again in 2 hours" as relative time', () => {
    const r = parseResetTime('try again in 2 hours')!;
    assert.ok(r.relative);
    assert.equal(r.waitMs, 2 * 3_600_000);
  });
  it('parses "wait 30 mins" as relative time', () => {
    const r = parseResetTime('wait 30 mins')!;
    assert.ok(r.relative);
    assert.equal(r.waitMs, 30 * 60_000);
  });
  it('parses "resets in: 3 hours" as relative time', () => {
    const r = parseResetTime('usage limit · resets in: 3 hours')!;
    assert.ok(r.relative);
    assert.equal(r.waitMs, 3 * 3_600_000);
  });
  it('parses "resets in 2 hours" as relative time', () => {
    const r = parseResetTime('resets in 2 hours')!;
    assert.ok(r.relative);
    assert.equal(r.waitMs, 2 * 3_600_000);
  });
  it('parses dated weekly reset "resets May 28 at 7pm (Europe/Madrid)"', () => {
    const r = parseResetTime("You've hit your weekly limit · resets May 28 at 7pm (Europe/Madrid)")!;
    assert.equal(r.hasDate, true);
    assert.equal(r.month, 4);   // May (0-indexed)
    assert.equal(r.day, 28);
    assert.equal(r.hour, 19);
    assert.equal(r.minute, 0);
    assert.equal(r.timezone, 'Europe/Madrid');
  });
  it('parses dated weekly reset "Resets by 4:00 AM Friday Apr 24" (day-of-week ignored, no tz)', () => {
    const r = parseResetTime('Resets by 4:00 AM Friday Apr 24')!;
    assert.equal(r.hasDate, true);
    assert.equal(r.month, 3);   // Apr
    assert.equal(r.day, 24);
    assert.equal(r.hour, 4);
    assert.equal(r.minute, 0);
    assert.equal(r.timezone, null);
  });
  it('does not read the date day number as the clock hour', () => {
    const r = parseResetTime('resets May 28 at 7pm (UTC)')!;
    assert.equal(r.hour, 19);   // 7pm, not 28
    assert.equal(r.day, 28);
  });
  it('parses a dated weekly reset given in 24-hour time (no am/pm)', () => {
    const r = parseResetTime("You've hit your weekly limit · resets May 28 at 19:00 (Europe/Madrid)")!;
    assert.equal(r.hasDate, true);
    assert.equal(r.month, 4);   // May
    assert.equal(r.day, 28);
    assert.equal(r.hour, 19);
    assert.equal(r.minute, 0);
    assert.equal(r.ambiguous, false);
    assert.equal(r.timezone, 'Europe/Madrid');
  });
  it('parses a 24-hour "Resets by 19:00 Friday Apr 24" (day-of-week + month/day)', () => {
    const r = parseResetTime('Resets by 19:00 Friday Apr 24')!;
    assert.equal(r.hasDate, true);
    assert.equal(r.month, 3);   // Apr
    assert.equal(r.day, 24);
    assert.equal(r.hour, 19);
    assert.equal(r.minute, 0);
  });
  it('marks a bare 1-12 dated hour without am/pm as ambiguous', () => {
    const r = parseResetTime('resets May 28 at 7 (UTC)')!;
    assert.equal(r.hasDate, true);
    assert.equal(r.hour, 7);
    assert.equal(r.ambiguous, true);
  });
  it('does not misread a digit-bearing timezone as the dated clock', () => {
    const r = parseResetTime('resets May 28 at 19:00 (GMT+5:30)')!;
    assert.equal(r.hour, 19);   // 19:00, not 5:30 from the zone
    assert.equal(r.minute, 0);
  });
});

describe('calculateWaitMs', () => {
  it('returns positive wait for future time', () => {
    const now = new Date();
    const futureHour = (now.getUTCHours() + 2) % 24;
    const wait = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 60, 5, now);
    assert.ok(wait > 0);
    assert.ok(wait <= 3 * 3600_000);
  });
  it('adds margin seconds', () => {
    const now = new Date();
    const futureHour = (now.getUTCHours() + 1) % 24;
    const w0 = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 0, 5, now);
    const w120 = calculateWaitMs({ hour: futureHour, minute: 0, timezone: 'UTC' }, 120, 5, now);
    assert.ok(w120 - w0 >= 119_000 && w120 - w0 <= 121_000);
  });
  it('returns fallback when parsed is null', () => {
    const wait = calculateWaitMs(null, 60, 5);
    assert.ok(Math.abs(wait - (5 * 3600 + 60) * 1000) < 2000);
  });
  it('handles ambiguous hour by picking soonest future', () => {
    const now = new Date('2026-03-18T13:00:00Z');
    const wait = calculateWaitMs(
      { hour: 3, minute: 0, timezone: 'UTC', ambiguous: true }, 0, 5, now
    );
    assert.ok(wait > 0 && wait <= 3 * 3600_000);
  });
  it('handles relative time correctly', () => {
    const wait = calculateWaitMs({ relative: true, waitMs: 300_000 }, 60, 5);
    assert.ok(Math.abs(wait - 360_000) < 2000); // 5 min + 60s margin
  });
  it('falls back on invalid timezone', () => {
    const wait = calculateWaitMs({ hour: 15, minute: 0, timezone: 'Invalid/Zone' }, 60, 5);
    assert.ok(Math.abs(wait - (5 * 3600 + 60) * 1000) < 2000); // fallback
  });

  // Issue #6: UTC+ zones used to compute the reset as "tomorrow" (~25h over-wait).
  it('does not over-wait ~24h for a same-day UTC+ reset (Asia/Tokyo)', () => {
    const now = new Date('2026-04-15T09:43:47Z'); // 18:43 JST
    const wait = calculateWaitMs({ hour: 20, minute: 0, timezone: 'Asia/Tokyo' }, 60, 5, now);
    assert.ok(wait > 3600_000 && wait < 2 * 3600_000, `expected ~1.3h, got ${wait / 3600000}h`);
  });
  it('does not over-wait a day for a positive-offset reset (Australia/Melbourne)', () => {
    const now = new Date('2026-06-15T00:02:00Z'); // 10:02 AEST (UTC+10, no DST in June)
    const wait = calculateWaitMs({ hour: 23, minute: 40, timezone: 'Australia/Melbourne' }, 0, 5, now);
    assert.ok(wait > 12 * 3600_000 && wait < 15 * 3600_000, `expected ~13.6h, got ${wait / 3600000}h`);
  });

  // Weekly limits (user choice: wait fully).
  it('waits days for a dated weekly reset', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    const wait = calculateWaitMs({ hasDate: true, month: 4, day: 28, hour: 19, minute: 0, timezone: 'Europe/Madrid' }, 0, 5, now);
    assert.ok(wait > 6 * 86400_000 && wait < 8 * 86400_000, `expected ~7 days, got ${wait / 86400000} days`);
  });
  it('rolls a dated reset to next year only across a real year boundary (Dec→Jan)', () => {
    const now = new Date('2026-12-30T00:00:00Z');
    const wait = calculateWaitMs({ hasDate: true, month: 0, day: 2, hour: 9, minute: 0, timezone: 'UTC' }, 0, 5, now);
    assert.ok(wait > 2 * 86400_000 && wait < 4 * 86400_000, `expected ~3 days, got ${wait / 86400000} days`);
  });
  it('does not wait ~a year for a dated reset that only just elapsed', () => {
    const now = new Date('2026-05-28T19:30:00Z'); // 30 min after a 7pm UTC reset
    const wait = calculateWaitMs({ hasDate: true, month: 4, day: 28, hour: 19, minute: 0, timezone: 'UTC' }, 60, 5, now);
    assert.ok(wait < 3600_000, `expected ~0 (just elapsed), got ${wait / 86400000} days`);
  });
  it('picks the future reading for an ambiguous dated time whose am reading elapsed', () => {
    const now = new Date('2026-05-28T13:00:00Z'); // 13:00 UTC on the reset day
    // "resets May 28 at 7" with no am/pm: 07:00 already passed, 19:00 is ~6h away.
    const wait = calculateWaitMs(
      { hasDate: true, month: 4, day: 28, hour: 7, minute: 0, timezone: 'UTC', ambiguous: true }, 0, 5, now
    );
    assert.ok(wait > 5 * 3600_000 && wait < 7 * 3600_000, `expected ~6h (19:00), got ${wait / 3600000}h`);
  });
});
