/**
 * 0.13.0 Work's test fixtures: Life status with Work on or off, a project
 * hub, and `api.request` answering Work's routes by path. Every name here
 * is made up (Acme, Northwind, Globex; W42).
 */
import { vi } from 'vitest';
import type { LifeModule, LifeStatus, ProjectView, Todo } from '@jantar/protocol';
import type { ProjectHub, SearchResponse } from '@jantar/protocol/work';
import { ApiError, type Api, type ApiRequest, type ApiRoute } from '../src/lib/api.js';

/** Life status with these modules on (the rest off); `work` needs `todos` on the Mac, as here. */
export function lifeStatus(on: Partial<Record<LifeModule, boolean>> = {}, over: Partial<LifeStatus> = {}): LifeStatus {
  return {
    open: true,
    timezone: 'UTC',
    today: '2026-01-15',
    currency: 'INR',
    lockScreenDetails: false,
    modules: { todos: false, medicines: false, food: false, places: false, finance: false, posts: false, work: false, ...on },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
    ...over,
  };
}

/** Work on (with Todos). */
export const WORK_ON = (): LifeStatus => lifeStatus({ todos: true, work: true });

export const IDS = {
  acme: '01JWRKPRJ0000000000000ACME',
  northwind: '01JWRKPRJ00000000000NRTHWD',
  globex: '01JWRKPRJ00000000000GL0BEX',
  client: '01JWRKC11ENT00000000000ACM',
  deal: '01JWRKDEA100000000000000AC',
  todo1: '01JWRKT0D0000000000000000A',
  todo2: '01JWRKT0D0000000000000000B',
  done1: '01JWRKT0D0000000000000000C',
  meeting: '01JWRKMEET00000000000000KC',
} as const;

const AT = '2026-01-14T10:00:00.000Z';

export function project(id: string, over: Partial<ProjectView> = {}): ProjectView {
  return { id, name: 'Site rebuild', status: 'active', open: 0, overdue: 0, createdAt: AT, updatedAt: AT, ...over };
}

export function todo(id: string, over: Partial<Todo> = {}): Todo {
  return { id, title: 'Send wireframes', priority: 'normal', createdAt: AT, updatedAt: AT, ...over };
}

export function hub(over: Partial<ProjectHub> = {}): ProjectHub {
  return {
    project: project(IDS.acme, { folder: '/Users/example/Desktop/work/client/acme', open: 2, overdue: 1, notes: 'Wants the store live before the festival.' }),
    open: [todo(IDS.todo1, { title: 'Fix staging login', due: { day: '2026-01-12' }, projectId: IDS.acme }), todo(IDS.todo2, { title: 'Send wireframes', due: { day: '2026-01-15', time: '15:00' }, projectId: IDS.acme })],
    doneThisWeek: 5,
    recentDone: [todo(IDS.done1, { title: 'Kickoff notes', doneAt: AT, projectId: IDS.acme })],
    health: { overdue: 1, nextDue: { todoId: IDS.todo1, due: { day: '2026-01-12' } }, doneByWeek: [0, 0, 0, 0, 0, 0, 2, 5] },
    ...over,
  };
}

type Answer = (init: ApiRequest) => unknown;

/**
 * `api.request` for Work's routes: each answer by "METHOD /path/pattern" (a function gets the request);
 * any other route answers the daemon's 501. The mock records every call.
 */
export function workRequest(answers: Record<string, unknown | Answer>) {
  const fn = vi.fn(async (route: ApiRoute, init: ApiRequest = {}): Promise<unknown> => {
    const key = `${route.method} ${route.path}`;
    if (!(key in answers)) throw new ApiError('not_implemented', 'not built yet', 501);
    const a = answers[key];
    const v = typeof a === 'function' ? (a as Answer)(init) : a;
    if (v instanceof Error) throw v;
    return v;
  });
  // The mock answers whatever the route's reply is; Api['request'] is generic in it.
  return fn as typeof fn & Api['request'];
}

export const NO_RESULTS: SearchResponse = { groups: [] };
