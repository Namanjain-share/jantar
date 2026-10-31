/**
 * MX7: listeners first. An event that wakes a stopped MV3 worker goes only
 * to listeners added in its first turn, so importing the entry adds
 * runtime.onMessage, commands.onCommand and tabs.onRemoved with no awaited
 * step in between, and nothing is opened (IndexedDB) on the way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChromeFake, type ChromeFake, type ChromeModel } from '../helpers/chrome-fake.js';

let chrome: ChromeFake;
let model: ChromeModel;

beforeEach(() => {
  vi.resetModules();
  ({ chrome, model } = createChromeFake());
});

afterEach(() => {
  model.uninstall();
  vi.unstubAllGlobals();
});

describe('the worker entry', () => {
  it('adds its three listeners when background.js runs, before anything is awaited', async () => {
    // An IndexedDB that never opens: nothing in the first turn may wait on it.
    const open = vi.fn(() => ({}) as IDBOpenDBRequest);
    vi.stubGlobal('indexedDB', { open });
    await import('../../src/background/index.js');
    expect(chrome.runtime.onMessage.hasListeners()).toBe(true);
    expect(chrome.commands.onCommand.hasListeners()).toBe(true);
    expect(chrome.tabs.onRemoved.hasListeners()).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it('startWorker adds them in the same turn it is called', async () => {
    const { startWorker } = await import('../../src/background/index.js');
    for (const e of [chrome.runtime.onMessage, chrome.commands.onCommand, chrome.tabs.onRemoved]) e.listeners.length = 0;
    const worker = startWorker({ keys: { get: () => new Promise(() => undefined), set: async () => undefined, clear: async () => undefined } });
    expect(chrome.runtime.onMessage.hasListener(worker.onMessage as never)).toBe(true);
    expect(chrome.commands.onCommand.hasListener(worker.onCommand as never)).toBe(true);
    expect(chrome.tabs.onRemoved.hasListener(worker.onRemoved as never)).toBe(true);
  });
});
