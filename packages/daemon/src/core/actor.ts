import type { Actor } from '../contracts.js';

/** How an actor appears in the audit log and in `decidedBy`. */
export function actorId(a: Actor): string {
  switch (a.kind) {
    case 'device':
      return `device:${a.deviceId}`;
    case 'cli':
      return 'cli';
    case 'system':
      return 'system';
    case 'extension':
      return `extension:${a.extensionId}`;
  }
}

export const SYSTEM_ACTOR: Actor = { kind: 'system' };
export const CLI_ACTOR: Actor = { kind: 'cli' };
