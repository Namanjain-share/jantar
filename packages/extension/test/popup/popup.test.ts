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
 * the captions sentences are the page's own. The run against the real
 * worker is with-worker.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEETING_MARKER } from '@jantar/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAD_CODE, MISMATCH, NOT_RUNNING, PAIR_AGAIN, TRY_AGAIN } from '../../src/background/sentences.js';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import { teamsAdapter } from '../../src/content/adapters/teams.js';
import { NOT_FOUND as PAGE_NOT_FOUND } from '../../src/content/capture.js';
import type { FromPopup, PopupState } from '../../src/shared/messages.js';
import { HOW_TO, LOADING, NOT_FOUND, mountPopup, tabFromSearch, type Popup } from '../../src/popup/app.js';
import { createChromeFake, type ChromeFake, type ChromeModel } from '../helpers/chrome-fake.js';

const PROJECT_A = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const PROJECT_B = '01JFZ8X8Y3T0V5G9WQK2M4N6QR';

type Tab = NonNullable<PopupState['tab']>;
const meetTab = (over: Partial<Tab> = {}): Tab => ({ site: 'meet', inCall: true, title: 'Weekly sync', notes: false, shots: 0, captions: 'unknown', ...over });
const state = (over: Partial<PopupState> = {}): PopupState => ({ connection: 'ok', pageButton: true, projects: null, tab: null, lastShot: null, shortcut: '', ...over });

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
