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
 */
import type { Pane, PaneForeground, PatchResult, Settings } from '@jantar/protocol';
import type {
  DecideResult,
  FolderBrowser,
  FoodModule,
  HooksBridge,
  LaunchResult,
  Launcher,
  LifeModuleBuilders,
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

export const READ_ONLY_REASON = 'jantard is running read-only (--read-only): this action is turned off';
/** v0.5: what the meetings status and a meeting's summary say under --read-only (WP-SU uses it). */
export const READ_ONLY_SUMMARIES = 'Summaries are off while Jantar is read-only.';
export const NO_TERMINAL_REASON = 'the terminal backend is turned off (jantard --no-terminal)';

/** Which terminal backend the daemon runs with (reported on /ctl/status). */
export type TerminalMode = 'terminal-app' | 'off' | 'injected';

export interface DaemonMode {
  readOnly: boolean;
  terminal: TerminalMode;
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
  return {
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
