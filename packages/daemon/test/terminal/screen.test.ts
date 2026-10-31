import { describe, expect, it } from 'vitest';
import {
  boxRowsShownAtMost,
  endsWithConfirmFooter,
  findInputBox,
  keysToChoose,
  lastLines,
  parseMenu,
  readScreenState,
  screenBlocker,
  screenLines,
  DIALOG_OPEN,
  vimModeBelow,
} from '../../src/terminal/index.js';

// Synthetic screens in the layout Claude Code 2.x draws. Every name and path is made up.
const RULE = '─'.repeat(72);

const BANNER = [
  ' ▐▛███▛▌   Claude Code v2.1.300',
  '▝▜█████▛▘  Synthetic model · API Usage Billing',
  '  ▘▘ ▝▝    ~/work/alpha-app',
  '',
];

const IDLE = [
  ...BANNER,
  '> Please add the login form.',
  '',
  '⏺ Done. All synthetic tests pass.',
  '',
  RULE,
  '❯ Try "write a test for the login form"',
  RULE,
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
  '',
  '',
].join('\n');

const WORKING_WITH_DRAFT = [
  ...BANNER,
  '⏺ Bash(npm test)',
  '  ⎿  Running…',
  '',
  '✻ Working… (esc to interrupt)',
  '',
  RULE,
  '❯ also fix the header',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

const PERMISSION = [
  ...BANNER,
  '⏺ Bash(npm test)',
  RULE,
  ' Bash command',
  '',
  '   npm test',
  '   Run the synthetic tests',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for npm test commands in /synthetic/work/alpha-app",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

const PERMISSION_NO_HINT = PERMISSION.split('\n').slice(0, -2).join('\n');

const TRUST = [
  RULE,
  ' Accessing workspace:',
  '',
  ' /synthetic/work/alpha-app',
  '',
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

const QUESTION = [
  ...BANNER,
  RULE,
  ' ☐ Database',
  '',
  'Which database should the synthetic app use?',
  '',
  '❯ 1. SQLite',
  '     Small and local',
  '  2. Postgres',
  '     Server based',
  '  3. Type something.',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

const PLAN_FRAMED = [
  '╭──────────────────────────────────────────────╮',
  '│ Ready to code?                               │',
  '│                                              │',
  "│ Here is Claude's plan: add the login form.   │",
  '│                                              │',
  '│ Would you like to proceed?                   │',
  '│                                              │',
  '│ ❯ 1. Yes, and auto-accept edits              │',
  '│   2. Yes, and manually approve edits         │',
  '│   3. No, keep planning                       │',
  '╰──────────────────────────────────────────────╯',
].join('\n');

const ANSWERED_ABOVE_BOX = [
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  ' Esc to cancel',
  '',
  '⏺ Bash(npm test)',
  '  ⎿  12 passed',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

describe('screen lines', () => {
  it('strips escapes, CRs, trailing spaces and blank lines', () => {
    expect(screenLines('\u001b[1mbold\u001b[0m  \r\nnext\r\n\n  \n')).toEqual(['bold', 'next']);
    expect(screenLines('\u001b]0;title\u0007after')).toEqual(['after']);
    expect(lastLines('a\nb\nc\n\n', 2)).toEqual(['b', 'c']);
  });
});

describe('input box', () => {
  it("is the last ❯ line under Claude's rule; the placeholder reads as empty", () => {
    const box = findInputBox(screenLines(IDLE));
    expect(box?.text).toBe('');
    expect(box?.placeholder).toBe(true);
    expect(box?.rows).toBe(1);
  });

  it('reads typed text, joining wrapped rows', () => {
    expect(findInputBox(screenLines(WORKING_WITH_DRAFT))?.text).toBe('also fix the header');
    const wrapped = [RULE, '❯ a long prompt that', '  wraps onto a second row', RULE].join('\n');
    const box = findInputBox(screenLines(wrapped));
    expect(box?.text).toBe('a long prompt that wraps onto a second row');
    expect(box?.rows).toBe(2);
  });

  it('is not confused by a draft that starts like a menu option', () => {
    const s = [...BANNER, RULE, '❯ 1. fix the bug first', RULE, '  ? for shortcuts'].join('\n');
    const st = readScreenState(s);
    expect(st.inputBox?.text).toBe('1. fix the bug first');
    expect(st.dialog).toBeNull();
  });

  it("finds the box of a named session: Claude Code writes the name into the rule above it", () => {
    const named = `${'─'.repeat(60)} senior-job-search-setup ─`;
    const s = [
      ...BANNER,
      named,
      '❯ ',
      RULE,
      '  ⏵⏵ auto mode on · 4 shells · ↓ to manage',
      '',
      '  ⏺ main',
      '  ◯ general-purpose  Verifying queue5 CSV        13h 14m · ↓ 726.4k tokens',
    ].join('\n');
    const st = readScreenState(s);
    expect(st.inputBox?.text).toBe('');
    expect(st.dialog).toBeNull();
    expect(findInputBox(screenLines([named, '❯ draft here', RULE].join('\n')))?.text).toBe('draft here');
  });

  it('a line of prose that merely starts with dashes is not a box edge', () => {
    expect(findInputBox(screenLines(['──────── Summary of the change: it works', '❯ 1. ok'].join('\n')))).toBeNull();
  });

  it('reads the older framed box', () => {
    const s = ['╭──────────────────────────╮', '│ > hello there            │', '╰──────────────────────────╯'].join('\n');
    expect(findInputBox(screenLines(s))?.text).toBe('hello there');
  });

  it('is not a dialog pointer (no rule directly above it)', () => {
    expect(findInputBox(screenLines(TRUST))).toBeNull();
    expect(findInputBox(screenLines(PERMISSION))).toBeNull();
  });

  it('says whether its bottom edge is on screen: without it, blank draft rows at the bottom are not counted', () => {
    const whole = findInputBox(screenLines([RULE, '❯ first row', '  ', '  ', RULE, '  ? for shortcuts'].join('\n')));
    expect(whole).toMatchObject({ closed: true, rows: 3 });
    // The same draft with the edge (and so the blank rows) cut off.
    const cut = findInputBox(screenLines([RULE, '❯ first row', '  ', '  '].join('\n')));
    expect(cut).toMatchObject({ closed: false, rows: 1, text: 'first row' });
  });

  it("reads the vim mode Claude writes under the box, and nothing when vim mode is off", () => {
    const at = (below: string[]) => {
      const lines = screenLines([...BANNER, RULE, '❯ a draft', RULE, ...below].join('\n'));
      return vimModeBelow(lines, findInputBox(lines)!);
    };
    expect(at(['  -- INSERT --', '  ? for shortcuts'])).toBe('INSERT');
    expect(at(['  -- NORMAL --'])).toBe('NORMAL');
    expect(at(['  -- VISUAL --  ⏵⏵ accept edits on (shift+tab to cycle)'])).toBe('VISUAL');
    expect(at(['  -- VISUAL LINE --'])).toBe('VISUAL LINE');
    expect(at(['  ⏵⏵ accept edits on (shift+tab to cycle)'])).toBeNull();
    expect(at([])).toBeNull();
    // A draft that reads like the indicator is not below the box.
    const lines = screenLines([RULE, '❯ -- NORMAL --', RULE, '  ? for shortcuts'].join('\n'));
    expect(vimModeBelow(lines, findInputBox(lines)!)).toBeNull();
  });

  it("Claude's full-screen display shows at most max(3, rows/2 - 5) rows of the box", () => {
    expect([10, 16, 24, 50, 71, 72, 80].map(boxRowsShownAtMost)).toEqual([3, 3, 7, 20, 30, 31, 35]);
  });
});

describe('dialog detection', () => {
  it('an idle or working screen has no dialog', () => {
    expect(readScreenState(IDLE).dialog).toBeNull();
    expect(readScreenState(WORKING_WITH_DRAFT).dialog).toBeNull();
    expect(screenBlocker(readScreenState(IDLE))).toBeNull();
  });

  it('a permission dialog (hint footer)', () => {
    const st = readScreenState(PERMISSION);
    expect(st.dialog?.kind).toBe('confirm');
    expect(st.dialog?.title).toBe('Bash command');
    expect(st.dialog?.options).toHaveLength(3);
    expect(st.dialog?.current).toBe(0);
    // A fixed sentence: the title is screen text, and the reason reaches events, logs and pushes.
    expect(screenBlocker(st)).toBe(DIALOG_OPEN);
    expect(screenBlocker(st)).not.toContain('Bash command');
  });

  it('a permission dialog without its hint line (numbered pointer)', () => {
    const st = readScreenState(PERMISSION_NO_HINT);
    expect(st.dialog?.kind).toBe('menu');
    expect(st.dialog?.title).toBe('Bash command');
  });

  it("the trust dialog (ccw's Enter to confirm footer)", () => {
    expect(endsWithConfirmFooter(TRUST)).toBe(true);
    const st = readScreenState(TRUST);
    expect(st.dialog?.title).toBe('Accessing workspace:');
    expect(st.dialog?.options).toEqual(['No, exit', 'Yes, I trust this folder']);
  });

  it('an AskUserQuestion question', () => {
    const st = readScreenState(QUESTION);
    expect(st.dialog?.kind).toBe('confirm');
    expect(st.dialog?.options?.[0]).toBe('1. SQLite Small and local');
  });

  it('a framed plan approval', () => {
    const st = readScreenState(PLAN_FRAMED);
    expect(st.inputBox).toBeNull();
    expect(st.dialog?.kind).toBe('menu');
    expect(st.dialog?.title).toBe('Ready to code?');
  });

  it('a dialog answered earlier, above the input box, does not count', () => {
    const st = readScreenState(ANSWERED_ABOVE_BOX);
    expect(st.inputBox).not.toBeNull();
    expect(st.dialog).toBeNull();
  });

  it('a question with no input box on screen counts; an unknown screen still blocks', () => {
    const q = ['⏺ Edit(src/app.ts)', ' Do you want to make this edit to app.ts?'].join('\n');
    expect(readScreenState(q).dialog?.kind).toBe('question');
    const unknown = ['⏺ Some output', '  more output'].join('\n');
    const st = readScreenState(unknown);
    expect(st.dialog).toBeNull();
    expect(screenBlocker(st)).toBe("Claude's input box isn't on screen");
    expect(screenBlocker(st, { requireInputBox: false })).toBeNull();
  });

  it("agent output that merely mentions the words doesn't count while the input box shows", () => {
    const s = [
      '⏺ The README says: "Do you want to proceed? Enter to confirm · Esc to cancel".',
      '',
      RULE,
      '❯ ',
      RULE,
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n');
    expect(readScreenState(s).dialog).toBeNull();
  });
});

describe('menus (adapted from Shed)', () => {
  it('parses options and the highlighted one; moves with arrow keys', () => {
    const m = parseMenu(TRUST);
    expect(m).toEqual({ options: ['No, exit', 'Yes, I trust this folder'], current: 0 });
    expect(keysToChoose(m as NonNullable<typeof m>, 1)).toBe('\u001b[B');
    expect(keysToChoose({ options: ['a', 'b', 'c'], current: 2 }, 0)).toBe('\u001b[A\u001b[A');
  });

  it('ignores the input box', () => {
    expect(parseMenu(IDLE)).toBeNull();
    expect(parseMenu(ANSWERED_ABOVE_BOX)).toBeNull();
  });
});
