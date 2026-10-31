/**
 * Terminal dialog fixtures (v0.4.2 wave 0, spec 9.1): the screens Claude Code
 * 2.1.314 draws for a permission prompt, a plan approval, a question (one or
 * several, multi-select, the review), as Terminal's `contents` gives them,
 * each with the model the daemon's `dialogOfScreen` must read from it (every
 * gate off, and with the gates it depends on on) and, per option, the bytes
 * of the one write that answers it; `withGates` picks the pair a set of
 * gates reads to (DIALOG_GATES ships `up` and `tall` on since SP14 and
 * SP15, `noFirst` off). Lane L1 tests its parser and its bytes
 * against them; lane L2 renders the same models from the web copy
 * (packages/web/test/term-dialog-fixtures.json, which test/dialogs-agree
 * keeps equal). Neither lane edits them: a fixture that disagrees with a
 * rule goes back to the main session.
 *
 * Built from the screenshots' and the real-Mac spikes' structure with
 * neutral words; DIALOG_SECRET is planted in every screen (a body line, or
 * an option's description where a question draws no body), for the privacy
 * tests. 80 or 96 columns; PERM_RAW_SPACES keeps trailing spaces and CRLF.
 *
 * How spec 2.3's rules were applied by hand:
 * - top: plan, the `Ready to code?` line right under the plan box's own
 *   rule; else the line after the nearest solid rule (20+ of ─/━ only) at
 *   column 0 above the question and its tab bar; with neither on screen, no
 *   dialog and the `unsure` note (PERM_OVERWRITE_3, PERM_BASH_TALL: a queued
 *   twin could differ only above the read). Under the dialog's last line
 *   only blank lines and edges, else `unsure`.
 * - title: plan, `Ready to code?`; a lone `☐ X` header (no arrows, no
 *   ✔ Submit) gives X; a tab bar is never the title; else the first
 *   non-blank line at top when it is above the question, '' otherwise.
 * - body: the lines between the title (or top, or the tab bar) and the
 *   question; plan: between `Here is Claude's plan:` and the rule above the
 *   question. Solid and dashed rules and blank lines dropped, the lines'
 *   common indent removed; past 40 lines the first 19, a line counting the
 *   rest (`… N more lines on the Mac …`) and the last 20 (PERM_BASH_LONG).
 * - options: wrapped lines joined with one space; a question's or multi's
 *   description lines are its detail; `checked` on every row that draws a
 *   box; `hold` on pick rows; gates turn rows `locked` with their note and
 *   keep the rest (label, detail, checked, hold); a row reached only from or
 *   across a row holding typed text is locked (`pastTyped`) whatever the
 *   gates.
 * - bytes: ESC[B per row down (ESC[A up, only with the `up` gate), then for
 *   a text row SAMPLE_TEXT; '' for the highlighted row; null when refused.
 */
import { DIALOG_NOTES, type DialogGates, type TerminalDialog } from '@jantar/protocol';

/** Planted in every fixture screen; must never reach an audit row, an event or a log line. */
export const DIALOG_SECRET = 'velvet-quokka-5521';

/** The text the `bytes` of a text row carry after its arrows. */
export const SAMPLE_TEXT = 'teal';

/** The 120-character answer Q_TEXT_PENDING shows typed into "Type something." (SP5: Terminal's CR left it there). */
export const TYPED_ANSWER = 'Teal for the header and the buttons, a soft grey for the body text, and white cards with a thin border around each card.';

/** The 191-character plan note PLAN_TEXT_PENDING shows typed into "Tell Claude what to change". */
export const TYPED_PLAN_NOTE =
  'Please keep the old file as a backup, write the new one beside it with the date in its name, and add a short line to the readme that says where the backup lives and how to restore it later on';

type Gate = 'up' | 'tall' | 'noFirst';
type Model = Omit<TerminalDialog, 'fingerprint'>;
type Option = Model['options'][number];

export interface DialogFixture {
  name: string;
  /** The screen as Terminal's `contents` gives it (80 or 96 columns; one fixture keeps trailing spaces and CRLF). */
  screen: string;
  /** The gates this fixture's model depends on, if any. */
  gates?: Gate[];
  /** dialogOfScreen with every gate off: the model without its fingerprint, and the note (`withGates` gives the shipped one). */
  expected: { dialog: Model | null; note: string | null };
  /** The same with every gate in `gates` on. */
  expectedOpen?: DialogFixture['expected'];
  /** Per option, gates off: the one write's bytes before Terminal's CR, or null when the row is refused. */
  bytes: Array<string | null>;
  bytesOpen?: Array<string | null>;
}

// ---------------------------------------------------------------------------
// Building blocks

const R80 = '─'.repeat(80);
const R96 = '─'.repeat(96);
const D80 = '╌'.repeat(80);
const D96 = '╌'.repeat(96);
/** The box's bottom edge with the session's name in it (fullscreen). */
const NAME80 = `${'─'.repeat(73)} demo ─`;
const NAME96 = `${'─'.repeat(89)} demo ─`;

const B = '\u001b[B';
const A = '\u001b[A';
const down = (n: number) => B.repeat(n);
const up = (n: number) => A.repeat(n);

const join = (lines: readonly string[]) => lines.join('\n');

/** Words wrapped at `width` columns, the way Claude wraps a row's text. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

const pick = (label: string, more: Partial<Option> = {}): Option => ({ label, role: 'pick', ...more });
const text = (label: string): Option => ({ label, role: 'text' });
const chat: Option = { label: 'Chat about this', role: 'chat' };
const typed = (label: string, more: Partial<Option> = {}): Option => ({ label, ...more, role: 'locked', note: DIALOG_NOTES.typed });
/** The same row as a gate turns it: locked with the gate's note, everything else kept. */
const gated = (o: Option, gate: 'up' | 'tall'): Option => (o.role === 'locked' ? o : { ...o, role: 'locked', note: DIALOG_NOTES[gate] });
/** A row reached only from or across a row holding typed text: locked whatever the gates. */
const past = (o: Option): Option => ({ ...o, role: 'locked', note: DIALOG_NOTES.pastTyped });

// ---------------------------------------------------------------------------
// Permission prompts

const CREATE_HEAD = [
  ' Create file',
  ' /tmp/demo/b.txt',
  ' This will modify /tmp/demo/b.txt (outside working directory) via a symlink',
  D80,
  `  1 +hello ${DIALOG_SECRET}`,
  D80,
  ' Do you want to create b.txt?',
];
const CREATE_ROWS = [' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'];
const CREATE_BODY = ['/tmp/demo/b.txt', 'This will modify /tmp/demo/b.txt (outside working directory) via a symlink', ` 1 +hello ${DIALOG_SECRET}`];
const CREATE_MODEL: Model = {
  kind: 'permission',
  title: 'Create file',
  question: 'Do you want to create b.txt?',
  body: CREATE_BODY,
  options: [pick('Yes'), pick('No')],
  current: 0,
};
const createScreen = (above: string) => ['● I will create the file now.', above, R80, ...CREATE_HEAD, ...CREATE_ROWS];

/** mac-1 with its whole dialog on screen: the solid rule, `Overwrite file`, the path and the diff. */
const OVERWRITE_TOP = [
  '● Updating the notes file.',
  '',
  R96,
  ' Overwrite file',
  ' /tmp/demo/notes.md',
  D96,
  ' 1 -# Notes',
  ' 1 +# Notes for the demo',
  ' 2',
  ' 3 -- first point',
  ' 3 +- first point, revised',
  ' 4 +- second point',
  ' 5',
  ' 6  ## Next steps',
  ' 7 -- old step one',
  ' 7 +- new step one',
  ' 8 -- old step two',
  ' 8 +- new step two',
  ` 9 +- check with ${DIALOG_SECRET}`,
  D96,
  ' Do you want to overwrite notes.md?',
  '   1. Yes',
  ' ❯ 2. Yes, and allow access to',
  '      /tmp/demo/workspace-alpha/notes/plans,',
  '      /tmp/demo/workspace-beta/plans for this session (shift+tab)',
  '   3. No',
  '',
  ' Esc to cancel',
  NAME96,
];
/** The diff lines PERM_OVERWRITE_3 still shows (the first nine screen lines scrolled off the top). */
const OVERWRITE_SCROLLED_AT = 9;
const OVERWRITE_DIFF = [
  '1 -# Notes',
  '1 +# Notes for the demo',
  '2',
  '3 -- first point',
  '3 +- first point, revised',
  '4 +- second point',
  '5',
  '6  ## Next steps',
  '7 -- old step one',
  '7 +- new step one',
  '8 -- old step two',
  '8 +- new step two',
  `9 +- check with ${DIALOG_SECRET}`,
];
const OVERWRITE_OPTIONS = [
  pick('Yes'),
  pick('Yes, and allow access to /tmp/demo/workspace-alpha/notes/plans, /tmp/demo/workspace-beta/plans for this session (shift+tab)'),
  pick('No'),
];

const bash = (file: 'a.txt' | 'b.txt') => [
  '● I will write the date to a file.',
  '',
  R80,
  ' Bash command',
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode"',
  ' below',
  ` Write the date to ${file} (${DIALOG_SECRET})`,
  D80,
  ` date > ${file}`,
  D80,
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to /tmp/demo/projects/sample-service',
  '      from this project',
  '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
  '   4. No',
  '',
  ' Esc to cancel · Tab to amend',
];
/**
 * A Bash prompt that removes a folder and writes a 41-line heredoc: 44 body lines, so its top and its
 * question are 55 lines apart. The twin that removes another folder differs only in its first lines.
 */
const longBash = (dir: string) => [
  '● I will reset the folder and write the notes.',
  '',
  R80,
  ' Bash command',
  ` Reset the folder and write the notes (${DIALOG_SECRET})`,
  D80,
  ` rm -rf ./${dir} && cat > notes.txt <<'EOF'`,
  ...Array.from({ length: 41 }, (_, i) => `   line ${i + 1} of the notes`),
  ' EOF',
  D80,
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
];
/** The rows an 80x24 Terminal shows of longBash: its top and the folder it removes are off screen. */
const TALL_ROWS = 24;

const bashModel = (file: 'a.txt' | 'b.txt'): Model => ({
  kind: 'permission',
  title: 'Bash command',
  question: 'Do you want to proceed?',
  body: ['Tip: auto mode handles these prompts for you — choose "switch to auto mode"', 'below', `Write the date to ${file} (${DIALOG_SECRET})`, `date > ${file}`],
  options: [
    pick('Yes'),
    pick('Yes, and always allow access to /tmp/demo/projects/sample-service from this project', { hold: 'rule' }),
    pick('Yes, and switch to auto mode · auto mode handles these prompts for you', { hold: 'mode' }),
    pick('No'),
  ],
  current: 0,
});

// ---------------------------------------------------------------------------
// Plan approval

const planScreen = (rows: readonly string[]) => [
  '● The plan is ready.',
  '',
  ` ${'─'.repeat(76)}`,
  '   Ready to code?',
  '',
  "   Here is Claude's plan:",
  `  ${'╌'.repeat(76)}`,
  '   Create b.txt with one line.',
  `   Keep a.txt as it is (${DIALOG_SECRET}).`,
  `  ${'─'.repeat(76)}`,
  '   Claude has written up a plan and is ready to execute. Would you like to',
  '   proceed?',
  '',
  ...rows,
  '',
  '   ctrl+g to edit in VS Code · ~/demo/plans/plan-name.md',
];
const PLAN_QUESTION = 'Claude has written up a plan and is ready to execute. Would you like to proceed?';
const planModel = (options: Option[], current = 0): Model => ({
  kind: 'plan',
  title: 'Ready to code?',
  question: PLAN_QUESTION,
  body: ['Create b.txt with one line.', `Keep a.txt as it is (${DIALOG_SECRET}).`],
  options,
  current,
});
const AUTO = pick('Yes, and use auto mode', { hold: 'mode' });
const MANUAL = pick('Yes, manually approve edits');
const FEEDBACK = text('Tell Claude what to change');
const SHIFT_TAB = '        shift+tab to approve with this feedback';

const FULLSCREEN_PLAN = [
  'Plan: Notes page for the demo app',
  'Context',
  'The demo app needs a notes page that lists notes and lets you add one.',
  `Keep the current routes as they are (${DIALOG_SECRET}).`,
  'Steps',
  '- Add a notes list at /notes.',
  '- Add a form to write a new note.',
  '  The form saves on Enter.',
  '- Add tests for both.',
];

// ---------------------------------------------------------------------------
// Questions

const questionScreen = (rows: readonly string[], opts: { hint?: string; onChat?: boolean } = {}) => [
  '● I have a question before I start.',
  '',
  R80,
  ' ☐ Colour',
  '',
  'Pick a colour',
  '',
  ...rows,
  R80,
  opts.onChat ? '❯ 5. Chat about this' : '  5. Chat about this',
  '',
  opts.hint ?? 'Enter to select · ↑/↓ to navigate · Esc to cancel',
];
const Q_ROWS = ['❯ 1. Red', '     Choose red', '  2. Green', '     Choose green', '  3. Blue', `     Choose blue (${DIALOG_SECRET})`, '  4. Type something.'];
const Q_ON_CHAT_ROWS = ['  1. Red', ...Q_ROWS.slice(1)];
const RED = pick('Red', { detail: 'Choose red' });
const GREEN = pick('Green', { detail: 'Choose green' });
const BLUE = pick('Blue', { detail: `Choose blue (${DIALOG_SECRET})` });
const TYPE = text('Type something.');
const questionModel = (options: Option[], current = 0): Model => ({ kind: 'question', title: 'Colour', question: 'Pick a colour', body: [], options, current });

const multiScreen = (rows: readonly string[]) => [
  '● Which fruits should the demo list?',
  '',
  R80,
  '←  ☐ Fruits  ✔ Submit  →',
  '',
  'Pick fruits',
  '',
  ...rows,
  '     Submit',
  R80,
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
];
const box = (label: string, detail: string, checked: boolean): Option => ({ label, detail, role: 'toggle', checked });
const MULTI_TYPE: Option = { label: 'Type something', role: 'locked', checked: false, note: DIALOG_NOTES.multiText };
const SUBMIT: Option = { label: 'Submit', role: 'submit' };
const multiModel = (options: Option[], current: number): Model => ({
  kind: 'multi',
  title: '',
  question: 'Pick fruits',
  body: [],
  tabs: [{ label: 'Fruits', answered: false }],
  options,
  current,
});

const reviewScreen = (tabs: string, middle: readonly string[]) => [
  '● Thanks, here is what you picked.',
  '',
  R80,
  tabs,
  '',
  'Review your answers',
  '',
  ...middle,
  '',
  'Ready to submit your answers?',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel',
  '',
  R80,
  NAME80,
];

// ---------------------------------------------------------------------------
// The fixtures

export const DIALOG_FIXTURES: readonly DialogFixture[] = [
  // --- Permission prompts
  {
    name: 'PERM_OVERWRITE_3',
    // mac-1: taller than the window, so its rule, title and path are scrolled off; the pointer on row 2. With
    // its top off screen it gets no buttons, whatever the gates: the next queued ask drawn alike below its top
    // would share its fingerprint (the keypad and the Mac answer it).
    screen: join(OVERWRITE_TOP.slice(OVERWRITE_SCROLLED_AT)),
    expected: { dialog: null, note: DIALOG_NOTES.unsure },
    bytes: [],
  },
  {
    name: 'PERM_OVERWRITE_3_TOP',
    // The same dialog scrolled into view: its title appears and its body grows at the top (an unchanged dialog, not an answer).
    screen: join(OVERWRITE_TOP),
    gates: ['up'],
    expected: {
      dialog: {
        kind: 'permission',
        title: 'Overwrite file',
        question: 'Do you want to overwrite notes.md?',
        body: ['/tmp/demo/notes.md', ...OVERWRITE_DIFF],
        options: [gated(OVERWRITE_OPTIONS[0] as Option, 'up'), OVERWRITE_OPTIONS[1] as Option, OVERWRITE_OPTIONS[2] as Option],
        current: 1,
      },
      note: null,
    },
    expectedOpen: {
      dialog: { kind: 'permission', title: 'Overwrite file', question: 'Do you want to overwrite notes.md?', body: ['/tmp/demo/notes.md', ...OVERWRITE_DIFF], options: OVERWRITE_OPTIONS, current: 1 },
      note: null,
    },
    bytes: [null, '', down(1)],
    bytesOpen: [up(1), '', down(1)],
  },
  {
    name: 'PERM_CREATE_2',
    screen: join(createScreen('')),
    expected: { dialog: CREATE_MODEL, note: null },
    bytes: ['', down(1)],
  },
  {
    name: 'PERM_CREATE_ALWAYS',
    screen: join([
      '● I will create the file now.',
      '',
      R80,
      ...CREATE_HEAD,
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to /tmp/demo/plans for this session',
      '      (shift+tab)',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ]),
    expected: {
      dialog: { ...CREATE_MODEL, options: [pick('Yes'), pick('Yes, and always allow access to /tmp/demo/plans for this session (shift+tab)', { hold: 'rule' }), pick('No')] },
      note: null,
    },
    bytes: ['', down(1), down(2)],
  },
  {
    name: 'PERM_BASH_PREFIX',
    // SP4, round 2: the real 2.1.314 layout; no "(1 of 2)" counter is drawn.
    screen: join(bash('a.txt')),
    expected: { dialog: bashModel('a.txt'), note: null },
    bytes: ['', down(1), down(2), down(3)],
  },
  {
    name: 'PERM_BASH_TWIN',
    // The next queued ask: the same question and rows, another description and command.
    screen: join(bash('b.txt')),
    expected: { dialog: bashModel('b.txt'), note: null },
    bytes: ['', down(1), down(2), down(3)],
  },
  {
    name: 'PERM_BASH_LONG',
    // A body of 44 lines: the phone gets its first 19 (the command's start), a line saying 5 more are on the
    // Mac, and its last 20. The fingerprint covers all 44.
    screen: join(longBash('build-cache')),
    expected: {
      dialog: {
        kind: 'permission',
        title: 'Bash command',
        question: 'Do you want to proceed?',
        body: [
          `Reset the folder and write the notes (${DIALOG_SECRET})`,
          "rm -rf ./build-cache && cat > notes.txt <<'EOF'",
          ...Array.from({ length: 17 }, (_, i) => `  line ${i + 1} of the notes`),
          '… 5 more lines on the Mac …',
          ...Array.from({ length: 19 }, (_, i) => `  line ${i + 23} of the notes`),
          'EOF',
        ],
        options: [pick('Yes'), pick('No')],
        current: 0,
      },
      note: null,
    },
    bytes: ['', down(1)],
  },
  {
    name: 'PERM_BASH_TALL',
    // PERM_BASH_LONG in an 80x24 Terminal: the read starts inside the dialog. Its twin removing another folder
    // shows exactly these rows, so no fingerprint could tell them apart: no buttons.
    screen: join(longBash('build-cache').slice(-TALL_ROWS)).replace('line 41 of the notes', `line 41 of the notes (${DIALOG_SECRET})`),
    expected: { dialog: null, note: DIALOG_NOTES.unsure },
    bytes: [],
  },
  {
    name: 'PERM_BASH_DONT_ASK',
    screen: join([
      '● Running the tests.',
      '',
      R80,
      ' Bash command',
      ` Run the tests (${DIALOG_SECRET})`,
      D80,
      ' npm test',
      D80,
      ' This command requires approval',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and don’t ask again for: npm test *',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ]),
    expected: {
      dialog: {
        kind: 'permission',
        title: 'Bash command',
        question: 'This command requires approval Do you want to proceed?',
        body: [`Run the tests (${DIALOG_SECRET})`, 'npm test'],
        options: [pick('Yes'), pick('Yes, and don’t ask again for: npm test *', { hold: 'rule' }), pick('No')],
        current: 0,
      },
      note: null,
    },
    bytes: ['', down(1), down(2)],
  },
  {
    name: 'PERM_READ_OUTSIDE',
    // Auto mode's first read outside the working directories.
    screen: join([
      '● Reading the photo you sent.',
      '',
      R80,
      ' Read file',
      ' /tmp/demo/uploads/photo.jpg',
      ` A read outside the working directories (${DIALOG_SECRET})`,
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and keep allowing any reads outside the working directories',
      '   3. No, and block reads outside the working directories from now on',
      '',
      ' Esc to cancel',
    ]),
    expected: {
      dialog: {
        kind: 'permission',
        title: 'Read file',
        question: 'Do you want to proceed?',
        body: ['/tmp/demo/uploads/photo.jpg', `A read outside the working directories (${DIALOG_SECRET})`],
        options: [
          pick('Yes'),
          pick('Yes, and keep allowing any reads outside the working directories', { hold: 'reads' }),
          pick('No, and block reads outside the working directories from now on', { hold: 'block' }),
        ],
        current: 0,
      },
      note: null,
    },
    bytes: ['', down(1), down(2)],
  },
  {
    name: 'PERM_FETCH',
    screen: join([
      '● Fetching the release notes.',
      '',
      R80,
      ' Fetch',
      '   Fetch the release notes',
      '   url: https://example.com/notes',
      `   prompt: Summarise the changes (${DIALOG_SECRET})`,
      '',
      ' Do you want to allow Claude to fetch this content?',
      ' ❯ 1. Yes',
      '   2. Yes, and don’t ask again for example.com',
      '   3. No, and tell Claude what to do differently (esc)',
      '',
      ' Esc to cancel',
    ]),
    expected: {
      dialog: {
        kind: 'permission',
        title: 'Fetch',
        question: 'Do you want to allow Claude to fetch this content?',
        body: ['Fetch the release notes', 'url: https://example.com/notes', `prompt: Summarise the changes (${DIALOG_SECRET})`],
        options: [pick('Yes'), pick('Yes, and don’t ask again for example.com', { hold: 'rule' }), pick('No, and tell Claude what to do differently (esc)')],
        current: 0,
      },
      note: null,
    },
    bytes: ['', down(1), down(2)],
  },
  {
    name: 'PERM_TICKING_A',
    // A background agent's progress ticks above the dialog's top: neither the model nor the block may change.
    screen: join(createScreen('● helper · 12s')),
    expected: { dialog: CREATE_MODEL, note: null },
    bytes: ['', down(1)],
  },
  {
    name: 'PERM_TICKING_B',
    screen: join(createScreen('● helper · 13s')),
    expected: { dialog: CREATE_MODEL, note: null },
    bytes: ['', down(1)],
  },
  {
    name: 'PERM_RAW_SPACES',
    // Terminal's own text: every line padded to the window's width, CRLF line ends.
    screen: `${createScreen('').map((l) => l.padEnd(80)).join('\r\n')}\r\n`,
    expected: { dialog: CREATE_MODEL, note: null },
    bytes: ['', down(1)],
  },
  {
    name: 'PERM_LONE_SUBMIT',
    // Row 2 wraps and leaves "Submit" alone on its line: parseMenu counts it as a row, the structure check must not.
    screen: join([
      '● Changing the form.',
      '',
      R80,
      ' Edit file',
      ' /tmp/demo/form.html',
      D80,
      '  3 -<button>Send</button>',
      `  3 +<button>Go ${DIALOG_SECRET}</button>`,
      D80,
      ' Do you want to make this edit to form.html?',
      ' ❯ 1. Yes',
      '   2. Yes, and allow edits to the form page while you review the next',
      '      Submit',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ]),
    expected: { dialog: null, note: DIALOG_NOTES.unsure },
    bytes: [],
  },
  {
    name: 'PERM_DEFAULT_NO',
    // dialogs.md 2's "default to No" shape (No first, no numbers, the pointer on No). The main session
    // replaces this screen with the layout spike SP2 records, in both copies.
    screen: join([
      '● Fetching the page title.',
      '',
      R80,
      ' Bash command',
      ` Fetch the page title (${DIALOG_SECRET})`,
      D80,
      ' curl -s https://example.com | head -1',
      D80,
      ' Do you want to proceed?',
      ' ❯ No',
      '   Yes',
      '',
      ' Esc to cancel',
    ]),
    gates: ['noFirst'],
    expected: { dialog: null, note: DIALOG_NOTES.noFirst },
    expectedOpen: {
      dialog: {
        kind: 'permission',
        title: 'Bash command',
        question: 'Do you want to proceed?',
        body: [`Fetch the page title (${DIALOG_SECRET})`, 'curl -s https://example.com | head -1'],
        options: [pick('No'), pick('Yes')],
        current: 0,
      },
      note: null,
    },
    bytes: [],
    bytesOpen: ['', down(1)],
  },

  // --- Plan approval
  {
    name: 'PLAN_FULLSCREEN',
    // mac-2/3 at 96 columns: the plan scrolls in its own box (the right-aligned ↓), the footer wraps. Its box
    // opens with a solid rule right above "Ready to code?", as spikes.md's text has it.
    screen: join([
      '  ⎿  /plan to preview',
      R96,
      '',
      `  ${'─'.repeat(92)}`,
      '   Ready to code?',
      '',
      "   Here is Claude's plan:",
      `  ${'┄'.repeat(92)}`,
      '   Plan: Notes page for the demo app',
      '',
      '   Context',
      '',
      '   The demo app needs a notes page that lists notes and lets you add one.',
      `   Keep the current routes as they are (${DIALOG_SECRET}).`,
      '',
      '   Steps',
      '   - Add a notes list at /notes.',
      '   - Add a form to write a new note.',
      '     The form saves on Enter.',
      '   - Add tests for both.',
      `${' '.repeat(93)}↓`,
      `  ${'─'.repeat(92)}`,
      `   ${PLAN_QUESTION}`,
      '',
      '   ❯ 1. Yes, and use auto mode',
      '     2. Yes, manually approve edits',
      '     3. Tell Claude what to change',
      SHIFT_TAB,
      '',
      '   ctrl+g to edit in VS Code · ~/demo/plans/',
      '   plan-name.md',
      NAME96,
    ]),
    gates: ['tall'],
    expected: {
      dialog: { ...planModel([AUTO, gated(MANUAL, 'tall'), gated(FEEDBACK, 'tall')]), body: [...FULLSCREEN_PLAN, `${' '.repeat(90)}↓`] },
      note: null,
    },
    expectedOpen: { dialog: { ...planModel([AUTO, MANUAL, FEEDBACK]), body: [...FULLSCREEN_PLAN, `${' '.repeat(90)}↓`] }, note: null },
    bytes: ['', null, null],
    bytesOpen: ['', down(1), down(2) + SAMPLE_TEXT],
  },
  {
    name: 'PLAN_80COL',
    // spikes.md: a short plan (no ↓), the question wrapped over two lines, the box indented 2-3 columns.
    screen: join(planScreen(['   ❯ 1. Yes, and use auto mode', '     2. Yes, manually approve edits', '     3. Tell Claude what to change', SHIFT_TAB])),
    expected: { dialog: planModel([AUTO, MANUAL, FEEDBACK]), note: null },
    bytes: ['', down(1), down(2) + SAMPLE_TEXT],
  },
  {
    name: 'PLAN_CLEAR',
    screen: join(
      planScreen([
        '   ❯ 1. Yes, clear context (23% used) and use auto mode',
        '     2. Yes, and use auto mode',
        '     3. Yes, manually approve edits',
        '     4. Tell Claude what to change',
        SHIFT_TAB,
      ]),
    ),
    expected: { dialog: planModel([pick('Yes, clear context (23% used) and use auto mode', { hold: 'context' }), AUTO, MANUAL, FEEDBACK]), note: null },
    bytes: ['', down(1), down(2), down(3) + SAMPLE_TEXT],
  },
  {
    name: 'PLAN_FEEDBACK_TYPED',
    // Feedback typed at the Mac, then the pointer moved back up.
    screen: join(planScreen(['   ❯ 1. Yes, and use auto mode', '     2. Yes, manually approve edits', '     3. use b.txt instead', SHIFT_TAB])),
    expected: { dialog: planModel([AUTO, MANUAL, typed('use b.txt instead')]), note: null },
    bytes: ['', down(1), null],
  },
  {
    name: 'PLAN_TEXT_PENDING',
    // PLAN_80COL after TYPED_PLAN_NOTE was typed into row 3 and Terminal's CR was swallowed (SP5).
    screen: join(
      planScreen([
        '     1. Yes, and use auto mode',
        '     2. Yes, manually approve edits',
        ...wrap(TYPED_PLAN_NOTE, 72).map((l, i) => (i === 0 ? `   ❯ 3. ${l}` : `        ${l}`)),
        SHIFT_TAB,
      ]),
    ),
    gates: ['up'],
    expected: { dialog: planModel([gated(AUTO, 'up'), gated(MANUAL, 'up'), typed(TYPED_PLAN_NOTE)], 2), note: null },
    // Up from the typed row is never sent (pastTyped), so opening the gate frees no row.
    expectedOpen: { dialog: planModel([past(AUTO), past(MANUAL), typed(TYPED_PLAN_NOTE)], 2), note: null },
    bytes: [null, null, null],
    bytesOpen: [null, null, null],
  },

  // --- Questions
  {
    name: 'Q_SINGLE',
    // spikes.md: one question, three options with descriptions, "Type something.", a rule, "Chat about this".
    screen: join(questionScreen(Q_ROWS)),
    expected: { dialog: questionModel([RED, GREEN, BLUE, TYPE, chat]), note: null },
    bytes: ['', down(1), down(2), down(3) + SAMPLE_TEXT, down(4)],
  },
  {
    name: 'Q_TEXT_PENDING',
    // Q_SINGLE after TYPED_ANSWER was typed into row 4 and Terminal's CR was swallowed (SP5): the row shows
    // the text wrapped, the pointer on it, and the hint gains "ctrl+g to edit in VS Code".
    screen: join(
      questionScreen(
        [
          '  1. Red',
          ...Q_ROWS.slice(1, 6),
          ...wrap(TYPED_ANSWER, 75).map((l, i) => (i === 0 ? `❯ 4. ${l}` : `     ${l}`)),
        ],
        { hint: 'Enter to select · ↑/↓ to navigate · ctrl+g to edit in VS Code · Esc to cancel' },
      ),
    ),
    gates: ['up'],
    expected: {
      dialog: questionModel(
        [gated(RED, 'up'), gated(GREEN, 'up'), gated(BLUE, 'up'), typed(wrap(TYPED_ANSWER, 75)[0] as string, { detail: wrap(TYPED_ANSWER, 75).slice(1).join(' ') }), past(chat)],
        3,
      ),
      note: null,
    },
    expectedOpen: {
      dialog: questionModel([past(RED), past(GREEN), past(BLUE), typed(wrap(TYPED_ANSWER, 75)[0] as string, { detail: wrap(TYPED_ANSWER, 75).slice(1).join(' ') }), past(chat)], 3),
      note: null,
    },
    // Every arrow would start on the wrapped text: none is sent (pastTyped).
    bytes: [null, null, null, null, null],
    bytesOpen: [null, null, null, null, null],
  },
  {
    name: 'Q_TYPED',
    // Text typed at the Mac in "Type something.", the pointer moved back to row 1.
    screen: join(questionScreen([...Q_ROWS.slice(0, 6), '  4. teal and grey'])),
    // Chat about this is reached only across the typed row (pastTyped).
    expected: { dialog: questionModel([RED, GREEN, BLUE, typed('teal and grey'), past(chat)]), note: null },
    bytes: ['', down(1), down(2), null, null],
  },
  {
    name: 'Q_ON_CHAT',
    // The pointer on "Chat about this", directly under the full-width rule: not the prompt box.
    screen: join(questionScreen(Q_ON_CHAT_ROWS, { onChat: true })),
    gates: ['up'],
    expected: { dialog: questionModel([gated(RED, 'up'), gated(GREEN, 'up'), gated(BLUE, 'up'), gated(TYPE, 'up'), chat], 4), note: null },
    expectedOpen: { dialog: questionModel([RED, GREEN, BLUE, TYPE, chat], 4), note: null },
    bytes: [null, null, null, null, ''],
    bytesOpen: [up(4), up(3), up(2), up(1) + SAMPLE_TEXT, ''],
  },
  {
    name: 'Q_LONE_NEXT',
    // Row 2's description wraps and leaves "Next" alone at the description column.
    screen: join(
      questionScreen([
        '❯ 1. Red',
        '     Choose red',
        '  2. Green',
        '     Choose green for a calm page, then pick the shade on the screen called',
        '     Next',
        '  3. Blue',
        `     Choose blue (${DIALOG_SECRET})`,
        '  4. Type something.',
      ]),
    ),
    expected: { dialog: null, note: DIALOG_NOTES.unsure },
    bytes: [],
  },
  {
    name: 'Q_NUM_GAP',
    // Numbered 1, 2, 4, 5: a row went missing, so every arrow below it would be off by one.
    screen: join(questionScreen(['❯ 1. Red', '     Choose red', '  2. Green', `     Choose green (${DIALOG_SECRET})`, '  4. Type something.'])),
    expected: { dialog: null, note: DIALOG_NOTES.unsure },
    bytes: [],
  },
  {
    name: 'Q_TABS',
    // Screenshots 44/45 as a 96-column Terminal draws them: three questions, the first answered. The phone's
    // own box wrapped the descriptions, the hint and the bottom edge; Terminal draws each on one line.
    screen: join([
      '● A few questions about the role.',
      '',
      R96,
      '←  ☒ Level  ☐ Scope  ☐ Setup  ✔ Submit  →',
      '',
      'What level should the role be?',
      '',
      '❯ 1. Junior, 0-1 yrs',
      '     Lowest cost; needs the most direction and review from the team on every change.',
      '  2. Junior-mid, 1-3 yrs',
      "     Close to the current team's level. Cheaper, but needs more direction from you.",
      '  3. Senior, 3+ yrs',
      `     Can own a surface end to end (${DIALOG_SECRET}).`,
      '  4. Type something.',
      R96,
      '  5. Chat about this',
      '',
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
      NAME96,
    ]),
    expected: {
      dialog: {
        kind: 'question',
        title: '',
        question: 'What level should the role be?',
        body: [],
        tabs: [
          { label: 'Level', answered: true },
          { label: 'Scope', answered: false },
          { label: 'Setup', answered: false },
        ],
        options: [
          pick('Junior, 0-1 yrs', { detail: 'Lowest cost; needs the most direction and review from the team on every change.' }),
          pick('Junior-mid, 1-3 yrs', { detail: "Close to the current team's level. Cheaper, but needs more direction from you." }),
          pick('Senior, 3+ yrs', { detail: `Can own a surface end to end (${DIALOG_SECRET}).` }),
          TYPE,
          chat,
        ],
        current: 0,
      },
      note: null,
    },
    bytes: ['', down(1), down(2), down(3) + SAMPLE_TEXT, down(4)],
  },
  {
    name: 'Q_MULTI',
    // spikes.md multi-select: a lone CR toggles; "Submit" is an unnumbered row at the label column.
    screen: join(
      multiScreen([
        '❯ 1. [ ] Apple',
        '         Crisp and sweet',
        '  2. [ ] Banana',
        `         Soft (${DIALOG_SECRET})`,
        '  3. [ ] Cherry',
        '         Small and dark',
        '  4. [ ] Type something',
      ]),
    ),
    expected: {
      dialog: multiModel(
        [box('Apple', 'Crisp and sweet', false), box('Banana', `Soft (${DIALOG_SECRET})`, false), box('Cherry', 'Small and dark', false), MULTI_TYPE, SUBMIT, chat],
        0,
      ),
      note: null,
    },
    bytes: ['', down(1), down(2), null, down(4), down(5)],
  },
  {
    name: 'Q_MULTI_TICKED',
    // Apple and Cherry ticked, the pointer on Cherry.
    screen: join(
      multiScreen([
        '  1. [✔] Apple',
        '         Crisp and sweet',
        '  2. [ ] Banana',
        `         Soft (${DIALOG_SECRET})`,
        '❯ 3. [✔] Cherry',
        '         Small and dark',
        '  4. [ ] Type something',
      ]),
    ),
    gates: ['up'],
    expected: {
      dialog: multiModel(
        [gated(box('Apple', 'Crisp and sweet', true), 'up'), gated(box('Banana', `Soft (${DIALOG_SECRET})`, false), 'up'), box('Cherry', 'Small and dark', true), MULTI_TYPE, SUBMIT, chat],
        2,
      ),
      note: null,
    },
    expectedOpen: {
      dialog: multiModel([box('Apple', 'Crisp and sweet', true), box('Banana', `Soft (${DIALOG_SECRET})`, false), box('Cherry', 'Small and dark', true), MULTI_TYPE, SUBMIT, chat], 2),
      note: null,
    },
    bytes: [null, null, '', null, down(2), down(3)],
    bytesOpen: [up(2), up(1), '', null, down(2), down(3)],
  },
  {
    name: 'Q_REVIEW',
    // spikes.md: the review screen has no hint line; the box edges below end the list.
    screen: join(reviewScreen('←  ☒ Colour  ☒ Size  ✔ Submit  →', [' ● Pick a colour', '   → purple', ' ● Pick a size', `   → Large (${DIALOG_SECRET})`])),
    expected: {
      dialog: {
        kind: 'review',
        title: 'Review your answers',
        question: 'Ready to submit your answers?',
        body: ['● Pick a colour', '  → purple', '● Pick a size', `  → Large (${DIALOG_SECRET})`],
        tabs: [
          { label: 'Colour', answered: true },
          { label: 'Size', answered: true },
        ],
        options: [pick('Submit answers'), pick('Cancel')],
        current: 0,
      },
      note: null,
    },
    bytes: ['', down(1)],
  },
  {
    name: 'Q_REVIEW_WARN',
    screen: join(reviewScreen('←  ☒ Colour  ☐ Size  ✔ Submit  →', [' ⚠ You have not answered all questions', '', ' ● Pick a colour', `   → purple (${DIALOG_SECRET})`])),
    expected: {
      dialog: {
        kind: 'review',
        title: 'Review your answers',
        question: 'Ready to submit your answers?',
        body: ['⚠ You have not answered all questions', '● Pick a colour', `  → purple (${DIALOG_SECRET})`],
        tabs: [
          { label: 'Colour', answered: true },
          { label: 'Size', answered: false },
        ],
        options: [pick('Submit answers'), pick('Cancel')],
        current: 0,
      },
      note: null,
    },
    bytes: ['', down(1)],
  },
  {
    name: 'Q_PREVIEW',
    // dialogs.md 5.4: options with previews in two columns, "press n to add notes".
    screen: join([
      '● One layout question.',
      '',
      R96,
      ' ☐ Layout',
      '',
      'Which layout should the page use?',
      '',
      `❯ 1. Cards ✔                    ┌${'─'.repeat(30)}┐`,
      `  2. List                       │ ${'[ card ] [ card ] [ card ]'.padEnd(28)} │`,
      `  3. Table                      │ ${DIALOG_SECRET.padEnd(28)} │`,
      `                                └${'─'.repeat(30)}┘`,
      '                                Notes: press n to add notes',
      R96,
      '  4. Chat about this',
      '',
      'Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel',
    ]),
    expected: { dialog: null, note: DIALOG_NOTES.preview },
    bytes: [],
  },
  {
    name: 'Q_SCROLLED',
    // Six rows, the last behind a ↓ in the pointer column: some options are off screen.
    screen: join([
      '● Picking a region.',
      '',
      R80,
      ' Pick a region',
      '',
      'Which region should the deploy use?',
      '',
      '❯ 1. North',
      '  2. South',
      '  3. East',
      '  4. West',
      '  5. Central',
      `↓ 6. Remote (${DIALOG_SECRET})`,
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]),
    expected: { dialog: null, note: DIALOG_NOTES.scrolled },
    bytes: [],
  },
];

/** A fixture by name (throws on a typo). */
export function dialogFixture(name: string): DialogFixture {
  const f = DIALOG_FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no dialog fixture ${name}`);
  return f;
}

/**
 * What `f` reads to with `gates` (DIALOG_GATES for what ships): its open
 * model and bytes when `gates` open every gate it lists, its gates-off ones
 * when they open none (a gate it doesn't list changes nothing). Throws for
 * gates that open only some of its own: no fixture holds that model.
 */
export function withGates(f: DialogFixture, gates: Readonly<DialogGates>): { expected: DialogFixture['expected']; bytes: Array<string | null> } {
  const own = f.gates ?? [];
  const open = own.filter((g) => gates[g]);
  if (open.length === 0) return { expected: f.expected, bytes: f.bytes };
  if (open.length === own.length && f.expectedOpen && f.bytesOpen) return { expected: f.expectedOpen, bytes: f.bytesOpen };
  throw new Error(`${f.name}: gates ${own.join(', ')} only partly open`);
}

/** Claude's output holding a saved permission screen (a `cat`, a fixture a test printed), as the transcript indents it. */
const SAVED_SCREEN = [
  '● Bash(cat saved-screen.txt)',
  '  ⎿  Bash command',
  `     date > a.txt (${DIALOG_SECRET})`,
  '     Do you want to proceed?',
  '     ❯ 1. Yes',
  '       2. No',
  '',
  '     Esc to cancel · Tab to amend',
];

/**
 * Screens that are not dialogs (spec 9.1, last row): dialogOfScreen gives
 * `{null, null, null}`, but for the two whose dialog-shaped text is Claude's
 * output above another screen (SAVED_OVER_FORM, SAVED_IN_TRANSCRIPT_VIEW):
 * no dialog and the `unsure` note, as a live dialog ends the screen. The
 * keypad may act on the ones without a prompt box and with a visible pointer
 * whose list ends the screen (MODEL_PICKER, MCP_FORM); NO_POINTER_LIST has no
 * ❯ or › (keypad K5), and the two saved screens' ❯ is not the live one.
 */
export const NOT_DIALOG_SCREENS: Readonly<Record<string, string>> = Object.freeze({
  /** The idle prompt box holding a draft that starts like a numbered row. */
  IDLE_DRAFT: join([`● Done. The tests pass (${DIALOG_SECRET}).`, '', R80, '❯ 1. fix the bug first', R80, '  ⏵⏵ auto mode on (shift+tab to cycle)']),
  /** "Press Ctrl-C again to exit" under an empty box. */
  CTRL_C_AGAIN: join([`● Stopped (${DIALOG_SECRET}).`, '', R80, '❯ ', R80, '  Press Ctrl-C again to exit']),
  /** After a No or an Escape: "Interrupted" and an empty box. */
  INTERRUPTED: join([`● Writing the notes (${DIALOG_SECRET}).`, '  ⎿  Interrupted · What should Claude do instead?', '', R80, '❯ ', R80, '  ⏸ manual mode on · ? for shortcuts']),
  /** An answered question still in the scrollback above the box. */
  ANSWERED_ABOVE_BOX: join([
    ' ☐ Colour',
    '',
    'Pick a colour',
    '',
    '  1. Red',
    '❯ 2. Green',
    '  3. Blue',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
    '',
    "● User answered Claude's questions:",
    `  ⎿  · Pick a colour → Green (${DIALOG_SECRET})`,
    '',
    R80,
    '❯ ',
    R80,
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ]),
  /** /model opened at the Mac: Enter would save a default. */
  MODEL_PICKER: join([
    `● Opening the model list (${DIALOG_SECRET}).`,
    '',
    R80,
    ' Select model',
    ' Switch between Claude models. Your pick becomes the default for new sessions.',
    '',
    ' ❯ 1. Default (recommended)  ✔',
    '   2. Opus',
    '   3. Haiku',
    '',
    ' Enter to confirm · s for this session only · Esc to cancel',
  ]),
  /** An MCP server asking for details in a form. */
  MCP_FORM: join([
    `● Asking the notes server (${DIALOG_SECRET}).`,
    '',
    R80,
    ' MCP server “notes” wants some details',
    '',
    ' Name of the notebook',
    ' > my notes',
    ' Share it?',
    ' ❯ Yes',
    '   No',
    '',
    ' Enter to confirm · Esc to cancel',
  ]),
  /** A list with no ❯ or ›: nothing shows which row is highlighted (Terminal shares no colours). */
  NO_POINTER_LIST: join([`● Choosing a theme (${DIALOG_SECRET}).`, '', R80, ' Choose a theme', '   Light', '   Dark', '   Light (colour-blind)', '', ' Enter to confirm · Esc to cancel']),
  /** A saved permission screen in a tool's output, above a live MCP form with only a text field: Return would submit the form. */
  SAVED_OVER_FORM: join([...SAVED_SCREEN, '', R80, ' MCP server “notes” wants some details', '', ' Name of the notebook', ' > my notes', '', ' Enter to confirm · Esc to cancel']),
  /** The same text drawn at column 0 under a rule, at the bottom of the ctrl+o transcript view (its footer under it). */
  SAVED_IN_TRANSCRIPT_VIEW: join([
    '● Bash(cat saved-screen.txt)',
    '  ⎿  (24 lines)',
    R80,
    ' Bash command',
    ` date > a.txt (${DIALOG_SECRET})`,
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
    '',
    '  Showing detailed transcript · ctrl+o to toggle',
  ]),
});
