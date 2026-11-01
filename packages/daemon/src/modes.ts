/**
 * Daemon run modes (integration step): `--no-terminal` and `--read-only`.
 *
 * Both are enforced on the parts themselves, so they hold whichever caller
 * reaches a part (REST, control socket, the writer's own retries). The API
 * also refuses the affected routes up front with a clear 403
 * (api/app.ts, READ_ONLY_REFUSED), but that is a courtesy, not the guard.
 *
 * --no-terminal  NullTerminalBackend: no osascript at all. No pane is ever
 *                found, so the screen peek, focus and every send are refused,
 *                and so are v0.3's new windows, keys and screenshots.
 * --read-only    The daemon only observes. Refused: typing, Enter, Ctrl-U,
 *                control keys, new windows and focus on any terminal;
 *                answering cards (and blocking PermissionRequest hooks are
 *                not held, so Claude asks in the terminal as if the daemon
 *                were not there); the cswap CLI poller (forced off); every
 *                settings change, mute included; Rewrite runs (they spend an
 *                account's quota); launches and new folders. Screenshots
 *                never select a tab. Still allowed, because they only touch
 *                Jantar's own state dir or only read: pairing, device revoke,
 *                push subscriptions, Files.
 *                v0.4: Life and the Intel shelf writes are not refused.
 *                --read-only is about sessions; logging a dose, a meal or an
 *                expense must not fail, and their data is Jantar's own
 *                (life.db, the captures file). Their settings still change
 *                only at the Mac, and not at all under --read-only. The one
 *                exception is Ask Claude: like Rewrite it runs a headless
 *                Claude that spends an account's quota, so the food module
 *                is wrapped (readOnlyLifeBuilders) and Ask Claude is off.
 *                v0.5: Meetings' capture and the phone's edits work (meetings.db
 *                and the screenshot files are Jantar's own); summaries do not
 *                run (they spend quota). The meetings part is told
 *                `readOnly`, not wrapped, and meetingSummarize is refused up
 *                front (api/app.ts READ_ONLY_REFUSED).
 *
 * v0.6 Fleet adds the stand-ins each role puts where the other role's part
 * goes (offFleet on a node, offNodeLink on the hub), and on a node the
 * hub-only parts the API's type still asks for (nodeOffParts: Changes,
 * Rewrite, Life, Intel, Meetings, Ask, the push router, an inert ccw reader):
 * none opens a file or starts a timer, and each answers 501 with the
 * sentence that it lives on the Mac. A node's `--read-only` is the same
 * wrappers as the hub's: its NodeView says readOnly, and every write there
 * is refused on the node itself.
 */
import { errorBody, type Pane, type PaneForeground, type PatchResult, type Settings } from '@jantar/protocol';
import type {
  AskService,
  CcwLegacySource,
  ChangesService,
  DaemonRole,
  DecideResult,
  FleetService,
  FolderBrowser,
  FoodModule,
  HooksBridge,
  IntelService,
  LaunchResult,
  Launcher,
  LifeModuleBuilders,
  LifeService,
  MeetingsService,
  NodeLinkService,
  NodeLinkStatus,
  NotificationRouter,
  OpResult,
  RewriteService,
  RewriteSubmitResult,
  SettingsStore,
  SubmitResult,
  TerminalBackend,
  TerminalShot,
  Unsubscribe,
  UsageSource,
  Writer,
} from './contracts.js';
import { ApiError } from './api/errors.js';

export const READ_ONLY_REASON = 'jantard is running read-only (--read-only): this action is turned off';
/** v0.5: what the meetings status and a meeting's summary say under --read-only (WP-SU uses it). */
export const READ_ONLY_SUMMARIES = 'Summaries are off while Jantar is read-only.';
export const NO_TERMINAL_REASON = 'the terminal backend is turned off (jantard --no-terminal)';

/**
 * Which terminal backend the daemon runs with (reported on /ctl/status).
 * v0.6: `tmux` on Linux (terminal/pick.ts), and `none` where this platform
 * has no backend Jantar can type with (native Windows: watch and cards only).
 */
export type TerminalMode = 'terminal-app' | 'tmux' | 'none' | 'off' | 'injected';

export interface DaemonMode {
  readOnly: boolean;
  terminal: TerminalMode;
  /** v0.6: hub or node (config.ts roleOf); absent means the hub. */
  role?: DaemonRole;
}

// ---------------------------------------------------------------------------
// --no-terminal

/** A terminal backend that never finds a pane and never runs anything. */
export class NullTerminalBackend implements TerminalBackend {
  readonly kind = 'terminal-app' as const;

  async available(): Promise<boolean> {
    return false;
  }

  async findPane(): Promise<Pane | null> {
    return null;
  }

  async readScreen(): Promise<OpResult<{ text: string; at: string }>> {
    return { ok: false, code: 'unsupported', reason: NO_TERMINAL_REASON };
  }

  async readInputBox(): Promise<OpResult<{ text: string; styled: boolean }>> {
    return { ok: false, code: 'unsupported', reason: NO_TERMINAL_REASON };
  }

  async type(): Promise<OpResult> {
    return { ok: false, code: 'unsupported', reason: NO_TERMINAL_REASON };
  }

  async pressEnter(): Promise<OpResult> {
    return { ok: false, code: 'unsupported', reason: NO_TERMINAL_REASON };
  }

  async clearInput(): Promise<OpResult> {
    return { ok: false, code: 'unsupported', reason: NO_TERMINAL_REASON };
  }

  async focus(): Promise<OpResult> {
    return { ok: false, code: 'unsupported', reason: NO_TERMINAL_REASON };
  }

  async foregroundOf(): Promise<PaneForeground> {
    return 'gone';
  }

  async openWindow(): Promise<OpResult<{ tty: string; windowId: string }>> {
    return { ok: false, code: 'unsupported', reason: NO_TERMINAL_REASON };
  }

  async pressKey(): Promise<OpResult> {
    return { ok: false, code: 'unsupported', reason: NO_TERMINAL_REASON };
  }

  async getScreenshot(): Promise<OpResult<TerminalShot>> {
    return { ok: false, code: 'unsupported', reason: NO_TERMINAL_REASON };
  }
}

// ---------------------------------------------------------------------------
// --read-only

const refusedOp = async (): Promise<OpResult> => ({ ok: false, code: 'unsupported', reason: READ_ONLY_REASON });

/** Reads pass through (a screenshot never selects a tab); type, Enter, Ctrl-U, keys, new windows and focus are refused. */
export function readOnlyTerminal(inner: TerminalBackend): TerminalBackend {
  const shot = inner.getScreenshot?.bind(inner);
  const start = inner.start?.bind(inner);
  const stop = inner.stop?.bind(inner);
  return {
    // v0.6: a backend's own tick (tmux ties sessions to panes) only reads.
    ...(start ? { start } : {}),
    ...(stop ? { stop } : {}),
    kind: inner.kind,
    available: () => inner.available(),
    findPane: (target) => inner.findPane(target),
    readScreen: (pane, opts) => inner.readScreen(pane, opts),
    readInputBox: (pane) => inner.readInputBox(pane),
    foregroundOf: (pane) => inner.foregroundOf(pane),
    type: refusedOp,
    pressEnter: refusedOp,
    clearInput: refusedOp,
    focus: refusedOp,
    pressKey: refusedOp,
    openWindow: async (): Promise<OpResult<{ tty: string; windowId: string }>> => ({ ok: false, code: 'unsupported', reason: READ_ONLY_REASON }),
    ...(shot ? { getScreenshot: (pane: Pane, opts?: Parameters<typeof shot>[1]) => shot(pane, { ...opts, select: 'never' }) } : {}),
  };
}

/** Every submit is refused; jobs can still be looked up (there are none). */
export function readOnlyWriter(inner: Writer): Writer {
  return {
    start: () => inner.start(),
    stop: () => inner.stop(),
    get: (jobId) => inner.get(jobId),
    wait: (jobId, timeoutMs) => inner.wait(jobId, timeoutMs),
    withPaneLock: (pane, task) => inner.withPaneLock(pane, task),
    submit: async (): Promise<SubmitResult> => ({ ok: false, code: 'refused', reason: READ_ONLY_REASON }),
  };
}

/** v0.3: no Rewrite runs (they spend quota); jobs can still be read and cancelled. */
export function readOnlyRewrite(inner: RewriteService): RewriteService {
  return {
    start: () => inner.start(),
    stop: () => inner.stop(),
    get: (jobId, actor) => inner.get(jobId, actor),
    cancel: (jobId, actor) => inner.cancel(jobId, actor),
    originFor: (jobId, sid, textHash, actor) => inner.originFor(jobId, sid, textHash, actor),
    markSent: (jobId, sendJobId) => inner.markSent(jobId, sendJobId),
    releaseOrigin: (jobId) => inner.releaseOrigin(jobId),
    submit: async (): Promise<RewriteSubmitResult> => ({ ok: false, code: 'refused', reason: READ_ONLY_REASON }),
  };
}

/** v0.3: no launches, answers, pins or new folders; previews, lists and reads pass through. */
export function readOnlyLauncher(inner: Launcher): Launcher {
  const refused = async (): Promise<LaunchResult<never>> => ({ ok: false, code: 'refused', reason: READ_ONLY_REASON });
  const folders: FolderBrowser = {
    roots: (actor) => inner.folders.roots(actor),
    list: (q, actor) => inner.folders.list(q, actor),
    recent: (actor) => inner.folders.recent(actor),
    pin: refused,
    create: refused,
  };
  return {
    folders,
    start: () => inner.start(),
    stop: () => inner.stop(),
    preview: (q, actor) => inner.preview(q, actor),
    get: (id) => inner.get(id),
    list: (opts) => inner.list(opts),
    launch: refused,
    answer: refused,
  };
}

/** Cards are shown but cannot be answered. */
export function readOnlyHooks(inner: HooksBridge): HooksBridge {
  return {
    get socketPath() {
      return inner.socketPath;
    },
    start: () => inner.start(),
    stop: () => inner.stop(),
    open: () => inner.open(),
    get: (id) => inner.get(id),
    onHookEvent: (fn) => inner.onHookEvent(fn),
    hasHooks: (sid) => inner.hasHooks(sid),
    decide: async (): Promise<DecideResult> => ({ ok: false, code: 'forbidden', message: READ_ONLY_REASON }),
  };
}

/** The cached usage is served; the cswap CLI is never asked for a refresh. */
export function readOnlyUsage(inner: UsageSource): UsageSource {
  return {
    start: () => inner.start(),
    stop: () => inner.stop(),
    read: () => inner.read(),
    latest: () => inner.latest(),
    isPolling: () => inner.isPolling(),
    requestRefresh: () => ({ queued: false, reason: 'read-only', nextAllowedAt: null }),
  };
}

function forcePollerOff(s: Settings): Settings {
  return s.usage.poller === 'off' ? s : { ...s, usage: { ...s.usage, poller: 'off' } };
}

/** Settings as configured, but with the cswap poller off; every patch is refused. */
export function readOnlySettings(inner: SettingsStore): SettingsStore {
  return {
    get: () => forcePollerOff(inner.get()),
    patch: async (): Promise<PatchResult> => ({ ok: false, error: READ_ONLY_REASON }),
    subscribe: (fn): Unsubscribe => inner.subscribe((next, prev) => fn(forcePollerOff(next), forcePollerOff(prev))),
  };
}

/** v0.4: Ask Claude runs a headless Claude (it spends quota), so it is off; every other Life call passes through. */
export function readOnlyLifeBuilders(inner: LifeModuleBuilders): LifeModuleBuilders {
  return {
    ...inner,
    food: (core, deps): FoodModule => {
      const food = inner.food(core, deps);
      return {
        ...food,
        estimate: async () => ({ ok: false, code: 'unavailable', reason: READ_ONLY_REASON }),
        estimateStatus: () => ({ available: false, reason: READ_ONLY_REASON }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// v0.6 Fleet: each role's stand-ins for the other role's parts

/** On a node, what a hub-only part answers (the API's 501). */
export const NODE_PART_OFF = 'This machine is a server paired with a Mac: that lives on the Mac.';
/** What the hub's Fleet stand-in answers on a node. */
export const NOT_A_HUB = 'This machine is a server: pair servers at the Mac (jantar node pair there).';

const idle = { start: async () => {}, stop: async () => {} };

/** A stand-in part: start and stop do nothing, `fixed` answers as given, every other method throws `refusal` (an ApiError). */
function standIn<T extends object>(fixed: Partial<T>, refusal: () => never): T {
  const base = { ...idle, ...fixed };
  return new Proxy(base as T, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      // Not a thenable: `await standIn(...)` must not call `then`.
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return refusal;
    },
  });
}

const nodeOff = (): never => {
  throw new ApiError('not_implemented', NODE_PART_OFF);
};

/** On a node: Fleet is the hub's (no targets, nothing to pair or list). */
export function offFleet(): FleetService {
  return {
    ...idle,
    target: () => null,
    forward: async () => ({ status: 501, body: errorBody('not_implemented', NOT_A_HUB) }),
    acceptLink: (_req, socket) => {
      socket.destroy();
    },
    pair: async () => ({ ok: false, code: 'not_found', reason: 'not found' }),
    makeTokens: async () => ({ ok: false, code: 'forbidden', reason: NOT_A_HUB }),
    list: () => [],
    revoke: async () => ({ ok: false, code: 'not_found', reason: 'no such machine' }),
  };
}

/** The node link's status while there is none (the hub, or a node not started yet). */
export const NODE_LINK_OFF: Readonly<NodeLinkStatus> = Object.freeze({
  state: 'off',
  name: null,
  hubHost: null,
  lastClose: null,
  accessRefused: 0,
  retryAt: null,
});

/** On the hub: no link to dial. */
export function offNodeLink(): NodeLinkService {
  return { ...idle, status: () => ({ ...NODE_LINK_OFF }) };
}

/** On a node: ccw is the Mac's legacy tool, never read there (no watchers, no `ps` or `lsof`). */
export function inertCcwLegacy(): CcwLegacySource {
  return {
    ...idle,
    present: () => false,
    botRunning: async () => false,
    moves: async () => [],
    moveFor: async () => null,
    moveLocked: async () => false,
    burn: async () => [],
    plan: async () => ({ source: 'none', next: null, accounts: [], updatedAt: null }),
    switchConfig: async () => null,
  };
}

/** The hub-only parts a node does not run, as the API's type still asks for them. */
export interface NodeOffParts {
  changes: ChangesService;
  rewrite: RewriteService;
  life: LifeService;
  intel: IntelService;
  meetings: MeetingsService;
  ask: AskService;
  notifications: NotificationRouter;
}

/**
 * On a node: Changes, Rewrite, Life, Intel, Meetings, Ask and the push router.
 * Their switches are off in the node's daemon.version and the link serves
 * none of their routes; a CLI call on the node's own socket gets the 501
 * that says they live on the Mac. Nothing here opens a file or starts a timer.
 */
export function nodeOffParts(): NodeOffParts {
  return {
    changes: standIn<ChangesService>({ forSession: async () => null, change: async () => null, recent: () => [], changedPathsFor: () => [] }, nodeOff),
    // A prompt naming a rewrite job finds none (404), as on a Mac whose job expired.
    rewrite: standIn<RewriteService>({ get: () => null, cancel: () => null, originFor: () => null, markSent: () => {}, releaseOrigin: () => {} }, nodeOff),
    life: standIn<LifeService>({ broken: () => null }, nodeOff),
    intel: standIn<IntelService>({ sources: () => [] }, nodeOff),
    meetings: standIn<MeetingsService>({ broken: () => null }, nodeOff),
    ask: standIn<AskService>({}, nodeOff),
    notifications: { ...idle },
  };
}
