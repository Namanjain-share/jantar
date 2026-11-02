/**
 * The popup (spec 3.10) against the chrome fake, with a stand-in worker
 * that answers `state` as each test says: every state renders (not paired,
 * the D1 offer, not a meeting tab, the waiting room, the assign sheet,
 * notes on, the daemon's problems, Settings); pairing, Start, Screenshot,
 * End and Unpair send their one message; the permission request runs from
 * the click itself; the target tab comes from `?tab=` or the active tab;
 * no em dash or exclamation mark anywhere; nothing of a meeting in the
 * console; a line while the worker has not answered; a screen reader hears
 * the view's first line once when it changes, not the whole popup again;
 * the captions sentences are the page's own. v0.5.3: Settings shows the
 * shortcut (with a link to Chrome's shortcuts page) and the last screenshot
 * try with Chrome's words or Jantar's status; the main view names this
 * tab's failed try of the last 10 minutes, and never claims the tab is
 * allowed. The run against the real worker is with-worker.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEETING_MARKER } from '@jantar/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALWAYS, ARM, BAD_CODE, CALL_CHECK, MISMATCH, NOT_RUNNING, PAIR_AGAIN, READS, TRY_AGAIN } from '../../src/background/sentences.js';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import { teamsAdapter } from '../../src/content/adapters/teams.js';
import { NOT_FOUND as PAGE_NOT_FOUND } from '../../src/content/capture.js';
import type { ArmView, FromPopup, LastShot, PopupState } from '../../src/shared/messages.js';
import { ARM_TIMING } from '../../src/shared/wire.js';
import { HOW_TO, LOADING, NOT_FOUND, RECENT_SHOT_MS, SHORTCUTS_URL, TELL_PEOPLE, clockOf, inTheCall, mountPopup, tabFromSearch, type Popup } from '../../src/popup/app.js';
import { CAPTURE_PERMISSION_ERROR, createChromeFake, type ChromeFake, type ChromeModel } from '../helpers/chrome-fake.js';

const PROJECT_A = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const PROJECT_B = '01JFZ8X8Y3T0V5G9WQK2M4N6QR';

type Tab = NonNullable<PopupState['tab']>;
// v0.10: a tab's stage follows inCall unless a test names one; no arm, no start by itself.
const meetTab = (over: Partial<Tab> = {}): Tab => ({ site: 'meet', inCall: true, title: 'Weekly sync', notes: false, shots: 0, captions: 'unknown', stage: over.inCall === false ? 'none' : 'in', hook: '', arm: null, auto: null, ...over });
const state = (over: Partial<PopupState> = {}): PopupState => ({ connection: 'ok', pageButton: true, projects: null, tab: null, lastShot: null, shortcut: '', reads: false, always: false, ...over }) as PopupState;

let chrome: ChromeFake;
let model: ChromeModel;
let root: HTMLElement;
let sent: FromPopup[];
let answers: { state: PopupState | undefined; done: Record<string, unknown> };
let closed: number;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  ({ chrome, model } = createChromeFake());
  document.body.replaceChildren();
  root = document.createElement('main');
  root.id = 'app';
  document.body.append(root);
  sent = [];
  closed = 0;
  answers = { state: state(), done: {} };
  // A stand-in worker: records each message and answers it.
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    const m = msg as FromPopup;
    sent.push(m);
    if (m.t === 'state') respond(answers.state);
    else if (m.t === 'shot') respond({ ok: true, text: 'Saved' });
    else respond(answers.done[m.t] ?? { ok: true });
    return undefined;
  });
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
});

afterEach(() => {
  // MP7: names, titles and people never reach the console.
  const seen = consoleSpies.flatMap((s) => s.mock.calls.flat()).map(String).join('\n');
  expect(seen).not.toContain(MEETING_MARKER);
  model.uninstall();
});

const open = (tabId: number | null = 7): Promise<Popup> => mountPopup({ root, tabId, close: () => (closed += 1) });
const text = () => root.textContent ?? '';
const buttons = () => [...root.querySelectorAll('button')];
const buttonNamed = (name: string) => {
  const b = buttons().find((x) => x.textContent === name);
  if (!b) throw new Error(`no button ${name}: ${buttons().map((x) => x.textContent).join(', ')}`);
  return b;
};
const input = (id: string) => root.querySelector<HTMLInputElement>(`#${id}`) as HTMLInputElement;
const select = () => root.querySelector<HTMLSelectElement>('#project');
const type = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};
const submit = (name: string) => buttonNamed(name).click();
/** Every word a person could read: text and the attributes that show. */
const words = () => [text(), ...[...root.querySelectorAll('[placeholder],[aria-label],[title]')].flatMap((e) => ['placeholder', 'aria-label', 'title'].map((a) => e.getAttribute(a) ?? ''))].join('\n');
const noBadMarks = () => expect(words()).not.toMatch(/[—!]/);

describe('not paired', () => {
  it('asks for the pairing code and shows the command', async () => {
    answers.state = state({ connection: 'unpaired', pageButton: false });
    await open();
    expect(text()).toContain('Pair with Jantar on this Mac.');
    expect(root.querySelector('label[for="code"]')?.textContent).toBe('Pairing code');
    expect(input('code').type).toBe('text');
    expect(root.querySelector('.mono')?.textContent).toBe('jantar pair --extension');
    expect(buttons().map((b) => b.textContent)).toEqual(['Pair']);
    noBadMarks();
  });

  it('after a 401 says "Pair again"', async () => {
    answers.state = state({ connection: 'unpaired', sentence: PAIR_AGAIN, pageButton: false });
    await open();
    expect(text()).toContain(PAIR_AGAIN);
    expect(text()).not.toContain('Pair with Jantar on this Mac.');
  });

  it('sends the pasted line, and shows why it did not pair', async () => {
    answers.state = state({ connection: 'unpaired', pageButton: false });
    answers.done.pair = { ok: false, error: BAD_CODE };
    await open();
    type(input('code'), ' jantar-ext:7421:C0DEc0de_C0DE-c0deC0 ');
    submit('Pair');
    await vi.waitFor(() => expect(text()).toContain(BAD_CODE));
    expect(sent).toContainEqual({ t: 'pair', text: ' jantar-ext:7421:C0DEc0de_C0DE-c0deC0 ' });
    // What was pasted stays in the field to fix or send again.
    expect(input('code').value).toBe(' jantar-ext:7421:C0DEc0de_C0DE-c0deC0 ');
    answers.done.pair = { ok: false, error: NOT_RUNNING };
    submit('Pair');
    await vi.waitFor(() => expect(text()).toContain(NOT_RUNNING));
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(NOT_RUNNING);
  });
});

describe('just paired (D1)', () => {
  it('offers the page button once: Allow asks Chrome from the click itself', async () => {
    answers.state = state({ connection: 'unpaired', pageButton: false });
    await open();
    type(input('code'), 'jantar-ext:7421:C0DEc0de_C0DE-c0deC0');
    answers.state = state({ pageButton: false });
    submit('Pair');
    await vi.waitFor(() => expect(text()).toContain('Let the screenshot button work on meeting pages'));
    expect(buttons().map((b) => b.textContent)).toEqual(['Allow', 'Not now', 'Settings']);
    noBadMarks();
    model.permissionAnswer = true;
    buttonNamed('Allow').click();
    // Before anything is awaited: Chrome only asks on the user's gesture.
    expect(model.requested).toEqual([['<all_urls>']]);
    answers.state = state({ pageButton: true });
    await vi.waitFor(() => expect(text()).toContain('Open a Google Meet or Teams call in this tab (reload it if the call is already open).'));
  });

  it('Not now goes on without asking; the offer is not shown again', async () => {
    answers.state = state({ connection: 'unpaired', pageButton: false });
    const popup = await open();
    type(input('code'), 'jantar-ext:7421:C0DEc0de_C0DE-c0deC0');
    answers.state = state({ pageButton: false });
    submit('Pair');
    await vi.waitFor(() => expect(text()).toContain('Let the screenshot button work'));
    buttonNamed('Not now').click();
    expect(text()).toContain('Open a Google Meet or Teams call in this tab (reload it if the call is already open).');
    await popup.refresh();
    expect(text()).not.toContain('Let the screenshot button work');
    expect(model.requested).toEqual([]);
  });

  it('is not offered when the page button is already allowed', async () => {
    answers.state = state({ connection: 'unpaired', pageButton: true });
    await open();
    type(input('code'), 'jantar-ext:7421:C0DEc0de_C0DE-c0deC0');
    answers.state = state({ pageButton: true });
    submit('Pair');
    await vi.waitFor(() => expect(text()).toContain('Open a Google Meet or Teams call in this tab (reload it if the call is already open).'));
  });
});

describe('a paired popup', () => {
  it('not a meeting tab: says so, with the connection line', async () => {
    await open();
    expect(text()).toContain('Open a Google Meet or Teams call in this tab (reload it if the call is already open).');
    expect(text()).toContain('Connected to Jantar on this Mac.');
    noBadMarks();
  });

  it('a meeting tab in the waiting room: "Join the call first."', async () => {
    answers.state = state({ tab: meetTab({ inCall: false }) });
    await open();
    expect(text()).toContain('Join the call first.');
    expect(buttons().map((b) => b.textContent)).toEqual(['Settings']);
  });

  it("daemon problems: the daemon's sentence, or the state's own line", async () => {
    for (const [s, line] of [
      [state({ connection: 'off', sentence: 'Meetings are off. Turn them on at your Mac: jantar meetings on' }), 'Meetings are off. Turn them on at your Mac: jantar meetings on'],
      [state({ connection: 'down' }), NOT_RUNNING],
      [state({ connection: 'down', sentence: MISMATCH }), MISMATCH],
    ] as const) {
      answers.state = s;
      await open();
      expect(text()).toContain(line);
      expect(root.querySelector('form')).toBeNull();
    }
  });

  it('the worker not answering reads as Jantar not running', async () => {
    answers.state = undefined;
    await open();
    expect(text()).toContain(NOT_RUNNING);
  });
});

describe('the assign sheet', () => {
  it('prefills the name from the page and lists the projects, No project first', async () => {
    answers.state = state({
      projects: [
        { id: PROJECT_A, name: 'Acme site', emoji: '🚀' },
        { id: PROJECT_B, name: 'Home' },
      ],
      tab: meetTab({ title: 'Weekly sync' }),
    });
    await open();
    expect(input('name').value).toBe('Weekly sync');
    expect(input('name').maxLength).toBe(120);
    expect(input('people').maxLength).toBe(200);
    expect([...(select()?.options ?? [])].map((o) => [o.value, o.textContent])).toEqual([
      ['', 'No project'],
      [PROJECT_A, '🚀 Acme site'],
      [PROJECT_B, 'Home'],
    ]);
    expect(text()).toContain('Let people know you keep notes.');
    expect(buttons().map((b) => b.textContent)).toEqual(['Start notes', 'Screenshot', 'Settings']);
    // The todos switch shows only once a project is chosen.
    const toggle = root.querySelector<HTMLLabelElement>('label.switch');
    expect(toggle?.hidden).toBe(true);
    type(select() as HTMLSelectElement, PROJECT_A);
    expect(toggle?.hidden).toBe(false);
    expect(toggle?.textContent).toBe("Action items go to Acme site's todos");
    expect(input('todos').checked).toBe(false);
    expect(input('todos').getAttribute('role')).toBe('switch');
    noBadMarks();
  });

  it('hides Project while Todos are off; "Meet call" or "Teams call" when the page has no title', async () => {
    answers.state = state({ projects: null, tab: meetTab({ title: '' }) });
    await open();
    expect(select()).toBeNull();
    expect(root.querySelector('label.switch')).toBeNull();
    expect(input('name').value).toBe('Meet call');
    answers.state = state({ projects: [], tab: meetTab({ site: 'teams', title: '' }) });
    await open();
    expect(input('name').value).toBe('Teams call');
    expect(select()).not.toBeNull();
  });

  it('shows the screenshots a meeting already has', async () => {
    answers.state = state({ tab: meetTab({ name: 'Weekly sync', shots: 2 }) });
    await open();
    expect(root.querySelector('.mono')?.textContent).toBe('2 screenshots');
  });

  it("Start sends the sheet's fields; action items go to todos only with a project", async () => {
    answers.state = state({ projects: [{ id: PROJECT_A, name: 'Acme site' }], tab: meetTab() });
    await open();
    type(input('name'), `Planning ${MEETING_MARKER}`);
    type(input('people'), 'Sam, Priya');
    type(select() as HTMLSelectElement, PROJECT_A);
    input('todos').click();
    submit('Start notes');
    await vi.waitFor(() => expect(sent.some((m) => m.t === 'start')).toBe(true));
    expect(sent.find((m) => m.t === 'start')).toEqual({ t: 'start', tabId: 7, name: `Planning ${MEETING_MARKER}`, projectId: PROJECT_A, people: 'Sam, Priya', autoTodos: true });

    sent.length = 0;
    await open();
    input('todos').click();
    type(select() as HTMLSelectElement, '');
    submit('Start notes');
    await vi.waitFor(() => expect(sent.some((m) => m.t === 'start')).toBe(true));
    expect(sent.find((m) => m.t === 'start')).toEqual({ t: 'start', tabId: 7, name: 'Weekly sync', autoTodos: false });
  });

  it('after Start shows notes on; a failed Start says why and keeps the sheet', async () => {
    answers.state = state({ tab: meetTab() });
    answers.done.start = { ok: false, error: 'Meetings are off. Turn them on at your Mac: jantar meetings on' };
    await open();
    type(input('name'), 'Kept name');
    submit('Start notes');
    await vi.waitFor(() => expect(text()).toContain('Meetings are off.'));
    expect(input('name').value).toBe('Kept name');
    answers.done.start = { ok: true };
    answers.state = state({ tab: meetTab({ name: 'Kept name', notes: true }) });
    submit('Start notes');
    await vi.waitFor(() => expect(text()).toContain('Keeping notes · Kept name'));
  });

  it('Screenshot sends the shot and closes the popup first', async () => {
    answers.state = state({ tab: meetTab() });
    await open();
    buttonNamed('Screenshot').click();
    expect(closed).toBe(1);
    await vi.waitFor(() => expect(sent).toContainEqual({ t: 'shot', tabId: 7 }));
  });
});

describe('notes on', () => {
  it('shows the name, the screenshots, the captions in words, Screenshot and End', async () => {
    answers.state = state({ tab: meetTab({ name: 'Weekly sync', notes: true, shots: 3, captions: 'reading' }) });
    await open();
    expect(text()).toContain('Keeping notes · Weekly sync');
    expect(root.querySelector('.mono')?.textContent).toBe('3 screenshots');
    expect(text()).toContain('Reading captions');
    expect(buttons().map((b) => b.textContent)).toEqual(['Screenshot', 'End', 'Settings']);
    noBadMarks();
  });

  it("the captions state: the site's way to turn them on, can't read them, or nothing yet", async () => {
    for (const [tab, line] of [
      [meetTab({ notes: true, captions: 'none' }), HOW_TO.meet],
      [meetTab({ site: 'teams', notes: true, captions: 'none' }), HOW_TO.teams],
      [meetTab({ notes: true, captions: 'notFound' }), NOT_FOUND],
    ] as const) {
      answers.state = state({ tab });
      await open();
      expect(text()).toContain(line);
    }
    answers.state = state({ tab: meetTab({ notes: true, shots: 1, captions: 'unknown' }) });
    await open();
    expect([...root.querySelectorAll('.view p')].map((p) => p.textContent)).toEqual(['Keeping notes · Weekly sync', '1 screenshot']);
  });

  it("the captions sentences are the page's own (the adapters' howTo, capture.ts's not found)", () => {
    expect(HOW_TO.meet).toBe(meetAdapter.howTo);
    expect(HOW_TO.teams).toBe(teamsAdapter.howTo);
    expect(NOT_FOUND).toBe(PAGE_NOT_FOUND);
  });

  it('an answer that is not a Done says "Something went wrong. Try again."', async () => {
    answers.state = state({ tab: meetTab({ name: 'Weekly sync', notes: true }) });
    answers.done.end = 'not a Done';
    await open();
    buttonNamed('End').click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe(TRY_AGAIN));
  });

  it('End sends end and shows the sheet again', async () => {
    answers.state = state({ tab: meetTab({ name: 'Weekly sync', notes: true }) });
    await open();
    answers.state = state({ tab: meetTab() });
    buttonNamed('End').click();
    await vi.waitFor(() => expect(text()).toContain('Start notes'));
    expect(sent).toContainEqual({ t: 'end', tabId: 7 });
  });
});

describe('Settings', () => {
  it('offers the page button (Allow, or "Allowed") and Unpair', async () => {
    answers.state = state({ pageButton: false });
    await open();
    buttonNamed('Settings').click();
    expect(text()).toContain('Screenshot button on meeting pages');
    buttonNamed('Allow').click();
    expect(model.requested).toEqual([['<all_urls>']]);
    answers.state = state({ pageButton: true });
    await vi.waitFor(() => expect(text()).toContain('Allowed'));
    noBadMarks();
    answers.state = state({ connection: 'unpaired', pageButton: true });
    buttonNamed('Unpair').click();
    await vi.waitFor(() => expect(text()).toContain('Pair with Jantar on this Mac.'));
    expect(sent).toContainEqual({ t: 'unpair' });
  });

  it('Back returns to the main view', async () => {
    await open();
    buttonNamed('Settings').click();
    buttonNamed('Back').click();
    expect(text()).toContain('Open a Google Meet or Teams call in this tab (reload it if the call is already open).');
  });
});

const ALLOW_HERE_WHY = 'click the Jantar icon once in this tab, then try again.';
/** 12:41 on this Mac's clock. */
const AT_1241 = new Date(2026, 9, 31, 12, 41, 30).getTime();
const shotRecord = (over: Partial<LastShot> = {}): LastShot => ({ at: AT_1241, from: 'page', tabId: 7, ok: true, text: 'Saved', step: 'saved', ...over });
const granted = shotRecord({ ok: false, text: `Not saved: ${ALLOW_HERE_WHY}`, step: 'grant', chrome: CAPTURE_PERMISSION_ERROR });
/** The Settings view's text, line by line (each row and paragraph). */
const settingsLines = () => [...root.querySelectorAll('.view .row, .view .stack p')].map((n) => n.textContent);

describe('v0.5.3: Settings › Shortcut', () => {
  it('shows the key Chrome holds, with Change opening chrome://extensions/shortcuts', async () => {
    answers.state = state({ shortcut: '⌥⇧S' });
    await open();
    buttonNamed('Settings').click();
    expect(settingsLines()).toContain('Shortcut: ⌥⇧SChange');
    // A screen reader hears what it changes.
    expect(buttonNamed('Change').getAttribute('aria-label')).toBe('Change the screenshot shortcut');
    buttonNamed('Change').click();
    await vi.waitFor(() => expect(model.opened).toEqual([SHORTCUTS_URL]));
    expect(SHORTCUTS_URL).toBe('chrome://extensions/shortcuts');
    noBadMarks();
  });

  it('"Shortcut: not set" when another extension took the key, with Set', async () => {
    answers.state = state({ shortcut: '' });
    await open();
    buttonNamed('Settings').click();
    expect(settingsLines()).toContain('Shortcut: not setSet');
    expect(buttonNamed('Set').getAttribute('aria-label')).toBe('Set the screenshot shortcut');
    buttonNamed('Set').click();
    await vi.waitFor(() => expect(model.opened).toEqual([SHORTCUTS_URL]));
  });
});

describe('v0.5.3: Settings › Last screenshot', () => {
  const lines = async (lastShot: LastShot | null) => {
    answers.state = state({ lastShot });
    await open();
    buttonNamed('Settings').click();
    noBadMarks();
    return [...root.querySelectorAll('.view .stack p')].map((p) => p.textContent);
  };

  it('none yet', async () => {
    expect(await lines(null)).toEqual(['Last screenshot: none yet']);
  });

  it('saved: the time, the control, Saved', async () => {
    expect(await lines(shotRecord())).toEqual(['Last screenshot: 12:41 · camera button · Saved']);
  });

  it("refused by Chrome: why, then Chrome's own words on a quiet line", async () => {
    expect(await lines({ ...granted, from: 'command' })).toEqual([`Last screenshot: 12:41 · shortcut · Not saved: ${ALLOW_HERE_WHY}`, `Chrome said: ${CAPTURE_PERMISSION_ERROR}`]);
    expect(await lines(shotRecord({ from: 'popup', ok: false, text: 'Not saved: Chrome could not take it.', step: 'chrome', chrome: 'Chrome did not answer' }))).toEqual([
      'Last screenshot: 12:41 · popup · Not saved: Chrome could not take it.',
      'Chrome said: Chrome did not answer',
    ]);
  });

  it("refused by Jantar: its sentence, then the status", async () => {
    expect(await lines(shotRecord({ ok: false, text: 'Not saved: This meeting has 500 screenshots.', step: 'daemon', status: 409 }))).toEqual([
      'Last screenshot: 12:41 · camera button · Not saved: This meeting has 500 screenshots.',
      'Jantar answered 409',
    ]);
    expect(await lines(shotRecord({ ok: false, text: MISMATCH, step: 'daemon', status: 400 }))).toEqual([`Last screenshot: 12:41 · camera button · Not saved: ${MISMATCH}`, 'Jantar answered 400']);
  });
});

describe('v0.5.3: the main view after a failed try in this tab', () => {
  const recent = (over: Partial<LastShot> = {}) => ({ ...granted, at: Date.now() - 2 * 60_000, ...over });
  const MISSED = `Last screenshot not saved: ${ALLOW_HERE_WHY}`;

  it('the sheet and notes on say it once, as a quiet line, with Screenshot still there', async () => {
    answers.state = state({ pageButton: false, lastShot: recent(), tab: meetTab() });
    await open();
    expect([...root.querySelectorAll('.view p.quiet')].at(-1)?.textContent).toBe(MISSED);
    // Once in the view (the live line beside it reads it out too).
    expect((root.querySelector('.view')?.textContent ?? '').split(MISSED)).toHaveLength(2);
    expect(buttonNamed('Screenshot')).toBeTruthy();
    answers.state = state({ pageButton: false, lastShot: recent({ from: 'popup', text: 'Not saved: Chrome could not take it.', step: 'chrome' }), tab: meetTab({ name: 'Weekly sync', notes: true }) });
    await open();
    expect(text()).toContain('Last screenshot not saved: Chrome could not take it.');
    noBadMarks();
  });

  it('not for a saved try, another tab, one over 10 minutes old, the waiting room or a page that is not a call', async () => {
    for (const s of [
      state({ lastShot: recent({ ok: true, text: 'Saved', step: 'saved' }), tab: meetTab() }),
      state({ lastShot: recent({ tabId: 8 }), tab: meetTab() }),
      state({ lastShot: recent({ at: Date.now() - RECENT_SHOT_MS - 1_000 }), tab: meetTab() }),
      state({ lastShot: recent(), tab: meetTab({ inCall: false }) }),
      state({ lastShot: recent(), tab: null }),
    ]) {
      answers.state = s;
      await open();
      expect(text()).not.toContain('Last screenshot');
    }
  });

  it('never claims this tab is allowed (opening the popup always grants it)', async () => {
    for (const s of [
      state({ pageButton: false, lastShot: recent(), tab: meetTab() }),
      state({ pageButton: false, lastShot: recent({ ok: true, text: 'Saved', step: 'saved' }), tab: meetTab({ notes: true }) }),
      state({ pageButton: true, lastShot: recent(), tab: meetTab() }),
    ]) {
      answers.state = s;
      await open();
      expect(text()).not.toMatch(/allowed/i);
    }
  });
});

describe('while the worker has not answered', () => {
  it('says it is connecting, with nothing to press', async () => {
    let answer: (state: PopupState) => void = () => undefined;
    chrome.runtime.onMessage.listeners.length = 0;
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if ((msg as FromPopup).t !== 'state') return undefined;
      answer = respond;
      return true;
    });
    const opened = open();
    await vi.waitFor(() => expect(text()).toContain(LOADING));
    expect(buttons()).toEqual([]);
    noBadMarks();
    answer(state({ tab: meetTab() }));
    await opened;
    expect(text()).not.toContain(LOADING);
    expect(buttonNamed('Start notes')).toBeTruthy();
  });
});

describe('for a screen reader', () => {
  it("one live line outside the redrawn view, holding the view's first line, changed only when that changes", async () => {
    answers.state = state({ tab: meetTab({ name: 'Weekly sync', notes: true }) });
    const popup = await open();
    const live = root.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0]?.closest('.view')).toBeNull();
    expect(live[0]?.textContent).toBe('Keeping notes · Weekly sync');
    const node = live[0] as Element;
    let changes = 0;
    new MutationObserver((records) => (changes += records.length)).observe(node, { childList: true, characterData: true, subtree: true });
    // Drawn again with the same first line: nothing is read again.
    await popup.refresh();
    await Promise.resolve();
    expect(changes).toBe(0);
    buttonNamed('Settings').click();
    await Promise.resolve();
    expect(node.textContent).toBe('Settings');
    buttonNamed('Back').click();
    await Promise.resolve();
    expect(node.textContent).toBe('Keeping notes · Weekly sync');
    expect(changes).toBe(2);
    expect(root.querySelector('[aria-live]')).toBe(node);
  });

  it('v0.5.3: a failed try in this tab is read out after the first line', async () => {
    const missed = shotRecord({ at: Date.now() - 60_000, ok: false, text: 'Not saved: Chrome could not take it.', step: 'chrome' });
    answers.state = state({ lastShot: missed, tab: meetTab({ name: 'Weekly sync', notes: true }) });
    await open();
    const live = () => root.querySelector('[aria-live]')?.textContent;
    expect(live()).toBe('Keeping notes · Weekly sync Last screenshot not saved: Chrome could not take it.');
    // The sheet has no lead: the line alone.
    answers.state = state({ lastShot: missed, tab: meetTab() });
    await open();
    expect(live()).toBe('Last screenshot not saved: Chrome could not take it.');
    buttonNamed('Settings').click();
    await Promise.resolve();
    expect(live()).toBe('Settings');
  });
});

describe('the target tab', () => {
  it('?tab=<id> when given', () => {
    expect(tabFromSearch('?tab=42')).toBe(42);
    for (const bad of ['', '?tab=', '?tab=x', '?tab=-1', '?tab=1.5', '?other=3']) expect(tabFromSearch(bad), bad).toBeNull();
  });

  it('else the active tab of the last focused window', async () => {
    model.addTab({ id: 3, windowId: 1, url: 'https://example.com/', active: false });
    model.addTab({ id: 5, windowId: 1, url: 'https://meet.google.com/abc-defg-hij', active: true });
    model.addTab({ id: 9, windowId: 2, url: 'https://example.com/', active: true });
    model.focusedWindow = 1;
    const popup = await open(null);
    expect(popup.tabId).toBe(5);
    expect(sent[0]).toEqual({ t: 'state', tabId: 5 });
  });
});

/** A file in src/popup (on jsdom a URL relative to a file URL comes out as http://localhost, so by path). */
const source = (name: string) => join(import.meta.dirname, '../../src/popup', name);

describe('popup.html', () => {
  it('has no inline script, no style attribute and no on* handler', () => {
    const html = readFileSync(source('popup.html'), 'utf8');
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\bsrc="popup\.js"/);
    expect(html).not.toMatch(/<script\b[^>]*>[^<\s]/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<style\b|\sstyle\s*=/i);
    expect(html).toContain('id="app"');
    // The view is redrawn on every action: no live region around it (app.ts keeps one live line beside it).
    expect(html).not.toMatch(/aria-live/);
  });

  it('popup.css: 320 px wide, 16 px fields, the six colour properties and no others', () => {
    const css = readFileSync(source('popup.css'), 'utf8');
    expect(css).toMatch(/width:\s*320px/);
    expect(css).toMatch(/font-size:\s*16px/);
    const props = new Set(css.match(/--[a-z0-9-]+(?=:)/g));
    expect([...props].sort()).toEqual(['--bg', '--ink', '--ink-2', '--jup', '--line-strong', '--surface']);
    expect(css).not.toMatch(/url\(/);
  });
});

describe('v0.8: Settings › Read saved links', () => {
  const POSTS = ['https://www.instagram.com/*', 'https://www.youtube.com/*', 'https://www.tiktok.com/*', 'https://x.com/*', 'https://www.reddit.com/*', 'https://www.linkedin.com/*'];
  const toggle = () => input('reads');
  const flip = (on: boolean) => {
    toggle().checked = on;
    toggle().dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('off by default, a switch with its plain line', async () => {
    await open();
    buttonNamed('Settings').click();
    expect(toggle().getAttribute('role')).toBe('switch');
    expect(toggle().checked).toBe(false);
    expect(root.querySelector('label[for="reads"]')?.textContent).toBe(READS.title);
    expect(text()).toContain(READS.why);
    noBadMarks();
  });

  it("on asks Chrome for exactly the six post sites from the click itself, then tells the worker", async () => {
    await open();
    buttonNamed('Settings').click();
    model.permissionAnswer = true;
    flip(true);
    // Before anything is awaited: Chrome only asks on the user's gesture.
    expect(model.requested).toEqual([POSTS]);
    answers.state = state({ reads: true });
    await vi.waitFor(() => expect(sent).toContainEqual({ t: 'reads', on: true }));
    await vi.waitFor(() => expect(toggle().checked).toBe(true));
  });

  it("Chrome's no leaves it off and says so; the worker is not told", async () => {
    await open();
    buttonNamed('Settings').click();
    model.permissionAnswer = false;
    flip(true);
    await vi.waitFor(() => expect(text()).toContain(READS.denied));
    expect(sent.some((m) => m.t === 'reads')).toBe(false);
    expect(toggle().checked).toBe(false);
  });

  it('off tells the worker, asking Chrome nothing', async () => {
    answers.state = state({ reads: true });
    await open();
    buttonNamed('Settings').click();
    expect(toggle().checked).toBe(true);
    answers.state = state({ reads: false });
    flip(false);
    await vi.waitFor(() => expect(sent).toContainEqual({ t: 'reads', on: false }));
    expect(model.requested).toEqual([]);
  });
});

describe('v0.10: Start when I join', () => {
  const before = (stage: 'prejoin' | 'lobby' | 'left' | 'none', over: Partial<Tab> = {}) => meetTab({ inCall: false, stage, hook: stage === 'lobby' ? 'meet:call_end' : 'meet:join-button', ...over });
  const armView = (over: Partial<ArmView> = {}): ArmView => ({ from: 'popup', off: false, name: 'Planning', autoTodos: false, until: Date.now() + ARM_TIMING.maxMs, ...over });
  const lead = () => root.querySelector('.view .lead')?.textContent;
  const arms = () => sent.filter((m): m is Extract<FromPopup, { t: 'arm' }> => m.t === 'arm');

  it('the join screen: the arm sheet, Start when I join, no Screenshot, the reminder and the hint', async () => {
    answers.state = state({ tab: before('prejoin') });
    await open();
    expect(lead()).toBe(ARM.leadPrejoin);
    expect(input('name').value).toBe('Weekly sync');
    expect(buttons().map((b) => b.textContent)).toEqual([ARM.button, 'Settings']);
    const quiet = [...root.querySelectorAll('.view p.quiet')].map((p) => p.textContent);
    expect(quiet).toEqual([TELL_PEOPLE, ARM.hint]);
    expect(root.querySelector('[aria-live]')?.textContent).toBe(ARM.leadPrejoin);
    noBadMarks();
  });

  it('the waiting room and after leaving have their own leads; a waiting room with a one-poll flicker too', async () => {
    answers.state = state({ tab: before('lobby') });
    await open();
    expect(lead()).toBe(ARM.leadLobby);
    answers.state = state({ tab: before('left') });
    await open();
    expect(lead()).toBe(ARM.leadLeft);
    answers.state = state({ tab: before('lobby', { inCall: true }) });
    await open();
    expect(lead()).toBe(ARM.leadLobby);
    expect(inTheCall({ inCall: true, stage: 'lobby' })).toBe(false);
    expect(inTheCall({ inCall: true, stage: 'none' })).toBe(true);
    expect(inTheCall({ inCall: false, stage: 'in' })).toBe(false);
  });

  it("sends `arm`: an untouched name as '' (the page's title in the call), a typed one as typed; the project and todos rules as Start's", async () => {
    answers.state = state({ projects: [{ id: PROJECT_A, name: 'Acme site' }], tab: before('prejoin') });
    await open();
    submit(ARM.button);
    await vi.waitFor(() => expect(arms()).toHaveLength(1));
    expect(arms()[0]).toEqual({ t: 'arm', tabId: 7, name: '', autoTodos: false });
    await open();
    type(input('name'), 'Planning');
    type(input('people'), 'Sam, Priya');
    type(select() as HTMLSelectElement, PROJECT_A);
    input('todos').click();
    submit(ARM.button);
    await vi.waitFor(() => expect(arms()).toHaveLength(2));
    expect(arms()[1]).toEqual({ t: 'arm', tabId: 7, name: 'Planning', projectId: PROJECT_A, people: 'Sam, Priya', autoTodos: true });
    // The todos switch alone, without a project, sends no todos.
    await open();
    input('todos').click();
    submit(ARM.button);
    await vi.waitFor(() => expect(arms()).toHaveLength(3));
    expect(arms()[2]).toEqual({ t: 'arm', tabId: 7, name: '', autoTodos: false });
  });

  it("a Done's error shows, and the sheet stays", async () => {
    answers.state = state({ tab: before('prejoin') });
    answers.done.arm = { ok: false, error: "Open the call's join screen first." };
    await open();
    type(input('name'), 'Kept');
    submit(ARM.button);
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe("Open the call's join screen first."));
    expect(input('name').value).toBe('Kept');
  });

  it('no join screen or call: "Join the call first.", and where Start when I join shows', async () => {
    answers.state = state({ tab: before('none') });
    await open();
    expect([...root.querySelectorAll('.view p')].map((p) => p.textContent)).toEqual([JOIN_FIRST_TEXT, ARM.where]);
    expect(buttons().map((b) => b.textContent)).toEqual(['Settings']);
    noBadMarks();
  });

  it('the armed view, per stage and per way in: what starts, People, the reminder; Change and Cancel or Not this call', async () => {
    const projects = [{ id: PROJECT_A, name: 'Acme site' }];
    answers.state = state({ projects, tab: before('lobby', { arm: armView({ projectId: PROJECT_A, people: 'Sam, Priya' }) }) });
    await open();
    expect([...root.querySelectorAll('.view p')].map((p) => p.textContent)).toEqual([ARM.armedLobby, 'Planning · Acme site', 'People: Sam, Priya', TELL_PEOPLE]);
    expect(root.querySelector('.view .lead .dot')).not.toBeNull();
    expect(buttons().map((b) => b.textContent)).toEqual([ARM.change, ARM.cancel, 'Settings']);
    expect(buttonNamed(ARM.change).getAttribute('aria-label')).toBe('Change what starts when you join');
    noBadMarks();
    answers.state = state({ projects, tab: before('prejoin', { arm: armView({ name: '' }) }) });
    await open();
    expect([...root.querySelectorAll('.view p')].map((p) => p.textContent)).toEqual([ARM.armedPrejoin, `${ARM.fromPage('Weekly sync')} · No project`, TELL_PEOPLE]);
    answers.state = state({ tab: before('left', { arm: armView({ from: 'always', name: '' }) }) });
    await open();
    expect([...root.querySelectorAll('.view p')].map((p) => p.textContent)).toEqual([ARM.armedLeft, ARM.fromPage('Weekly sync'), TELL_PEOPLE, ARM.byAlways]);
    expect(buttons().map((b) => b.textContent)).toEqual([ARM.change, ARM.notThisCall, 'Settings']);
    noBadMarks();
  });

  it('Cancel and Not this call send `disarm`; an off arm shows the sheet to arm by hand', async () => {
    answers.state = state({ tab: before('lobby', { arm: armView() }) });
    await open();
    answers.state = state({ tab: before('lobby') });
    buttonNamed(ARM.cancel).click();
    await vi.waitFor(() => expect(sent).toContainEqual({ t: 'disarm', tabId: 7 }));
    await vi.waitFor(() => expect(lead()).toBe(ARM.leadLobby));
    answers.state = state({ tab: before('lobby', { arm: armView({ from: 'always', name: '' }) }) });
    await open();
    answers.state = state({ always: true, tab: before('lobby', { arm: armView({ from: 'always', off: true, name: '' }) }) });
    buttonNamed(ARM.notThisCall).click();
    await vi.waitFor(() => expect(buttons().map((b) => b.textContent)).toEqual([ARM.button, 'Settings']));
    expect(sent.filter((m) => m.t === 'disarm')).toHaveLength(2);
  });

  it("Change opens the sheet filled from the arm, Back returns; Start when I join sends the changes", async () => {
    answers.state = state({ projects: [{ id: PROJECT_A, name: 'Acme site' }], tab: before('lobby', { arm: armView({ projectId: PROJECT_A, people: 'Sam', autoTodos: true }) }) });
    await open();
    buttonNamed(ARM.change).click();
    expect(lead()).toBe(ARM.leadLobby);
    expect(input('name').value).toBe('Planning');
    expect(input('people').value).toBe('Sam');
    expect(select()?.value).toBe(PROJECT_A);
    expect(input('todos').checked).toBe(true);
    expect(buttons().map((b) => b.textContent)).toEqual([ARM.button, 'Back', 'Settings']);
    buttonNamed('Back').click();
    expect(lead()).toBe(ARM.armedLobby);
    buttonNamed(ARM.change).click();
    type(input('people'), 'Sam, Alex');
    submit(ARM.button);
    await vi.waitFor(() => expect(arms()).toHaveLength(1));
    expect(arms()[0]).toEqual({ t: 'arm', tabId: 7, name: 'Planning', projectId: PROJECT_A, people: 'Sam, Alex', autoTodos: true });
    // An arm with no name of its own keeps it so: the page's title in the call.
    answers.state = state({ tab: before('lobby', { arm: armView({ from: 'always', name: '' }) }) });
    await open();
    buttonNamed(ARM.change).click();
    expect(input('name').value).toBe('Weekly sync');
    submit(ARM.button);
    await vi.waitFor(() => expect(arms()).toHaveLength(2));
    expect(arms()[1]).toMatchObject({ name: '' });
  });

  it('asks the worker again every 2 s while the armed view shows, and becomes the notes view when notes start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      answers.state = state({ tab: before('lobby', { arm: armView() }) });
      await open();
      const asked = () => sent.filter((m) => m.t === 'state').length;
      expect(asked()).toBe(1);
      await vi.advanceTimersByTimeAsync(ARM_TIMING.popupPollMs - 1);
      expect(asked()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(asked()).toBe(2);
      await vi.advanceTimersByTimeAsync(2 * ARM_TIMING.popupPollMs);
      expect(asked()).toBe(4);
      // Let in: notes started by themselves.
      answers.state = state({ tab: meetTab({ name: 'Planning', notes: true, auto: { at: AT_1241, ok: true } }) });
      await vi.advanceTimersByTimeAsync(ARM_TIMING.popupPollMs);
      expect(text()).toContain('Keeping notes · Planning');
      const n = asked();
      await vi.advanceTimersByTimeAsync(5 * ARM_TIMING.popupPollMs);
      expect(asked()).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });

  it('"Join the call first." follows the page too: opened in its first second, it becomes the arm sheet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      answers.state = state({ tab: before('none') });
      await open();
      expect(lead()).toBe(JOIN_FIRST_TEXT);
      answers.state = state({ tab: before('prejoin') });
      await vi.advanceTimersByTimeAsync(ARM_TIMING.popupPollMs);
      expect(lead()).toBe(ARM.leadPrejoin);
      // The sheet is a form: no more asking.
      const n = sent.filter((m) => m.t === 'state').length;
      await vi.advanceTimersByTimeAsync(5 * ARM_TIMING.popupPollMs);
      expect(sent.filter((m) => m.t === 'state')).toHaveLength(n);
      // Not a meeting tab, or Settings open: nothing to follow.
      answers.state = state({ tab: null });
      await open();
      const m = sent.filter((x) => x.t === 'state').length;
      await vi.advanceTimersByTimeAsync(5 * ARM_TIMING.popupPollMs);
      expect(sent.filter((x) => x.t === 'state')).toHaveLength(m);
      answers.state = state({ tab: before('none') });
      await open();
      buttonNamed('Settings').click();
      const k = sent.filter((x) => x.t === 'state').length;
      await vi.advanceTimersByTimeAsync(5 * ARM_TIMING.popupPollMs);
      expect(sent.filter((x) => x.t === 'state')).toHaveLength(k);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never asks again while a form is on screen (a redraw would lose the typing)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      answers.state = state({ tab: before('lobby', { arm: armView() }) });
      await open();
      buttonNamed(ARM.change).click();
      const n = sent.filter((m) => m.t === 'state').length;
      await vi.advanceTimersByTimeAsync(5 * ARM_TIMING.popupPollMs);
      expect(sent.filter((m) => m.t === 'state')).toHaveLength(n);
      answers.state = state({ tab: before('prejoin') });
      await open();
      await vi.advanceTimersByTimeAsync(5 * ARM_TIMING.popupPollMs);
      expect(sent.filter((m) => m.t === 'state')).toHaveLength(n + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('notes started by themselves: the notes view says when; a failed start: the sheet says why, above Start notes', async () => {
    answers.state = state({ tab: meetTab({ name: 'Planning', notes: true, auto: { at: AT_1241, ok: true } }) });
    await open();
    expect(text()).toContain('Started when you joined, 12:41');
    expect(ARM.startedAt(clockOf(AT_1241))).toBe('Started when you joined, 12:41');
    noBadMarks();
    const why = 'Meetings are off. Turn them on at your Mac: jantar meetings on';
    answers.state = state({ tab: meetTab({ auto: { at: Date.now(), ok: false, text: why } }) });
    await open();
    const alert = root.querySelector('form [role="alert"]');
    expect(alert?.textContent).toBe(`Notes did not start when you joined: ${why}`);
    expect(alert?.nextElementSibling?.querySelector('button')?.textContent).toBe('Start notes');
    noBadMarks();
  });

  it('Settings: Always start when I join a call, off by default, with its copy; the switch sends `always`', async () => {
    answers.state = state({ tab: before('lobby') });
    await open();
    buttonNamed('Settings').click();
    const box = input('always');
    expect(box.getAttribute('role')).toBe('switch');
    expect(box.checked).toBe(false);
    expect(root.querySelector('label[for="always"]')?.textContent).toBe(ALWAYS.title);
    expect(text()).toContain(ALWAYS.why);
    noBadMarks();
    answers.state = state({ always: true, tab: before('lobby') });
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(sent).toContainEqual({ t: 'always', on: true }));
    await vi.waitFor(() => expect(input('always').checked).toBe(true));
    // No Chrome prompt for it.
    expect(model.requested).toEqual([]);
  });

  it('an off arm (Not this call, End): the sheet says this call is skipped, above the form', async () => {
    answers.state = state({ always: true, tab: before('lobby', { arm: armView({ from: 'always', off: true, name: '' }) }) });
    await open();
    const ps = [...root.querySelectorAll('.view p')].map((p) => p.textContent);
    expect(ps.slice(0, 2)).toEqual([ARM.leadLobby, ARM.skipped]);
    expect(root.querySelector('.view form')?.previousElementSibling?.textContent).toBe(ARM.skipped);
    expect(buttons().map((b) => b.textContent)).toEqual([ARM.button, 'Settings']);
    // Without an off arm, no such line.
    answers.state = state({ tab: before('lobby') });
    await open();
    expect(text()).not.toContain(ARM.skipped);
    expect(ARM.hint.startsWith(`Press ${ARM.button}`)).toBe(true);
    noBadMarks();
  });

  it('Meetings off or Jantar not answering on an armed tab: the reason, that the arm is on but cannot start, and Cancel or Not this call', async () => {
    const off = 'Meetings are off. Turn them on at your Mac: jantar meetings on';
    answers.state = state({ connection: 'off', sentence: off, tab: before('prejoin', { arm: armView() }) });
    await open();
    expect([...root.querySelectorAll('.view p')].map((p) => p.textContent)).toEqual([off, ARM.blocked]);
    expect(buttons().map((b) => b.textContent)).toEqual([ARM.cancel, 'Settings']);
    answers.state = state({ connection: 'off', sentence: off, tab: before('prejoin') });
    buttonNamed(ARM.cancel).click();
    await vi.waitFor(() => expect(sent).toContainEqual({ t: 'disarm', tabId: 7 }));
    await vi.waitFor(() => expect(text()).not.toContain(ARM.blocked));
    answers.state = state({ connection: 'down', tab: before('lobby', { arm: armView({ from: 'always', name: '' }) }) });
    await open();
    expect([...root.querySelectorAll('.view p')].map((p) => p.textContent)).toEqual([NOT_RUNNING, ARM.blocked]);
    expect(buttons().map((b) => b.textContent)).toEqual([ARM.notThisCall, 'Settings']);
    // An off arm, or none: only the reason.
    answers.state = state({ connection: 'off', sentence: off, tab: before('lobby', { arm: armView({ from: 'always', off: true }) }) });
    await open();
    expect([...root.querySelectorAll('.view p')].map((p) => p.textContent)).toEqual([off]);
    noBadMarks();
  });

  it('not paired with Always on: the pairing view says notes cannot start, and Always can be turned off there', async () => {
    answers.state = state({ connection: 'unpaired', sentence: PAIR_AGAIN, pageButton: false, always: true, tab: before('prejoin') });
    await open();
    expect(text()).toContain(PAIR_AGAIN);
    expect(text()).toContain(ALWAYS.unpaired);
    const off = buttonNamed(ALWAYS.turnOff);
    expect(off.getAttribute('aria-label')).toBe(ALWAYS.turnOffName);
    answers.state = state({ connection: 'unpaired', sentence: PAIR_AGAIN, pageButton: false, always: false, tab: before('prejoin') });
    off.click();
    await vi.waitFor(() => expect(sent).toContainEqual({ t: 'always', on: false }));
    await vi.waitFor(() => expect(text()).not.toContain(ALWAYS.unpaired));
    expect(buttons().map((b) => b.textContent)).toEqual(['Pair']);
    noBadMarks();
  });

  it("the armed view names the page's title when the arm has no name, the todos when on, and what Cancel cancels", async () => {
    const projects = [{ id: PROJECT_A, name: 'Acme site' }];
    answers.state = state({ projects, tab: before('prejoin', { arm: armView({ name: '', projectId: PROJECT_A, autoTodos: true }) }) });
    await open();
    expect([...root.querySelectorAll('.view p')][1]?.textContent).toBe(`${ARM.fromPage('Weekly sync')} · Acme site · ${ARM.todos}`);
    expect(buttonNamed(ARM.cancel).getAttribute('aria-label')).toBe(ARM.cancelName);
    answers.state = state({ tab: before('prejoin', { title: '', arm: armView({ name: '' }) }) });
    await open();
    expect([...root.querySelectorAll('.view p')][1]?.textContent).toBe(ARM.nameFromPage);
  });

  it('Settings: the meeting settings come first, together (Always, then Call check)', async () => {
    answers.state = state({ tab: before('lobby', { site: 'teams', hook: 'teams:after-join' }) });
    await open();
    buttonNamed('Settings').click();
    const blocks = [...root.querySelectorAll('.view > *')].map((n) => n.className || n.tagName);
    const always = blocks.indexOf('setting');
    expect(blocks[always + 1]).toBe('mono check');
    expect(root.querySelector('.view h2')?.nextElementSibling?.querySelector('#always')).not.toBeNull();
  });

  it('a redraw after an action keeps the keyboard in the view: on the same control, else the first one', async () => {
    answers.state = state({ tab: before('lobby') });
    const popup = await open();
    buttonNamed(ARM.button).focus();
    answers.state = state({ tab: before('lobby', { arm: armView() }) });
    submit(ARM.button);
    await vi.waitFor(() => expect(root.querySelector('.view .lead')?.textContent).toBe(ARM.armedLobby));
    expect(document.activeElement?.textContent).toBe(ARM.change);
    buttonNamed(ARM.cancel).focus();
    await popup.refresh();
    expect(document.activeElement?.textContent).toBe(ARM.cancel);
  });

  it('Settings › Call check: the stage in words and our hook id, for a meeting tab only', async () => {
    answers.state = state({ tab: before('lobby', { site: 'teams', hook: 'teams:after-join' }) });
    await open();
    buttonNamed('Settings').click();
    expect(root.querySelector('.view p.check')?.textContent).toBe('Call check: waiting to be let in · teams:after-join');
    expect(CALL_CHECK.line(CALL_CHECK.none, '')).toBe('Call check: no join screen or call');
    answers.state = state({ tab: null });
    await open();
    buttonNamed('Settings').click();
    expect(root.querySelector('.view p.check')).toBeNull();
    expect(text()).not.toContain('Call check');
  });
});

const JOIN_FIRST_TEXT = 'Join the call first.';
