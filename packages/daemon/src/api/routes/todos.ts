/**
 * Projects and todos (feature `todos`; a reminder is a todo with a time).
 * Device routes only, never on ctl.sock. Each calls `s.deps.life.todos`
 * (life/todos/module.ts).
 *
 * The one exception (v0.5.3): folderTodos and folderTodoCreate, ctl.sock
 * only (localOnly: TCP answers 403 before any handler), for `jantar mcp`:
 * the open todos of the project linked to a folder, and a todo added to it.
 * The folder is the caller's word; the module maps it to a project (the
 * deepest folder, a home-, `/Users`- or `/`-linked project only for exactly
 * that folder). Claude sessions add at most V053_LIMITS.folderTodo an hour
 * (s.folderTodoLimiter, every ctl.sock peer being the one actor `cli`),
 * counted before the module answers, on top of the Life write limit.
 *
 * The pipeline has already checked control scope, the switch and a broken
 * life.db, and validated the strict bodies. Write replies carry ids only
 * (`lifeValue` turns a LifeResult into the value or the API error); the
 * audit records the target id and nothing else (`lifeAudit`). The pipeline
 * has counted every write against s.lifeWriteLimiter already.
 */
import type { FolderTodoBody, FolderTodosQuery, FolderTodosResponse, ProjectBody, ProjectPatch, SnoozeBody, TodoBody, TodoDoneBody, TodoPatch, TodosQuery } from '@jantar/protocol';
import type { LifeResult } from '../../contracts.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { lifeAudit, lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';
import { V053_LIMITS } from '../services.js';

type Id = { id: string };
const OK = { ok: true as const };

/** The folder todos' hourly cap, as a refusal says it. */
export const FOLDER_TODOS_LIMITED = `Claude sessions added ${V053_LIMITS.folderTodo.limit} todos this hour. Add more on the phone, or try again later.`;

export const TODOS_ROUTE_IMPLS: RouteTable = {
  projectsList: {
    handle: (_c: Call, s) => lifeValue(s.deps.life.todos.listProjects()),
  },
  projectCreate: {
    handle: (c: Call<Id, unknown, ProjectBody>, s) => lifeValue(s.deps.life.todos.createProject(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  projectUpdate: {
    handle: (c: Call<Id, unknown, ProjectPatch>, s) => {
      lifeValue(s.deps.life.todos.updateProject(c.params.id, c.body, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },
  projectDelete: {
    handle: (c: Call<Id>, s) => {
      lifeValue(s.deps.life.todos.removeProject(c.params.id, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },

  todosList: {
    handle: (c: Call<Id, TodosQuery>, s) => lifeValue(s.deps.life.todos.listTodos(c.query)),
  },
  todoCreate: {
    handle: (c: Call<Id, unknown, TodoBody>, s) => lifeValue(s.deps.life.todos.createTodo(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  todoUpdate: {
    handle: (c: Call<Id, unknown, TodoPatch>, s) => {
      lifeValue(s.deps.life.todos.updateTodo(c.params.id, c.body, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },
  todoDone: {
    handle: (c: Call<Id, unknown, TodoDoneBody>, s) => {
      lifeValue(s.deps.life.todos.setDone(c.params.id, c.body.done, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },
  todoSnooze: {
    handle: (c: Call<Id, unknown, SnoozeBody>, s) => {
      lifeValue(s.deps.life.todos.snooze(c.params.id, c.body.preset, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },
  todoDelete: {
    handle: (c: Call<Id>, s) => {
      lifeValue(s.deps.life.todos.removeTodo(c.params.id, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },

  // v0.5.3, ctl.sock only.
  folderTodos: {
    handle: (c: Call<Id, FolderTodosQuery>, s) => {
      // Life not open yet answers every call with a refusal (life/service.ts closedModule).
      const r = s.deps.life.todos.forFolder(c.query.folder) as FolderTodosResponse | LifeResult<never>;
      return 'ok' in r ? lifeValue(r) : r;
    },
  },
  folderTodoCreate: {
    handle: (c: Call<Id, unknown, FolderTodoBody>, s) => {
      const limited = s.folderTodoLimiter.hit(actorName(c.auth));
      if (!limited.ok) throw new ApiError('rate_limited', FOLDER_TODOS_LIMITED, { 'retry-after': String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) });
      return lifeValue(s.deps.life.todos.createInFolder(c.body, needActor(c.auth)));
    },
    audit: lifeAudit,
  },
};
