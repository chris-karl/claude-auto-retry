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

describe('isRateLimited — chrome-aware tail (tailLines > 0)', () => {
  // A live banner pushed up by UI furniture is still found; a stale/quoted banner
  // with real work below it is not.
  const withChrome = (banner: string): string => [
    banner,
    "     /usage-credits to finish what you're working on.",
    '', '✻ Brewed for 12m 3s', '',
    '  8 tasks (4 done, 1 in progress, 3 open)',
    '  ◼ a', '  □ b', '  □ c', '  ✓ d', '   … +3 completed',
    '  new task? /clear to save 300k tokens',
    '', '──────', '❯ ', '──────',
    '  Opus 4.8 | repo@dev | v2.1.201', '  ⏵⏵ auto mode on',
  ].join('\n');
  it('finds a banner buried behind a task widget + input box (tail=12)', () => {
    assert.equal(isRateLimited(withChrome("You've hit your session limit · resets 2am (Europe/Zurich)"), [], 12), true);
  });
  it('finds it via the /usage-credits companion even without the reset on the banner line', () => {
    const pane = ['Ran 1 shell command', '  └ Session limit hit',
      "     /usage-credits to finish what you're working on. resets 2am",
      '', '  8 tasks (4 done, 1 in progress, 3 open)', '  □ a', '  □ b', '  □ c', '  □ d', '  □ e', '  □ f', '  □ g', '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), true);
  });
  // A session EXPLAINING /usage-credits (companion + a loose "usage limit" match,
  // but no reset time) must not fire the backstop.
  it('does NOT backstop-fire on a conversation explaining /usage-credits (no reset nearby)', () => {
    const pane = ['When you hit your usage limit you can run',
      '/usage-credits to purchase extra usage.', '', '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  // The backstop needs the main path's liveness discipline: a resumed session's
  // scrollback contains the stale banner+companion with real work rendered BELOW it.
  it('does NOT fire on a stale banner+companion with real work rendered below (resumed session)', () => {
    const pane = [
      "You've hit your session limit · resets 2am (Europe/Zurich)",
      "     /usage-credits to finish what you're working on.",
      ...Array(15).fill('● wrote some code'),
      '❯ ',
    ].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  it('does NOT fire when a stale companion sits above later non-chrome output', () => {
    const pane = [
      '  └ Session limit hit · /usage-credits to finish. resets 2am',
      '● Ran a shell command',
      '  └ done',
      ...Array(12).fill('● more real work after the resume'),
      '❯ ',
    ].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  it('does NOT fire on a quoted banner with real work below it (tail=12)', () => {
    const pane = ["You've hit your session limit · resets 3pm (UTC)",
      ...Array(15).fill('● wrote some code'), '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  it('full scan (tailLines=0, print mode) is unaffected by chrome logic', () => {
    assert.equal(isRateLimited("You've hit your session limit · resets 3pm (UTC)", [], 0), true);
  });

  // Custom patterns test the RAW tail, not the chrome-stripped window — a pattern
  // keyed on footer text must still fire even though the footer is furniture.
  it('matches a footer-keyed custom pattern in the raw tail (not chrome-stripped)', () => {
    const pane = [
      ...Array(6).fill('● ordinary work'),
      '  Opus 4.8 | repo@dev | 5h 3% left @02:00 | v2.1.201',
      '  ⏵⏵ auto mode on',
      '❯ ',
    ].join('\n');
    assert.equal(isRateLimited(pane, [/\b3% left\b/i], 12), true);
  });

  // The banner-behind-a-widget fix must also fire for the BOXED input render.
  const widget = ['  8 tasks (4 done, 1 in progress, 3 open)',
    '  □ a', '  □ b', '  □ c', '  □ d', '  □ e', '  □ f', '  □ g', '   … +3 completed',
    '  new task? /clear to save 300k tokens'];
  const banner = "You've hit your session limit · resets 3pm (UTC)";
  it('finds a banner behind a widget above a BARE prompt (tail=12)', () => {
    const bare = ['───────', '❯ ', '───────', '  ⏵⏵ auto mode on'];
    assert.equal(isRateLimited([banner, ...widget, ...bare].join('\n'), [], 12), true);
  });
  it('finds a banner behind a widget above a BOXED input "│ > │" (tail=12)', () => {
    const boxed = ['╭────────────────────────╮', '│ >                      │', '╰────────────────────────╯', '  ? for shortcuts'];
    assert.equal(isRateLimited([banner, ...widget, ...boxed].join('\n'), [], 12), true);
  });
  it('boxed input with typed text is still chrome (box row stripped)', () => {
    const boxed = ['╭────────────────────────╮', '│ > continue the task    │', '╰────────────────────────╯'];
    assert.equal(isRateLimited([banner, ...widget, ...boxed].join('\n'), [], 12), true);
  });
  // The boxed-input rule must NOT strip unicode-border tool output (psql/duf tables):
  // those rows are content — stripping them would collapse the content distance and
  // pull a stale, scrolled-past banner back into the window.
  it('does NOT strip a psql unicode-border table, so a stale banner above it stays out', () => {
    const table = ['  ⎿  ┌────────┬───────────┐', '     │ id     │ name      │', '     ├────────┼───────────┤',
      ...Array(10).fill('     │ 0      │ user0     │'), '     └────────┴───────────┘'];
    const pane = ["You've hit your session limit · resets 3pm (UTC)",
      '● Bash(psql -c "select * from users limit 8")', ...table, '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });
  it('does NOT strip a psql row whose first cell is ">" (internal bar guard)', () => {
    const table = ['  ⎿  ┌────────┬───────────┐', '     │ op     │ meaning   │', '     ├────────┼───────────┤',
      ...Array(10).fill('     │ >      │ greater-than op │'), '     └────────┴───────────┘'];
    const pane = ["You've hit your session limit · resets 3pm (UTC)", '● Bash(psql)', ...table, '❯ '].join('\n');
    assert.equal(isRateLimited(pane, [], 12), false);
  });

  // Chrome classifiers must not match ordinary content: each probe is a real output
  // line that, if wrongly stripped as chrome, lets contentTail "see through" it and
  // pull a STALE banner above back into the window.
  const CONTENT_PROBES = [
    'Press ctrl+c to stop the dev server',      // contains "ctrl+"
    '⎿ Renamed a.js → b.js',                     // contains arrow →
    '✓ Fixed the bug',                           // checkmark bullet, no leading indent
    'Released v0.5.1',                           // bare semver, no footer pipe
    'auto mode is enabled in your settings',     // prose, not the auto-mode notice
    '3 tasks remain in the backlog',             // prose, not the widget header
    'Backgrounded agent finished the lint run',  // prose, not the agent notice
    'Should I start the new task?',              // prose, not the /clear hint
  ];
  for (const probe of CONTENT_PROBES) {
    it(`does not strip "${probe}" as chrome, so a stale banner above it stays out (tail=12)`, () => {
      const pane = [
        "You've hit your session limit · resets 3pm (UTC)",
        ...Array(13).fill(probe),
        '───────────────────────────────',
        '❯ ',
      ].join('\n');
      assert.equal(isRateLimited(pane, [], 12), false);
    });
  }
  // The genuine renders those anchors target must STILL classify as chrome, so a
  // banner behind them is still reachable.
  const CHROME_RENDERS = [
    '  Allowed by auto mode',
    '  8 tasks (4 done, 1 in progress, 3 open)',
    '  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)',
    '  new task? /clear to save 300k tokens',
  ];
  for (const render of CHROME_RENDERS) {
    it(`still strips genuine render "${render.trim()}" as chrome (banner behind it detected)`, () => {
      const pane = [
        "You've hit your session limit · resets 2am (Europe/Zurich)",
        ...Array(13).fill(render),
        '❯ ',
      ].join('\n');
      assert.equal(isRateLimited(pane, [], 12), true);
    });
  }
  it('still strips the real version footer and mode footer (banner behind them detected)', () => {
    const pane = [
      "You've hit your session limit · resets 2am (Europe/Zurich)",
      '───────────────────────────────',
      '❯ ',
      '───────────────────────────────',
      '  Opus 4.8 1M | automation-monorepo@dev | 5h 100% @02:00 | v2.1.201',
      '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
    ].join('\n');
    assert.equal(isRateLimited(pane, [], 12), true);
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
  // A live menu pushed up by a tall widget below it must still be detected —
  // otherwise the menu branch is skipped and a later send types into the open menu,
  // where Enter confirms the highlighted default ("Upgrade your plan").
  it('detects a live menu pushed up by a widget below it (chrome-aware)', () => {
    const screen = [
      'What do you want to do?',
      '❯ 1. Upgrade your plan',
      '  2. Stop and wait for limit to reset',
      'Enter to confirm · Esc to cancel',
      '',
      '  8 tasks (2 done, 6 open)',
      '  □ a', '  □ b', '  □ c', '  □ d', '  □ e', '  □ f', '  □ g', '  □ h', '  □ i',
      '───────────────',
      '❯ ',
      '───────────────',
      '  ⏵⏵ auto mode on',
    ].join('\n');
    assert.equal(isLimitMenuPrompt(screen), true);
  });
  it('still ignores a menu only quoted above live work (chrome-aware)', () => {
    const screen = [upgradeFirstMenu, ...Array(12).fill('● unrelated work'), '❯ '].join('\n');
    assert.equal(isLimitMenuPrompt(screen), false);
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
  // isWorking must measure the SAME bottom as isRateLimited (both chrome-aware). A
  // live working footer pushed up by a tall chrome stack below it was invisible to
  // the old raw tail, while chrome-aware isRateLimited still saw a lingering banner
  // → the waiting branch injected retry text into a mid-flight session.
  it('sees a working footer even when a tall chrome stack is rendered below it', () => {
    const screen = [
      '✻ Cogitating… (12s · esc to interrupt)',
      '  10 tasks (2 done, 1 in progress, 7 open)',
      '  □ a', '  □ b', '  □ c', '  □ d', '  □ e', '  □ f', '  □ g',
      '   … +2 completed',
      '  new task? /clear to save 300k tokens',
      '',
      '───────────────',
      '❯ ',
      '───────────────',
      '  Opus 4.8 | repo@dev | v2.1.201',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ].join('\n');   // 17 lines: the footer is >12 raw lines from the bottom
    assert.equal(isWorking(screen), true);
  });
  it('does not treat the idle "✻ Brewed for …" spinner as working', () => {
    assert.equal(isWorking('✻ Brewed for 54m 35s\n❯ '), false);
  });
  // The main thread awaiting a subagent is working — injecting a retry there spams
  // a progressing session. LIVE-ONLY render, so it's safe (see the counter-repro).
  it('treats "Waiting for N background agent(s) to finish" as working', () => {
    assert.equal(isWorking('✻ Waiting for 1 background agent to finish'), true);
    assert.equal(isWorking('✻ Waiting for 3 background agents to finish'), true);
  });
  // Counter-repro: the "Backgrounded agent" NOTICE is a transcript line that lingers
  // after the agent finished. It must NOT be treated as working, or a genuinely
  // limited idle session (banner live below the stale notice) would never be retried.
  it('does NOT treat the lingering "Backgrounded agent" transcript notice as working', () => {
    const screen = ['● Task(build the parser)', '  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)',
      '● Done. The parser passes all 14 tests.',
      "You've hit your session limit · resets 3pm (Europe/Zurich)", '❯ '].join('\n');
    assert.equal(isWorking(screen), false);   // agent finished; the screen is idle at a live limit
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
