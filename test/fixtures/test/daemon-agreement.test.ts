/**
 * The fixtures against the daemon's own readers: launch screens through
 * terminal/screen.ts, menu.ts and the launcher's dialogs.ts, the file-op
 * denial texts through the alert scanner's denialKind. These are pure
 * modules; importing them here (the daemon depends on the fixtures, not the
 * other way round) is the only way to prove a fixture says what the daemon
 * will read. Keep this list short: a daemon file mid-edit breaks the
 * fixtures' typecheck.
 */
import { describe, expect, it } from 'vitest';
import { answerKeys, dialogAction, readStartupScreen } from '../../../packages/daemon/src/launcher/dialogs.js';
import { denialKind } from '../../../packages/daemon/src/sources/transcripts/alerts.js';
import { keysToChoose, parseMenu } from '../../../packages/daemon/src/terminal/menu.js';
import { readScreenState, screenBlocker } from '../../../packages/daemon/src/terminal/screen.js';
import {
  DENIAL_TEXT,
  LaunchScreenScript,
  dialogAnswerBytes,
  fileOpsScenario,
  launchMenu,
  launchOptionExits,
  launchScreen,
  type LaunchScreenName,
} from '../src/index.js';

const o = { folder: '/synthetic/home/Desktop/work/foo', command: "cd -- '/synthetic/home/Desktop/work/foo' && cs 7 -- --chrome", name: 'foo' };

/**
 * The legacy ccw tool's reading of a startup dialog, ported line for line
 * from its Python (dialog_body, dialog_title, startup_answer; the relaunch
 * loop's screen_tail(25) with each line stripped): the keys it would send, or
 * null when it leaves the dialog for the user. The --resume-only dialogs
 * ("Resume full session as-is", "Resume this conversation?") are left out:
 * no launch fixture shows them.
 */
function ccwStartupAnswer(screen: string): { title: string; options: string[]; on: string | null; keys: string | null } | null {
  const tail = screen.split('\n').map((l) => l.trimEnd());
  while (tail.length && !tail.at(-1)) tail.pop();
  const lines = tail.slice(-25).map((l) => l.trim().replace(/^[│ ]+|[│ ]+$/gu, ''));
  if (!lines.length || !(lines.at(-1) as string).startsWith('Enter to confirm')) return null;
  let top = -1;
  lines.slice(0, -1).forEach((l, i) => {
    if (l.startsWith('Enter to confirm') || (l && /^[─╌┄┈━═\-–—_ ]+$/u.test(l))) top = i;
  });
  const body = lines.slice(top + 1);
  const title = body.slice(0, -1).find(Boolean) ?? '';
  const opts = new Map<string, boolean>();
  for (const l of body) {
    if (l.startsWith('❯') || /^\d+\.\s/u.test(l) || ['Yes, I trust this folder', 'No, exit', 'Resume', 'Start a new conversation'].includes(l)) {
      opts.set((/^(?:❯\s*)?(?:\d+\.\s*)?(.+)$/u.exec(l) as RegExpExecArray)[1] as string, l.startsWith('❯'));
    }
  }
  const on = [...opts].find(([, cur]) => cur)?.[0] ?? null;
  const out = (keys: string | null) => ({ title, options: [...opts.keys()], on, keys });
  if (opts.has('Yes, I trust this folder')) return out(on === 'Yes, I trust this folder' ? '' : on?.startsWith('No,') ? '\u001b[B' : null);
  if (title === 'Claude in Chrome' || body.some((l) => l.startsWith('Claude in Chrome works with') || l.startsWith('For more info, use /chrome'))) {
    return out(opts.size === 0 ? '' : null);
  }
  if (title.startsWith('You’re resuming') && on?.startsWith('Keep ')) return out('');
  if (title === "Claude Code can't start this session yet" && on === 'Retry now') return out('');
  return out(null);
}

const DIALOGS: Array<[LaunchScreenName, string]> = [
  ['trust', 'trust'],
  ['chromeIntro', 'chrome'],
  ['bypassWarning', 'bypass'],
  ['retryNow', 'retry'],
  ['keepModel', 'keep-model'],
  ['unknownMenu', 'unknown'],
];

describe('launch screens as screen.ts reads them', () => {
  it.each(['trust', 'bypassWarning', 'retryNow', 'keepModel', 'unknownMenu'] as LaunchScreenName[])('%s is a dialog with its menu', (name) => {
    const st = readScreenState(launchScreen(name, o));
    expect(st.inputBox).toBeNull();
    expect(st.dialog?.kind).toBe('confirm');
    expect(st.dialog?.options).toEqual(launchMenu(name));
    expect(st.dialog?.current).toBe(0);
    expect(screenBlocker(st)).toMatch(/a dialog is open/);
  });

  it('the trust dialog: its title, and the keys to each option', () => {
    const st = readScreenState(launchScreen('trust', o));
    expect(st.dialog?.title).toBe('Accessing workspace:');
    const menu = parseMenu(launchScreen('trust', o));
    expect(menu).toEqual({ options: ['1. Yes, I trust this folder', '2. No, exit'], current: 0 });
    expect(keysToChoose(menu!, 0)).toBe('');
    expect(keysToChoose(menu!, 1)).toBe('\u001b[B');
    // the pointer moved by LaunchScreenScript reads back as moved
    expect(parseMenu(launchScreen('bypassWarning', o, 1))?.current).toBe(1);
  });

  it('the Chrome intro is a confirm notice titled "Claude in Chrome"; the login screen a menu', () => {
    const chrome = readScreenState(launchScreen('chromeIntro', o));
    expect(chrome.dialog).toMatchObject({ kind: 'confirm', title: 'Claude in Chrome' });
    expect(chrome.dialog?.options).toBeUndefined();
    const login = readScreenState(launchScreen('login', o));
    expect(login.dialog?.kind).toBe('menu');
    expect(login.dialog?.options).toHaveLength(3);
  });

  it("Claude ready: the input box (empty, Claude's placeholder) and no dialog", () => {
    const st = readScreenState(launchScreen('ready', o));
    expect(st.dialog).toBeNull();
    expect(st.inputBox).toMatchObject({ text: '', placeholder: true });
    expect(screenBlocker(st)).toBeNull();
  });

  it.each(['shell', 'csNotFound', 'claudeExited'] as LaunchScreenName[])('%s: no box, no dialog', (name) => {
    const st = readScreenState(launchScreen(name, o));
    expect(st.inputBox).toBeNull();
    expect(st.dialog).toBeNull();
  });
});

describe('launch dialogs as the legacy ccw tool and the launcher read them', () => {
  it('ccw answers the Chrome intro, "Retry now" and "Keep model" on its own (spec 4.5.5), and trust from its options', () => {
    expect(ccwStartupAnswer(launchScreen('chromeIntro', o))).toMatchObject({ title: 'Claude in Chrome', options: [], keys: '' });
    expect(ccwStartupAnswer(launchScreen('retryNow', o))).toMatchObject({ title: "Claude Code can't start this session yet", on: 'Retry now', keys: '' });
    expect(ccwStartupAnswer(launchScreen('keepModel', o))).toMatchObject({ on: 'Keep current model', keys: '' });
    expect(ccwStartupAnswer(launchScreen('keepModel', o))?.title).toMatch(/^You’re resuming/u);
    expect(ccwStartupAnswer(launchScreen('trust', o))).toMatchObject({ title: 'Accessing workspace:', keys: '' });
    expect(ccwStartupAnswer(launchScreen('trust', o, 1))).toMatchObject({ on: 'No, exit', keys: '\u001b[B' });
    // left for the user: the bypass warning and a menu ccw does not know
    expect(ccwStartupAnswer(launchScreen('bypassWarning', o))?.keys).toBeNull();
    expect(ccwStartupAnswer(launchScreen('unknownMenu', o))?.keys).toBeNull();
    // and no dialog at all
    for (const name of ['shell', 'ready', 'csNotFound', 'claudeExited'] as LaunchScreenName[]) expect(ccwStartupAnswer(launchScreen(name, o)), name).toBeNull();
  });

  it.each(DIALOGS)("%s is classified %s by WP-L's readStartupScreen", (name, kind) => {
    const { dialog } = readStartupScreen(launchScreen(name, o));
    expect(dialog?.kind).toBe(kind);
    expect(dialog?.bare).toBe(name === 'chromeIntro');
  });

  it('the three auto answers act on their own; trust, bypass and unknown wait for a card; login fails', () => {
    const act = (name: LaunchScreenName) => dialogAction(readStartupScreen(launchScreen(name, o)).dialog!, { retried: 0, account: 7 });
    expect(act('chromeIntro')).toEqual({ act: 'auto', option: 0 });
    expect(act('retryNow')).toEqual({ act: 'auto', option: 0 });
    expect(act('keepModel')).toEqual({ act: 'auto', option: 0 });
    for (const name of ['trust', 'bypassWarning', 'unknownMenu'] as LaunchScreenName[]) expect(act(name), name).toEqual({ act: 'card' });
    expect(readStartupScreen(launchScreen('login', o)).dialog?.kind).toBe('login');
  });

  it.each(DIALOGS)("%s: answerKeys() for each option, fed through LaunchScreenScript.press(), picks that option", (name) => {
    const n = launchMenu(name)?.length ?? 1;
    for (let option = 0; option < n; option++) {
      const s = new LaunchScreenScript([{ screen: 'shell' }, { screen: name, until: 'answer' }, { screen: 'ready' }], o);
      s.screen();
      const { dialog } = readStartupScreen(s.screen());
      const keys = answerKeys(dialog!, option);
      if (keys.key === 'enter') s.press('enter');
      else s.press(keys.key, keys.repeat);
      expect(s.answers, `${name} ${option}`).toEqual([{ screen: name, option }]);
      expect(s.state).toBe(launchOptionExits(name, option) ? 'claudeExited' : 'ready');
      // the osascript rules expect the same bytes (menu.ts keysToChoose; for the highlighted one an empty
      // write, whose Return Terminal adds: KEY_BYTES.enter)
      const menu = parseMenu(launchScreen(name, o));
      expect(dialogAnswerBytes(option)).toBe(menu && option > 0 ? keysToChoose(menu, option) : '');
    }
  });
});

describe('file-op denial texts as the alert scanner reads them', () => {
  it('rejected, blocked, or neither', () => {
    expect(denialKind(DENIAL_TEXT.rejected)).toBe('rejected');
    expect(denialKind(DENIAL_TEXT.denyRule('Write', '/w/.env'))).toBe('blocked');
    expect(denialKind(DENIAL_TEXT.autoMode)).toBe('blocked');
    expect(denialKind(DENIAL_TEXT.safety)).toBe('blocked');
    expect(denialKind(DENIAL_TEXT.hook)).toBe('blocked');
    expect(denialKind(DENIAL_TEXT.notFound)).toBeNull();
  });

  it("every refused op's expected status is denialKind(text) ?? 'error'", () => {
    const s = fileOpsScenario({ sid: 'sid', cwd: '/w', at: 0, largeBytes: 100 });
    const results = new Map<string, string>();
    for (const e of s.main) {
      const block = (e.message as { content?: Array<Record<string, unknown>> } | undefined)?.content?.[0];
      if (block?.type === 'tool_result' && block.is_error) results.set(block.tool_use_id as string, block.content as string);
    }
    const refused = s.expected.filter((x) => results.has(x.opId));
    expect(refused).toHaveLength(5);
    for (const op of refused) expect(op.status, op.label).toBe(denialKind(results.get(op.opId) as string) ?? 'error');
  });
});
