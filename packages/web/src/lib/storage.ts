/**
 * Per-device conveniences in localStorage (theme, dismissed hints, this
 * device's id). Storage can be missing or throw (private mode, blocked site
 * data), so every access is guarded and the app works without it.
 * Nothing here is a secret: the device key lives in an HttpOnly cookie and
 * the device secret in IndexedDB (credential.ts), never in localStorage.
 */
const PREFIX = 'jantar:';
/** The same keys under the old name (ccw-v2): read while the new key is unset, so an upgrade keeps them. */
const LEGACY_PREFIX = 'ccw-v2:';

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const ls = globalThis.localStorage;
    const raw = ls?.getItem(PREFIX + key) ?? ls?.getItem(LEGACY_PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    if (value === undefined) {
      globalThis.localStorage?.removeItem(PREFIX + key);
      globalThis.localStorage?.removeItem(LEGACY_PREFIX + key); // else the old value would read back
    } else globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // ignore: a convenience, not state
  }
}
