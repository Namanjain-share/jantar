/**
 * The popup and the real worker together (the stand-in daemon behind the
 * worker's fetch): pair, allow the page button, Start with a project, see
 * notes on and the captions state, End, and a Screenshot from the sheet
 * that saves into a meeting made for the call. And a meeting tab that went
 * to another site: the popup offers nothing there. v0.5.3: a page-button
 * try Chrome refused shows in the main view and in Settings, with Chrome's
 * words and the shortcut. v0.9.1: Start when I join, from the join screen to
 * notes on, with the badge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARM, AUTO, NO_MEETING_TAB, SHOT } from '../../src/background/sentences.js';
import { MEET_CODE, MEET_URL } from '../background/chrome.js';
import { CAPTURE_PERMISSION_ERROR } from '../helpers/chrome-fake.js';
import { mountPopup } from '../../src/popup/app.js';
import { KEY, PROJECT_ID, setupWorker, type WorkerUnderTest } from '../background/chrome.js';

let w: WorkerUnderTest;
afterEach(() => w?.close());

describe('the popup with the worker', () => {
  it('pairs, offers the page button, starts notes with a project, ends, and takes a screenshot', async () => {
    w = setupWorker({ paired: false });
    await w.meetTab(7, { title: 'Weekly sync' });
    const root = document.createElement('main');
    document.body.replaceChildren(root);
    let closed = 0;
    const popup = await mountPopup({ root, tabId: 7, close: () => (closed += 1) });
    const text = () => root.textContent ?? '';
    const click = (name: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === name)?.click();
    const field = (id: string) => root.querySelector<HTMLInputElement & HTMLSelectElement>(`#${id}`) as HTMLInputElement & HTMLSelectElement;

    expect(text()).toContain('Pair with Jantar on this Mac.');
    field('code').value = 'jantar-ext:47123:C0DEc0de_C0DE-c0deC0';
    w.daemon.on('info', { status: 200, body: { projects: [{ id: PROJECT_ID, name: 'Acme site' }] } });
    click('Pair');
    await vi.waitFor(() => expect(text()).toContain('Let the screenshot button work on meeting pages'));
    expect(await w.keys.get()).toMatchObject({ port: 47123, key: KEY });
    expect(w.toPage(7)).toEqual([{ t: 'button', on: true }]);

    w.model.permissionAnswer = true;
    click('Allow');
    expect(w.model.requested).toEqual([['<all_urls>']]);
    await vi.waitFor(() => expect(field('name')?.value).toBe('Weekly sync'));

    field('project').value = PROJECT_ID;
    field('project').dispatchEvent(new Event('change'));
    field('todos').click();
    click('Start notes');
    await vi.waitFor(() => expect(text()).toContain('Keeping notes · Weekly sync'));
    expect(w.daemon.of('open')[0]?.body).toMatchObject({ name: 'Weekly sync', projectId: PROJECT_ID, autoTodos: true, captions: true });
    expect(w.toPage(7).at(-1)).toEqual({ t: 'capture', on: true, cc: true });

    await w.page(7, { t: 'captions', state: 'reading' });
    await popup.refresh();
    expect(text()).toContain('Reading captions');

    click('End');
    await vi.waitFor(() => expect(text()).toContain('Start notes'));
    expect(w.daemon.of('end')[0]?.body).toMatchObject({ reason: 'user' });

    click('Screenshot');
    expect(closed).toBe(1);
    await vi.waitFor(() => expect(w.daemon.of('shot')).toHaveLength(1));
    expect(w.daemon.of('open')[1]?.body).toMatchObject({ captions: false });
    await vi.waitFor(() => expect(w.toPage(7).at(-1)).toEqual({ t: 'show', flash: 'Saved' }));
  });

  it('a meeting tab that went to another site: "Open a Google Meet or Teams call in this tab (reload it if the call is already open)." and nothing to press but Settings', async () => {
    w = setupWorker();
    await w.meetTab(7, { title: 'Weekly sync' });
    expect(await w.page(7, { t: 'shot' })).toEqual({ ok: true, text: 'Saved' });
    // Left the call and typed another address in the same tab within the 60-s grace: no receiver there now.
    w.model.addTab({ id: 7, windowId: 1, url: 'https://mail.example.com/inbox', active: true });
    w.model.onTabMessage(7, null);
    const root = document.createElement('main');
    document.body.replaceChildren(root);
    await mountPopup({ root, tabId: 7, close: () => undefined });
    expect(root.textContent).toContain(NO_MEETING_TAB);
    expect([...root.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Settings']);
    expect(w.daemon.of('shot')).toHaveLength(1);
  });

  it('v0.5.3: a page-button try Chrome refused: the main view says so, Settings says how and when, with the shortcut', async () => {
    w = setupWorker();
    await w.meetTab(7, { title: 'Weekly sync' });
    w.model.shortcut = '⌥⇧S';
    // The popup reads "the last 10 minutes" on the real clock.
    w.clock.t = Date.now();
    w.model.failCapture('permission');
    expect(await w.page(7, { t: 'shot' })).toEqual({ ok: false, text: SHOT.allowHere });
    const root = document.createElement('main');
    document.body.replaceChildren(root);
    await mountPopup({ root, tabId: 7, close: () => undefined });
    expect(root.textContent).toContain('Last screenshot not saved: click the Jantar icon once in this tab, then try again.');
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Settings')?.click();
    const lines = [...root.querySelectorAll('.view .row, .view .stack p')].map((n) => n.textContent);
    expect(lines).toContain('Shortcut: ⌥⇧SChange');
    expect(lines.some((l) => /^Last screenshot: \d\d:\d\d · camera button · Not saved: click the Jantar icon once in this tab, then try again\.$/.test(l ?? ''))).toBe(true);
    expect(lines).toContain(`Chrome said: ${CAPTURE_PERMISSION_ERROR}`);
    // The popup's own Screenshot now (it holds the grant): saved, and Settings follows.
    expect(await w.popup({ t: 'shot', tabId: 7 })).toEqual({ ok: true, text: SHOT.saved });
    await mountPopup({ root, tabId: 7, close: () => undefined });
    expect(root.textContent).not.toContain('Last screenshot not saved');
  });

  it('v0.9.1: Start when I join with a project, from the join screen; let in, notes start by themselves and the popup follows', async () => {
    w = setupWorker();
    w.model.addTab({ id: 7, windowId: 1, url: MEET_URL, active: true });
    w.model.onTabMessage(7, () => ({ ok: true }));
    const page = (stage: string, inCall = false) =>
      w.page(7, { t: 'call', site: 'meet', inCall, callKey: MEET_CODE, title: 'Weekly sync', stage, hook: stage === 'lobby' ? 'meet:call_end' : stage === 'in' ? 'meet:captions-button' : 'meet:join-button' });
    await page('none');
    await page('prejoin');
    w.daemon.on('info', { status: 200, body: { projects: [{ id: PROJECT_ID, name: 'Acme site' }] } });
    const root = document.createElement('main');
    document.body.replaceChildren(root);
    const popup = await mountPopup({ root, tabId: 7, close: () => undefined });
    const text = () => root.textContent ?? '';
    const click = (name: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === name)?.click();
    const field = (id: string) => root.querySelector<HTMLInputElement & HTMLSelectElement>(`#${id}`) as HTMLInputElement & HTMLSelectElement;
    expect(text()).toContain(ARM.leadPrejoin);

    field('project').value = PROJECT_ID;
    field('project').dispatchEvent(new Event('change'));
    field('todos').click();
    click(ARM.button);
    await vi.waitFor(() => expect(text()).toContain(ARM.armedPrejoin));
    // The name untouched: the page's title once in the call.
    expect(text()).toContain(`${ARM.fromPage('Weekly sync')} · Acme site · ${ARM.todos}`);
    expect(w.model.badge(7).text).toBe('ARM');
    expect(w.daemon.ops().filter((op) => op !== 'info')).toEqual([]);

    // Ask to join, then let in: the in-call hooks on two polls.
    await page('lobby');
    await popup.refresh();
    expect(text()).toContain(ARM.armedLobby);
    await page('lobby', true);
    expect(w.daemon.of('open')).toEqual([]);
    await page('in', true);
    expect(w.daemon.of('open')).toHaveLength(1);
    expect(w.daemon.of('open')[0]?.body).toMatchObject({ name: 'Weekly sync', projectId: PROJECT_ID, autoTodos: true, captions: true });
    expect(w.toPage(7).at(-1)).toEqual({ t: 'capture', on: true, text: AUTO.started, cc: true });
    expect(w.model.badge(7).text).toBe('ON');
    await popup.refresh();
    expect(text()).toContain('Keeping notes · Weekly sync');
    expect(text()).toMatch(/Started when you joined, \d\d:\d\d/);
  });
});
