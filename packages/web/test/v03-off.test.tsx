/**
 * With every v0.3 switch off (a v0.3 daemon that says so, not one that says
 * nothing), nothing new shows, even when the state already holds v0.3 data
 * (a launch starting, a rewrite job, changed files counted): no New button,
 * no Starting rail, no Files place or tab, no Rewrite button, no control bar,
 * no "New session in…" in ⌘K, /files and /new not found, and not one v0.3
 * call goes to the daemon.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RewriteJob } from '@jantar/protocol';
import { fakeApi, iso, renderApp, session, stateWith } from './helpers.js';
import { job, viewport } from './launch-fixtures.js';

/** The client calls that reach v0.3 routes. */
const V03_CALLS = [
  'rewriteStart',
  'rewriteGet',
  'rewriteCancel',
  'filesRoots',
  'filesList',
  'filesStat',
  'filesText',
  'filesRaw',
  'filesChanges',
  'sessionChanges',
  'sessionChange',
  'foldersRoots',
  'foldersList',
  'foldersRecent',
  'foldersPin',
  'foldersCreate',
  'launchPreview',
  'launchStart',
  'launchGet',
  'launchList',
  'launchAnswer',
  'sessionKey',
  'sessionMode',
  'sessionCommand',
  'screenshot',
] as const;

function offState() {
  // features: {} is every switch off, said by the daemon.
  const s = stateWith({ sessions: [session('a', { status: 'idle', filesChanged: 3, mode: 'plan' })], features: {} });
  s.launches.L1 = job('L1', { stage: 'opening' });
  const rewrite: RewriteJob = {
    id: 'rw-1',
    sid: 'a',
    deviceId: 'dev-1',
    state: 'ready',
    model: 'opus',
    input: { hash: 'synthetic', length: 12 },
    createdAt: iso(100_000),
    updatedAt: iso(110_000),
  };
  s.rewrites['rw-1'] = rewrite;
  return s;
}

function quietApi() {
  const api = fakeApi();
  return { api, calls: () => V03_CALLS.filter((name) => (api[name] as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0) };
}

afterEach(() => vi.unstubAllGlobals());

describe('every v0.3 switch off', () => {
  it('the Board shows no New button, no Starting rail and no Files place', async () => {
    viewport(1440);
    const { api, calls } = quietApi();
    renderApp({ state: offState(), api });
    await screen.findAllByText('a');
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
    expect(document.querySelector('[data-ghosts]')).toBeNull();
    expect(screen.queryByRole('link', { name: /^Files/ })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await screen.findByPlaceholderText('Jump to a session or account');
    expect(screen.queryByText('New session in…')).toBeNull();
    expect(calls()).toEqual([]);
  });

  it('a session shows no Files tab, no Rewrite button and no control bar, and the meta keeps the mode', async () => {
    viewport(1440);
    const { api, calls } = quietApi();
    renderApp({ path: '/s/a', state: offState(), api });
    const box = await screen.findByRole('textbox', { name: /prompt/i });
    fireEvent.change(box, { target: { value: 'rename the helper' } });
    expect(screen.queryByRole('tab', { name: /Files/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Rewrite/ })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Controls' })).toBeNull();
    expect(screen.getByText('plan mode')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    expect(calls()).toEqual([]);
  });

  it('before the first sync says which switches are on, /files and /new wait instead of saying not found', async () => {
    const { api } = quietApi();
    // No daemon info yet: a cold start, or a cache a new version dropped (a launch push opens /new?launch=).
    const cold = stateWith({ seq: 0 });
    const files = renderApp({ path: '/files', state: cold, api });
    expect(await screen.findByText('Opening Files…')).toBeTruthy();
    expect(screen.queryByText('That is off on this Mac.')).toBeNull();
    files.unmount();
    renderApp({ path: '/new?launch=L1', state: cold, api });
    expect(await screen.findByText('Opening New session…')).toBeTruthy();
    expect(screen.queryByText('That is off on this Mac.')).toBeNull();
  });

  it('/files and /new are not found', async () => {
    const { api, calls } = quietApi();
    const files = renderApp({ path: '/files', state: offState(), api });
    expect(await screen.findByText('That is off on this Mac.')).toBeTruthy();
    files.unmount();
    renderApp({ path: '/new?root=s.a&start=1', state: offState(), api });
    expect(await screen.findByText('That is off on this Mac.')).toBeTruthy();
    expect(calls()).toEqual([]);
  });
});
