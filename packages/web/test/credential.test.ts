/**
 * The device secret (SEC-2) lives in IndexedDB, which browsers keep per
 * origin, port included, so a page on another 127.0.0.1 port cannot read it.
 * jsdom has no IndexedDB, so these tests drive the store through a small
 * in-memory double of the parts it uses.
 */
import { describe, expect, it } from 'vitest';
import { createCredentialStore, type DeviceCredential } from '../src/lib/credential.js';

const SECRET = 'S'.repeat(43);
const CRED: DeviceCredential = { secret: SECRET, deviceId: 'dev-1', savedAt: '2026-01-15T10:00:00.000Z' };

type Handler = ((ev?: unknown) => void) | null;

/** Just enough of IDBFactory for open / createObjectStore / get / put / delete. */
function fakeIndexedDB(opts: { failOpen?: boolean } = {}) {
  const databases = new Map<string, Map<string, Map<string, unknown>>>();
  const later = (fn: () => void) => queueMicrotask(fn);
  function request<T>(run: () => T) {
    const r = { result: undefined as T | undefined, error: null as unknown, onsuccess: null as Handler, onerror: null as Handler };
    later(() => {
      try {
        r.result = run();
        r.onsuccess?.();
      } catch (e) {
        r.error = e;
        r.onerror?.();
      }
    });
    return r;
  }
  const factory = {
    opened: 0,
    open(name: string) {
      factory.opened += 1;
      const r = {
        result: null as unknown,
        error: null as unknown,
        onsuccess: null as Handler,
        onerror: null as Handler,
        onupgradeneeded: null as Handler,
        onblocked: null as Handler,
        transaction: null as { abort(): void } | null,
      };
      later(() => {
        if (opts.failOpen) {
          r.error = new Error('denied');
          r.onerror?.();
          return;
        }
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const stores = databases.get(name) as Map<string, Map<string, unknown>>;
        const db = {
          objectStoreNames: { contains: (s: string) => stores.has(s) },
          createObjectStore(s: string) {
            stores.set(s, new Map());
          },
          transaction(s: string) {
            const store = stores.get(s);
            if (!store) throw new Error(`no store ${s}`);
            const objectStore = {
              get: (k: string) => request(() => structuredClone(store.get(k))),
              put: (v: unknown, k: string) => request(() => void store.set(k, structuredClone(v))),
              delete: (k: string) => request(() => void store.delete(k)),
            };
            const tx = {
              oncomplete: null as Handler,
              onerror: null as Handler,
              onabort: null as Handler,
              error: null as unknown,
              objectStore: () => objectStore,
            };
            // The transaction completes after its one request (queued a turn earlier) has succeeded.
            queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
            return tx;
          },
          close() {},
        };
        r.result = db;
        if (fresh) {
          // Aborting a new database's first upgrade fails the open and leaves no database.
          let aborted = false;
          r.transaction = { abort: () => void (aborted = true) };
          r.onupgradeneeded?.();
          r.transaction = null;
          if (aborted) {
            databases.delete(name);
            r.error = new Error('AbortError');
            r.onerror?.();
            return;
          }
        }
        r.onsuccess?.();
      });
      return r;
    },
    /** Raw access for the tests. */
    has(name: string) {
      return databases.has(name);
    },
    seed(name: string, store: string, key: string, value: unknown) {
      databases.set(name, new Map([[store, new Map([[key, value]])]]));
    },
    peek(name: string, store: string, key: string) {
      return databases.get(name)?.get(store)?.get(key);
    },
    poke(name: string, store: string, key: string, value: unknown) {
      databases.get(name)?.get(store)?.set(key, value);
    },
  };
  return factory;
}

describe('device credential store', () => {
  it('keeps the secret in IndexedDB and reads it back, also from a new page (a new store)', async () => {
    const idb = fakeIndexedDB();
    const a = createCredentialStore({ indexedDB: idb as unknown as IDBFactory });
    expect(await a.get()).toBeNull();
    await a.set(CRED);
    expect(await a.get()).toEqual(CRED);
    const b = createCredentialStore({ indexedDB: idb as unknown as IDBFactory });
    expect(await b.get()).toEqual(CRED);
    await b.clear();
    expect(await b.get()).toBeNull();
  });

  it('never writes the secret to localStorage', async () => {
    const idb = fakeIndexedDB();
    const store = createCredentialStore({ indexedDB: idb as unknown as IDBFactory });
    await store.set(CRED);
    const all = JSON.stringify({ ...localStorage });
    expect(all).not.toContain(SECRET);
  });

  it('a second tab that paired again wins: reads go to IndexedDB, not a stale copy in memory', async () => {
    const idb = fakeIndexedDB();
    const tab1 = createCredentialStore({ indexedDB: idb as unknown as IDBFactory });
    const tab2 = createCredentialStore({ indexedDB: idb as unknown as IDBFactory });
    await tab1.set(CRED);
    expect(await tab2.get()).toEqual(CRED);
    const next = { ...CRED, secret: 'N'.repeat(43), deviceId: 'dev-2' };
    await tab2.set(next);
    expect(await tab1.get()).toEqual(next);
  });

  it('ignores a stored value that is not a well-formed secret', async () => {
    const idb = fakeIndexedDB();
    const store = createCredentialStore({ indexedDB: idb as unknown as IDBFactory });
    await store.set(CRED);
    for (const bad of [{ ...CRED, secret: 'short' }, { secret: 42 }, 'just a string', null]) {
      idb.poke('jantar-credentials', 'device', 'current', bad);
      expect(await store.get(), JSON.stringify(bad)).toBeNull();
    }
  });

  it('without IndexedDB (or when it refuses to open) the secret still works for this page, in memory', async () => {
    for (const factory of [null, fakeIndexedDB({ failOpen: true }) as unknown as IDBFactory]) {
      const store = createCredentialStore({ indexedDB: factory });
      expect(await store.get()).toBeNull();
      await store.set(CRED);
      expect(await store.get()).toEqual(CRED);
      await store.clear();
      expect(await store.get()).toBeNull();
    }
  });

  it('copies a secret ccw-v2 (the old name) stored, once, leaving the old database as it was', async () => {
    const idb = fakeIndexedDB();
    idb.seed('ccw-v2-credentials', 'device', 'current', CRED);
    const store = createCredentialStore({ indexedDB: idb as unknown as IDBFactory });
    expect(await store.get()).toEqual(CRED);
    expect(idb.peek('jantar-credentials', 'device', 'current')).toEqual(CRED);
    expect(idb.peek('ccw-v2-credentials', 'device', 'current')).toEqual(CRED);
    const next = { ...CRED, secret: 'N'.repeat(43) };
    await store.set(next);
    expect(await createCredentialStore({ indexedDB: idb as unknown as IDBFactory }).get()).toEqual(next);
    // Cleared means cleared: the old secret does not come back.
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it('never creates the old database when there is none', async () => {
    const idb = fakeIndexedDB();
    const store = createCredentialStore({ indexedDB: idb as unknown as IDBFactory });
    expect(await store.get()).toBeNull();
    expect(await store.get()).toBeNull();
    expect(idb.has('ccw-v2-credentials')).toBe(false);
    expect(idb.has('jantar-credentials')).toBe(true);
  });

  it('refuses to save a malformed secret', async () => {
    const store = createCredentialStore({ indexedDB: null });
    await expect(store.set({ ...CRED, secret: 'nope' })).rejects.toThrow(/secret/);
    expect(await store.get()).toBeNull();
  });
});
