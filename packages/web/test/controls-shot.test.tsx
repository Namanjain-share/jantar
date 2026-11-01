/**
 * The Screen tab's Picture | Text switch (C8) against the fake API: taking
 * the first picture, the picture, a refusal that falls back to the text
 * peek (with the optional switch-tabs capture), an error, offline, the
 * remembered choice, and object URLs revoked when replaced or unmounted (W5).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Features } from '@jantar/protocol';
import { ApiError, type Screenshot } from '../src/lib/api.js';
import { writeLocal } from '../src/lib/storage.js';
import { LOCAL_DEVICE_KEY } from '../src/ui/screens/devices/local.js';
import { fakeApi, iso, renderApp, session, stateWith } from './helpers.js';

function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: m ? width >= Number(m[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
}

let urls = 0;
const created = vi.fn((_b: Blob) => `blob:http://127.0.0.1:7420/shot-${++urls}`);
const revoked = vi.fn((_u: string) => undefined);

beforeEach(() => {
  viewport(1440);
  urls = 0;
  created.mockClear();
  revoked.mockClear();
  // jsdom has no object URLs.
  Object.defineProperty(URL, 'createObjectURL', { value: created, configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revoked, configurable: true, writable: true });
});
afterEach(() => vi.unstubAllGlobals());

const shot = (over: Partial<Screenshot> = {}): Screenshot => ({
  blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
  at: iso(290_000),
  width: 1600,
  height: 1000,
  disturbed: false,
  etag: '"abc"',
  ...over,
});

const state = (features: Partial<Features> = { screenshots: true }) => stateWith({ sessions: [session('a')], features });

function clickScreen() {
  fireEvent.click(screen.getByRole('tab', { name: 'Screen' }));
}

/** v0.6: the picture is its own chunk; the panel to look in is the one it renders once loaded. */
async function openScreen() {
  clickScreen();
  await screen.findByRole('group', { name: 'Show the screen as' });
  return screen.getByRole('tabpanel', { name: 'Screen' });
}

const picture = () => screen.getByRole('button', { name: 'Picture' });
const textFace = () => screen.getByRole('button', { name: 'Text' });

describe('the Screen tab with screenshots on (C8)', () => {
  it('shows the picture through an object URL, with the capture time, Refresh and Show on Mac', async () => {
    const api = fakeApi({ screenshot: vi.fn(async () => shot()) });
    renderApp({ path: '/s/a', api, state: state() });
    const panel = await openScreen();
    // The app's segmented control (32 px, 44 under a coarse pointer), not a look-alike of its own.
    expect(within(panel).getByRole('group', { name: 'Show the screen as' }).className).toMatch(/\bh-32\b.*\bcoarse:h-44\b/);
    expect(picture().getAttribute('aria-pressed')).toBe('true');
    const img = (await within(panel).findByRole('img', { name: "Screenshot of the session's terminal window" })) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:http://127.0.0.1:7420/shot-1');
    expect(api.screenshot).toHaveBeenCalledWith('a', {}, { signal: expect.any(AbortSignal) });
    expect(within(panel).getByText(/^captured /)).toBeTruthy();
    // The footer grows when its line wraps (a 44 px Refresh on touch), never spilling onto the bar below.
    expect(within(panel).getByText(/^captured /).parentElement?.className).toMatch(/\bmin-h-32\b/);
    expect(within(panel).getByRole('button', { name: 'Show on Mac' })).toBeTruthy();
    // No fetch of the text peek while the picture shows.
    expect(api.getScreen).not.toHaveBeenCalled();
  });

  it('W5: Refresh takes a new picture and revokes the old URL; leaving the tab revokes the last one', async () => {
    const api = fakeApi({ screenshot: vi.fn(async () => shot()) });
    const { unmount } = renderApp({ path: '/s/a', api, state: state() });
    const panel = await openScreen();
    await within(panel).findByRole('img');
    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(panel).getByRole('img').getAttribute('src')).toBe('blob:http://127.0.0.1:7420/shot-2'));
    expect(revoked).toHaveBeenCalledWith('blob:http://127.0.0.1:7420/shot-1');
    expect(revoked).not.toHaveBeenCalledWith('blob:http://127.0.0.1:7420/shot-2');
    unmount();
    expect(revoked).toHaveBeenCalledWith('blob:http://127.0.0.1:7420/shot-2');
    expect(created).toHaveBeenCalledTimes(2);
  });

  it('says it is taking the first picture while the request is out', async () => {
    const api = fakeApi({ screenshot: vi.fn(() => new Promise<Screenshot>(() => undefined)) });
    renderApp({ path: '/s/a', api, state: state() });
    const panel = await openScreen();
    expect(await within(panel).findByRole('status', { name: 'Taking a screenshot' })).toBeTruthy();
    expect(within(panel).queryByRole('img')).toBeNull();
    expect((within(panel).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('falls back to the text peek when another tab is showing (409), and can switch tabs for a moment where allowed', async () => {
    const api = fakeApi({
      screenshot: vi
        .fn()
        .mockRejectedValueOnce(new ApiError('tab_not_visible', 'another tab is showing in that window', 409))
        .mockResolvedValueOnce(shot({ disturbed: true })),
      getScreen: vi.fn(async () => ({ text: '> npm test\n  12 passing', lines: 2, at: iso(0), backend: 'terminal-app' })),
    });
    renderApp({ path: '/s/a', api, state: state({ screenshots: true, screenshotSelect: true }) });
    const panel = await openScreen();
    expect(await within(panel).findByText('Another tab is showing in that window, showing text instead')).toBeTruthy();
    await waitFor(() => expect(within(panel).getByLabelText('Terminal text').textContent).toBe('> npm test\n  12 passing'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Switch tabs for a moment and capture' }));
    await waitFor(() => expect(api.screenshot).toHaveBeenLastCalledWith('a', { select: true }, { signal: expect.any(AbortSignal) }));
    expect(await within(panel).findByRole('img')).toBeTruthy();
    expect(within(panel).getByText('switched tabs on the Mac for a moment')).toBeTruthy();
  });

  it('offers no tab switch to a device paired without the control scope (the daemon would answer 403)', async () => {
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-2', name: 'iPad', scopes: ['read'] });
    const api = fakeApi({ screenshot: vi.fn().mockRejectedValue(new ApiError('tab_not_visible', 'another tab is showing in that window', 409)) });
    renderApp({ path: '/s/a', api, state: state({ screenshots: true, screenshotSelect: true }) });
    const panel = await openScreen();
    await within(panel).findByText('Another tab is showing in that window, showing text instead');
    expect(within(panel).queryByRole('button', { name: /Switch tabs/ })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Try the picture again' })).toBeTruthy();
  });

  it('a failed tab switch keeps the text peek and says why under it', async () => {
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-1', name: 'iPhone', scopes: ['read', 'control'] });
    const api = fakeApi({
      screenshot: vi
        .fn()
        .mockRejectedValueOnce(new ApiError('tab_not_visible', 'another tab is showing in that window', 409))
        .mockRejectedValueOnce(new ApiError('forbidden', 'Selecting a background tab for a screenshot is off. Turn it on at your Mac: jantar screenshots allow-select', 403)),
      getScreen: vi.fn(async () => ({ text: '> npm test', lines: 1, at: iso(0), backend: 'terminal-app' })),
    });
    renderApp({ path: '/s/a', api, state: state({ screenshots: true, screenshotSelect: true }) });
    const panel = await openScreen();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Switch tabs for a moment and capture' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain("Couldn't switch tabs: Selecting a background tab for a screenshot is off");
    expect(within(panel).getByText('Another tab is showing in that window, showing text instead')).toBeTruthy();
    await waitFor(() => expect(within(panel).getByLabelText('Terminal text').textContent).toBe('> npm test'));
    expect(within(panel).queryByRole('img')).toBeNull();
    // Refused as forbidden: not offered again.
    expect(within(panel).queryByRole('button', { name: /Switch tabs/ })).toBeNull();
  });

  it('offers no tab switch while the Mac does not allow it, and says when the window is minimized', async () => {
    const api = fakeApi({
      screenshot: vi
        .fn()
        .mockRejectedValueOnce(new ApiError('tab_not_visible', 'another tab is showing in that window', 409))
        .mockRejectedValueOnce(new ApiError('tab_not_visible', 'the Terminal window is minimized or hidden', 409)),
    });
    renderApp({ path: '/s/a', api, state: state() });
    const panel = await openScreen();
    await within(panel).findByText('Another tab is showing in that window, showing text instead');
    expect(within(panel).queryByRole('button', { name: /Switch tabs/ })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Try the picture again' }));
    expect(await within(panel).findByText('That window is minimized or hidden on the Mac, showing text instead')).toBeTruthy();
  });

  it('shows an error with the reason and keeps Refresh', async () => {
    const api = fakeApi({
      screenshot: vi
        .fn()
        .mockRejectedValueOnce(new ApiError('unavailable', 'screencapture could not capture the window. Is Screen Recording allowed for /synthetic/node?', 503))
        .mockResolvedValueOnce(shot()),
    });
    renderApp({ path: '/s/a', api, state: state() });
    const panel = await openScreen();
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('The screenshot failed: screencapture could not capture the window');
    expect(alert.className).not.toMatch(/signal/);
    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh' }));
    expect(await within(panel).findByRole('img')).toBeTruthy();
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('takes no picture offline', async () => {
    const api = fakeApi({ screenshot: vi.fn(async () => shot()) });
    renderApp({ path: '/s/a', api, state: state(), status: 'offline' });
    const panel = await openScreen();
    expect(within(panel).getByText("Offline: can't take a screenshot right now")).toBeTruthy();
    expect((within(panel).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.screenshot).not.toHaveBeenCalled();
  });

  it('Text shows the text peek and is remembered on this device', async () => {
    const api = fakeApi({
      screenshot: vi.fn(async () => shot()),
      getScreen: vi.fn(async () => ({ text: 'plain text', lines: 1, at: iso(0), backend: 'terminal-app' })),
    });
    const first = renderApp({ path: '/s/a', api, state: state() });
    await openScreen();
    await screen.findByRole('img', { name: "Screenshot of the session's terminal window" });
    fireEvent.click(textFace());
    expect(textFace().getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(screen.getByLabelText('Terminal text').textContent).toBe('plain text'));
    first.unmount();
    api.screenshot.mockClear();
    renderApp({ path: '/s/a', api, state: state() });
    await openScreen();
    expect(textFace().getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(screen.getByLabelText('Terminal text')).toBeTruthy());
    expect(api.screenshot).not.toHaveBeenCalled();
    fireEvent.click(picture());
    await waitFor(() => expect(api.screenshot).toHaveBeenCalledTimes(1));
  });

  it('is not there while screenshots are off: the Screen tab is the text peek alone', async () => {
    const api = fakeApi();
    renderApp({ path: '/s/a', api, state: state({ screenshots: false }) });
    clickScreen();
    expect(screen.queryByRole('group', { name: 'Show the screen as' })).toBeNull();
    expect(api.screenshot).not.toHaveBeenCalled();
  });
});
