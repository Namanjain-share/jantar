/**
 * v0.8: the iOS Shortcut's capture keys, made, listed and revoked at the
 * Mac only (ctl.sock, `localOnly`: `jantar intel shortcut add | list |
 * revoke`). A new key is shown once, in the add reply, with the door's URL
 * (null while `remote.mode` is loopback or lan); only its prefixed sha256
 * is stored (auth/capture-keys.ts, jantar.db's capture_keys). At most
 * INTEL_READ_LIMITS.captureKeysMax active: a new one past that revokes the
 * oldest. A key is never logged, audited, put in a URL, a cookie or an
 * event.
 *
 * Wave 0: every route is a stub that answers 501 until lane C replaces this
 * table.
 */
import { notImplementedRoute, type RouteTable } from '../route-kit.js';

export const CAPTURE_KEYS_ROUTE_IMPLS: RouteTable = {
  captureKeyAdd: notImplementedRoute('Shortcut keys'),
  captureKeyList: notImplementedRoute('Shortcut keys'),
  captureKeyRevoke: notImplementedRoute('Shortcut keys'),
};
