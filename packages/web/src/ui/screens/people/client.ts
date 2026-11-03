/**
 * v0.12 People (P2): the owner's client for his People routes, in the lazy
 * Partner chunk so his main load doesn't grow (spec 9.4). Writes carry his
 * device secret and an Idempotency-Key, as lib/api.ts does. Every path is
 * one of PEOPLE_ROUTES (test/people/client.test.ts compares).
 */
import { DEVICE_SECRET_HEADER } from '@jantar/protocol';
import type {
  AlertReplyBody,
  AlertsResponse,
  AssignTodoBody,
  AssignTodoPatch,
  JournalEntryFull,
  JournalList,
  OwnerAlertSendBody,
  OwnerChatView,
  OwnerTodosView,
  SharedItemsResponse,
  SharedListKind,
  SharedListsResponse,
  PeopleList,
  PersonActivityResponse,
  PersonToday,
  PlanApplyBody,
  PlanPutBody,
  PlanTemplate,
  PlanView,
  ReviewView,
  SleepWeek,
  TemplateBody,
} from '@jantar/protocol/people';
import { ApiError } from '../../../lib/api.js';
import { defaultCredentialStore, type CredentialStore } from '../../../lib/credential.js';
import { newIdempotencyKey } from '../../../lib/ids.js';

export const PEOPLE_PATHS = {
  list: ['GET', '/v1/people'],
  today: ['GET', '/v1/people/:pid/today'],
  activity: ['GET', '/v1/people/:pid/activity'],
  plan: ['GET', '/v1/people/:pid/plans/:day'],
  planPut: ['PUT', '/v1/people/:pid/plans/:day'],
  planApply: ['POST', '/v1/people/:pid/plans/:day/apply'],
  review: ['GET', '/v1/people/:pid/plans/:day/review'],
  carry: ['POST', '/v1/people/:pid/plans/:day/review/carry'],
  templates: ['GET', '/v1/people/:pid/templates'],
  templateCreate: ['POST', '/v1/people/:pid/templates'],
  templateDelete: ['DELETE', '/v1/people/:pid/templates/:tid'],
  sleep: ['GET', '/v1/people/:pid/sleep'],
  journal: ['GET', '/v1/people/:pid/journal'],
  journalGet: ['GET', '/v1/people/:pid/journal/:id'],
  comment: ['POST', '/v1/people/:pid/journal/:id/comments'],
  commentDelete: ['DELETE', '/v1/people/:pid/journal/:id/comments/:cid'],
  alerts: ['GET', '/v1/people/alerts'],
  alertSend: ['POST', '/v1/people/alerts'],
  alertSeen: ['POST', '/v1/people/alerts/:id/seen'],
  alertReply: ['POST', '/v1/people/alerts/:id/reply'],
  // P3: her chat, read only.
  chat: ['GET', '/v1/people/:pid/chat'],
  chatPhoto: ['GET', '/v1/people/:pid/chat/photos/:id'],
  // P3: her chat's daily cap (with her colour).
  person: ['PATCH', '/v1/people/:pid'],
  // P4: the lists he shares with her.
  lists: ['GET', '/v1/people/:pid/lists'],
  listCreate: ['POST', '/v1/people/:pid/lists'],
  listUpdate: ['PATCH', '/v1/people/:pid/lists/:id'],
  listDelete: ['DELETE', '/v1/people/:pid/lists/:id'],
  listItems: ['GET', '/v1/people/:pid/lists/:id/items'],
  listItemAdd: ['POST', '/v1/people/:pid/lists/:id/items'],
  listItemDelete: ['DELETE', '/v1/people/:pid/lists/:id/items/:itemId'],
  listItemTick: ['POST', '/v1/people/:pid/lists/:id/items/:itemId/tick'],
  listItemAssign: ['POST', '/v1/people/:pid/lists/:id/items/:itemId/assign'],
  // P1: her to-dos (see.todos), his assign (assign.todos), his edits (his, or hers with editHers.todos).
  todos: ['GET', '/v1/people/:pid/todos'],
  todoAssign: ['POST', '/v1/people/:pid/todos'],
  todoUpdate: ['PATCH', '/v1/people/:pid/todos/:id'],
  todoDelete: ['DELETE', '/v1/people/:pid/todos/:id'],
} as const;
type Key = keyof typeof PEOPLE_PATHS;

export interface PeopleClient {
  list(): Promise<PeopleList>;
  today(pid: string, day?: string): Promise<PersonToday>;
  activity(pid: string): Promise<PersonActivityResponse>;
  plan(pid: string, day: string): Promise<PlanView>;
  putPlan(pid: string, day: string, body: PlanPutBody): Promise<PlanView>;
  applyTemplate(pid: string, day: string, body: PlanApplyBody): Promise<PlanView>;
  review(pid: string, day: string): Promise<ReviewView>;
  carry(pid: string, day: string, steps: string[], to?: string): Promise<void>;
  templates(pid: string): Promise<{ templates: PlanTemplate[] }>;
  createTemplate(pid: string, body: TemplateBody): Promise<{ id: string }>;
  deleteTemplate(pid: string, tid: string): Promise<void>;
  sleep(pid: string, week?: string): Promise<SleepWeek>;
  journal(pid: string): Promise<JournalList>;
  journalGet(pid: string, id: string): Promise<JournalEntryFull>;
  comment(pid: string, id: string, text: string): Promise<{ id: string }>;
  deleteComment(pid: string, id: string, cid: string): Promise<void>;
  alerts(pid: string): Promise<AlertsResponse>;
  sendAlert(body: OwnerAlertSendBody): Promise<{ id: string; delivery: string }>;
  seen(id: string): Promise<void>;
  reply(id: string, body: AlertReplyBody): Promise<void>;
  /** P3: her chat, read only (see.chat). */
  chat(pid: string, before?: string): Promise<OwnerChatView>;
  chatPhotoUrl(pid: string, id: string): string;
  /** P3: her chat's messages a day. */
  setChatPerDay(pid: string, chatPerDay: number): Promise<void>;
  /** P4: shared lists. */
  lists(pid: string): Promise<SharedListsResponse>;
  listCreate(pid: string, name: string, kind: SharedListKind): Promise<{ id: string }>;
  listRename(pid: string, id: string, name: string): Promise<void>;
  listDelete(pid: string, id: string): Promise<void>;
  listItems(pid: string, id: string): Promise<SharedItemsResponse>;
  listItemAdd(pid: string, id: string, title: string): Promise<{ id: string }>;
  listItemDelete(pid: string, id: string, itemId: string): Promise<void>;
  listItemTick(pid: string, id: string, itemId: string, done: boolean): Promise<void>;
  listItemAssign(pid: string, id: string, itemId: string): Promise<{ id: string }>;
  /** P1: her to-dos, and his assign and edits. */
  todos(pid: string, done?: boolean): Promise<OwnerTodosView>;
  assignTodo(pid: string, body: AssignTodoBody): Promise<{ id: string }>;
  updateTodo(pid: string, id: string, patch: AssignTodoPatch): Promise<void>;
  deleteTodo(pid: string, id: string): Promise<void>;
}

/** A route pattern with its `:params` filled (camelCase names too: `:itemId`). */
export function fillPath(pattern: string, params: Record<string, string> = {}): string {
  return pattern.replace(/:([a-zA-Z]+)/g, (_m, n: string) => encodeURIComponent(params[n] ?? ''));
}

export function createPeopleClient(opts: { fetch?: typeof fetch; base?: string; credentials?: CredentialStore } = {}): PeopleClient {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const base = opts.base ?? (typeof location === 'undefined' ? 'http://127.0.0.1' : location.origin);
  const creds = opts.credentials ?? defaultCredentialStore();

  async function call<T>(key: Key, init: { params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
    const [method, pattern] = PEOPLE_PATHS[key];
    let path: string = fillPath(pattern, init.params);
    const q = Object.entries(init.query ?? {}).filter(([, v]) => v !== undefined) as [string, string][];
    if (q.length) path += `?${new URLSearchParams(q).toString()}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') {
      headers['idempotency-key'] = newIdempotencyKey();
      const c = await creds.get().catch(() => null);
      if (c?.secret) headers[DEVICE_SECRET_HEADER] = c.secret;
    }
    let res: Response;
    try {
      res = await doFetch(new URL(path, base).toString(), { method, headers, credentials: 'same-origin', cache: 'no-store', ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    } catch (e) {
      throw new ApiError('network', e instanceof Error ? e.message : 'network error', 0);
    }
    const text = await res.text().catch(() => '');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError((err?.code ?? 'error') as ConstructorParameters<typeof ApiError>[0], err?.message ?? `${res.status}`, res.status);
    }
    return json as T;
  }
  const v = async (p: Promise<unknown>) => void (await p);
  return {
    list: () => call('list'),
    today: (pid, day) => call('today', { params: { pid }, query: { day } }),
    activity: (pid) => call('activity', { params: { pid } }),
    plan: (pid, day) => call('plan', { params: { pid, day } }),
    putPlan: (pid, day, body) => call('planPut', { params: { pid, day }, body }),
    applyTemplate: (pid, day, body) => call('planApply', { params: { pid, day }, body }),
    review: (pid, day) => call('review', { params: { pid, day } }),
    carry: (pid, day, steps, to) => v(call('carry', { params: { pid, day }, body: { steps, ...(to ? { to } : {}) } })),
    templates: (pid) => call('templates', { params: { pid } }),
    createTemplate: (pid, body) => call('templateCreate', { params: { pid }, body }),
    deleteTemplate: (pid, tid) => v(call('templateDelete', { params: { pid, tid } })),
    sleep: (pid, week) => call('sleep', { params: { pid }, query: { week } }),
    journal: (pid) => call('journal', { params: { pid } }),
    journalGet: (pid, id) => call('journalGet', { params: { pid, id } }),
    comment: (pid, id, text) => call('comment', { params: { pid, id }, body: { text } }),
    deleteComment: (pid, id, cid) => v(call('commentDelete', { params: { pid, id, cid } })),
    alerts: (pid) => call('alerts', { query: { with: pid } }),
    sendAlert: (body) => call('alertSend', { body }),
    seen: (id) => v(call('alertSeen', { params: { id } })),
    reply: (id, body) => v(call('alertReply', { params: { id }, body })),
    chat: (pid, before) => call('chat', { params: { pid }, query: { before } }),
    chatPhotoUrl: (pid, id) => PEOPLE_PATHS.chatPhoto[1].replace(':pid', encodeURIComponent(pid)).replace(':id', encodeURIComponent(id)),
    setChatPerDay: (pid, chatPerDay) => v(call('person', { params: { pid }, body: { chatPerDay } })),
    lists: (pid) => call('lists', { params: { pid } }),
    listCreate: (pid, name, kind) => call('listCreate', { params: { pid }, body: { name, kind } }),
    listRename: (pid, id, name) => v(call('listUpdate', { params: { pid, id }, body: { name } })),
    listDelete: (pid, id) => v(call('listDelete', { params: { pid, id } })),
    listItems: (pid, id) => call('listItems', { params: { pid, id } }),
    listItemAdd: (pid, id, title) => call('listItemAdd', { params: { pid, id }, body: { title } }),
    listItemDelete: (pid, id, itemId) => v(call('listItemDelete', { params: { pid, id, itemId } })),
    listItemTick: (pid, id, itemId, done) => v(call('listItemTick', { params: { pid, id, itemId }, body: { done } })),
    listItemAssign: (pid, id, itemId) => call('listItemAssign', { params: { pid, id, itemId }, body: {} }),
    todos: (pid, done) => call('todos', { params: { pid }, query: { done: done ? '1' : undefined } }),
    assignTodo: (pid, body) => call('todoAssign', { params: { pid }, body }),
    updateTodo: (pid, id, patch) => v(call('todoUpdate', { params: { pid, id }, body: patch })),
    deleteTodo: (pid, id) => v(call('todoDelete', { params: { pid, id } })),
  };
}

let shared: PeopleClient | null = null;
/** One client for the screen (tests pass their own). */
export function peopleClient(): PeopleClient {
  shared ??= createPeopleClient();
  return shared;
}
