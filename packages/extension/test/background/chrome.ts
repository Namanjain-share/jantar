/**
 * The worker under test (WP-XS's own helper beside WP0's chrome fake): the
 * fake `chrome`, an in-memory KeyStore, a fake daemon behind `fetch` that
 * records every call, a virtual clock whose `sleep` returns at once (and
 * remembers how long it was asked to wait), and the worker's three
 * listeners added as the entry adds them.
 *
 *   const w = setupWorker();
 *   await w.meetTab(7);                                   // a Meet tab in a call
 *   const answer = await w.page(7, { t: 'shot' });
 *   expect(w.daemon.ops()).toEqual(['open', 'shot']);
 *   w.close();
 */
import { MEETING_MARKER, MEETING_T0 } from '@jantar/fixtures';
import { vi } from 'vitest';
import { createWorker, type Worker, type WorkerDeps } from '../../src/background/worker.js';
import { memoryKeyStore, type KeyStore, type Pairing } from '../../src/background/store.js';
import type { ToPage } from '../../src/shared/messages.js';
import { createChromeFake, type ChromeFake, type ChromeModel, type FakeTab } from '../helpers/chrome-fake.js';

/** A port nothing listens on (the fake daemon answers instead). */
export const PORT = 47123;
/** A synthetic extension key, shaped like the daemon's (43 base64url characters). */
export const KEY = 'TESTkey_0123456789-abcdefghijklmnopqrstuvwx';
export const PAIRED: Pairing = { port: PORT, key: KEY, pairedAt: '2026-10-30T09:00:00.000Z' };
export const MEET_URL = 'https://meet.google.com/abc-defg-hij';
export const MEET_CODE = 'abc-defg-hij';
export const TEAMS_URL = 'https://teams.cloud.microsoft/v2/';
/** A Jantar Life id (a ulid). */
export const ULID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
export const PROJECT_ID = '01JFZ8X8Y3T0V5G9WQK2M4N6QR';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Op = 'info' | 'claim' | 'open' | 'lines' | 'shot' | 'end' | 'readNext' | 'readResult';

/** What the fake daemon answers: a status and body, or 'down' (the connection is refused). */
export type Answer = { status: number; body?: unknown } | 'down';

export interface Sent {
  op: Op;
  method: string;
  url: string;
  path: string;
  clientId: string | null;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

const DEFAULTS: Record<Op, Answer> = {
  info: { status: 200, body: { projects: [] } },
  claim: { status: 200, body: { id: ULID, key: KEY } },
  open: { status: 200, body: { id: ULID } },
  lines: { status: 200, body: { ok: true } },
  shot: { status: 200, body: { id: ULID } },
  end: { status: 200, body: { ok: true } },
  // v0.8: no post to read; a result taken.
  readNext: { status: 200, body: { job: null } },
  readResult: { status: 200, body: { ok: true } },
};

/** An error body as the daemon writes it. */
export const daemonError = (status: number, message: string): Answer => ({ status, body: { error: { code: 'x', message } } });

function opOf(path: string): { op: Op; clientId: string | null } | null {
  if (path === '/v1/ext/info') return { op: 'info', clientId: null };
  if (path === '/v1/ext/pair') return { op: 'claim', clientId: null };
  // v0.8: a read result's lease id rides where a meeting's client id does.
  if (path === '/v1/ext/reads/next') return { op: 'readNext', clientId: null };
  const read = /^\/v1\/ext\/reads\/([^/]+)$/.exec(path);
  if (read?.[1]) return { op: 'readResult', clientId: read[1] };
  const m = /^\/v1\/ext\/meetings\/([^/]+)(?:\/(lines|shots|end))?$/.exec(path);
  if (!m?.[1]) return null;
  const tail = m[2];
  return { op: tail === 'lines' ? 'lines' : tail === 'shots' ? 'shot' : tail === 'end' ? 'end' : 'open', clientId: m[1] };
}

export interface FakeDaemon {
  fetch: typeof fetch;
  calls: Sent[];
  /** Answer the next calls of `op` with these, in order; the last one repeats. */
  on(op: Op, ...answers: Answer[]): void;
  /** Hold the next call of `op` until `release(answer)`. */
  hold(op: Op): { release(answer?: Answer): void; started: Promise<void> };
  ops(): Op[];
  of(op: Op): Sent[];
}

export function fakeDaemon(): FakeDaemon {
  const calls: Sent[] = [];
  const queued = new Map<Op, Answer[]>();
  const held = new Map<Op, { gate: Promise<Answer | undefined>; started: () => void }>();
  const answerFor = (op: Op): Answer => {
    const q = queued.get(op);
    if (!q || q.length === 0) return DEFAULTS[op];
    return q.length > 1 ? (q.shift() as Answer) : (q[0] as Answer);
  };
  const fetchFn = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const route = opOf(url.pathname);
    if (!route) throw new TypeError('Failed to fetch');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({
      op: route.op,
      method: init.method ?? 'GET',
      url: url.href,
      path: url.pathname,
      clientId: route.clientId,
      headers,
      credentials: init.credentials,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    let answer = answerFor(route.op);
    const hold = held.get(route.op);
    if (hold) {
      held.delete(route.op);
      hold.started();
      answer = (await hold.gate) ?? answer;
    }
    if (answer === 'down') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { 'content-type': 'application/json' } });
  };
  return {
    fetch: fetchFn as typeof fetch,
    calls,
    on(op, ...answers) {
      queued.set(op, [...answers]);
    },
    hold(op) {
      let release!: (a?: Answer) => void;
      let started!: () => void;
      const gate = new Promise<Answer | undefined>((r) => (release = r));
      const begun = new Promise<void>((r) => (started = r));
      held.set(op, { gate, started });
      return { release: (a?: Answer) => release(a), started: begun };
    },
    ops: () => calls.map((c) => c.op),
    of: (op) => calls.filter((c) => c.op === op),
  };
}

/** A clock for the worker: `sleep` returns at once and moves the clock on. */
export interface VirtualClock {
  t: number;
  slept: number[];
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function virtualClock(t0 = MEETING_T0): VirtualClock {
  const c: VirtualClock = {
    t: t0,
    slept: [],
    now: () => c.t,
    sleep: async (ms) => {
      c.slept.push(ms);
      c.t += ms;
    },
  };
  return c;
}

/** Every console call during a test, so a test can say no caption text, name, title, key or image went there (MP7). */
export function watchConsole(): { text(): string } {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  return { text: () => spies.flatMap((s) => s.mock.calls.flat()).map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join('\n') };
}

export const markerIn = (text: string) => text.includes(MEETING_MARKER);

export interface WorkerUnderTest {
  chrome: ChromeFake;
  model: ChromeModel;
  keys: KeyStore;
  daemon: FakeDaemon;
  clock: VirtualClock;
  worker: Worker;
  /** A message from the page in `tabId` (the content script). */
  page(tabId: number, msg: unknown): Promise<unknown>;
  /** A message from the popup page. */
  popup(msg: unknown): Promise<unknown>;
  /** A meeting tab whose page answers `hide` (and records every message); then its `call` in a call. */
  meetTab(tabId: number, opts?: { url?: string; windowId?: number; active?: boolean; title?: string; inCall?: boolean; callKey?: string | null }): Promise<FakeTab>;
  /** What the page in `tabId` was sent, in order. */
  toPage(tabId: number): ToPage[];
  /** The tab's record in storage.session. */
  tabState(tabId: number): Record<string, unknown> | undefined;
  close(): void;
}

export function setupWorker(opts: { paired?: boolean; deps?: Partial<WorkerDeps> } = {}): WorkerUnderTest {
  const { chrome, model } = createChromeFake();
  const keys = memoryKeyStore(opts.paired === false ? null : PAIRED);
  const daemon = fakeDaemon();
  const clock = virtualClock();
  const worker = createWorker({ keys, fetch: daemon.fetch, now: clock.now, sleep: clock.sleep, ...opts.deps });
  // As the entry adds them (src/background/index.ts).
  chrome.runtime.onMessage.addListener(worker.onMessage as never);
  chrome.commands.onCommand.addListener(worker.onCommand as never);
  chrome.tabs.onRemoved.addListener(worker.onRemoved as never);
  chrome.alarms.onAlarm.addListener(worker.onAlarm as never);
  chrome.runtime.onStartup.addListener(worker.onStartup as never);
  chrome.runtime.onInstalled.addListener(worker.onStartup as never);

  const page = (tabId: number, msg: unknown) => chrome.runtime.onMessage.dispatch(msg, model.pageSender(tabId));
  return {
    chrome,
    model,
    keys,
    daemon,
    clock,
    worker,
    page,
    popup: (msg) => chrome.runtime.onMessage.dispatch(msg, model.extensionSender('popup.html')),
    async meetTab(tabId, o = {}) {
      const url = o.url ?? MEET_URL;
      const tab = model.addTab({ id: tabId, windowId: o.windowId ?? 1, url, active: o.active ?? true });
      model.onTabMessage(tabId, (msg) => ((msg as ToPage).t === 'hide' ? { ok: true } : undefined));
      const site = url.includes('meet.google.com') ? 'meet' : 'teams';
      await page(tabId, { t: 'call', site, inCall: o.inCall ?? true, callKey: o.callKey === undefined ? (site === 'meet' ? MEET_CODE : null) : o.callKey, title: o.title ?? 'Weekly sync' });
      return tab;
    },
    toPage: (tabId) => model.sentTo(tabId) as ToPage[],
    tabState: (tabId) => model.session.get(`tab:${tabId}`) as Record<string, unknown> | undefined,
    close: () => model.uninstall(),
  };
}
