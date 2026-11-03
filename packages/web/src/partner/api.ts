/**
 * v0.12 People: her app's API client. It calls her routes only
 * (`/v1/p/*`): the owner's client (lib/api.ts) is never in her bundle, and
 * a test pins every path here to PERSON_ROUTES. Writes carry her device
 * secret (IndexedDB `jantar-person`) and an Idempotency-Key; errors arrive
 * as `{error: {code, message}}` and are thrown as PersonApiError with the
 * daemon's sentence.
 */
import type {
  AgreementFields,
  AgreementPatch,
  AlertReplyBody,
  AlertSendBody,
  AlertsResponse,
  JoinPreview,
  JoinReply,
  JournalCreateBody,
  JournalEntryFull,
  JournalList,
  JournalPatchBody,
  PersonActivityResponse,
  PersonChatList,
  PersonMe,
  PersonOwnToday,
  PersonPrefsPatch,
  PersonStatus,
  PersonStatusBody,
  PersonTodo,
  PersonWeightsResponse,
  PlanView,
  ReviewSendBody,
  ReviewView,
  SharingCheckinBody,
  SleepPutBody,
  SleepWakeBody,
  SleepWeek,
  StepBody,
  StepCheckinBody,
  StepPatch,
  StepStateBody,
} from '@jantar/protocol/people';
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
  todoUpdate: ['PATCH', '/v1/p/todos/:id'],
  todoDelete: ['DELETE', '/v1/p/todos/:id'],
  todoDone: ['POST', '/v1/p/todos/:id/done'],
  todoAck: ['POST', '/v1/p/todos/:id/ack'],
  todoAsk: ['POST', '/v1/p/todos/:id/ask'],
  todoSkip: ['POST', '/v1/p/todos/:id/skip'],
  weights: ['GET', '/v1/p/weights'],
  weightSet: ['PUT', '/v1/p/weights/:day'],
  weightDelete: ['DELETE', '/v1/p/weights/:day'],
  mirror: ['GET', '/v1/p/mirror/:area'],
  // P2: status, the sharing check-in, the day plan and review, sleep, the journal and alerts.
  status: ['PUT', '/v1/p/status'],
  sharingCheckin: ['POST', '/v1/p/sharing/checkin'],
  plan: ['GET', '/v1/p/plans/:day'],
  planAck: ['POST', '/v1/p/plans/:day/ack'],
  stepAdd: ['POST', '/v1/p/plans/:day/steps'],
  stepUpdate: ['PATCH', '/v1/p/plans/:day/steps/:stepId'],
  stepDelete: ['DELETE', '/v1/p/plans/:day/steps/:stepId'],
  stepState: ['POST', '/v1/p/plans/:day/steps/:stepId/state'],
  stepAck: ['POST', '/v1/p/plans/:day/steps/:stepId/ack'],
  stepCheckin: ['POST', '/v1/p/plans/:day/steps/:stepId/checkin'],
  stepAsk: ['POST', '/v1/p/plans/:day/steps/:stepId/ask'],
  stepCarry: ['POST', '/v1/p/plans/:day/steps/:stepId/carry'],
  betweenTick: ['POST', '/v1/p/plans/:day/between/:bid/tick'],
  rough: ['POST', '/v1/p/plans/:day/rough'],
  roughUndo: ['DELETE', '/v1/p/plans/:day/rough'],
  review: ['GET', '/v1/p/plans/:day/review'],
  reviewSend: ['POST', '/v1/p/plans/:day/review'],
  sleep: ['GET', '/v1/p/sleep'],
  sleepStart: ['POST', '/v1/p/sleep/start'],
  sleepWake: ['POST', '/v1/p/sleep/wake'],
  sleepPut: ['PUT', '/v1/p/sleep/:night'],
  sleepDelete: ['DELETE', '/v1/p/sleep/:night'],
  journal: ['GET', '/v1/p/journal'],
  journalGet: ['GET', '/v1/p/journal/:id'],
  journalCreate: ['POST', '/v1/p/journal'],
  journalUpdate: ['PATCH', '/v1/p/journal/:id'],
  journalDelete: ['DELETE', '/v1/p/journal/:id'],
  journalComment: ['POST', '/v1/p/journal/:id/comments'],
  journalCommentDelete: ['DELETE', '/v1/p/journal/:id/comments/:cid'],
  alerts: ['GET', '/v1/p/alerts'],
  alertSend: ['POST', '/v1/p/alerts'],
  alertSeen: ['POST', '/v1/p/alerts/:id/seen'],
  alertReply: ['POST', '/v1/p/alerts/:id/reply'],
  // P3: her chat thread.
  chat: ['GET', '/v1/p/chat'],
  chatSend: ['POST', '/v1/p/chat'],
  chatClear: ['DELETE', '/v1/p/chat'],
  chatStatus: ['GET', '/v1/p/chat/status'],
  chatCancel: ['POST', '/v1/p/chat/turns/:id/cancel'],
  chatTurnDelete: ['DELETE', '/v1/p/chat/turns/:id'],
  chatUndo: ['POST', '/v1/p/chat/turns/:id/changes/:n/undo'],
  chatCard: ['POST', '/v1/p/chat/turns/:id/cards/:n'],
  chatDismiss: ['POST', '/v1/p/chat/turns/:id/cards/:n/dismiss'],
  chatPhotoCreate: ['POST', '/v1/p/chat/photos'],
  chatPhoto: ['GET', '/v1/p/chat/photos/:id'],
  chatPhotoDelete: ['DELETE', '/v1/p/chat/photos/:id'],
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
  prefs(patch: PersonPrefsPatch): Promise<void>;
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
  /** Move a to-do of hers to another day (the review's "Tomorrow"). */
  moveTodo(id: string, day: string): Promise<void>;
  done(id: string, done: boolean, report?: string): Promise<void>;
  ack(id: string): Promise<void>;
  ask(id: string, note: string): Promise<void>;
  skip(id: string, reason?: string): Promise<void>;
  weights(): Promise<PersonWeightsResponse>;
  setWeight(day: string, kg: number): Promise<void>;
  deleteWeight(day: string): Promise<void>;
  mirror(area: string): Promise<unknown>;
  // P2
  status(body: PersonStatusBody): Promise<{ status: PersonStatus | null }>;
  sharingCheckin(body: SharingCheckinBody): Promise<void>;
  plan(day: string): Promise<PlanView>;
  planAck(day: string): Promise<void>;
  stepAdd(day: string, body: StepBody): Promise<{ id: string }>;
  stepUpdate(day: string, stepId: string, patch: StepPatch): Promise<void>;
  stepDelete(day: string, stepId: string): Promise<void>;
  stepState(day: string, stepId: string, body: StepStateBody): Promise<void>;
  stepAck(day: string, stepId: string): Promise<void>;
  stepCheckin(day: string, stepId: string, body: StepCheckinBody): Promise<void>;
  stepAsk(day: string, stepId: string, note: string): Promise<void>;
  stepCarry(day: string, stepId: string, to: string): Promise<void>;
  betweenTick(day: string, bid: string, slot: string, done: boolean): Promise<void>;
  rough(day: string, note?: string): Promise<void>;
  roughUndo(day: string): Promise<void>;
  review(day: string): Promise<ReviewView>;
  reviewSend(day: string, body: ReviewSendBody): Promise<void>;
  sleep(week?: string): Promise<SleepWeek>;
  sleepStart(at?: string): Promise<{ id: string; night: string }>;
  sleepWake(body: Omit<SleepWakeBody, 'clientId'>): Promise<void>;
  sleepPut(night: string, body: SleepPutBody): Promise<void>;
  sleepDelete(night: string): Promise<void>;
  journal(q?: { before?: string; day?: string }): Promise<JournalList>;
  journalGet(id: string): Promise<JournalEntryFull>;
  journalCreate(body: Omit<JournalCreateBody, 'clientId'>): Promise<{ id: string }>;
  journalUpdate(id: string, patch: JournalPatchBody): Promise<void>;
  journalDelete(id: string): Promise<void>;
  journalComment(id: string, text: string): Promise<{ id: string }>;
  journalCommentDelete(id: string, cid: string): Promise<void>;
  alerts(): Promise<AlertsResponse>;
  alertSend(body: AlertSendBody): Promise<{ id: string; delivery: string }>;
  alertSeen(id: string): Promise<void>;
  alertReply(id: string, body: AlertReplyBody): Promise<void>;
  // P3
  chat(before?: string): Promise<PersonChatList>;
  chatSend(text: string, photos?: string[]): Promise<{ id: string }>;
  chatClear(): Promise<void>;
  chatCancel(id: string): Promise<void>;
  chatTurnDelete(id: string): Promise<void>;
  chatUndo(id: string, n: number): Promise<void>;
  chatCard(id: string, n: number): Promise<void>;
  chatDismiss(id: string, n: number): Promise<void>;
  /** One photo's bytes (JPEG, PNG, WebP or GIF); the Mac strips its location and camera details before keeping it. */
  chatPhotoAdd(bytes: Blob): Promise<{ id: string }>;
  chatPhotoUrl(id: string): string;
  chatPhotoDelete(id: string): Promise<void>;
}

/** A client id: a double tap sends the same one, so the daemon makes one row (sleep and journal). */
export function clientId(): string {
  return idemKey();
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

  async function call<T>(key: PathKey, init: { params?: Record<string, string>; query?: Record<string, string | number | undefined>; body?: unknown; raw?: Blob } = {}): Promise<T> {
    const [method, pattern] = PERSON_PATHS[key];
    let path: string = pattern.replace(/:([a-zA-Z]+)/g, (_m, n: string) => encodeURIComponent(init.params?.[n] ?? ''));
    const q = Object.entries(init.query ?? {}).filter(([, v]) => v !== undefined);
    if (q.length) path += `?${q.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.raw !== undefined) headers['content-type'] = 'application/octet-stream';
    else if (init.body !== undefined) headers['content-type'] = 'application/json';
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
        ...(init.raw !== undefined ? { body: init.raw } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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
    moveTodo: async (id, day) => void (await call('todoUpdate', { params: { id }, body: { due: { day } } })),
    done: async (id, done, report) => void (await call('todoDone', { params: { id }, body: { done, ...(report ? { report } : {}) } })),
    ack: async (id) => void (await call('todoAck', { params: { id } })),
    ask: async (id, note) => void (await call('todoAsk', { params: { id }, body: { note } })),
    skip: async (id, reason) => void (await call('todoSkip', { params: { id }, body: reason ? { reason } : {} })),
    weights: () => call('weights'),
    setWeight: async (day, kg) => void (await call('weightSet', { params: { day }, body: { kg } })),
    deleteWeight: async (day) => void (await call('weightDelete', { params: { day } })),
    mirror: (area) => call('mirror', { params: { area } }),
    status: (body) => call('status', { body }),
    sharingCheckin: async (body) => void (await call('sharingCheckin', { body })),
    plan: (day) => call('plan', { params: { day } }),
    planAck: async (day) => void (await call('planAck', { params: { day } })),
    stepAdd: (day, body) => call('stepAdd', { params: { day }, body }),
    stepUpdate: async (day, stepId, patch) => void (await call('stepUpdate', { params: { day, stepId }, body: patch })),
    stepDelete: async (day, stepId) => void (await call('stepDelete', { params: { day, stepId } })),
    stepState: async (day, stepId, body) => void (await call('stepState', { params: { day, stepId }, body })),
    stepAck: async (day, stepId) => void (await call('stepAck', { params: { day, stepId } })),
    stepCheckin: async (day, stepId, body) => void (await call('stepCheckin', { params: { day, stepId }, body })),
    stepAsk: async (day, stepId, note) => void (await call('stepAsk', { params: { day, stepId }, body: { note } })),
    stepCarry: async (day, stepId, to) => void (await call('stepCarry', { params: { day, stepId }, body: { to } })),
    betweenTick: async (day, bid, slot, done) => void (await call('betweenTick', { params: { day, bid }, body: { slot, done } })),
    rough: async (day, note) => void (await call('rough', { params: { day }, body: note ? { note } : {} })),
    roughUndo: async (day) => void (await call('roughUndo', { params: { day } })),
    review: (day) => call('review', { params: { day } }),
    reviewSend: async (day, body) => void (await call('reviewSend', { params: { day }, body })),
    sleep: (week) => call('sleep', { query: { week } }),
    sleepStart: (at) => call('sleepStart', { body: { clientId: idemKey(), ...(at ? { at } : {}) } }),
    sleepWake: async (body) => void (await call('sleepWake', { body: { ...body, clientId: idemKey() } })),
    sleepPut: async (night, body) => void (await call('sleepPut', { params: { night }, body })),
    sleepDelete: async (night) => void (await call('sleepDelete', { params: { night } })),
    journal: (q = {}) => call('journal', { query: q }),
    journalGet: (id) => call('journalGet', { params: { id } }),
    journalCreate: (body) => call('journalCreate', { body: { ...body, clientId: idemKey() } }),
    journalUpdate: async (id, patch) => void (await call('journalUpdate', { params: { id }, body: patch })),
    journalDelete: async (id) => void (await call('journalDelete', { params: { id } })),
    journalComment: (id, text) => call('journalComment', { params: { id }, body: { text } }),
    journalCommentDelete: async (id, cid) => void (await call('journalCommentDelete', { params: { id, cid } })),
    alerts: () => call('alerts'),
    alertSend: (body) => call('alertSend', { body }),
    alertSeen: async (id) => void (await call('alertSeen', { params: { id } })),
    alertReply: async (id, body) => void (await call('alertReply', { params: { id }, body })),
    chat: (before) => call('chat', { query: { before } }),
    chatSend: (text, photos) => call('chatSend', { body: { text, ...(photos?.length ? { photos } : {}) } }),
    chatClear: async () => void (await call('chatClear')),
    chatCancel: async (id) => void (await call('chatCancel', { params: { id } })),
    chatTurnDelete: async (id) => void (await call('chatTurnDelete', { params: { id } })),
    chatUndo: async (id, n) => void (await call('chatUndo', { params: { id, n: String(n) } })),
    chatCard: async (id, n) => void (await call('chatCard', { params: { id, n: String(n) } })),
    chatDismiss: async (id, n) => void (await call('chatDismiss', { params: { id, n: String(n) } })),
    chatPhotoAdd: (bytes) => call('chatPhotoCreate', { raw: bytes }),
    chatPhotoUrl: (id) => PERSON_PATHS.chatPhoto[1].replace(':id', encodeURIComponent(id)),
    chatPhotoDelete: async (id) => void (await call('chatPhotoDelete', { params: { id } })),
  };
}
