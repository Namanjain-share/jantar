/**
 * The Files views follow the sessions live (wave 2): every files.changed
 * moves the session's counter in state.fileTicks, and the views ask again,
 * once per burst of writes, even when the count of changed files stays the
 * same (a second Edit to the same file). The viewer reads an open file again
 * when Claude writes it.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@jantar/protocol';
import type { AppStore } from '../src/store.js';
import { TICK_RELOAD_MS, clearFilesCache } from '../src/ui/screens/files/data.js';
import { FILES_ON, change, stat, text } from './files-helpers.js';
import { emit, fakeApi, iso, preloadPlaces, renderApp, session, stateWith } from './helpers.js';

preloadPlaces('files');

beforeEach(() => clearFilesCache());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One files.changed event for `sid`, as the watcher publishes it (the reducer keeps only a count). */
function wrote(store: AppStore, sid: string, n = 1) {
  const evs: DaemonEvent[] = [];
  for (let i = 0; i < n; i++) {
    const seq = store.getState().state.seq + 1 + i;
    evs.push({
      seq,
      ts: iso(300_000 + i),
      type: 'files.changed',
      sid,
      data: { changeId: 'c1', path: `/synthetic/home/work/${sid}/src/auth/session.ts`, tool: 'Edit', at: iso(300_000 + i), status: 'ok', opId: `op-${seq}`, transcriptOffset: 10 * seq, byAgent: false },
    } as DaemonEvent);
  }
  act(() => emit(store, evs));
}

const flush = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('/files', () => {
  it('asks again after a write that changes no count, once per burst', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const filesChanges = vi.fn(async () => ({ changes: [change()] }));
    const { store } = renderApp({ path: '/files', api: fakeApi({ filesChanges }), state: stateWith({ sessions: [session('a', { filesChanged: 1 })], features: FILES_ON }) });
    await screen.findByText('1 file changed today');
    expect(filesChanges).toHaveBeenCalledTimes(1);

    wrote(store, 'a', 5);
    expect(store.getState().state.fileTicks).toEqual({ a: 5 });
    await flush(TICK_RELOAD_MS + 50);
    await waitFor(() => expect(filesChanges).toHaveBeenCalledTimes(2));
    await flush(TICK_RELOAD_MS * 3);
    expect(filesChanges).toHaveBeenCalledTimes(2);

    wrote(store, 'a');
    await flush(TICK_RELOAD_MS + 50);
    await waitFor(() => expect(filesChanges).toHaveBeenCalledTimes(3));
  });

  it('does not ask while Files is off, whatever the events say', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const filesChanges = vi.fn(async () => ({ changes: [] }));
    const { store } = renderApp({ path: '/', api: fakeApi({ filesChanges }), state: stateWith({ sessions: [session('a')] }) });
    wrote(store, 'a', 3);
    await flush(TICK_RELOAD_MS * 3);
    expect(filesChanges).not.toHaveBeenCalled();
  });
});

describe("a session's Files tab", () => {
  it("asks again after this session's write, not another session's", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sessionChanges = vi.fn(async () => ({ changes: [change()], scan: { done: true, bytes: 1, total: 1 }, truncated: false }));
    const { store } = renderApp({
      path: '/s/a',
      api: fakeApi({ sessionChanges }),
      state: stateWith({ sessions: [session('a', { status: 'idle', filesChanged: 1 }), session('b')], features: FILES_ON }),
    });
    fireEvent.click(screen.getByRole('tab', { name: /^Files/ }));
    await screen.findByRole('list', { name: 'Files this session changed' });
    expect(sessionChanges).toHaveBeenCalledTimes(1);

    wrote(store, 'b', 2);
    await flush(TICK_RELOAD_MS * 3);
    expect(sessionChanges).toHaveBeenCalledTimes(1);

    wrote(store, 'a', 2);
    await flush(TICK_RELOAD_MS + 50);
    await waitFor(() => expect(sessionChanges).toHaveBeenCalledTimes(2));
    expect(sessionChanges).toHaveBeenLastCalledWith('a');
  });
});

describe('the viewer', () => {
  it('reads the open file again when Claude writes it, not when the list first arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let lastAt = iso(120_000);
    const sessionChanges = vi.fn(async () => ({ changes: [change({ lastAt })], scan: { done: true, bytes: 1, total: 1 }, truncated: false }));
    const filesText = vi.fn(async () => text('const a = 1;\n'));
    const filesStat = vi.fn(async () => stat());
    const { store } = renderApp({
      path: '/s/a',
      api: fakeApi({ sessionChanges, filesText, filesStat, filesRoots: vi.fn(async () => ({ roots: [] })) }),
      state: stateWith({ sessions: [session('a', { status: 'idle', filesChanged: 1 })], features: FILES_ON }),
    });
    fireEvent.click(screen.getByRole('tab', { name: /^Files/ }));
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    expect(await screen.findByText('const a = 1;')).toBeTruthy();
    expect(filesText).toHaveBeenCalledTimes(1);
    expect(filesStat).toHaveBeenCalledTimes(1);

    lastAt = iso(310_000);
    filesText.mockImplementation(async () => text('const a = 2;\n', { mtime: iso(310_000) }));
    wrote(store, 'a');
    await flush(TICK_RELOAD_MS + 50);
    expect(await screen.findByText('const a = 2;')).toBeTruthy();
    expect(filesText).toHaveBeenCalledTimes(2);
    expect(filesStat).toHaveBeenCalledTimes(2);
  });

  it('a write that leaves the open file as it was reads it once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sessionChanges = vi.fn(async () => ({ changes: [change()], scan: { done: true, bytes: 1, total: 1 }, truncated: false }));
    const filesText = vi.fn(async () => text('const a = 1;\n'));
    const { store } = renderApp({
      path: '/s/a',
      api: fakeApi({ sessionChanges, filesText, filesStat: vi.fn(async () => stat()), filesRoots: vi.fn(async () => ({ roots: [] })) }),
      state: stateWith({ sessions: [session('a', { status: 'idle', filesChanged: 1 })], features: FILES_ON }),
    });
    fireEvent.click(screen.getByRole('tab', { name: /^Files/ }));
    fireEvent.click(await screen.findByRole('button', { name: /session\.ts/ }));
    expect(await screen.findByText('const a = 1;')).toBeTruthy();
    wrote(store, 'a');
    await flush(TICK_RELOAD_MS + 50);
    await waitFor(() => expect(sessionChanges).toHaveBeenCalledTimes(2));
    await flush(TICK_RELOAD_MS);
    expect(filesText).toHaveBeenCalledTimes(1);
  });
});
