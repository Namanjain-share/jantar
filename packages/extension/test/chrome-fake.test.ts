/**
 * WP0's chrome fake behaves as the code under test will find Chrome:
 * messages answered through sendResponse (later when a listener returns
 * true), tabs and the active one per window, page messages and the missing
 * receiver, captures with their failures, storage.session, permissions,
 * commands, and an invalidated context.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_PERMISSION_ERROR, CAPTURE_QUOTA_ERROR, INVALIDATED_ERROR, NO_RECEIVER_ERROR, createChromeFake, type ChromeModel } from './helpers/chrome-fake.js';
import { EXTENSION_ID } from '../src/shared/wire.js';

let model: ChromeModel | undefined;
afterEach(() => model?.uninstall());

describe('the chrome fake', () => {
  it('is installed on globalThis with the extension ID and URLs', () => {
    const f = createChromeFake();
    model = f.model;
    expect((globalThis as { chrome?: unknown }).chrome).toBe(f.chrome);
    expect(f.chrome.runtime.id).toBe(EXTENSION_ID);
    expect(f.chrome.runtime.getURL('/popup.html')).toBe(`chrome-extension://${EXTENSION_ID}/popup.html`);
  });

  it('answers a message through sendResponse, at once or later', async () => {
    const f = createChromeFake();
    model = f.model;
    f.chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if ((msg as { t: string }).t === 'now') respond('now');
      else if ((msg as { t: string }).t === 'later') {
        setTimeout(() => respond('later'), 1);
        return true;
      }
      return undefined;
    });
    expect(await f.chrome.runtime.sendMessage({ t: 'now' })).toBe('now');
    expect(await f.chrome.runtime.onMessage.dispatch({ t: 'later' }, f.model.extensionSender())).toBe('later');
    expect(await f.chrome.runtime.sendMessage({ t: 'other' })).toBeUndefined();
  });

  it('keeps tabs and the active one per window; a page with no listener rejects', async () => {
    const f = createChromeFake();
    model = f.model;
    f.model.addTab({ id: 1, windowId: 1, url: 'https://meet.google.com/abc-defg-hij', active: true });
    f.model.addTab({ id: 2, windowId: 1, url: 'https://example.com/', active: true });
    expect((await f.chrome.tabs.get(1)).active).toBe(false);
    f.model.activate(1);
    expect((await f.chrome.tabs.query({ active: true, lastFocusedWindow: true })).map((t) => t.id)).toEqual([1]);
    await expect(f.chrome.tabs.sendMessage(2, { t: 'hide' })).rejects.toThrow(NO_RECEIVER_ERROR);
    f.model.onTabMessage(1, () => ({ ok: true }));
    expect(await f.chrome.tabs.sendMessage(1, { t: 'hide' })).toEqual({ ok: true });
    expect(f.model.sentTo(1)).toEqual([{ t: 'hide' }]);
    expect(f.model.pageSender(1)).toMatchObject({ id: EXTENSION_ID, url: 'https://meet.google.com/abc-defg-hij', tab: { id: 1 } });
    await expect(f.chrome.tabs.get(9)).rejects.toThrow(/No tab/);
  });

  it('captures a JPEG data URL, or fails as asked', async () => {
    const f = createChromeFake();
    model = f.model;
    const url = await f.chrome.tabs.captureVisibleTab(1, { format: 'jpeg', quality: 85 });
    expect(url.startsWith('data:image/jpeg;base64,/9j/')).toBe(true);
    f.model.failCapture('permission');
    await expect(f.chrome.tabs.captureVisibleTab(1)).rejects.toThrow(CAPTURE_PERMISSION_ERROR);
    f.model.failCapture('quota', 2);
    await expect(f.chrome.tabs.captureVisibleTab(1)).rejects.toThrow(CAPTURE_QUOTA_ERROR);
    await expect(f.chrome.tabs.captureVisibleTab(1)).rejects.toThrow(CAPTURE_QUOTA_ERROR);
    await expect(f.chrome.tabs.captureVisibleTab(1)).resolves.toMatch(/^data:image\/jpeg/);
    expect(f.model.captures).toHaveLength(5);
  });

  it('keeps storage.session, answers permissions and dispatches commands and tab closes', async () => {
    const f = createChromeFake();
    model = f.model;
    await f.chrome.storage.session.set({ 'tab:1': { notes: true } });
    expect(await f.chrome.storage.session.get('tab:1')).toEqual({ 'tab:1': { notes: true } });
    await f.chrome.storage.session.remove('tab:1');
    expect(await f.chrome.storage.session.get(null)).toEqual({});
    expect(await f.chrome.permissions.contains({ origins: ['<all_urls>'] })).toBe(false);
    f.model.permissionAnswer = true;
    expect(await f.chrome.permissions.request({ origins: ['<all_urls>'] })).toBe(true);
    expect(await f.chrome.permissions.contains({ origins: ['<all_urls>'] })).toBe(true);
    const seen: string[] = [];
    f.chrome.commands.onCommand.addListener((c) => void seen.push(c));
    f.chrome.tabs.onRemoved.addListener((id) => void seen.push(`closed ${id}`));
    f.chrome.commands.onCommand.dispatch('take-screenshot');
    f.chrome.tabs.onRemoved.dispatch(3);
    expect(seen).toEqual(['take-screenshot', 'closed 3']);
  });

  it("lists the commands with the screenshot's shortcut, and opens a tab", async () => {
    const f = createChromeFake();
    model = f.model;
    const shortcut = async () => (await f.chrome.commands.getAll()).find((c) => c.name === 'take-screenshot')?.shortcut;
    expect(await shortcut()).toBe('');
    f.model.shortcut = '⌥⇧S';
    expect(await shortcut()).toBe('⌥⇧S');
    f.model.addTab({ id: 4, windowId: 1, url: 'https://example.com/', active: true });
    const made = await f.chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    expect(made).toMatchObject({ id: 5, windowId: 1, url: 'chrome://extensions/shortcuts', active: true });
    expect(f.model.opened).toEqual(['chrome://extensions/shortcuts']);
    expect(f.model.tab(4)?.active).toBe(false);
  });

  it('after invalidate, the id is gone and every call throws', async () => {
    const f = createChromeFake();
    model = f.model;
    f.model.invalidate();
    expect(f.chrome.runtime.id).toBeUndefined();
    expect(() => f.chrome.runtime.getURL('x')).toThrow(INVALIDATED_ERROR);
    await expect(f.chrome.runtime.sendMessage({ t: 'call' })).rejects.toThrow(INVALIDATED_ERROR);
    expect(() => f.chrome.runtime.onMessage.addListener(() => undefined)).toThrow(INVALIDATED_ERROR);
  });
});

describe('the chrome fake, v0.8 (Read saved links)', () => {
  it('reads the source manifest, keeps alarms and storage.local, and has the startup events', async () => {
    const f = createChromeFake();
    model = f.model;
    expect(f.chrome.runtime.getManifest()).toMatchObject({ manifest_version: 3, permissions: ['activeTab', 'storage', 'alarms', 'scripting'] });
    await f.chrome.alarms.create('a', { periodInMinutes: 0.5 });
    expect(await f.chrome.alarms.get('a')).toEqual({ name: 'a', periodInMinutes: 0.5 });
    expect(await f.chrome.alarms.clear('a')).toBe(true);
    expect(await f.chrome.alarms.get('a')).toBeUndefined();
    await f.chrome.storage.local.set({ k: true });
    expect(await f.chrome.storage.local.get('k')).toEqual({ k: true });
    expect(f.model.local.get('k')).toBe(true);
    const seen: string[] = [];
    f.chrome.runtime.onStartup.addListener(() => seen.push('startup'));
    f.chrome.alarms.onAlarm.addListener((a) => seen.push(a.name));
    f.chrome.runtime.onStartup.dispatch();
    f.chrome.alarms.onAlarm.dispatch({ name: 'jantar-reads', scheduledTime: 0 });
    expect(seen).toEqual(['startup', 'jantar-reads']);
  });

  it('navigates a tab with its scripted updates, removes it, and answers executeScript', async () => {
    const f = createChromeFake();
    model = f.model;
    const tab = await f.chrome.tabs.create({ url: 'about:blank', active: false });
    expect(tab).toMatchObject({ url: 'about:blank', active: false });
    const updates: unknown[] = [];
    f.chrome.tabs.onUpdated.addListener((id, info, t) => updates.push([id, info, t.url]));
    await f.chrome.tabs.update(tab.id, { url: 'https://example.com/a', muted: true });
    // The fake sends 'complete' on a later tick; a fixed 5 ms was too short on a busy CI runner.
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates).toEqual([
      [tab.id, { status: 'loading', url: 'https://example.com/a' }, 'https://example.com/a'],
      [tab.id, { status: 'complete' }, 'https://example.com/a'],
    ]);
    expect(f.model.tab(tab.id)).toMatchObject({ url: 'https://example.com/a', muted: true });
    f.model.onScript = () => [{ frameId: 0, result: 42 }];
    expect(await f.chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => 42 })).toEqual([{ frameId: 0, result: 42 }]);
    await f.chrome.tabs.remove(tab.id);
    expect(f.model.removed).toEqual([tab.id]);
    await expect(f.chrome.tabs.remove(tab.id)).rejects.toThrow('No tab with id');
    await expect(f.chrome.scripting.executeScript({ target: { tabId: tab.id } })).rejects.toThrow('No tab with id');
  });

  it('<all_urls> granted covers every web origin', async () => {
    const f = createChromeFake();
    model = f.model;
    expect(await f.chrome.permissions.contains({ origins: ['https://x.com/*'] })).toBe(false);
    f.model.granted.add('<all_urls>');
    expect(await f.chrome.permissions.contains({ origins: ['https://x.com/*'] })).toBe(true);
  });
});
