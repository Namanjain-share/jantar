/**
 * Projects and todos (feature `todos`; a reminder is a todo with a time).
 * Device routes only, never on ctl.sock. Each calls `s.deps.life.todos`
 * (life/todos/module.ts).
 *
 * The pipeline has already checked control scope, the switch and a broken
 * life.db, and validated the strict bodies. Write replies carry ids only
 * (`lifeValue` turns a LifeResult into the value or the API error); the
 * audit records the target id and nothing else (`lifeAudit`). The pipeline
 * has counted every write against s.lifeWriteLimiter already.
 */
import type { ProjectBody, ProjectPatch, SnoozeBody, TodoBody, TodoDoneBody, TodoPatch, TodosQuery } from '@jantar/protocol';
import { lifeAudit, lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';

type Id = { id: string };
const OK = { ok: true as const };

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
};
