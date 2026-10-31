/**
 * Launch fixtures (spec 8.2.8): an 11-account roster, the screens a new
 * Terminal tab shows while Claude starts, scripted screen sequences, the
 * fake osascript rules for the real Terminal.app backend, and a helper that
 * writes the launched session's file the way Claude would.
 *
 *   const home = await makeFakeHome({ accounts: launchAccounts(), sessions: [] });
 *   await home.setRules('osascript', launchOsascriptRules({ flow: 'trust', folder }));
 *   ... the launcher opens a window, reads the trust dialog, presses Enter ...
 *   const s = await completeLaunch(home);          // session file from the typed --session-id
 *
 * For a fake TerminalBackend, LaunchScreenScript plays the same screens in
 * process and answers a dialog the way Terminal.app does: every key write
 * ends with one Return, so an arrow moves the pointer and picks.
 *
 * Screen wording: the trust dialog and the input box match what screen.ts
 * and menu.ts parse (Claude Code 2.1). The Chrome intro, "Retry now" and
 * "Keep model" screens carry what the legacy ccw tool matches on them today
 * (ccw startup_answer; research sessions.md 4.6), which WP-L's dialogs.ts
 * matches too: the title "Claude in Chrome" over lines starting "Claude in
 * Chrome works with" and "For more info, use /chrome", with nothing to pick;
 * the title "Claude Code can't start this session yet" over "Retry now"; a
 * title starting "You’re resuming" over an option starting "Keep ". The rest
 * of those lines is filler.
 *
 * v0.4 (WP-LA): a resume types `--resume <id>` in place of `--session-id`,
 * and claude mode types `cd -- <folder> && <claude> <args>` (no account, no
 * `--`). parseLaunchCommand reads both, completeLaunch writes the session
 * under the resumed id (on the default login in claude mode), and the
 * "resume" flow is what a resumed conversation started on another model
 * shows: the Keep-model menu, then ready.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { LaunchPermission } from '@jantar/protocol';
import type { FakeAccount } from './cswap.js';
import { profileDirName } from './cswap.js';
import type { FakeHome, FakeProcess, FakeRule, FakeRuleStep, FakeSession, RecordedCall } from './home.js';
import { SCREEN_MARKER } from './privacy.js';
import type { Entry } from './transcripts.js';

export const LAUNCH_TTY = '/dev/ttys099';
export const LAUNCH_WINDOW_ID = 4242;
/** The launch tab's `number of rows`, the first line of each `contents` answer (an 80x24 window). */
export const LAUNCH_TAB_ROWS = 24;
/** The pid the launched claude gets. */
export const LAUNCH_PID = 42099;
/** Held by ccw (switch.json `hold`, synthetic): Auto and the prompt writer never pick them. */
export const LAUNCH_HELD = [1, 2, 8] as const;
/** The account Auto should pick from launchAccounts(): the lowest 5-hour % among usable ones. */
export const LAUNCH_AUTO_ACCOUNT = 7;
/** A line of WP-L's open-window script (spec 4.5.3) that tells its osascript call apart. */
export const OPEN_SCRIPT_LINE = 'set t to do script cmd';

// ---------------------------------------------------------------------------
// Accounts

const account = (id: number, name: string, over: Partial<FakeAccount>): FakeAccount => {
  const email = `${name}@example.${['com', 'org', 'net'][id % 3]}`;
  return {
    id,
    email,
    organizationUuid: '',
    organizationName: '',
    uuid: `00000000-0000-4000-8000-${'0'.repeat(10)}${id.toString(16).padStart(2, '0')}`,
    usageStatus: 'ok',
    fiveHourPct: 50,
    sevenDayPct: 30,
    fiveHourResetMin: 120,
    ageS: 60,
    profile: id === 1 ? null : profileDirName(id, email),
    ...over,
  };
};

/**
 * Eleven accounts, one case each. The held ones (LAUNCH_HELD: 1, 2, 8) have
 * the most room, so a picker that forgets the hold list picks them; 7 is the
 * right pick for both Auto (launch) and the prompt writer.
 *
 *   1 held, 5% · 2 held, 8% · 3 disabled, re-login · 4 unavailable, 97% · 5 ok, 64%
 *   6 ok, 30% · 7 ok, 12% · 8 held, 3% · 9 ok, 99% (over the ceiling)
 *   10 ok, 20% but 97% weekly (over the weekly ceiling) · 11 ok, 15% but usage 25 min old (stale)
 */
export function launchAccounts(): FakeAccount[] {
  return [
    account(1, 'alpha', { fiveHourPct: 5, sevenDayPct: 10, fiveHourResetMin: 200 }),
    account(2, 'bravo', { alias: 'team-b', fiveHourPct: 8, sevenDayPct: 12, fiveHourResetMin: 180 }),
    account(3, 'charlie', { disabled: true, usageStatus: 'relogin_required', fiveHourPct: 0, sevenDayPct: 0, ageS: 4000 }),
    account(4, 'delta', { usageStatus: 'unavailable', fiveHourPct: 97, sevenDayPct: 96, fiveHourResetMin: 12, ageS: 900 }),
    account(5, 'echo', { fiveHourPct: 64, sevenDayPct: 40, fiveHourResetMin: 60 }),
    account(6, 'foxtrot', { fiveHourPct: 30, sevenDayPct: 35, fiveHourResetMin: 90 }),
    account(7, 'golf', { fiveHourPct: 12, sevenDayPct: 22, fiveHourResetMin: 220 }),
    account(8, 'hotel', { fiveHourPct: 3, sevenDayPct: 5, fiveHourResetMin: 240 }),
    account(9, 'india', { fiveHourPct: 99, sevenDayPct: 60, fiveHourResetMin: 45 }),
    account(10, 'juliet', { fiveHourPct: 20, sevenDayPct: 97, fiveHourResetMin: 150 }),
    account(11, 'kilo', { fiveHourPct: 15, sevenDayPct: 25, fiveHourResetMin: 200, ageS: 1500 }),
  ];
}

// ---------------------------------------------------------------------------
// Screens

export type LaunchScreenName =
  | 'shell'
  | 'trust'
  | 'chromeIntro'
  | 'bypassWarning'
  | 'retryNow'
  | 'keepModel'
  | 'unknownMenu'
  | 'login'
  | 'ready'
  | 'csNotFound'
  | 'claudeExited';

export interface ScreenOptions {
  /** The folder being launched in (absolute). */
  folder: string;
  /** The line the launcher typed (shown at the shell prompt). */
  command?: string;
  /** The session name, shown in the rule above the input box. */
  name?: string;
  version?: string;
  /** The permission mode the ready screen's status line shows. Default: from `command`'s flags, else skip (bypass). */
  mode?: LaunchPermission;
}

interface MenuOption {
  label: string;
  /** Enter on it: the next step, or Claude exits back to the shell. */
  then: 'next' | 'exit';
}

interface MenuSpec {
  /** Lines above the options, under the dialog's rule (the first is the title). */
  body: (o: ScreenOptions) => string[];
  /** None: a notice, answered by any Return. */
  options: MenuOption[];
  numbered: boolean;
  hint: string | null;
}

const RULE = '─'.repeat(80);
const PROMPT = 'tester@synthetic-mac ~ %';

/** The dialogs, as data: LaunchScreenScript moves their pointer. */
const MENUS: Partial<Record<LaunchScreenName, MenuSpec>> = {
  trust: {
    body: (o) => [
      'Accessing workspace:',
      '',
      o.folder,
      '',
      'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
      "project, or work from your team). If not, take a moment to review what's in this folder first.",
      '',
      "Claude Code'll be able to read, edit, and execute files here.",
      '',
      'Security guide',
    ],
    options: [
      { label: 'Yes, I trust this folder', then: 'next' },
      { label: 'No, exit', then: 'exit' },
    ],
    numbered: true,
    hint: 'Enter to confirm · Esc to cancel',
  },
  bypassWarning: {
    body: () => [
      'WARNING: Claude Code running in Bypass Permissions mode',
      '',
      'In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.',
      'This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be',
      'restored if damaged.',
      '',
      'By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
    ],
    options: [
      { label: 'No, exit', then: 'exit' },
      { label: 'Yes, I accept', then: 'next' },
    ],
    numbered: true,
    hint: 'Enter to confirm · Esc to exit',
  },
  chromeIntro: {
    body: () => [
      'Claude in Chrome',
      '',
      'Claude in Chrome works with the Chrome extension to open, read and test pages from this session.',
      '',
      'For more info, use /chrome',
    ],
    options: [],
    numbered: false,
    hint: 'Enter to confirm · Esc to cancel',
  },
  retryNow: {
    body: () => ["Claude Code can't start this session yet"],
    options: [
      { label: 'Retry now', then: 'next' },
      { label: 'Exit', then: 'exit' },
    ],
    numbered: true,
    hint: 'Enter to confirm · Esc to cancel',
  },
  keepModel: {
    body: () => ['You’re resuming a session that was started with a different model'],
    options: [
      { label: 'Keep current model', then: 'next' },
      { label: 'Switch to the default model', then: 'next' },
    ],
    numbered: true,
    hint: 'Enter to confirm · Esc to cancel',
  },
  unknownMenu: {
    body: () => ['Something Claude asks at startup that ccw does not know'],
    options: [
      { label: 'First choice', then: 'next' },
      { label: 'Second choice', then: 'next' },
      { label: 'Third choice', then: 'exit' },
    ],
    numbered: true,
    hint: 'Enter to confirm · Esc to cancel',
  },
};

/** Terminal's first line in a new window (it carries SCREEN_MARKER: screen text must never reach an event), then the prompt with what was typed. */
function tabTop(o: ScreenOptions): string {
  return `Last login: Thu Jan 15 09:59:00 on ttys099 · ${SCREEN_MARKER}\n${o.command ? `${PROMPT} ${o.command}` : `${PROMPT} `}`;
}

function renderMenu(spec: MenuSpec, o: ScreenOptions, current: number): string {
  const options = spec.options.map((opt, i) => {
    const label = spec.numbered ? `${i + 1}. ${opt.label}` : opt.label;
    return i === current ? ` ❯ ${label}` : `   ${label}`;
  });
  return [
    tabTop(o),
    RULE,
    ...spec.body(o).map((l) => (l ? ` ${l}` : '')),
    '',
    ...(options.length ? [...options, ''] : []),
    ...(spec.hint ? [` ${spec.hint}`] : []),
    '',
  ].join('\n');
}

/** Claude's status line under the input box, per mode (the words controls/modes.ts reads). */
const MODE_LINE: Readonly<Record<LaunchPermission, string>> = {
  skip: '⏵⏵ bypass permissions on (shift+tab to cycle)',
  auto: '⏵⏵ auto mode on (shift+tab to cycle)',
  acceptEdits: '⏵⏵ accept edits on (shift+tab to cycle)',
  plan: '⏸ plan mode on (shift+tab to cycle)',
  manual: '⏸ manual mode on (shift+tab to cycle)',
};

/** The mode a typed launch command starts Claude in (launchFlagArgs' permission flags), or null without a readable command. */
function modeOfCommand(command: string | undefined): LaunchPermission | null {
  if (!command) return null;
  let args: string[];
  try {
    args = parseLaunchCommand(command).claudeArgs;
  } catch {
    return null;
  }
  if (args.includes('--dangerously-skip-permissions')) return 'skip';
  const m = optionAfter(args, '--permission-mode');
  if (m === 'bypassPermissions') return 'skip';
  if (m === 'auto' || m === 'acceptEdits' || m === 'plan') return m;
  return 'manual';
}

/** The text of one launch screen, as Terminal's `contents of tab` shows it. `current` moves a dialog's pointer. */
export function launchScreen(name: LaunchScreenName, o: ScreenOptions, current = 0): string {
  const menu = MENUS[name];
  if (menu) return renderMenu(menu, o, current);
  const version = o.version ?? '2.1.300';
  switch (name) {
    case 'shell':
      return `${tabTop(o)}\n`;
    case 'login':
      return [
        tabTop(o),
        RULE,
        ` Welcome to Claude Code v${version}`,
        '',
        ' Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.',
        '',
        ' Select login method:',
        '',
        ' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise',
        '',
        '   2. Anthropic Console account · API usage billing',
        '',
        '   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI',
        '',
      ].join('\n');
    case 'ready': {
      const label = o.name ?? basename(o.folder);
      return [
        tabTop(o),
        `╭─── Claude Code v${version} ${'─'.repeat(40)}╮`,
        '│                Welcome back!                                    │',
        `│   ${o.folder}`,
        `╰${'─'.repeat(66)}╯`,
        '',
        `${'─'.repeat(70)} ${label} ──`,
        '❯ Try "write a test for send.ts"',
        '─'.repeat(80),
        `  ${MODE_LINE[o.mode ?? modeOfCommand(o.command) ?? 'skip']}`,
        '',
      ].join('\n');
    }
    case 'csNotFound':
      return [tabTop(o), 'zsh: command not found: cs', `${PROMPT} `, ''].join('\n');
    case 'claudeExited':
      return [tabTop(o), '', 'Bye!', `${PROMPT} `, ''].join('\n');
    default:
      throw new Error(`no launch screen ${name}`);
  }
}

/** The options a dialog screen offers (null for a screen with nothing to pick, the Chrome intro included). */
export function launchMenu(name: LaunchScreenName): string[] | null {
  const menu = MENUS[name];
  return menu?.options.length ? menu.options.map((o, i) => (menu.numbered ? `${i + 1}. ${o.label}` : o.label)) : null;
}

/** Whether choosing `option` of a dialog screen ends Claude ("No, exit"). */
export function launchOptionExits(name: LaunchScreenName, option: number): boolean {
  return MENUS[name]?.options[option]?.then === 'exit';
}

// ---------------------------------------------------------------------------
// Flows

export interface LaunchStep {
  screen: LaunchScreenName;
  /** Stay until a key write picks one of the dialog's options (any Return for a notice). Otherwise shown `times` reads. */
  until?: 'answer';
  /** Reads before moving on (default 1). The last step stays. */
  times?: number;
}

export type LaunchFlowName =
  | 'clean'
  | 'trust'
  | 'chrome-intro'
  | 'trust-then-chrome'
  | 'bypass'
  | 'retry-now'
  | 'keep-model'
  | 'unknown-menu'
  | 'login'
  | 'cs-not-found'
  | 'claude-exits'
  | 'resume';

/** What a new tab shows, read after read (spec 8.2.8 and the 4.5.5 dialog table). */
export const LAUNCH_FLOWS: Readonly<Record<LaunchFlowName, readonly LaunchStep[]>> = {
  clean: [{ screen: 'shell' }, { screen: 'ready' }],
  trust: [{ screen: 'shell' }, { screen: 'trust', until: 'answer' }, { screen: 'ready' }],
  'chrome-intro': [{ screen: 'shell' }, { screen: 'chromeIntro', until: 'answer' }, { screen: 'ready' }],
  'trust-then-chrome': [{ screen: 'shell' }, { screen: 'trust', until: 'answer' }, { screen: 'chromeIntro', until: 'answer' }, { screen: 'ready' }],
  bypass: [{ screen: 'shell' }, { screen: 'bypassWarning', until: 'answer' }, { screen: 'ready' }],
  'retry-now': [{ screen: 'shell' }, { screen: 'retryNow', until: 'answer' }, { screen: 'ready' }],
  'keep-model': [{ screen: 'shell' }, { screen: 'keepModel', until: 'answer' }, { screen: 'ready' }],
  'unknown-menu': [{ screen: 'shell' }, { screen: 'unknownMenu', until: 'answer' }, { screen: 'ready' }],
  login: [{ screen: 'shell' }, { screen: 'login' }],
  'cs-not-found': [{ screen: 'csNotFound' }],
  'claude-exits': [{ screen: 'shell' }, { screen: 'claudeExited' }],
  resume: [{ screen: 'shell' }, { screen: 'keepModel', until: 'answer' }, { screen: 'ready' }],
};

export interface LaunchScriptOptions extends ScreenOptions {
  /**
   * Terminal.app ends every key write with one Return (`do script`; the
   * pressKey contract), which in a menu is the selection itself: an arrow
   * moves the pointer and then picks, as WP-L's answerKeys() expects.
   * Default true; false keeps arrows pointer-only, until spike S1 settles it.
   */
  appendedReturn?: boolean;
  /**
   * An `enter` that types a Return of its own as well as Terminal's (the
   * "\r" KEY_BYTES.enter once was): the second Return answers the dialog
   * that follows (trust-then-chrome). Off (default): KEY_BYTES.enter is an
   * empty write, so an `enter` is Terminal's Return alone.
   */
  doubleEnter?: boolean;
}

/**
 * A new tab's screens for a fake TerminalBackend: `screen()` is
 * `readScreen`, `press()` is `pressKey`. Arrows move a dialog's pointer and
 * the Return that ends every write picks the highlighted option (Claude
 * exits on "No, exit"). Every key and every answer is recorded.
 */
export class LaunchScreenScript {
  readonly keys: Array<'up' | 'down' | 'enter'> = [];
  /** Each dialog answered: its screen and the option picked (0 for a notice). */
  readonly answers: Array<{ screen: LaunchScreenName; option: number }> = [];
  private readonly steps: LaunchStep[];
  private at = 0;
  private reads = 0;
  private pointer = 0;
  private exited = false;

  constructor(
    flow: LaunchFlowName | readonly LaunchStep[],
    private readonly opts: LaunchScriptOptions,
  ) {
    this.steps = [...(typeof flow === 'string' ? LAUNCH_FLOWS[flow] : flow)];
    if (!this.steps.length) throw new Error('a launch flow needs at least one step');
  }

  /** The screen showing now. */
  get state(): LaunchScreenName {
    return this.exited ? 'claudeExited' : (this.steps[this.at] as LaunchStep).screen;
  }

  /** Index of the highlighted option on a dialog. */
  get current(): number {
    return this.pointer;
  }

  /** Read the screen (each read counts toward a step's `times`). */
  screen(): string {
    const name = this.state;
    const text = launchScreen(name, this.opts, this.pointer);
    const step = this.steps[this.at] as LaunchStep;
    if (!this.exited && !step.until) {
      this.reads += 1;
      if (this.reads >= (step.times ?? 1)) this.advance();
    }
    return text;
  }

  /** One key write into the tab (with Terminal's Return after it, unless appendedReturn is false). */
  press(key: 'up' | 'down' | 'enter', repeat = 1): void {
    for (let i = 0; i < repeat; i++) this.keys.push(key);
    if (this.exited) return;
    const appended = this.opts.appendedReturn ?? true;
    if (key !== 'enter') {
      const menu = MENUS[(this.steps[this.at] as LaunchStep).screen];
      if (menu?.options.length) {
        const delta = key === 'down' ? repeat : -repeat;
        this.pointer = Math.min(menu.options.length - 1, Math.max(0, this.pointer + delta));
      }
      if (appended) this.pressReturn();
      return;
    }
    this.pressReturn();
    if (appended && this.opts.doubleEnter) this.pressReturn();
  }

  /** A Return: on a dialog step it picks the highlighted option; elsewhere it does nothing here. */
  private pressReturn(): void {
    if (this.exited) return;
    const step = this.steps[this.at] as LaunchStep;
    if (!step.until) return;
    this.answers.push({ screen: step.screen, option: this.pointer });
    if (launchOptionExits(step.screen, this.pointer)) {
      this.exited = true;
      return;
    }
    this.advance();
  }

  private advance(): void {
    if (this.at < this.steps.length - 1) {
      this.at += 1;
      this.reads = 0;
      this.pointer = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// The fake osascript, for the real Terminal.app backend

/** WP-L's open-window call answering `ok / <tty> / <window id>`. */
export function openWindowRule(opts: { tty?: string; windowId?: number; stdinIncludes?: string } = {}): FakeRule {
  return {
    match: { stdinIncludes: opts.stdinIncludes ?? OPEN_SCRIPT_LINE },
    stdout: `ok\n${opts.tty ?? LAUNCH_TTY}\n${opts.windowId ?? LAUNCH_WINDOW_ID}\n`,
  };
}

/** The open-window call refused by macOS Automation permission (-1743). */
export function openWindowDeniedRule(opts: { stdinIncludes?: string } = {}): FakeRule {
  return {
    match: { stdinIncludes: opts.stdinIncludes ?? OPEN_SCRIPT_LINE },
    code: 1,
    stderr: '275:281: execution error: Not authorized to send Apple events to Terminal. (-1743)\n',
  };
}

export interface LaunchRulesOptions extends ScreenOptions {
  flow: LaunchFlowName | readonly LaunchStep[];
  tty?: string;
  windowId?: number;
  /** Fail the open-window call with -1743 instead. */
  denied?: boolean;
}

/**
 * The keys of KEY_BYTES (WP-C's terminal-app/keys.ts) a launcher writes to
 * answer a dialog. Enter is an empty write: Terminal's own Return picks.
 */
const ENTER_BYTES = '';
const DOWN_BYTES = '\u001b[B';

/**
 * The one `type` payload that picks `option` of a dialog whose pointer is on
 * its first option: Enter (an empty write), or that many downs (Terminal's
 * Return picks).
 */
export function dialogAnswerBytes(option: number): string {
  return option === 0 ? ENTER_BYTES : DOWN_BYTES.repeat(option);
}

/**
 * Rules for the fake osascript: the open-window call, then TERMINAL_APP_SCRIPT
 * on the new tty (`find`, `contents` as a sequence of screens, `type`). A
 * dialog step stays until a `type` into that tab picks one of its options
 * (dialogAnswerBytes): one that goes on shows the next step, one that ends
 * Claude ("No, exit", or Enter on the bypass warning) shows claudeExited.
 * Any other `type` leaves the dialog on screen.
 */
export function launchOsascriptRules(opts: LaunchRulesOptions): FakeRule[] {
  const tty = opts.tty ?? LAUNCH_TTY;
  const wid = opts.windowId ?? LAUNCH_WINDOW_ID;
  const steps = typeof opts.flow === 'string' ? LAUNCH_FLOWS[opts.flow] : opts.flow;
  const last = steps.length - 1;
  const exited = steps.length; // the claudeExited entry after the flow
  const step = (s: LaunchStep, i: number): FakeRuleStep => {
    const stdout = `ok\n${LAUNCH_TAB_ROWS}\n${launchScreen(s.screen, opts)}`;
    if (!s.until) return i === last ? { stdout, hold: true } : { stdout, times: s.times ?? 1 };
    const n = MENUS[s.screen]?.options.length || 1;
    const jump = Array.from({ length: n }, (_, k) => ({
      match: { args: ['-', tty, 'type', dialogAnswerBytes(k)] },
      to: launchOptionExits(s.screen, k) ? exited : Math.min(i + 1, last),
    }));
    return { stdout, hold: true, jump };
  };
  return [
    opts.denied ? openWindowDeniedRule() : openWindowRule({ tty, windowId: wid }),
    { match: { argsPrefix: ['-', tty, 'find'] }, stdout: `ok\n${wid}\n1\n${basename(opts.folder)} — claude\n` },
    {
      match: { argsPrefix: ['-', tty, 'contents'] },
      seq: [...steps.map(step), { stdout: `ok\n${LAUNCH_TAB_ROWS}\n${launchScreen('claudeExited', opts)}`, hold: true }],
    },
    { match: { argsPrefix: ['-', tty, 'type'] }, stdout: 'ok\n' },
    { match: { argsPrefix: ['-', tty, 'focus'] }, stdout: 'ok\n' },
  ];
}

/** The login shell and claude on the launch tty, for the fake `ps` (foregroundOf by tty). */
export function launchProcesses(opts: { tty?: string; pid?: number; startMs: number }): FakeProcess[] {
  const tty = (opts.tty ?? LAUNCH_TTY).replace(/^\/dev\//, '');
  const pid = opts.pid ?? LAUNCH_PID;
  return [
    { pid: pid - 1, ppid: 1, tty, stat: 'Ss', comm: '-zsh', args: '-zsh', startMs: opts.startMs - 1000, pcpu: 0, user: 'tester' },
    { pid, ppid: pid - 1, tty, stat: 'S+', comm: 'claude', args: 'claude', startMs: opts.startMs, pcpu: 1, user: 'tester' },
  ];
}

// ---------------------------------------------------------------------------
// The typed command and the session it starts

export interface ParsedLaunchCommand {
  mode: 'cs-shell' | 'cswap-run' | 'claude';
  /** From `cd -- <folder>`. */
  folder: string | null;
  /** null in claude mode: it names no account. */
  account: number | null;
  /** Everything after `--` (claude mode: after claude): launchFlagArgs plus --session-id or --resume, and --name. */
  claudeArgs: string[];
  sessionId: string | null;
  /** v0.4: the conversation a resume opens (`--resume <id>`). */
  resume: string | null;
  name: string | null;
  /** Commands between the cd and the launcher (launch.preLaunchArgv). */
  preLaunch: string[][];
}

/** Split a shell line into words and `&&`, honouring single quotes (as q() writes them), double quotes and backslashes. */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error('unclosed single quote');
      cur += line.slice(i + 1, end);
      has = true;
      i = end;
    } else if (ch === '"') {
      i++;
      for (; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1] as string)) i++;
        cur += line[i];
      }
      if (i >= line.length) throw new Error('unclosed double quote');
      has = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else if (ch === '&' && line[i + 1] === '&') {
      if (has) out.push(cur);
      out.push('&&');
      cur = '';
      has = false;
      i++;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const optionAfter = (args: readonly string[], name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? (args[i + 1] as string) : null;
};

/**
 * Read back what the launcher typed (spec 4.5.2): `cd -- <folder> && [pre... &&] (cs N | cswap run --share-history N) -- <args>`,
 * or in claude mode `cd -- <folder> && <claude> <args>`.
 */
export function parseLaunchCommand(command: string): ParsedLaunchCommand {
  const words = shellWords(command);
  const parts: string[][] = [[]];
  for (const w of words) {
    if (w === '&&') parts.push([]);
    else (parts.at(-1) as string[]).push(w);
  }
  let folder: string | null = null;
  const rest: string[][] = [];
  for (const p of parts) {
    if (p[0] === 'cd' && folder === null) folder = (p[1] === '--' ? p[2] : p[1]) ?? null;
    else rest.push(p);
  }
  const launcher = rest.pop();
  if (!launcher) throw new Error('no launcher command');
  if (/(?:^|\/)claude$/.test(launcher[0] ?? '')) {
    const claudeArgs = launcher.slice(1);
    return {
      mode: 'claude',
      folder,
      account: null,
      claudeArgs,
      sessionId: optionAfter(claudeArgs, '--session-id'),
      resume: optionAfter(claudeArgs, '--resume'),
      name: optionAfter(claudeArgs, '--name'),
      preLaunch: rest,
    };
  }
  const dd = launcher.indexOf('--');
  if (dd < 0) throw new Error('no -- before the claude args');
  const head = launcher.slice(0, dd);
  const claudeArgs = launcher.slice(dd + 1);
  const run = head.indexOf('run');
  const mode = run > 0 ? 'cswap-run' : 'cs-shell';
  const n = (run > 0 ? head.slice(run + 1) : head.slice(1)).find((w) => /^\d+$/.test(w));
  if (n === undefined) throw new Error('no account number');
  return {
    mode,
    folder,
    account: Number(n),
    claudeArgs,
    sessionId: optionAfter(claudeArgs, '--session-id'),
    resume: optionAfter(claudeArgs, '--resume'),
    name: optionAfter(claudeArgs, '--name'),
    preLaunch: rest,
  };
}

/** The command of the newest open-window call in the fake osascript's log (argv[1] of `osascript - <cmd> <prev>`), or null. */
export function openWindowCommand(calls: readonly RecordedCall[], stdinIncludes = OPEN_SCRIPT_LINE): string | null {
  const call = calls.filter((c) => c.stdin.includes(stdinIncludes)).at(-1);
  return call?.args[1] ?? null;
}

export interface CompleteLaunchOptions {
  /** Default: the newest open-window call's command. */
  command?: string;
  /** Default: the command's account. A different one plays an account mismatch. */
  account?: number;
  tty?: string;
  pid?: number;
  status?: 'busy' | 'idle' | 'waiting';
  /** Start time, epoch ms. Default home.now (fixed, not the wall clock: pass Date.now() for a launcher that compares with it). */
  startedAt?: number;
  /** Default []: a fresh session has said nothing yet. */
  transcript?: Entry[];
}

/**
 * What Claude does once it is past its dialogs: write the session file, with
 * the `--session-id` (or the `--resume` id) and `--name` from the typed
 * command, cwd = its folder, under the account's config dir (claude mode:
 * the default login's), and a live process on the launch tty. The folder
 * must lie inside the fake home (addSession refuses any other). A resume's
 * transcript is written afresh, as for a new session.
 */
export async function completeLaunch(home: FakeHome, opts: CompleteLaunchOptions = {}): Promise<FakeSession> {
  const command = opts.command ?? openWindowCommand(await home.calls('osascript'));
  if (!command) throw new Error('no launch command: the open-window call was never made');
  const cmd = parseLaunchCommand(command);
  const sid = cmd.sessionId ?? cmd.resume;
  if (!sid || !cmd.folder) throw new Error(`the launch command has no --session-id, --resume or folder: ${command}`);
  const account = opts.account ?? cmd.account ?? home.accounts.find((a) => a.profile === null)?.id;
  if (account === undefined) throw new Error('claude mode: the fake home has no default login');
  const tty = (opts.tty ?? LAUNCH_TTY).replace(/^\/dev\//, '');
  return home.addSession({
    sid,
    pid: opts.pid ?? LAUNCH_PID,
    account,
    project: basename(cmd.folder),
    cwd: cmd.folder,
    status: opts.status ?? 'idle',
    name: cmd.name ?? basename(cmd.folder),
    tty,
    startedAt: opts.startedAt ?? home.now,
    transcript: opts.transcript ?? [],
    // --resume goes on in the conversation's own transcript (and its recorded folder).
    keepTranscript: cmd.resume !== null && opts.transcript === undefined,
  });
}

/**
 * Poll the fake osascript's log (in the test process) and complete the
 * launch at the right moment: once the tab is answered (the first `type`
 * into it after the window opened), or right after the window opens. Only
 * an open-window call made after the watch started counts (the newest one).
 * Polling ends when it resolves, is stopped, times out or the home is gone.
 */
export function watchLaunch(
  home: FakeHome,
  opts: CompleteLaunchOptions & { after?: 'answer' | 'open'; pollMs?: number; timeoutMs?: number } = {},
): { session: Promise<FakeSession>; stop(): void } {
  const tty = opts.tty ?? LAUNCH_TTY;
  const since = Date.now();
  let stopped = false;
  const session = (async () => {
    const deadline = since + (opts.timeoutMs ?? 30_000);
    for (;;) {
      const calls = await home.calls('osascript');
      if (stopped) throw new Error('watchLaunch: stopped');
      if (!existsSync(home.root)) throw new Error('watchLaunch: the fake home was cleaned up');
      const open = calls.findLastIndex((c) => c.ts >= since && c.stdin.includes(OPEN_SCRIPT_LINE));
      const ready =
        open >= 0 && ((opts.after ?? 'answer') === 'open' || calls.slice(open + 1).some((c) => c.args[1] === tty && c.args[2] === 'type'));
      if (ready) return completeLaunch(home, { ...opts, command: opts.command ?? (calls[open] as RecordedCall).args[1] });
      if (Date.now() > deadline) throw new Error('watchLaunch: timed out');
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 50));
    }
  })();
  session.catch(() => {}); // a stopped watcher is not an unhandled rejection
  return {
    session,
    stop() {
      stopped = true;
    },
  };
}
