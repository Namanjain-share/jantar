/**
 * Synthetic fixtures and a fake API for component tests. Every name, folder
 * and address here is made up.
 */
import { render } from '@testing-library/react';
import { beforeAll, vi } from 'vitest';
import {
  NO_FEATURES,
  PROTOCOL_VERSION,
  emptyState,
  type Account,
  type Alert,
  type DaemonEvent,
  type Features,
  type WsServerMessage,
  type PendingRequest,
  type SendJob,
  type Session,
  type State,
} from '@jantar/protocol';
import { App } from '../src/App.js';
import { ApiError, type Api } from '../src/lib/api.js';
import type { Connection } from '../src/lib/connection.js';
import type { PushEnv } from '../src/lib/push.js';
import { createRouter, memoryHistory } from '../src/lib/router.js';
import { createAppStore, type AppStore } from '../src/store.js';
import { createToastStore } from '../src/ui/context.js';

export const T0 = '2026-01-15T10:00:00.000Z';
export const NOW = Date.parse('2026-01-15T10:05:00.000Z');

/** The places Shell loads on first visit (React.lazy), by route name. */
const LAZY_PLACES = {
  files: () => import('../src/ui/screens/files/FilesPlace.js'),
  new: () => import('../src/ui/screens/new/NewSession.js'),
  today: () => import('../src/ui/screens/life/today/Today.js'),
  todos: () => import('../src/ui/screens/life/todos/Todos.js'),
  meds: () => import('../src/ui/screens/life/meds/Meds.js'),
  food: () => import('../src/ui/screens/life/food/Food.js'),
  places: () => import('../src/ui/screens/life/places/Places.js'),
  money: () => import('../src/ui/screens/life/money/Money.js'),
  intel: () => import('../src/ui/screens/intel/Intel.js'),
  meetings: () => import('../src/ui/screens/meetings/Meetings.js'),
  ask: () => import('../src/ui/screens/ask/Ask.js'),
};

/**
 * Load these lazy places before the file's tests run. A place's first import
 * (transform and evaluation) takes a few hundred ms here and can take
 * seconds on a busy runner, more than a findBy waits for the screen; done in
 * beforeAll it has the hook's own time, and every test's wait is for the
 * screen alone. Call it at the top of a test file.
 */
export function preloadPlaces(...names: Array<keyof typeof LAZY_PLACES>): void {
  beforeAll(async () => {
    await Promise.all(names.map((name) => LAZY_PLACES[name]()));
  });
}

export const iso = (msFromT0: number) => new Date(Date.parse(T0) + msFromT0).toISOString();

export function session(sid: string, over: Partial<Session> = {}): Session {
  return {
    sid,
    pid: 41001,
    procStart: 'Thu Jan 15 09:00:00 2026',
    account: 1,
    configDir: '/synthetic/home/.claude',
    cwd: `/synthetic/home/work/${sid}`,
    folder: sid,
    name: `task ${sid}`,
    entrypoint: 'cli',
    status: 'working',
    statusSource: 'session-file',
    statusSince: T0,
    subagentsRunning: 0,
    ...over,
  };
}

let pendingN = 0;
export function pending(sid: string, over: Partial<PendingRequest> = {}): PendingRequest {
  pendingN += 1;
  const id = `01JTESTPENDING${String(pendingN).padStart(4, '0')}abcdefghijklmnop`;
  return {
    id,
    sid,
    kind: 'permission',
    tool: 'Bash',
    input: { command: 'npm test', description: 'Run the tests' },
    suggestions: [],
    correlationKey: `${sid}|Bash|{}`,
    createdAt: iso(60_000),
    settleUntil: iso(63_000),
    state: 'open',
    ...over,
  };
}

export function account(id: number, over: Partial<Account> = {}): Account {
  return {
    id,
    emailMasked: `u***@e***.com`,
    isDefaultLogin: false,
    disabled: false,
    held: false,
    usageStatus: 'ok',
    windows: [
      { kind: 'five_hour', pct: 42, resetsAt: iso(2 * 3600_000) },
      { kind: 'seven_day', pct: 18, resetsAt: iso(3 * 86400_000) },
    ],
    ...over,
  };
}

export function sendJob(id: string, sid: string, over: Partial<SendJob> = {}): SendJob {
  return {
    id,
    sid,
    textHash: 'sha256:synthetic',
    textLength: 12,
    stage: 'queued',
    attempts: 0,
    createdAt: iso(120_000),
    updatedAt: iso(120_000),
    ...over,
  };
}

export function alert(id: string, over: Partial<Alert> = {}): Alert {
  return {
    id,
    ts: iso(30_000),
    kind: 'blocked',
    label: 'Working · web-app · fix login',
    what: 'A tool call was blocked',
    ...over,
  };
}

export function stateWith(parts: {
  sessions?: Session[];
  pending?: PendingRequest[];
  accounts?: Account[];
  alerts?: Alert[];
  sends?: SendJob[];
  seq?: number;
  activeAccount?: number | null;
  /** Switches to turn on (daemon.version; v0.3's, v0.4's life and intel, v0.5's meetings, v0.5.3's ask); without it the state has no daemon info, so every one is off. */
  features?: Partial<Features>;
  /** v0.4: the daemon's accounts mode (needs `features` for daemon info; default cswap). */
  accountsMode?: 'single' | 'cswap';
  /** v0.4: state.lifeTick. */
  lifeTick?: number;
}): State {
  const s = emptyState();
  s.seq = parts.seq ?? 10;
  for (const x of parts.sessions ?? []) s.sessions[x.sid] = x;
  for (const p of parts.pending ?? []) s.pending[p.id] = p;
  for (const a of parts.accounts ?? []) s.accounts[String(a.id)] = a;
  for (const j of parts.sends ?? []) s.sends[j.id] = j;
  s.alerts = parts.alerts ?? [];
  s.activeAccount = parts.activeAccount ?? null;
  if (parts.accounts?.length) s.usage = { fetchedAt: iso(240_000), source: 'cache' };
  if (parts.features) {
    s.daemon = { protocol: PROTOCOL_VERSION, daemonVersion: '0.0.0-test', webHash: null, features: { ...NO_FEATURES, ...parts.features } };
    if (parts.accountsMode) s.daemon.accountsMode = parts.accountsMode;
  }
  if (parts.lifeTick !== undefined) s.lifeTick = parts.lifeTick;
  return s;
}

/** What a v0.3 (and later) call answers until a test gives it a fake: the daemon's 501 for a part not built yet. */
const notBuilt = () =>
  vi.fn(async (..._args: unknown[]): Promise<never> => {
    throw new ApiError('not_implemented', 'not built yet', 501);
  });

/** Every API method as a vi.fn with a harmless default. */
export function fakeApi(over: Partial<Api> = {}) {
  const base = {
    getState: vi.fn(async () => ({ seq: 0, epoch: 'e1', state: emptyState() })),
    getSession: vi.fn(async () => {
      throw new Error('not used');
    }),
    getTranscript: vi.fn(async () => ({ items: [], nextBefore: null })),
    getScreen: vi.fn(async () => ({ text: '', lines: 0, at: iso(0), backend: 'terminal-app' })),
    sendPrompt: vi.fn(async (sid: string, _text: string, _key: string) => ({ jobId: 'job-1', job: sendJob('job-1', sid) })),
    getSend: vi.fn(async (jobId: string) => ({ job: sendJob(jobId, 's') })),
    focus: vi.fn(async () => undefined),
    decide: vi.fn(async (id: string) => ({ pending: pending('s', { id, state: 'decided' }) })),
    getAccounts: vi.fn(async () => ({ accounts: [], activeAccount: null, fetchedAt: null, source: null })),
    getPlan: vi.fn(async () => ({ source: 'none' as const, next: null, accounts: [], updatedAt: null })),
    refreshUsage: vi.fn(async () => ({ queued: true, nextAllowedAt: null })),
    mute: vi.fn(async () => ({ mutedUntil: iso(3600_000) })),
    pairStart: vi.fn(async () => ({
      code: 'C0DEc0deC0DEc0deC0DE',
      url: 'https://mac.example.test/pair#c=C0DEc0deC0DEc0deC0DE',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })),
    pairClaim: vi.fn(async (body: { name: string }) => ({
      device: { id: 'dev-1', name: body.name, scopes: ['read', 'control'] as ('read' | 'control' | 'admin')[], createdAt: iso(0), lastSeenAt: iso(0) },
    })),
    listDevices: vi.fn(async () => ({ devices: [] })),
    revokeDevice: vi.fn(async (id: string) => ({
      device: { id, name: 'x', scopes: ['read'] as ('read' | 'control' | 'admin')[], createdAt: iso(0), lastSeenAt: iso(0), revokedAt: iso(1) },
    })),
    vapidKey: vi.fn(async () => ({ publicKey: 'BAQIDBA' })),
    pushSubscribe: vi.fn(async () => undefined),
    pushUnsubscribe: vi.fn(async () => undefined),
    eventsUrl: vi.fn((after?: number) => `ws://127.0.0.1:7420/v1/events${after ? `?after=${after}` : ''}`),
    // v0.3: each answers 501 (a part not built yet) unless the test passes its own.
    rewriteStart: notBuilt(),
    rewriteGet: notBuilt(),
    rewriteCancel: notBuilt(),
    filesRoots: notBuilt(),
    filesList: notBuilt(),
    filesStat: notBuilt(),
    filesText: notBuilt(),
    filesRawUrl: vi.fn((q: { root: string; path: string }) => `http://127.0.0.1:7420/v1/files/raw?root=${encodeURIComponent(q.root)}&path=${encodeURIComponent(q.path)}`),
    filesRaw: notBuilt(),
    filesChanges: notBuilt(),
    sessionChanges: notBuilt(),
    sessionChange: notBuilt(),
    foldersRoots: notBuilt(),
    foldersList: notBuilt(),
    foldersRecent: notBuilt(),
    foldersPin: notBuilt(),
    foldersCreate: notBuilt(),
    launchPreview: notBuilt(),
    launchStart: notBuilt(),
    launchGet: notBuilt(),
    launchList: notBuilt(),
    launchAnswer: notBuilt(),
    sessionKey: notBuilt(),
    sessionMode: notBuilt(),
    sessionCommand: notBuilt(),
    screenshot: notBuilt(),
    // v0.4: each answers 501 (a part not built yet) unless the test passes its own.
    lifeStatus: notBuilt(),
    lifeToday: notBuilt(),
    projectsList: notBuilt(),
    projectCreate: notBuilt(),
    projectUpdate: notBuilt(),
    projectDelete: notBuilt(),
    todosList: notBuilt(),
    todoCreate: notBuilt(),
    todoUpdate: notBuilt(),
    todoDone: notBuilt(),
    todoSnooze: notBuilt(),
    todoDelete: notBuilt(),
    medsGet: notBuilt(),
    medCreate: notBuilt(),
    medUpdate: notBuilt(),
    medStop: notBuilt(),
    medDelete: notBuilt(),
    doseLog: notBuilt(),
    doseUndo: notBuilt(),
    foodDay: notBuilt(),
    foodAdd: notBuilt(),
    foodUpdate: notBuilt(),
    foodDelete: notBuilt(),
    foodSavedDelete: notBuilt(),
    foodTargets: notBuilt(),
    foodEstimate: notBuilt(),
    weightSet: notBuilt(),
    weightDelete: notBuilt(),
    placesList: notBuilt(),
    placeCreate: notBuilt(),
    placeUpdate: notBuilt(),
    placeDelete: notBuilt(),
    moneyMonth: notBuilt(),
    moneyAdd: notBuilt(),
    moneyUpdate: notBuilt(),
    moneyDelete: notBuilt(),
    budgetSet: notBuilt(),
    billCreate: notBuilt(),
    billUpdate: notBuilt(),
    billPaid: notBuilt(),
    billDelete: notBuilt(),
    intelList: notBuilt(),
    intelGet: notBuilt(),
    intelCapture: notBuilt(),
    intelSources: notBuilt(),
    launchHistory: notBuilt(),
    // v0.4.2: each answers 501 (a part not built yet) unless the test passes its own.
    sessionDialog: notBuilt(),
    sessionKeypad: notBuilt(),
    uploadCreate: notBuilt(),
    uploadDelete: notBuilt(),
    // v0.5: each answers 501 (a part not built yet) unless the test passes its own.
    meetingsStatus: notBuilt(),
    meetingsList: notBuilt(),
    meetingGet: notBuilt(),
    meetingShot: notBuilt(),
    meetingUpdate: notBuilt(),
    meetingDelete: notBuilt(),
    meetingSummarize: notBuilt(),
    meetingItemTodo: notBuilt(),
    meetingItemUntodo: notBuilt(),
    // v0.5.3: each answers 501 (a part not built yet) unless the test passes its own.
    askList: notBuilt(),
    askSend: notBuilt(),
    askClear: notBuilt(),
    askCancel: notBuilt(),
    askAdd: notBuilt(),
    askSkip: notBuilt(),
    askUndo: notBuilt(),
    // v0.6 Fleet: no paired machines unless the test passes its own.
    machinesList: vi.fn(async () => ({ machines: [] })),
    machineRevoke: notBuilt(),
  };
  return Object.assign(base, over) as typeof base & Api;
}

/** A push environment with nothing available (overridable). */
export function fakePushEnv(over: Partial<PushEnv> = {}): PushEnv {
  return {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0',
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
    standalone: false,
    isSecureContext: true,
    hasServiceWorker: false,
    hasPushManager: false,
    notification: null,
    ready: async () => null,
    ...over,
  };
}

export function fakeConnection(): Connection & { kick: ReturnType<typeof vi.fn> } {
  return { start: vi.fn(), stop: vi.fn(), kick: vi.fn() } as unknown as Connection & { kick: ReturnType<typeof vi.fn> };
}

export function renderApp(opts: {
  state?: State;
  path?: string;
  api?: Api;
  pushEnv?: PushEnv;
  connection?: Connection;
  status?: 'live' | 'polling' | 'connecting' | 'offline' | 'unauthorized';
} = {}) {
  const store = createAppStore(opts.state ?? emptyState());
  store.getState().setConn({ status: opts.status ?? 'live', lastOkAt: NOW });
  const history = memoryHistory(opts.path ?? '/');
  const router = createRouter(history);
  const toasts = createToastStore();
  const api = opts.api ?? fakeApi();
  const connection = opts.connection ?? fakeConnection();
  const pushEnv = opts.pushEnv ?? fakePushEnv();
  const utils = render(
    <App store={store} api={api} router={router} toasts={toasts} connection={connection} pushEnv={pushEnv} now={() => NOW} />,
  );
  return { ...utils, store, router, history, toasts, api, connection };
}

/** Apply events to a store as the WebSocket would. */
export function emit(store: AppStore, events: DaemonEvent[]) {
  for (const event of events) store.getState().applyMessage({ kind: 'event', event } as WsServerMessage);
}
