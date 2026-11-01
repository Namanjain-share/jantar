/**
 * v0.8: the iOS Shortcut's capture keys, made, listed and revoked at the
 * Mac only (ctl.sock, `localOnly`: `jantar intel shortcut add | list |
 * revoke`). A new key is shown once, in the add reply, with the door's URL
 * (null while `remote.mode` is loopback or lan, or there is no https public
 * address); only its prefixed sha256 is stored (auth/capture-keys.ts,
 * jantar.db's capture_keys). At most INTEL_READ_LIMITS.captureKeysMax
 * active: a new one past that revokes the oldest. A key is never logged,
 * audited, put in a URL, a cookie or an event: the audit rows carry the
 * key's id and nothing else.
 */
import type { CaptureKeyAddBody, CaptureKeyAddReply, CaptureKeyList, CaptureKeyRevokeBody, CaptureKeyRevokeReply } from '@jantar/protocol';
import { CAPTURE_KEY_DEFAULT_NAME, captureDoor } from '../../auth/capture-keys.js';
import type { Call, RouteTable } from '../route-kit.js';

export const CAPTURE_KEYS_ROUTE_IMPLS: RouteTable = {
  captureKeyAdd: {
    handle: (c: Call<Record<string, string>, unknown, CaptureKeyAddBody>, s): CaptureKeyAddReply => {
      const made = s.captureKeys.issue(c.body.name ?? CAPTURE_KEY_DEFAULT_NAME);
      c.scratch.keyId = made.id;
      return { ...made, saveUrl: captureDoor(s.ctx.settings.get()).url };
    },
    // The key's id only: never the key or its name.
    audit: (c) => ({ target: typeof c.scratch.keyId === 'string' ? c.scratch.keyId : undefined, params: {} }),
  },

  captureKeyList: {
    handle: (_c: Call, s): CaptureKeyList => ({
      keys: s.captureKeys.list().map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastSeenAt: k.lastSeenAt })),
    }),
  },

  captureKeyRevoke: {
    handle: (c: Call<Record<string, string>, unknown, CaptureKeyRevokeBody>, s): CaptureKeyRevokeReply => {
      const body = c.body;
      if ('all' in body) return { revoked: s.captureKeys.revokeAll() };
      return { revoked: s.captureKeys.revoke(body.id) ? 1 : 0 };
    },
    audit: (c: Call<Record<string, string>, unknown, CaptureKeyRevokeBody>, out) => ({
      target: 'id' in c.body ? c.body.id : 'all',
      params: { revoked: (out.body as { revoked?: unknown } | null)?.revoked ?? 0 },
    }),
  },
};
