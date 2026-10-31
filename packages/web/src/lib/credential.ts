/**
 * This browser's device secret: the second credential the daemon wants on
 * every write and on the event stream (SEC-2).
 *
 * Why not just the cookie: browsers send a 127.0.0.1 cookie to every port on
 * 127.0.0.1, so anything else listening on loopback can read it. IndexedDB is
 * kept per origin, port included, so a page on another port cannot read
 * what is stored here. The secret arrives once, in the pairing claim's reply
 * (api.ts stores it), and is never put in localStorage, a URL or a log.
 *
 * Reads go to IndexedDB each time, so a tab that paired again wins over a
 * stale copy in another tab. When IndexedDB is missing or refuses to open
 * (some private modes, blocked site data), the secret is kept in memory for
 * this page only: writes keep working until the page reloads, and then the
 * daemon asks for pairing again.
 *
 * A browser paired before the rename keeps its secret in ccw-v2's database.
 * While this one has none, the first read copies it over (the old one is left
 * as it is, and never created), so the phone stays paired after
 * `jantar import-ccw-v2`.
 */

export interface DeviceCredential {
  /** 32 random bytes, base64url. */
  secret: string;
  /** The device it was issued to (for display and debugging only). */
  deviceId: string;
  savedAt: string;
}

export interface CredentialStore {
  get(): Promise<DeviceCredential | null>;
  set(credential: DeviceCredential): Promise<void>;
  clear(): Promise<void>;
}

export interface CredentialStoreOptions {
  /** IndexedDB to use; null means none (memory only). Default: the page's own. */
  indexedDB?: IDBFactory | null;
}

const DB_NAME = 'jantar-credentials';
/** The same database under the old name (ccw-v2), read only. */
const LEGACY_DB_NAME = 'ccw-v2-credentials';
const DB_VERSION = 1;
const STORE = 'device';
const KEY = 'current';
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

function wellFormed(v: unknown): DeviceCredential | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<DeviceCredential>;
  if (typeof c.secret !== 'string' || !SECRET_RE.test(c.secret)) return null;
  return {
    secret: c.secret,
    deviceId: typeof c.deviceId === 'string' ? c.deviceId : '',
    savedAt: typeof c.savedAt === 'string' ? c.savedAt : '',
  };
}

/** Open `name`; with `existing`, one that is not there yet is not created and the open fails. */
function openDb(factory: IDBFactory, name = DB_NAME, existing = false): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      if (existing) {
        req.transaction?.abort(); // a new database: aborting its first upgrade leaves none behind
        return;
      }
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB did not open'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

/** The secret in ccw-v2's database, or null (no such database, or nothing usable in it). */
async function readLegacy(factory: IDBFactory): Promise<DeviceCredential | null> {
  try {
    const conn = await openDb(factory, LEGACY_DB_NAME, true);
    try {
      if (!conn.objectStoreNames.contains(STORE)) return null;
      return wellFormed(
        await new Promise<unknown>((resolve, reject) => {
          const req = conn.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
        }),
      );
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }
}

export function createCredentialStore(opts: CredentialStoreOptions = {}): CredentialStore {
  const factory =
    opts.indexedDB !== undefined
      ? opts.indexedDB
      : ((globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null);
  /** The fallback copy (and the only one without IndexedDB). */
  let memory: DeviceCredential | null = null;
  /** The last set() could not reach IndexedDB: memory holds the newer value. */
  let unsaved = false;
  /** ccw-v2's secret, looked up once per store; null after clear(). */
  let legacy: Promise<DeviceCredential | null> | null = null;
  let db: Promise<IDBDatabase> | null = null;

  const database = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new Error('no IndexedDB'));
    db ??= openDb(factory).catch((e: unknown) => {
      db = null; // try again next time
      throw e;
    });
    return db;
  };

  /** Run one request in its own transaction; resolves with its result once the transaction completes. */
  async function run<T>(mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const conn = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = conn.transaction(STORE, mode);
      const req = make(tx.objectStore(STORE));
      let result: T;
      req.onsuccess = () => {
        result = req.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  /** ccw-v2's secret copied into this database (which has none); null when there is none. */
  async function adoptLegacy(): Promise<DeviceCredential | null> {
    if (!factory) return null;
    legacy ??= readLegacy(factory);
    const old = await legacy;
    if (old) await run('readwrite', (s) => s.put(old, KEY)).catch(() => undefined);
    return old;
  }

  return {
    async get() {
      try {
        const stored = wellFormed(await run('readonly', (s) => s.get(KEY))) ?? (unsaved ? null : await adoptLegacy());
        if (unsaved && !stored) return memory;
        memory = stored;
        unsaved = false;
        return stored;
      } catch {
        return memory;
      }
    },
    async set(credential) {
      const c = wellFormed(credential);
      if (!c) throw new Error('not a device secret');
      memory = c;
      try {
        await run('readwrite', (s) => s.put(c, KEY));
        unsaved = false;
      } catch {
        unsaved = true; // kept in memory for this page
      }
    },
    async clear() {
      memory = null;
      unsaved = false;
      legacy = Promise.resolve(null);
      try {
        await run('readwrite', (s) => s.delete(KEY));
      } catch {
        // nothing stored
      }
    },
  };
}

let shared: CredentialStore | null = null;

/** The page's one credential store (IndexedDB when the browser has it). */
export function defaultCredentialStore(): CredentialStore {
  shared ??= createCredentialStore();
  return shared;
}
