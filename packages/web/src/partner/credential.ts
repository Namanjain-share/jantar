/**
 * v0.12 People: her device secret, in IndexedDB `jantar-person` (never the
 * owner's `jantar-credentials`): the second credential her writes and her
 * stream carry. Her host is its own origin, so its IndexedDB is apart from
 * his anyway; the name keeps them apart on a shared dev origin too.
 *
 * Reads go to IndexedDB each time. Without IndexedDB (a private window,
 * blocked site data) the secret is kept in memory for this page only. It is
 * never put in localStorage, a URL or a log.
 */
import { PERSON_CREDENTIAL_DB } from '@jantar/protocol/people-core';

export interface PersonCredential {
  secret: string;
  deviceId: string;
}

const STORE = 'device';
const KEY = 'current';
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(PERSON_CREDENTIAL_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

export interface PersonCredentialStore {
  get(): Promise<PersonCredential | null>;
  set(c: PersonCredential): Promise<void>;
  clear(): Promise<void>;
}

export function personCredentialStore(factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB): PersonCredentialStore {
  let memory: PersonCredential | null = null;
  const run = async <T>(mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    if (!factory) throw new Error('no indexedDB');
    const db = await open(factory);
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = make(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
      });
    } finally {
      db.close();
    }
  };
  return {
    async get() {
      try {
        const v = (await run('readonly', (s) => s.get(KEY))) as Partial<PersonCredential> | undefined;
        if (v && typeof v.secret === 'string' && SECRET_RE.test(v.secret)) return { secret: v.secret, deviceId: String(v.deviceId ?? '') };
        return memory;
      } catch {
        return memory;
      }
    },
    async set(c) {
      memory = c;
      try {
        await run('readwrite', (s) => s.put(c, KEY));
      } catch {
        /* kept in memory for this page */
      }
    },
    async clear() {
      memory = null;
      try {
        await run('readwrite', (s) => s.delete(KEY));
      } catch {
        /* nothing stored */
      }
    },
  };
}
