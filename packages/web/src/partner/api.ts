/**
 * v0.12 People: her app's API client. It calls her routes only
 * (`/v1/p/*`): the owner's client (lib/api.ts) is never in her bundle, and
 * a test pins every path here to PERSON_ROUTES. Writes carry her device
 * secret (IndexedDB `jantar-person`) and an Idempotency-Key; errors arrive
 * as `{error: {code, message}}` and are thrown as PersonApiError with the
 * daemon's sentence.
 */
import type { AgreementFields, AgreementPatch, JoinPreview, JoinReply, PersonActivityResponse, PersonMe, PersonOwnToday, PersonTodo, PersonWeightsResponse } from '@jantar/protocol/people';
import { personCredentialStore, type PersonCredentialStore } from './credential.js';

/** Her routes' paths, as PERSON_ROUTES has them (test/partner/api.test.ts compares). */
export const PERSON_PATHS = {
  joinPreview: ['POST', '/v1/p/join/preview'],
  join: ['POST', '/v1/p/join'],
  me: ['GET', '/v1/p/me'],
  accept: ['POST', '/v1/p/agreement/accept'],
  decline: ['POST', '/v1/p/agreement/decline'],
  narrow: ['POST', '/v1/p/agreement/narrow'],
  pause: ['POST', '/v1/p/pause'],
  resume: ['POST', '/v1/p/resume'],
  leave: ['POST', '/v1/p/leave'],
  export: ['GET', '/v1/p/export'],
  activity: ['GET', '/v1/p/activity'],
  prefs: ['PATCH', '/v1/p/prefs'],
  devices: ['GET', '/v1/p/devices'],
  deviceRevoke: ['DELETE', '/v1/p/devices/:id'],
  linkCode: ['POST', '/v1/p/devices/link'],
  linkClaim: ['POST', '/v1/p/devices/link/claim'],
  pushKey: ['GET', '/v1/p/push/vapid-public-key'],
  pushSubscribe: ['POST', '/v1/p/push/subscribe'],
  pushUnsubscribe: ['POST', '/v1/p/push/unsubscribe'],
  pushTest: ['POST', '/v1/p/push/test'],
  today: ['GET', '/v1/p/today'],
  todos: ['GET', '/v1/p/todos'],
  todoCreate: ['POST', '/v1/p/todos'],
  todoDelete: ['DELETE', '/v1/p/todos/:id'],
  todoDone: ['POST', '/v1/p/todos/:id/done'],
  todoAck: ['POST', '/v1/p/todos/:id/ack'],
  todoAsk: ['POST', '/v1/p/todos/:id/ask'],
  todoSkip: ['POST', '/v1/p/todos/:id/skip'],
  weights: ['GET', '/v1/p/weights'],
  weightSet: ['PUT', '/v1/p/weights/:day'],
  weightDelete: ['DELETE', '/v1/p/weights/:day'],
  mirror: ['GET', '/v1/p/mirror/:area'],
} as const;
type PathKey = keyof typeof PERSON_PATHS;

export class PersonApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PersonApiError';
  }
}

export interface PersonDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
  accessEmail?: string;
}

export interface PersonApi {
  joinPreview(code: string): Promise<JoinPreview>;
  join(body: { code: string; acceptedVersion: number; agreement: AgreementFields; name: string; deviceName: string }): Promise<JoinReply>;
  linkClaim(code: string, deviceName: string): Promise<JoinReply>;
  me(): Promise<PersonMe>;
  accept(version: number): Promise<void>;
  decline(version: number, dontAsk: boolean): Promise<void>;
  narrow(patch: AgreementPatch): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  leave(data: 'keep30' | 'delete'): Promise<void>;
  exportUrl(format: 'html' | 'json'): string;
  activity(before?: number): Promise<PersonActivityResponse>;
  prefs(patch: { lockScreen?: 'all' | 'hide_alerts' | 'hide_all'; muteUntil?: string | null }): Promise<void>;
  devices(): Promise<{ devices: PersonDevice[] }>;
  revokeDevice(id: string): Promise<void>;
  linkCode(): Promise<{ code: string; url: string; expiresAt: string }>;
  pushKey(): Promise<{ publicKey: string }>;
  pushSubscribe(subscription: PushSubscriptionJSON): Promise<void>;
  pushTest(): Promise<{ delivered: number }>;
  today(): Promise<PersonOwnToday>;
  todos(done?: boolean): Promise<{ today: string; todos: PersonTodo[] }>;
  createTodo(body: { title: string; due?: { day: string; time?: string } }): Promise<{ id: string }>;
  deleteTodo(id: string): Promise<void>;
  done(id: string, done: boolean, report?: string): Promise<void>;
  ack(id: string): Promise<void>;
  ask(id: string, note: string): Promise<void>;
  skip(id: string, reason?: string): Promise<void>;
  weights(): Promise<PersonWeightsResponse>;
  setWeight(day: string, kg: number): Promise<void>;
  deleteWeight(day: string): Promise<void>;
  mirror(area: string): Promise<unknown>;
}

function idemKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createPersonApi(opts: { fetch?: typeof fetch; base?: string; credentials?: PersonCredentialStore } = {}): PersonApi {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const base = opts.base ?? (typeof location === 'undefined' ? 'http://localhost' : location.origin);
  const creds = opts.credentials ?? personCredentialStore();

  async function call<T>(key: PathKey, init: { params?: Record<string, string>; query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const [method, pattern] = PERSON_PATHS[key];
    let path: string = pattern.replace(/:([a-z]+)/g, (_m, n: string) => encodeURIComponent(init.params?.[n] ?? ''));
    const q = Object.entries(init.query ?? {}).filter(([, v]) => v !== undefined);
    if (q.length) path += `?${q.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') {
      headers['idempotency-key'] = idemKey();
      const c = await creds.get();
      if (c) headers['x-jantar-device-secret'] = c.secret;
    }
    let res: Response;
    try {
      res = await doFetch(new URL(path, base).toString(), {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new PersonApiError('network', "Can't reach the Mac right now.", 0);
    }
    const text = await res.text().catch(() => '');
    const json: unknown = text ? (() => { try { return JSON.parse(text) as unknown; } catch { return undefined; } })() : undefined;
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new PersonApiError(e?.code ?? 'error', e?.message ?? `${res.status}`, res.status);
    }
    return json as T;
  }

  const saveSecret = async (r: JoinReply) => {
    await creds.set({ secret: r.deviceSecret, deviceId: r.deviceId });
    return r;
  };

  return {
    joinPreview: (code) => call('joinPreview', { body: { code } }),
    join: async (b) => saveSecret(await call<JoinReply>('join', { body: { ...b, adult: true } })),
    linkClaim: async (code, deviceName) => saveSecret(await call<JoinReply>('linkClaim', { body: { code, deviceName } })),
    me: () => call('me'),
    accept: async (version) => void (await call('accept', { body: { version } })),
    decline: async (version, dontAsk) => void (await call('decline', { body: { version, dontAsk } })),
    narrow: async (patch) => void (await call('narrow', { body: patch })),
    pause: async () => void (await call('pause', { body: {} })),
    resume: async () => void (await call('resume', { body: {} })),
    leave: async (data) => {
      await call('leave', { body: { data, confirm: 'LEAVE' } });
      await creds.clear();
    },
    exportUrl: (format) => `${PERSON_PATHS.export[1]}?format=${format}`,
    activity: (before) => call('activity', { query: { before } }),
    prefs: async (patch) => void (await call('prefs', { body: patch })),
    devices: () => call('devices'),
    revokeDevice: async (id) => void (await call('deviceRevoke', { params: { id } })),
    linkCode: () => call('linkCode'),
    pushKey: () => call('pushKey'),
    pushSubscribe: async (subscription) => void (await call('pushSubscribe', { body: { subscription: { endpoint: subscription.endpoint, keys: subscription.keys } } })),
    pushTest: () => call('pushTest'),
    today: () => call('today'),
    todos: (done) => call('todos', { query: { done: done ? '1' : undefined } }),
    createTodo: (body) => call('todoCreate', { body }),
    deleteTodo: async (id) => void (await call('todoDelete', { params: { id } })),
    done: async (id, done, report) => void (await call('todoDone', { params: { id }, body: { done, ...(report ? { report } : {}) } })),
    ack: async (id) => void (await call('todoAck', { params: { id } })),
    ask: async (id, note) => void (await call('todoAsk', { params: { id }, body: { note } })),
    skip: async (id, reason) => void (await call('todoSkip', { params: { id }, body: reason ? { reason } : {} })),
    weights: () => call('weights'),
    setWeight: async (day, kg) => void (await call('weightSet', { params: { day }, body: { kg } })),
    deleteWeight: async (day) => void (await call('weightDelete', { params: { day } })),
    mirror: (area) => call('mirror', { params: { area } }),
  };
}
