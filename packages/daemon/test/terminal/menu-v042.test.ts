/**
 * menu.ts in v0.4.2: `parseMenuRows` gives the rows as drawn (numbers,
 * columns, the pointer column's mark, continuation lines), and `parseMenu`
 * keeps v0.4.1's output on every screen but the two shapes it newly reads:
 * the plan approval (a footer, no hint) and a hintless list with Claude's
 * box edges under it (the questions' review). v0.4.1's parseMenu is kept
 * below, verbatim, as the oracle.
 */
import { describe, expect, it } from 'vitest';
import { DIALOG_FIXTURES, NOT_DIALOG_SCREENS, dialogFixture, launchScreen, type LaunchScreenName } from '@jantar/fixtures';
import { parseMenu, parseMenuRows, type ScreenMenu } from '../../src/terminal/menu.js';
import { readScreenState } from '../../src/terminal/screen.js';

/** v0.4.1's parseMenu (commit 0633bb7), unchanged. */
function parseMenuV041(screen: string | readonly string[]): ScreenMenu | null {
  const POINTER = /^(\s*)([❯›])\s+(\S.*)$/;
  const HINT = /Enter to confirm|Esc to cancel|Press enter|to cancel|Tab to amend|enter to select|to navigate/i;
  const RULE = /^\s*[─━]{3,}\s*$/;
  const pointerText = (line: string): string | null => {
    const m = POINTER.exec(line);
    return m ? (m[3] as string) : null;
  };
  const source = typeof screen === 'string' ? screen.replace(/\r/g, '').split('\n') : [...screen];
  const lines = source.map((line) => line.replace(/\s+$/, '')).slice(-70);
  let at = -1;
  let hint = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) {
    const text = pointerText(lines[i] as string);
    if (text === null) continue;
    const below = lines.slice(i + 1, i + 1 + 30).findIndex((line) => HINT.test(line));
    if (below >= 0) {
      at = i;
      hint = i + 1 + below;
    } else if (
      /^\d+\.\s/.test(text) &&
      lines.slice(i + 1).every((line) => !line.trim() || /^\s+(\d+\.\s|\s{3,}\S)/.test(line)) &&
      lines.slice(i + 1).some((line) => /^\s+\d+\.\s/.test(line))
    ) {
      at = i;
      hint = lines.length;
    }
  }
  if (at < 0) return null;
  if (lines.slice(hint + 1).some((line) => /^\s*[❯›](\s|$)/.test(line))) return null;
  const first = pointerText(lines[at] as string) as string;
  const column = (lines[at] as string).length - first.length;
  const textAt = (line: string) => line.length - line.trimStart().length;
  const isSubmit = (line: string) => /^(Submit|Next)$/.test(line.trim());
  const isOption = (line: string) => Boolean(line.trim()) && !HINT.test(line) && !RULE.test(line) && (POINTER.test(line) || isSubmit(line) || textAt(line) === column);
  const isContinuation = (line: string) =>
    Boolean(line.trim()) && !HINT.test(line) && !RULE.test(line) && !POINTER.test(line) && !isSubmit(line) && textAt(line) > column;
  const label = (line: string) => (pointerText(line) ?? line.trim()).trim();
  let start = at;
  while (start > 0 && (isOption(lines[start - 1] as string) || isContinuation(lines[start - 1] as string))) start--;
  while (start < at && !isOption(lines[start] as string)) start++;
  const options: string[] = [];
  let current = -1;
  for (let i = start; i < hint; i++) {
    const line = lines[i] as string;
    if (isOption(line)) {
      if (i === at) current = options.length;
      options.push(label(line));
    } else if (isContinuation(line) && options.length) {
      options[options.length - 1] += ` ${line.trim()}`;
    } else if (!line.trim() || RULE.test(line)) {
      continue;
    } else {
      break;
    }
  }
  if (options.length < 2 || current < 0 || options.length > 12) return null;
  return { options, current };
}

const RULE = '─'.repeat(72);
/** Screens from the v0.4.1 tests (screen.test.ts) and the launcher's fixtures, rebuilt here. */
const OLD_SCREENS: Record<string, string> = {
  idle: ['⏺ Done.', '', RULE, '❯ Try "write a test"', RULE, '  ⏵⏵ accept edits on (shift+tab to cycle)', '', ''].join('\n'),
  permission: [
    '⏺ Bash(npm test)',
    RULE,
    ' Bash command',
    '',
    '   npm test',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for npm test commands in /synthetic/work/alpha-app",
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n'),
  permissionNoHint: [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n'),
  trust: [RULE, ' Accessing workspace:', '', ' ❯ 1. Yes, I trust this folder', '   2. No, exit', '', ' Enter to confirm · Esc to cancel'].join('\n'),
  unnumbered: [' Pick one', ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'].join('\n'),
  question: [
    '☐ Database',
    '',
    'Which one?',
    '',
    '❯ 1. SQLite',
    '     Small and local',
    '  2. Postgres',
    '     A server',
    '  3. Type something.',
    RULE,
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n'),
  pointerOnChat: ['Which one?', '', '  1. SQLite', '  2. Postgres', RULE, '❯ 3. Chat about this', '', 'Enter to select · Esc to cancel'].join('\n'),
  reviewNoEdges: ['Ready to submit your answers?', '', '❯ 1. Submit answers', '  2. Cancel'].join('\n'),
  answered: ['❯ 2. Green', '  3. Blue', '', 'Enter to select · Esc to cancel', '', RULE, '❯ ', RULE].join('\n'),
  draftLikeRow: ['⏺ Done.', '', RULE, '❯ 1. fix the bug first', '  2. then the tests', RULE].join('\n'),
};

const LAUNCH: LaunchScreenName[] = ['trust', 'chromeIntro', 'bypassWarning', 'retryNow', 'keepModel'];

describe('parseMenu keeps its v0.4.1 output', () => {
  const newlyRead = new Set(['PLAN_FULLSCREEN', 'PLAN_80COL', 'PLAN_CLEAR', 'PLAN_FEEDBACK_TYPED', 'PLAN_TEXT_PENDING', 'Q_REVIEW', 'Q_REVIEW_WARN']);

  it('on the v0.4.1 screens and the launcher dialogs', () => {
    for (const [name, screen] of Object.entries(OLD_SCREENS)) expect(parseMenu(screen), name).toEqual(parseMenuV041(screen));
    for (const name of LAUNCH) {
      for (const current of [0, 1]) {
        const s = launchScreen(name, { folder: '/synthetic/work/alpha-app' }, current);
        expect(parseMenu(s), `${name} ${current}`).toEqual(parseMenuV041(s));
      }
    }
  });

  it('on every dialog fixture but the plan and the review with box edges, which it now reads', () => {
    for (const f of DIALOG_FIXTURES) {
      if (newlyRead.has(f.name)) {
        expect(parseMenuV041(f.screen), f.name).toBeNull();
        expect(parseMenu(f.screen), f.name).not.toBeNull();
      } else {
        expect(parseMenu(f.screen), f.name).toEqual(parseMenuV041(f.screen));
      }
    }
    for (const [name, screen] of Object.entries(NOT_DIALOG_SCREENS)) expect(parseMenu(screen), name).toEqual(parseMenuV041(screen));
  });

  it('reads the plan approval: its rows, the shift+tab line joined into the last, the footer left out', () => {
    expect(parseMenu(dialogFixture('PLAN_80COL').screen)).toEqual({
      options: ['1. Yes, and use auto mode', '2. Yes, manually approve edits', '3. Tell Claude what to change shift+tab to approve with this feedback'],
      current: 0,
    });
    expect(parseMenu(dialogFixture('PLAN_TEXT_PENDING').screen)?.current).toBe(2);
    expect(parseMenu(dialogFixture('Q_REVIEW').screen)).toEqual({ options: ['1. Submit answers', '2. Cancel'], current: 0 });
  });

  it("readScreenState still sees a plan as a dialog (it refuses keys there), now with its options", () => {
    const st = readScreenState(dialogFixture('PLAN_80COL').screen);
    expect(st.dialog?.kind).toBe('menu');
    expect(st.dialog?.options).toHaveLength(3);
  });

  it('a draft that looks like a list, with box edges under it, is still no menu', () => {
    expect(parseMenu(OLD_SCREENS.draftLikeRow as string)).toBeNull();
    expect(parseMenuRows(OLD_SCREENS.draftLikeRow as string)).toBeNull();
    expect(parseMenuRows(NOT_DIALOG_SCREENS.IDLE_DRAFT as string)).toBeNull();
  });
});

describe('parseMenuRows', () => {
  it('numbers, columns, continuations and the pointer (PERM_OVERWRITE_3)', () => {
    const lines = dialogFixture('PERM_OVERWRITE_3').screen.split('\n');
    const m = parseMenuRows(lines);
    expect(m?.current).toBe(1);
    expect(m?.rows.map((r) => [r.number, r.text, r.col, r.labelCol, r.marker, r.lone])).toEqual([
      [1, 'Yes', 3, 6, ' ', false],
      [2, 'Yes, and allow access to', 3, 6, '❯', false],
      [3, 'No', 3, 6, ' ', false],
    ]);
    expect(m?.rows[1]?.more).toEqual(['/tmp/demo/workspace-alpha/notes/plans,', '/tmp/demo/workspace-beta/plans for this session (shift+tab)']);
    expect(lines[m?.start ?? -1]).toBe('   1. Yes');
    expect(lines[m?.end ?? -1]).toBe('   3. No');
    expect(lines[m?.hint ?? -1]).toBe(' Esc to cancel');
  });

  it("a multi-select's Submit row is lone, at the boxes' label column", () => {
    const m = parseMenuRows(dialogFixture('Q_MULTI').screen);
    const submit = m?.rows[4];
    expect(submit).toMatchObject({ text: 'Submit', number: null, lone: true, col: 5, labelCol: 5 });
    expect(m?.rows[3]).toMatchObject({ text: '[ ] Type something', number: 4, col: 2, labelCol: 5, lone: false });
    expect(m?.rows[5]).toMatchObject({ text: 'Chat about this', number: 5 });
  });

  it('takes the rows above the rule when the pointer is on "Chat about this"', () => {
    const m = parseMenuRows(dialogFixture('Q_ON_CHAT').screen);
    expect(m?.rows.map((r) => r.number)).toEqual([1, 2, 3, 4, 5]);
    expect(m?.current).toBe(4);
    // parseMenu reads only from the rule down, as v0.4.1 did (one row: none).
    expect(parseMenu(dialogFixture('Q_ON_CHAT').screen)).toBeNull();
  });

  it('marks a ↓ in the pointer column as a row of its own', () => {
    const m = parseMenuRows(dialogFixture('Q_SCROLLED').screen);
    expect(m?.rows.map((r) => r.marker)).toEqual(['❯', ' ', ' ', ' ', ' ', '↓']);
    expect(m?.rows[5]).toMatchObject({ number: 6, col: 2 });
    expect(parseMenu(dialogFixture('Q_SCROLLED').screen)?.options).toHaveLength(5);
  });

  it('a plan has no hint; its rows end where the footer starts', () => {
    const lines = dialogFixture('PLAN_FULLSCREEN').screen.split('\n');
    const m = parseMenuRows(lines);
    expect(m?.hint).toBe(-1);
    expect(m?.rows.map((r) => r.text)).toEqual(['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change']);
    expect(m?.rows[2]?.more).toEqual(['shift+tab to approve with this feedback']);
    expect(lines[m?.end ?? -1]).toBe('        shift+tab to approve with this feedback');
  });

  it('a pointer under the hint is the prompt box: no list', () => {
    expect(parseMenuRows(NOT_DIALOG_SCREENS.ANSWERED_ABOVE_BOX as string)).toBeNull();
    expect(parseMenuRows(OLD_SCREENS.answered as string)).toBeNull();
  });

  it('line numbers are indices into the lines given, past the 70 it reads', () => {
    const lines = [...Array.from({ length: 100 }, (_, i) => `older ${i}`), ...dialogFixture('PERM_CREATE_2').screen.split('\n')];
    const m = parseMenuRows(lines);
    expect(lines[m?.rows[0]?.line ?? -1]).toBe(' ❯ 1. Yes');
    expect(lines[m?.hint ?? -1]).toBe(' Esc to cancel · Tab to amend');
  });
});
