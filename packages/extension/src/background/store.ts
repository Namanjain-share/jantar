/**
 * Where the worker keeps its pairing: the daemon's port and the extension
 * key, nothing else. IndexedDB `jantar` (version 1), one store `config`
 * with one record. The extension origin's IndexedDB is out of a content
 * script's reach (it gets the page's), unlike chrome.storage.local, so the
 * key never goes into chrome.storage (MP9). Opened lazily, on the first
 * handler that needs it, never while the worker adds its listeners.
 *
 * Tests use memoryKeyStore(): neither node nor jsdom has IndexedDB.
 */

export interface Pairing {
  port: number;
  key: string;
  /** ISO time of the pairing. */
  pairedAt: string;
}

export interface KeyStore {
  /** The pairing, or null when there is none (or it could not be read). */
  get(): Promise<Pairing | null>;
  set(pairing: Pairing): Promise<void>;
  clear(): Promise<void>;
}

/** What the daemon's key looks like (43 base64url characters today; a little room either way). */
export const KEY_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;

export function isPairing(v: unknown): v is Pairing {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.port === 'number' && Number.isInteger(p.port) && p.port > 0 && p.port < 65_536 &&
    typeof p.key === 'string' && KEY_SHAPE.test(p.key) &&
    typeof p.pairedAt === 'string'
  );
}

const DB_NAME = 'jantar';
const DB_VERSION = 1;
const STORE = 'config';
const RECORD = 'pairing';

/** The worker's own IndexedDB. The record is cached in memory after the first read (the worker is its only writer). */
export function indexedDbKeyStore(): KeyStore {
  let db: Promise<IDBDatabase> | null = null;
  let cached: Promise<Pairing | null> | null = null;

  const open = (): Promise<IDBDatabase> =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const conn = req.result;
        conn.onversionchange = () => {
          conn.close();
          db = null;
        };
        conn.onclose = () => {
          db = null;
        };
        resolve(conn);
      };
      req.onerror = () => {
        db = null;
        reject(req.error ?? new Error('indexedDB open failed'));
      };
    }));

  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const conn = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = conn.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  };

  return {
    get() {
      cached ??= run<unknown>('readonly', (s) => s.get(RECORD)).then(
        (v) => (isPairing(v) ? { port: v.port, key: v.key, pairedAt: v.pairedAt } : null),
        () => {
          // Unreadable storage reads as "not paired"; the next call tries again.
          cached = null;
          return null;
        },
      );
      return cached;
    },
    async set(pairing) {
      const record: Pairing = { port: pairing.port, key: pairing.key, pairedAt: pairing.pairedAt };
      await run('readwrite', (s) => s.put(record, RECORD));
      cached = Promise.resolve(record);
    },
    async clear() {
      cached = Promise.resolve(null);
      await run('readwrite', (s) => s.delete(RECORD));
    },
  };
}

/** An in-memory KeyStore for tests. */
export function memoryKeyStore(initial: Pairing | null = null): KeyStore {
  let value = initial ? { ...initial } : null;
  return {
    get: async () => (value ? { ...value } : null),
    set: async (pairing) => {
      value = { port: pairing.port, key: pairing.key, pairedAt: pairing.pairedAt };
    },
    clear: async () => {
      value = null;
    },
  };
}
