/**
 * Which notification kinds reach THIS device. The daemon keeps the list on
 * the device's push subscription (PushSubscribeBody.kinds) and filters each
 * push with it, after the Mac's own notify.kinds. The choice is remembered
 * here too, so it can be sent again whenever the subscription is renewed.
 *
 * "send-failed" is always on: a prompt that was not sent must reach you.
 */
import { DEFAULT_NOTIFY_KINDS, type NotifyKind, type PushSubscriptionJSON } from '@jantar/protocol';
import type { Api } from '../../../lib/api.js';
import { defaultPushEnv, type PushEnv } from '../../../lib/push.js';
import { readLocal, writeLocal } from '../../../lib/storage.js';

export interface KindInfo {
  kind: NotifyKind;
  word: string;
  /** One line: when this push arrives. */
  text: string;
  locked?: boolean;
}

/** direction.md 5.5 order. */
export const KINDS: readonly KindInfo[] = [
  { kind: 'question', word: 'Question', text: 'Claude asks you something' },
  { kind: 'permission', word: 'Permission', text: 'A tool waits for your OK' },
  { kind: 'plan', word: 'Plan', text: 'A plan waits for approval' },
  { kind: 'done', word: 'Done', text: 'A session finished its turn' },
  { kind: 'blocked', word: 'Blocked', text: 'A hook or rule refused a tool' },
  { kind: 'limit', word: 'Limit', text: 'An account hit its limit' },
  { kind: 'error', word: 'API error', text: 'Claude stopped on an API error' },
  { kind: 'usage', word: 'Usage', text: 'An account passed a usage mark' },
  { kind: 'reminder', word: 'Reminder', text: 'Something still waits on you' },
  { kind: 'send-failed', word: 'Not delivered', text: 'A prompt that was not sent must reach you.', locked: true },
];

export const LOCKED_KINDS: readonly NotifyKind[] = KINDS.filter((k) => k.locked).map((k) => k.kind);

const KEY = 'push-kinds';

/** This device's kinds, in KINDS order, always with the locked ones. Defaults to the Mac's defaults. */
export function readKinds(): NotifyKind[] {
  const saved = readLocal<unknown>(KEY, null);
  const list = Array.isArray(saved) ? saved.filter((k): k is NotifyKind => KINDS.some((x) => x.kind === k)) : [...DEFAULT_NOTIFY_KINDS];
  return normalise(list);
}

/** This device's saved kinds, or undefined when it never chose (the Mac's list applies). */
export function savedKinds(): NotifyKind[] | undefined {
  return Array.isArray(readLocal<unknown>(KEY, null)) ? readKinds() : undefined;
}

export function normalise(list: readonly NotifyKind[]): NotifyKind[] {
  const on = new Set([...list, ...LOCKED_KINDS]);
  return KINDS.map((k) => k.kind).filter((k) => on.has(k));
}

export function writeKinds(list: readonly NotifyKind[]): NotifyKind[] {
  const next = normalise(list);
  writeLocal(KEY, next);
  return next;
}

/**
 * Send this device's kinds with its existing push subscription. Returns
 * false when there is no subscription to update (push is off).
 */
export async function registerKinds(api: Api, kinds: readonly NotifyKind[], env: PushEnv = defaultPushEnv()): Promise<boolean> {
  const reg = await env.ready(3000);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  if (!sub) return false;
  await api.pushSubscribe({ subscription: sub.toJSON() as PushSubscriptionJSON, kinds: normalise(kinds) });
  return true;
}
