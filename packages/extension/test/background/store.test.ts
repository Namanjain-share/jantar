/**
 * The key store (spec 3.9): IndexedDB `jantar` version 1, one store
 * `config`, one record `{ port, key, pairedAt }`, opened only when first
 * needed. Node has no IndexedDB, so a small stand-in (open with its
 * upgrade, one object store, get, put and delete in transactions) plays it
 * here; the real one runs in the end-to-end suite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedDbKeyStore, isPairing, memoryKeyStore } from '../../src/background/store.js';
import { KEY, PAIRED } from './chrome.js';

type Handler = (() => void) | null;

/** What the stand-in keeps "on disk": database name -> store name -> key -> value. */
function fakeIndexedDb(opts: { failOpen?: number } = {}) {
  const disk = new Map<string, Map<string, Map<string, unknown>>>();
  const opened: { name: string; version: number }[] = [];
  let failOpen = opts.failOpen ?? 0;
  const later = (fn: () => void) => setTimeout(fn, 0);

  function request<T>(run: () => T) {
    const req = { result: undefined as T | undefined, error: null as Error | null, onsuccess: null as Handler, onerror: null as Handler };
    later(() => {
      req.result = run();
      req.onsuccess?.();
    });
    return req;
  }

  const api = {
    open(name: string, version: number) {
      opened.push({ name, version });
      const req = { result: undefined as unknown, error: null as Error | null, onupgradeneeded: null as Handler, onsuccess: null as Handler, onerror: null as Handler, onblocked: null as Handler };
      later(() => {
        if (failOpen > 0) {
          failOpen -= 1;
          req.error = new Error('open failed');
          req.onerror?.();
          return;
        }
        const fresh = !disk.has(name);
        const stores = disk.get(name) ?? new Map<string, Map<string, unknown>>();
        disk.set(name, stores);
        const db = {
          objectStoreNames: { contains: (s: string) => stores.has(s) },
          createObjectStore: (s: string) => stores.set(s, new Map()),
          onversionchange: null as Handler,
          onclose: null as Handler,
          close: () => undefined,
          transaction(storeName: string, _mode: string) {
            const data = stores.get(storeName);
            if (!data) throw new Error(`no store ${storeName}`);
            const tx = { oncomplete: null as Handler, onerror: null as Handler, onabort: null as Handler, error: null as Error | null, objectStore: () => store };
            // The request settles first, then its transaction completes.
            const done = <T>(run: () => T) => {
              const req = request(run);
              later(() => later(() => tx.oncomplete?.()));
              return req;
            };
            const store = {
              get: (k: string) => done(() => structuredClone(data.get(k))),
              put: (v: unknown, k: string) => done(() => void data.set(k, structuredClone(v))),
              delete: (k: string) => done(() => void data.delete(k)),
            };
            return tx;
          },
        };
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { api, disk, opened };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('indexedDbKeyStore', () => {
  it('opens nothing until asked, then keeps the pairing in jantar/config', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.api);
    const store = indexedDbKeyStore();
    expect(idb.opened).toEqual([]);
    expect(await store.get()).toBeNull();
    expect(idb.opened).toEqual([{ name: 'jantar', version: 1 }]);
    await store.set({ ...PAIRED, extra: 'dropped' } as typeof PAIRED);
    expect(await store.get()).toEqual(PAIRED);
    expect([...(idb.disk.get('jantar')?.keys() ?? [])]).toEqual(['config']);
    expect([...(idb.disk.get('jantar')?.get('config')?.values() ?? [])]).toEqual([PAIRED]);
    // A worker that stopped and started again reads it back.
    expect(await indexedDbKeyStore().get()).toEqual(PAIRED);
    await store.clear();
    expect(await store.get()).toBeNull();
    expect(await indexedDbKeyStore().get()).toBeNull();
  });

  it('a record of another shape reads as not paired', async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.api);
    await indexedDbKeyStore().set(PAIRED);
    idb.disk.get('jantar')?.get('config')?.set('pairing', { port: 'x', key: KEY });
    expect(await indexedDbKeyStore().get()).toBeNull();
  });

  it('storage that will not open reads as not paired, and the next call tries again', async () => {
    const idb = fakeIndexedDb({ failOpen: 1 });
    vi.stubGlobal('indexedDB', idb.api);
    const store = indexedDbKeyStore();
    expect(await store.get()).toBeNull();
    await store.set(PAIRED);
    expect(await store.get()).toEqual(PAIRED);
    expect(idb.opened).toHaveLength(2);
  });
});

describe('isPairing and memoryKeyStore', () => {
  it("takes a port, a key shaped like the daemon's and a time", () => {
    expect(isPairing(PAIRED)).toBe(true);
    for (const bad of [null, {}, { ...PAIRED, port: 0 }, { ...PAIRED, port: 70_000 }, { ...PAIRED, port: 1.5 }, { ...PAIRED, key: 'short' }, { ...PAIRED, key: `${KEY} ` }, { ...PAIRED, pairedAt: 1 }]) {
      expect(isPairing(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('memoryKeyStore hands out copies', async () => {
    const store = memoryKeyStore(PAIRED);
    const got = await store.get();
    if (got) got.key = 'changed';
    expect(await store.get()).toEqual(PAIRED);
    await store.clear();
    expect(await store.get()).toBeNull();
  });
});
