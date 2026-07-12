import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, isRateLimited, findRateLimitMessage, isLimitMenuPrompt, isWorking } from '../src/patterns.ts';

describe('stripAnsi', () => {
  it('removes bold codes', () => {
    assert.equal(stripAnsi('\x1b[1mlimit\x1b[0m'), 'limit');
  });
  it('removes color codes', () => {
    assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  });
  it('removes cursor positioning', () => {
    assert.equal(stripAnsi('\x1b[2Jhello\x1b[H'), 'hello');
  });
  it('leaves plain text unchanged', () => {
    assert.equal(stripAnsi('plain text'), 'plain text');
  });
  it('handles mixed content', () => {
    assert.equal(
      stripAnsi('5-hour \x1b[1mlimit\x1b[0m reached - resets 3pm'),
      '5-hour limit reached - resets 3pm'
    );
  });
});

describe('isRateLimited', () => {
  it('detects "5-hour limit reached"', () => {
    assert.equal(isRateLimited('5-hour limit reached - resets 3pm'), true);
  });
  it('detects "usage limit" with reset', () => {
    assert.equal(isRateLimited('Claude usage limit reached. Resets at 2pm'), true);
  });
  it('detects "out of extra usage"', () => {
    assert.equal(isRateLimited("You're out of extra usage · resets 3pm"), true);
  });
  it('detects "try again in 5 hours"', () => {
    assert.equal(isRateLimited('Please try again in 5 hours'), true);
  });
  it('detects "rate limit resets"', () => {
    assert.equal(isRateLimited('Rate limit hit. Resets at 4pm'), true);
  });
  it('returns false for normal output', () => {
    assert.equal(isRateLimited('I can help you with that code'), false);
  });
  it('returns false for empty string', () => {
    assert.equal(isRateLimited(''), false);
  });
  it('detects rate limit with ANSI codes embedded', () => {
    assert.equal(isRateLimited('5-hour \x1b[1mlimit\x1b[0m reached - resets 3pm'), true);
  });
  it('matches custom patterns', () => {
    assert.equal(isRateLimited('custom error xyz', [/custom error/i]), true);
  });
  it('detects "You\'ve hit your limit" (real Claude Code message)', () => {
    assert.equal(isRateLimited("You've hit your limit · resets 3pm (Asia/Tbilisi)"), true);
  });
  it('detects "hit the limit resets"', () => {
    assert.equal(isRateLimited('You hit the limit. Resets at 5pm'), true);
  });
  it('detects "usage limit · resets in: 3 hours"', () => {
    assert.equal(isRateLimited('usage limit · resets in: 3 hours'), true);
  });
  it('detects new "session limit" wording (Claude Code update)', () => {
    assert.equal(isRateLimited("You've hit your session limit · resets 4:50pm (Asia/Shanghai)"), true);
  });
  it('detects new "weekly limit" wording with a clock time', () => {
    assert.equal(isRateLimited("You've hit your weekly limit · resets 9am (UTC)"), true);
  });
  it('detects "Weekly limit reached"', () => {
    assert.equal(isRateLimited('Weekly limit reached · resets 9am'), true);
  });
  it('detects dated weekly limit "resets May 28 at 7pm (Europe/Madrid)"', () => {
    assert.equal(isRateLimited("You've hit your weekly limit · resets May 28 at 7pm (Europe/Madrid)"), true);
  });
  it('detects dated weekly limit "Resets by 4:00 AM Friday Apr 24"', () => {
    assert.equal(isRateLimited("You've hit your weekly limit\nResets by 4:00 AM Friday Apr 24"), true);
  });
  it('detects a dated weekly limit given in 24-hour time (no am/pm)', () => {
    assert.equal(isRateLimited("You've hit your weekly limit · resets May 28 at 19:00 (Europe/Madrid)"), true);
  });
  it('does not treat a benign "session limit" mention as a rate limit', () => {
    assert.equal(isRateLimited('We were discussing the session limit feature in the meeting.'), false);
  });
  it('ignores the passive "used N% of your session limit" usage gauge', () => {
    assert.equal(isRateLimited("You've used 98% of your session limit · resets 8:40pm (Europe/Berlin) · /upgrade to keep using Claude Code"), false);
  });
  it('ignores the usage gauge as it appears in the footer (with shortcuts hint)', () => {
    assert.equal(isRateLimited("? for shortcuts · ← for agents          You've used 98% of your session limit · resets 8:40pm (Europe/Berlin) · /upgrade to keep using Claude Code"), false);
  });
  it('ignores the "used N% of your weekly limit" gauge too', () => {
    assert.equal(isRateLimited("You've used 75% of your weekly limit · resets May 28 at 7pm (Europe/Madrid)"), false);
  });
  it('still detects a real hit banner even when the usage gauge is also on screen', () => {
    const text = [
      "You've used 98% of your session limit · resets 8:40pm (Europe/Berlin)",
      "You've hit your session limit · resets 8:40pm (Europe/Berlin)",
    ].join('\n');
    assert.equal(isRateLimited(text), true);
  });
});

describe('isLimitMenuPrompt', () => {
  const menu = [
    '❯ /rate-limit-options',
    "You've hit your session limit · resets 6:50pm (Europe/London)",
    'What do you want to do?',
    '❯ 1. Stop and wait for limit to reset',
    '  2. Upgrade your plan',
    '  3. Upgrade to Team plan',
    'Enter to confirm · Esc to cancel',
  ].join('\n');
  const upgradeFirstMenu = [
    "You've hit your session limit · resets 6:50pm (Europe/London)",
    'What do you want to do?',
    '❯ 1. Upgrade your plan',
    '  2. Stop and wait for limit to reset',
    'Enter to confirm · Esc to cancel',
  ].join('\n');
  const spendMenu = [
    'What do you want to do?',
    '❯ Adjust monthly spend limit: Unlimited',
    '  Wait for limit to reset',
    '  Upgrade to Max for higher session limits every month',
  ].join('\n');

  it('detects the rate-limit-options menu', () => {
    assert.equal(isLimitMenuPrompt(menu), true);
  });
  it('detects the menu regardless of which option is highlighted first', () => {
    assert.equal(isLimitMenuPrompt(upgradeFirstMenu), true);
  });
  it('detects the spend-limit menu', () => {
    assert.equal(isLimitMenuPrompt(spendMenu), true);
  });
  it('ignores a generic "What do you want to do?" menu', () => {
    assert.equal(isLimitMenuPrompt('What do you want to do?\n❯ Open file\n  Close file'), false);
  });
  it('ignores menu text quoted above the tail of the capture', () => {
    const screen = [menu, ...Array(12).fill('● unrelated output'), '❯ '].join('\n');
    assert.equal(isLimitMenuPrompt(screen), false);
  });
  it('still detects a live menu at the bottom of a tall capture', () => {
    const screen = [...Array(12).fill('● earlier output'), menu].join('\n');
    assert.equal(isLimitMenuPrompt(screen), true);
  });
  it('returns false for normal output', () => {
    assert.equal(isLimitMenuPrompt('I can help you with that code'), false);
  });
});

describe('isWorking', () => {
  it('detects the "esc to interrupt" processing footer', () => {
    assert.equal(isWorking('✻ Cogitating… (12s · ↓ 3.4k tokens · esc to interrupt)'), true);
  });
  it('detects esc/interrupt through ANSI', () => {
    assert.equal(isWorking('\x1b[2mesc to interrupt\x1b[0m'), true);
  });
  it('returns false for normal output', () => {
    assert.equal(isWorking('Here is the code you asked for'), false);
  });
  it('does not confuse the menu\'s "Esc to cancel" with working', () => {
    assert.equal(isWorking('What do you want to do?\nEnter to confirm · Esc to cancel'), false);
  });
  // Claude's internal-retry indicator means retries are NOT exhausted → not terminal.
  it('treats the "Retrying in" suffix as still-working', () => {
    assert.equal(isWorking('API Error: 529 Overloaded · Retrying in 5s · attempt 3/10'), true);
  });
  it('treats an "attempt n/m" indicator as still-working', () => {
    assert.equal(isWorking('thinking… attempt 2/10'), true);
  });
  it('ignores a working footer that scrolled far up out of the tail', () => {
    const screen = ['old… (esc to interrupt)', ...Array(15).fill('● unrelated output'), '❯ '].join('\n');
    assert.equal(isWorking(screen), false);
  });
});

describe('stripAnsi (private-mode sequences)', () => {
  it('strips cursor hide sequence', () => {
    assert.equal(stripAnsi('\x1b[?25lhello\x1b[?25h'), 'hello');
  });
  it('strips bracketed paste mode', () => {
    assert.equal(stripAnsi('\x1b[?2004htext\x1b[?2004l'), 'text');
  });
});

describe('findRateLimitMessage', () => {
  it('returns the matching line from multiline input', () => {
    const text = 'Some output\n5-hour limit reached - resets 3pm (Europe/Dublin)\nMore output';
    assert.equal(findRateLimitMessage(text), '5-hour limit reached - resets 3pm (Europe/Dublin)');
  });
  it('returns null when no match', () => {
    assert.equal(findRateLimitMessage('normal output\nmore output'), null);
  });
  it('returns the resets line from multi-line TUI render', () => {
    const text = '⚠ You\'ve hit your limit\n· resets 3pm (UTC)';
    assert.equal(findRateLimitMessage(text), '· resets 3pm (UTC)');
  });
  it('returns Resets line when limit and resets on different lines', () => {
    const text = '5-hour limit reached\nResets at 3pm (UTC)';
    assert.ok(findRateLimitMessage(text)!.includes('3pm'));
  });
  it('returns the freshest reset line when a stale one lingers above', () => {
    const text = 'hit your limit · resets 11:30am (UTC)\nworked a while\nhit your limit · resets 4:30pm (UTC)';
    assert.ok(findRateLimitMessage(text)!.includes('4:30pm'));
  });
  it('returns the dated weekly reset line', () => {
    const text = "You've hit your weekly limit · resets May 28 at 7pm (Europe/Madrid)";
    assert.ok(findRateLimitMessage(text)!.includes('May 28'));
  });
});

describe('isRateLimited (multi-line TUI renders)', () => {
  it('detects limit + resets on separate lines', () => {
    assert.ok(isRateLimited('⚠ You\'ve hit your limit\n· resets 3pm (UTC)'));
  });
  it('detects box-drawing TUI format', () => {
    const text = '╭──────────╮\n│ ⚠ You\'ve hit your limit │\n│ · resets 3pm │\n╰──────────╯';
    assert.ok(isRateLimited(text));
  });
  it('detects 5-hour limit + Resets on separate lines', () => {
    assert.ok(isRateLimited('⚠ 5-hour limit reached\nResets at 3pm (UTC)'));
  });
  it('detects middle-dot separated multi-line', () => {
    assert.ok(isRateLimited('⚠ You\'ve hit your 5-hour limit\n· resets 3pm (Asia/Tbilisi)'));
  });
  it('rejects limit + resets too far apart (>6 lines)', () => {
    assert.equal(isRateLimited('hit your limit\n1\n2\n3\n4\n5\n6\n7\nresets 3pm'), false);
  });
  it('rejects normal output with no rate limit keywords', () => {
    assert.equal(isRateLimited('Working on your request\nHere is the code\nDone'), false);
  });
});

describe('stripAnsi (OSC sequences)', () => {
  it('strips OSC hyperlinks (\\x1b]8;;url\\x1b\\\\)', () => {
    const input = '\x1b]8;;https://example.com\x1b\\click here\x1b]8;;\x1b\\';
    assert.equal(stripAnsi(input), 'click here');
  });
  it('strips OSC window title (\\x1b]0;title\\x07)', () => {
    assert.equal(stripAnsi('\x1b]0;My Terminal\x07hello'), 'hello');
  });
  it('strips OSC + CSI mixed sequences', () => {
    const input = '\x1b]8;;url\x1b\\\x1b[33m5-hour limit reached - resets 3pm\x1b[0m\x1b]8;;\x1b\\';
    assert.equal(stripAnsi(input), '5-hour limit reached - resets 3pm');
  });
  it('rate limit detection works through OSC hyperlinks', () => {
    const input = '\x1b]8;;link\x1b\\5-hour limit reached\x1b]8;;\x1b\\ - resets 3pm';
    assert.ok(isRateLimited(input));
  });
});
