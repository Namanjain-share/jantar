/**
 * v0.12 People (P3, spec 7.1, 7.3): her thread, and the deps her run gets.
 *
 * - `threadOf(actor)`: `p:<pid>` for her, `''` for everyone else. Every
 *   query in chat/store.ts names the thread, so a turn, photo, change or
 *   card of the other thread is 404.
 * - `personChatDeps(base, pc)`: what her run and her taps see. Life is her
 *   space and nothing else: her to-dos and projects (through the People
 *   module's rules: his assigned items refuse an edit or a delete), her
 *   weights; every other Life module, Intel, Meetings, the board, usage and
 *   pushes are denied (any call throws, so a tool listed by mistake fails
 *   closed, spec 7.3). She never reaches his space, his switches or his
 *   sessions, whatever the tool list says.
 */
import type { ProjectBody, ProjectPatch, SnoozePreset, TodoBody, TodoPatch, TodosQuery, WeightBody } from '@jantar/protocol';
import { chatThreadOf } from '@jantar/protocol/people';
import type { Actor, LifeResult, LifeService, TodosModule } from '../contracts.js';
import type { PeopleModule } from '../life/people/module.js';
import type { ChatDeps } from './types.js';

/** Her run's person: her id and the People module (her space's rules, her plan, sleep and alerts). */
export interface PersonChat {
  pid: string;
  people: PeopleModule;
}

/** The thread an actor writes and reads: hers is `p:<pid>`, every other actor's is the owner's `''`. */
export function threadOf(actor: Actor): string {
  return actor.kind === 'person' ? chatThreadOf(actor.personId) : '';
}

/** The person a thread belongs to, or null for the owner's. */
export function personOfThread(thread: string): string | null {
  return thread.startsWith('p:') ? thread.slice(2) : null;
}

const CLOSED: Extract<LifeResult, { ok: false }> = { ok: false, code: 'life_unavailable', reason: 'Life is not open right now. Try again in a moment.' };

/** Anything she can't reach: every member is a function that throws (fails closed). */
function denied<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_t, key) {
      if (key === 'then') return undefined;
      return () => {
        throw new Error(`not_in_her_space:${what}`);
      };
    },
  });
}

/** Her to-dos and projects, through the People module's rules (spec 3.3). */
function herTodos(pc: PersonChat): TodosModule {
  const { pid, people } = pc;
  const space = () => people.space;
  const inner = (): TodosModule | null => {
    const sp = people.space;
    return sp ? sp.todosOf(pid) : null;
  };
  const wrote = (r: LifeResult<unknown>) => {
    if (r.ok) {
      people.ticks.bump(pid, 'life');
      if (people.agreement(pid)?.see.todos) people.ownerChanged();
    }
  };
  const t: Partial<TodosModule> = {
    name: 'todos',
    listProjects: () => inner()?.listProjects() ?? CLOSED,
    createProject: (body: ProjectBody, actor: Actor) => {
      const m = inner();
      if (!m) return CLOSED;
      const { folder: _no, ...rest } = body;
      const r = m.createProject(rest, actor);
      wrote(r);
      return r;
    },
    updateProject: (id: string, patch: ProjectPatch, actor: Actor) => {
      const m = inner();
      if (!m) return CLOSED;
      const { folder: _no, ...rest } = patch;
      const r = m.updateProject(id, rest, actor);
      wrote(r);
      return r;
    },
    removeProject: (id: string, actor: Actor) => {
      const m = inner();
      if (!m) return CLOSED;
      const r = m.removeProject(id, actor);
      wrote(r);
      return r;
    },
    listTodos: (q: TodosQuery) => space()?.herList(pid, q) ?? CLOSED,
    createTodo: (body: TodoBody, actor: Actor) => space()?.herCreate(pid, body, actor) ?? CLOSED,
    updateTodo: (id: string, patch: TodoPatch, actor: Actor) => space()?.herUpdate(pid, id, patch, actor) ?? CLOSED,
    setDone: (id: string, done: boolean, actor: Actor) => space()?.herDone(pid, id, done, undefined, actor) ?? CLOSED,
    snooze: (id: string, preset: SnoozePreset, actor: Actor) => space()?.herSnooze(pid, id, preset, actor) ?? CLOSED,
    removeTodo: (id: string, actor: Actor) => space()?.herDelete(pid, id, actor) ?? CLOSED,
  };
  return new Proxy(t as TodosModule, {
    get(target, key) {
      if (key in target) return (target as unknown as Record<string | symbol, unknown>)[key];
      if (key === 'then') return undefined;
      return () => {
        throw new Error('not_in_her_space:todos');
      };
    },
  });
}

/** Her weights only (her food module, if any, is not her assistant's: spec 7.2 lists food only with the module, and P1 serves none). */
function herWeights(pc: PersonChat): LifeService['food'] {
  const { pid, people } = pc;
  const w: Record<string, unknown> = {
    weightOn: (day: string): LifeResult<number | null> => {
      const sp = people.space;
      if (!sp) return CLOSED;
      const hit = sp.weights(pid).weights.find((x) => x.day === day);
      return { ok: true, value: hit ? hit.kg : null };
    },
    setWeight: (day: string, body: WeightBody, _actor: Actor): LifeResult => people.space?.herWeightSet(pid, day, body) ?? CLOSED,
    removeWeight: (day: string, _actor: Actor): LifeResult => people.space?.herWeightDelete(pid, day) ?? CLOSED,
  };
  return new Proxy(w as unknown as LifeService['food'], {
    get(target, key) {
      if (key in target) return (target as unknown as Record<string | symbol, unknown>)[key];
      if (key === 'then') return undefined;
      return () => {
        throw new Error('not_in_her_space:food');
      };
    },
  });
}

/** P4: her shared space's cafés, as her; nothing else of the owner's places. */
function herPlaces(base: ChatDeps, pc: PersonChat): LifeService['places'] {
  let space: string | null = null;
  try {
    space = pc.people.person(pc.pid)?.sharedSpace ?? null;
  } catch {
    space = null;
  }
  return space ? base.life.places.inShared(space, pc.pid) : denied<LifeService['places']>('places');
}

/** The deps her run and her taps get: her space, nothing of his (spec 7.3). */
export function personChatDeps(base: ChatDeps, pc: PersonChat): ChatDeps {
  const life = {
    status: () => base.life.status(),
    broken: () => base.life.broken(),
    today: () => {
      throw new Error('not_in_her_space:today');
    },
    todos: herTodos(pc),
    food: herWeights(pc),
    medicines: denied<LifeService['medicines']>('medicines'),
    // P4: the cafés of her shared space, as her (her visits are hers; his can't be changed).
    places: herPlaces(base, pc),
    finance: denied<LifeService['finance']>('finance'),
    posts: denied<LifeService['posts']>('posts'),
    people: pc.people,
  } as unknown as LifeService;
  return {
    life,
    intel: denied<ChatDeps['intel']>('intel'),
    meetings: denied<ChatDeps['meetings']>('meetings'),
    board: denied<ChatDeps['board']>('board'),
    usage: denied<ChatDeps['usage']>('usage'),
    ccwLegacy: denied<ChatDeps['ccwLegacy']>('ccwLegacy'),
    notifiers: [],
    person: pc,
  };
}
