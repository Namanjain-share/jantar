/**
 * Chat's parts on a test context: Life's real six modules on a life.db in a
 * temp dir (every part on, UTC, rupees), chat.db in memory, a small Intel
 * shelf and a meetings library held in maps, and a board whose state the
 * test sets (sessions, waiting prompts, accounts). The clock is a FakeClock
 * at 10:00 UTC on Mon 2 Nov 2026. Every value synthetic.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSession } from '@jantar/fixtures';
import {
  SettingsSchema,
  type IntelItem,
  type Meeting,
  type MeetingDetail,
  type PendingRequest,
  type Session,
  type Settings,
  type State,
  type TranscriptItem,
} from '@jantar/protocol';
import type { Actor, IntelService, LifeService, MeetingsService } from '../../src/contracts.js';
import { V04_LIMITS } from '../../src/api/services.js';
import { SlidingWindowLimiter } from '../../src/auth/rate-limit.js';
import { openChatDb } from '../../src/chat/db.js';
import { ChatStore } from '../../src/chat/store.js';
import { TurnTools, toolsFor } from '../../src/chat/tools.js';
import type { ChatDeps } from '../../src/chat/types.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { buildLifeService } from '../../src/life/service.js';
import { meetingTodoNotes } from '../../src/meetings/common.js';
import { makeFakes } from '../api/fakes.js';

export const NOW = '2026-11-02T10:00:00.000Z';
export const TODAY = '2026-11-02';
export const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
export const TABLET: Actor = { kind: 'device', deviceId: 'dev-tablet', scopes: ['read', 'control'] };

export const LIFE_ON = { todos: true, medicines: true, food: true, places: true, finance: true, posts: true, timezone: 'UTC', currency: 'INR' };

export function chatSettings(over: Record<string, unknown> = {}): Settings {
  const base: Record<string, unknown> = { ask: { enabled: true }, life: LIFE_ON, intel: { enabled: true }, meetings: { enabled: true } };
  for (const [k, v] of Object.entries(over)) {
    const prev = base[k];
    base[k] = typeof prev === 'object' && prev !== null && typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...prev, ...v } : v;
  }
  return SettingsSchema.parse(base);
}

/** A tiny Intel shelf: what Chat calls. */
export class FakeIntel implements Pick<IntelService, 'list' | 'get' | 'read' | 'remove' | 'reread' | 'jobs'> {
  readonly items = new Map<string, IntelItem>();
  readonly reads: Array<{ text: string; via: string }> = [];
  rereads: string[] = [];
  private n = 0;
  add(over: Partial<IntelItem> = {}): IntelItem {
    this.n += 1;
    const id = over.id ?? `cap-${this.n}`;
    const item: IntelItem = { id, source: 'captures', at: '2026-11-01T09:00:00.000Z', title: `A saved page ${this.n}`, tags: ['synthetic'], fields: [], ...over };
    this.items.set(id, item);
    return item;
  }
  list: IntelService['list'] = (q) => ({ items: [...this.items.values()].filter((i) => !q.q || i.title.includes(q.q)).map((i) => ({ id: i.id, source: i.source, at: i.at, title: i.title, tags: i.tags })), next: null, total: this.items.size } as unknown as ReturnType<IntelService['list']>);
  get: IntelService['get'] = (id) => this.items.get(id) ?? null;
  read: IntelService['read'] = async (body, from) => {
    this.reads.push({ text: body.text, via: from.via });
    const existing = [...this.items.values()].find((i) => i.url === body.text);
    if (existing) return { ok: true, value: { id: existing.id, duplicate: true, queued: false, message: 'Already saved.' } };
    const item = this.add({ url: body.text, title: 'A new link' });
    return { ok: true, value: { id: item.id, duplicate: false, queued: true, message: 'Saved.' } };
  };
  remove: IntelService['remove'] = async (id) => (this.items.delete(id) ? { ok: true, value: true } : { ok: false, code: 'not_found', reason: 'No such item.' });
  reread: IntelService['reread'] = (id) => {
    this.rereads.push(id);
    return this.items.has(id) ? { ok: true, value: { id } } : { ok: false, code: 'not_found', reason: 'No such item.' };
  };
  jobs: IntelService['jobs'] = () => ({ jobs: [], available: true } as unknown as ReturnType<IntelService['jobs']>);
}

/** A meetings library in a map, with action items that become todos through Life (marked as the meeting's words). */
export function fakeMeetings(life: () => LifeService): Pick<MeetingsService, 'library' | 'summaries' | 'status' | 'broken'> & { details: Map<string, MeetingDetail>; requested: string[] } {
  const details = new Map<string, MeetingDetail>();
  const requested: string[] = [];
  const library = notBuilt<MeetingsService['library']>('library', {
    list: (q) => ({ ok: true, value: { meetings: [...details.values()].map((d) => d.meeting).filter((m) => !q.q || m.name.includes(q.q)), next: null, running: null } }),
    get: (id) => {
      const d = details.get(id);
      return d ? { ok: true, value: structuredClone(d) } : { ok: false, code: 'not_found', reason: 'No such meeting.' };
    },
    update: (id, patch) => {
      const d = details.get(id);
      if (!d) return { ok: false, code: 'not_found', reason: 'No such meeting.' };
      const m: Meeting = { ...d.meeting };
      if (patch.name !== undefined) m.name = patch.name;
      if (patch.autoTodos !== undefined) m.autoTodos = patch.autoTodos;
      if (patch.people === null) delete m.people;
      else if (patch.people !== undefined) m.people = patch.people;
      if (patch.projectId === null) delete m.projectId;
      else if (patch.projectId !== undefined) m.projectId = patch.projectId;
      d.meeting = m;
      return { ok: true, value: true };
    },
    remove: async (id) => (details.delete(id) ? { ok: true, value: true } : { ok: false, code: 'not_found', reason: 'No such meeting.' }),
  });
  const summaries = notBuilt<MeetingsService['summaries']>('summaries', {
    request: (id) => {
      requested.push(id);
      return { ok: true, value: true };
    },
    addTodo: (id, n, actor) => {
      const d = details.get(id);
      const item = d?.summary.items[n];
      if (!d || !item) return { ok: false, code: 'not_found', reason: 'No such item.' };
      // As meetings/summary.ts makes it: the meeting's name in the notes, marked as the meeting's words.
      const r = life().todos.createTodo({ title: item.title, notes: meetingTodoNotes(d.meeting.name, d.meeting.startedAt.slice(0, 10)) }, actor, { from: 'meeting' });
      if (r.ok) item.todoId = r.value.id;
      return r;
    },
    removeTodo: (id, n, actor) => {
      const item = details.get(id)?.summary.items[n];
      if (!item?.todoId) return { ok: false, code: 'not_found', reason: 'No such item.' };
      const r = life().todos.removeTodo(item.todoId, actor);
      delete item.todoId;
      return r;
    },
  });
  return { library, summaries, status: () => ({ on: true, open: true }) as ReturnType<MeetingsService['status']>, broken: () => null, details, requested };
}

export interface ChatRig {
  dir: string;
  ctx: TestContext;
  life: LifeService;
  store: ChatStore;
  intel: FakeIntel;
  meetings: ReturnType<typeof fakeMeetings>;
  deps: ChatDeps;
  /** The board: what sessions_find and session_get read. */
  board: { sessions: Record<string, Session>; pending: Record<string, PendingRequest>; transcript: TranscriptItem[] };
  /** Life's per-device write limit (240 a minute), as daemon.ts shares it between the API and Chat. */
  lifeWrites: SlidingWindowLimiter;
  /** A turn's tools (every part on unless the settings say otherwise). */
  turn(o?: { message?: string; actor?: Actor; id?: string }): { tools: TurnTools; turnId: string };
  close(): Promise<void>;
}

let seq = 0;
export function turnId(): string {
  seq += 1;
  return `01JTURN${String(seq).padStart(19, '0')}`;
}

export async function chatRig(over: Record<string, unknown> = {}): Promise<ChatRig> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-chat-')));
  const ctx = createTestContext({ home: dir, settings: chatSettings(over) });
  ctx.clock.set(NOW);
  const f = makeFakes(ctx);
  const life = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC', send: async () => ({ delivered: 0, failed: 0 }) });
  await life.start();
  const opened = openChatDb(':memory:');
  if (!opened.ok) throw new Error(opened.reason);
  const store = new ChatStore(opened.db);
  const intel = new FakeIntel();
  const meetings = fakeMeetings(() => life);
  const board: ChatRig['board'] = { sessions: {}, pending: {}, transcript: [] };
  const lifeWrites = new SlidingWindowLimiter({ ...V04_LIMITS.lifeWrite, clock: ctx.clock });
  const deps: ChatDeps = {
    life,
    intel,
    meetings,
    board: {
      state: () => ({ ...(ctx.store.getState() as State), sessions: board.sessions, pending: board.pending }),
      page: async (_sid, o) => ({ items: board.transcript.slice(0, o.limit), nextBefore: null }),
    },
    usage: f.usage,
    ccwLegacy: f.ccwLegacy,
    notifiers: f.notifiers,
  };
  const rig: ChatRig = {
    dir,
    ctx,
    life,
    store,
    intel,
    meetings,
    deps,
    board,
    lifeWrites,
    turn(o = {}) {
      const id = o.id ?? turnId();
      if (!store.turn(id)) store.insertTurn({ id, at: ctx.clock.iso(), via: 'phone', text: o.message ?? '', photos: [], state: 'running', tainted: false, refused: 0, by: 'device:dev-phone' });
      const tools = new TurnTools({
        ctx,
        deps,
        store,
        turnId: id,
        actor: o.actor ?? PHONE,
        actorName: 'device:dev-phone',
        message: o.message ?? '',
        tools: toolsFor(ctx.settings.get(), deps),
        lifeWrites,
        live: () => true,
      });
      return { tools, turnId: id };
    },
    async close() {
      await life.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return rig;
}

/** A session on the board with paths that must never reach the model. */
export function boardSession(over: Partial<Session> = {}): Session {
  return makeSession({ sid: '22222222-2222-4222-8222-222222222222', cwd: '/synthetic/home/work/secret-client', configDir: '/synthetic/home/.claude-x', transcriptPath: '/synthetic/home/.claude/projects/x.jsonl', paneId: 'pane-9', tty: '/dev/ttys009', ...over });
}

/** The id in a tool's answer: "(id …)". */
export function idIn(text: string): string {
  const m = /\(id ([^)\s]+)\)/.exec(text);
  if (!m?.[1]) throw new Error(`no id in: ${text}`);
  return m[1];
}
