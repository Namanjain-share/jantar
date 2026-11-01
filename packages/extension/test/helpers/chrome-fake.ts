/**
 * A stand-in for `chrome` in the extension's unit tests (WP0; shared and
 * frozen for wave 1: a package that needs more wraps or extends it in its
 * own test folder, test/content/chrome.ts or test/background/chrome.ts).
 *
 *   const { chrome, model } = createChromeFake();          // installs globalThis.chrome
 *   model.addTab({ id: 7, windowId: 1, url: 'https://meet.google.com/abc-defg-hij', active: true });
 *   model.onTabMessage(7, (msg) => ({ ok: true }));          // what the page answers
 *   await import('../../src/background/index.js');          // the worker adds its listeners
 *   const answer = await chrome.runtime.onMessage.dispatch({ t: 'shot' }, model.pageSender(7));
 *   model.uninstall();
 *
 * Its surface is what the spec lists (8.2) and nothing more: runtime (id,
 * getURL, sendMessage, onMessage with dispatch, lastError, invalidate),
 * tabs (get, query, sendMessage, captureVisibleTab, onRemoved), an in-memory
 * storage.session, permissions (contains, request) and commands.onCommand.
 * v0.5.3 adds commands.getAll (the screenshot command's shortcut is
 * `model.shortcut`) and tabs.create (each URL in `model.opened`), for the
 * popup's Settings.
 * v0.8 (Read saved links) adds what the read loop uses: runtime.getManifest
 * (the source manifest.json), runtime.onStartup and onInstalled, alarms
 * (create, get, clear, onAlarm), storage.local, tabs.update, tabs.remove
 * and tabs.onUpdated (a navigation's updates come from `model.navigation`,
 * default loading then complete on the URL), scripting.executeScript (its
 * answer from `model.onScript`), and permissions.contains answering true for
 * any https origin while `<all_urls>` is granted, as Chrome does.
 * Every call after `model.invalidate()` throws "Extension context
 * invalidated.", as Chrome does after the extension is reloaded.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeJpeg } from '@jantar/fixtures';
import { EXTENSION_ID } from '../../src/shared/wire.js';

/** Chrome's error when a capture has neither grant. */
export const CAPTURE_PERMISSION_ERROR = "Either the '<all_urls>' or 'activeTab' permission is required.";
/** Chrome's error for a third capture in one second. */
export const CAPTURE_QUOTA_ERROR = 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.';
/** Chrome's error for a message to a tab with no listener. */
export const NO_RECEIVER_ERROR = 'Could not establish connection. Receiving end does not exist.';
export const INVALIDATED_ERROR = 'Extension context invalidated.';

export interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  title?: string;
  /** v0.8 */
  muted?: boolean;
}

/** v0.8: one tabs.onUpdated as the test scripts it: the change, and the URL the tab shows (undefined: hidden from the extension). */
export interface FakeUpdate {
  info: { status?: 'loading' | 'complete'; url?: string };
  url: string | undefined;
}

/** v0.8: one scripting.executeScript call, as the code under test made it. */
export interface ScriptCall {
  target: { tabId: number; frameIds?: number[]; allFrames?: boolean };
  world?: string;
  func?: (...args: never[]) => unknown;
  args?: unknown[];
}

/** Who sent a runtime message, as the test names it. */
export interface FakeSender {
  id?: string;
  tab?: FakeTab;
  url?: string;
}

type Listener = (...args: never[]) => unknown;

/** A chrome event: addListener, removeListener, hasListener, hasListeners, and the listeners for dispatch. */
export class FakeEvent<F extends Listener> {
  readonly listeners: F[] = [];
  constructor(private readonly alive: () => void) {}
  addListener(fn: F): void {
    this.alive();
    this.listeners.push(fn);
  }
  removeListener(fn: F): void {
    const i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  hasListener(fn: F): boolean {
    return this.listeners.includes(fn);
  }
  hasListeners(): boolean {
    return this.listeners.length > 0;
  }
}

type MessageListener = (msg: unknown, sender: FakeSender, sendResponse: (answer?: unknown) => void) => unknown;

/** runtime.onMessage: `dispatch` runs every listener as Chrome would and answers what the first sendResponse gave. */
export class FakeMessageEvent extends FakeEvent<MessageListener> {
  /**
   * Deliver `msg` from `sender`. A listener that returns true answers later
   * through sendResponse: the promise waits for it. With none answering, it
   * resolves undefined.
   */
  dispatch(msg: unknown, sender: FakeSender): Promise<unknown> {
    return new Promise((resolve) => {
      let answered = false;
      let waiting = false;
      const sendResponse = (answer?: unknown) => {
        if (answered) return;
        answered = true;
        resolve(answer);
      };
      for (const fn of [...this.listeners]) {
        if (fn(msg, sender, sendResponse) === true) waiting = true;
      }
      if (!answered && !waiting) resolve(undefined);
    });
  }
}

/** commands.onCommand: `dispatch(command, tab)`. */
export class FakeCommandEvent extends FakeEvent<(command: string, tab?: FakeTab) => unknown> {
  dispatch(command: string, tab?: FakeTab): void {
    for (const fn of [...this.listeners]) fn(command, tab);
  }
}

/** v0.8: runtime.onStartup and onInstalled, alarms.onAlarm: `dispatch(...args)`. */
export class FakeSimpleEvent<A extends unknown[]> extends FakeEvent<(...args: A) => unknown> {
  dispatch(...args: A): void {
    for (const fn of [...this.listeners]) fn(...args);
  }
}

/** v0.8: tabs.onUpdated: `dispatch(tabId, info, tab)`. */
export class FakeUpdatedEvent extends FakeEvent<(tabId: number, info: FakeUpdate['info'], tab: { id: number; url?: string; status?: string }) => unknown> {
  dispatch(tabId: number, info: FakeUpdate['info'], tab: { id: number; url?: string; status?: string }): void {
    for (const fn of [...this.listeners]) fn(tabId, info, tab);
  }
}

/** tabs.onRemoved: `dispatch(tabId)`. */
export class FakeRemovedEvent extends FakeEvent<(tabId: number, info: { windowId: number; isWindowClosing: boolean }) => unknown> {
  dispatch(tabId: number, info: { windowId?: number; isWindowClosing?: boolean } = {}): void {
    for (const fn of [...this.listeners]) fn(tabId, { windowId: info.windowId ?? 1, isWindowClosing: info.isWindowClosing ?? false });
  }
}

export interface CaptureCall {
  windowId: number | undefined;
  options: { format?: string; quality?: number } | undefined;
}

export interface ChromeModel {
  /** Add (or replace) a tab; `active` makes it the active tab of its window. */
  addTab(tab: FakeTab): FakeTab;
  removeTab(tabId: number): void;
  /** Make a tab the active one of its window (the others there stop being active). */
  activate(tabId: number): void;
  tab(tabId: number): FakeTab | undefined;
  /** The window `query({ lastFocusedWindow: true })` means (default: the first tab's). */
  focusedWindow: number | null;
  /** What the page in a tab answers to tabs.sendMessage (without one, the send rejects as Chrome does). */
  onTabMessage(tabId: number, handler: ((msg: unknown) => unknown) | null): void;
  /** Every message sent to a tab, in order. */
  sentTo(tabId: number): unknown[];
  /** Every captureVisibleTab call, in order (failed ones too). */
  captures: CaptureCall[];
  /** The next capture fails: 'permission', 'quota' or a message of its own; `times` captures in a row (default 1). null clears. */
  failCapture(kind: 'permission' | 'quota' | string | null, times?: number): void;
  /** The image a capture answers (default makeJpeg(64, 48)). */
  captureImage: Buffer;
  /** Origins granted (permissions.contains reads it). */
  granted: Set<string>;
  /** What permissions.request answers (true grants the origins asked for). */
  permissionAnswer: boolean;
  /** Every permissions.request call's origins. */
  requested: string[][];
  /** What storage.session holds. */
  session: Map<string, unknown>;
  /** The take-screenshot command's shortcut as commands.getAll shows it ('' when none is set; the default). */
  shortcut: string;
  /** Every URL tabs.create opened, in order. */
  opened: string[];
  /** The sender `runtime.sendMessage` uses (default: the extension's popup page). */
  sender: FakeSender;
  /** A page sender for tab `tabId` (its URL from the tab), from this extension. */
  pageSender(tabId: number): FakeSender;
  /** A sender from the extension's own page `path` (default popup.html). */
  extensionSender(path?: string): FakeSender;
  // --- v0.8
  /** What runtime.getManifest answers (default: the source manifest.json). */
  manifest: Record<string, unknown>;
  /** Alarms by name, as alarms.create made them. */
  alarms: Map<string, { name: string; periodInMinutes?: number; delayInMinutes?: number }>;
  /** What storage.local holds. */
  local: Map<string, unknown>;
  /** Every tabs.update, in order. */
  updates: { tabId: number; url?: string; muted?: boolean }[];
  /** Every tabs.remove, in order. */
  removed: number[];
  /**
   * The updates a navigation of `tabId` to `url` sends, in order, each a
   * macrotask apart (default: loading then complete on that URL). The tab's
   * URL follows the last one (a hidden URL leaves it as it was).
   */
  navigation: (tabId: number, url: string) => FakeUpdate[];
  /** Every executeScript call, in order. */
  scripts: ScriptCall[];
  /** What executeScript answers (default: one frame with an undefined result); throwing rejects it. */
  onScript: (call: ScriptCall) => unknown;
  /** From now on `runtime.id` is undefined and every call throws "Extension context invalidated." */
  invalidate(): void;
  /** Put back what globalThis.chrome was. */
  uninstall(): void;
}

type StorageArea = {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
};

export interface ChromeFake {
  runtime: {
    readonly id: string | undefined;
    lastError: { message: string } | undefined;
    getURL(path: string): string;
    sendMessage(msg: unknown): Promise<unknown>;
    onMessage: FakeMessageEvent;
    // v0.8
    getManifest(): Record<string, unknown>;
    onStartup: FakeSimpleEvent<[]>;
    onInstalled: FakeSimpleEvent<[{ reason: string }]>;
  };
  alarms: {
    create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): Promise<void>;
    get(name: string): Promise<{ name: string; periodInMinutes?: number } | undefined>;
    clear(name: string): Promise<boolean>;
    onAlarm: FakeSimpleEvent<[{ name: string; scheduledTime: number }]>;
  };
  scripting: {
    executeScript(call: ScriptCall): Promise<unknown>;
  };
  tabs: {
    get(tabId: number): Promise<FakeTab>;
    query(q: { active?: boolean; lastFocusedWindow?: boolean; windowId?: number; currentWindow?: boolean }): Promise<FakeTab[]>;
    sendMessage(tabId: number, msg: unknown): Promise<unknown>;
    captureVisibleTab(windowId?: number, options?: { format?: string; quality?: number }): Promise<string>;
    create(p: { url?: string; active?: boolean; windowId?: number }): Promise<FakeTab>;
    onRemoved: FakeRemovedEvent;
    // v0.8
    update(tabId: number, p: { url?: string; muted?: boolean }): Promise<FakeTab>;
    remove(tabId: number): Promise<void>;
    onUpdated: FakeUpdatedEvent;
  };
  storage: {
    session: StorageArea;
    /** v0.8 */
    local: StorageArea;
  };
  permissions: {
    contains(p: { origins?: string[] }): Promise<boolean>;
    request(p: { origins?: string[] }): Promise<boolean>;
  };
  commands: {
    onCommand: FakeCommandEvent;
    getAll(): Promise<{ name: string; description: string; shortcut: string }[]>;
  };
}

/** Install a fake `chrome` on globalThis (replacing any) and return it with the model the test drives. */
export function createChromeFake(opts: { id?: string } = {}): { chrome: ChromeFake; model: ChromeModel } {
  const g = globalThis as { chrome?: unknown };
  const before = g.chrome;
  let id: string | undefined = opts.id ?? EXTENSION_ID;
  let dead = false;
  const alive = () => {
    if (dead) throw new Error(INVALIDATED_ERROR);
  };
  const tabs = new Map<number, FakeTab>();
  const pages = new Map<number, (msg: unknown) => unknown>();
  const sent = new Map<number, unknown[]>();
  let failing: { kind: string; times: number } | null = null;
  const base = () => `chrome-extension://${opts.id ?? EXTENSION_ID}/`;
  const copy = (t: FakeTab): FakeTab => ({ ...t });

  const model: ChromeModel = {
    addTab(tab) {
      if (tab.active) for (const t of tabs.values()) if (t.windowId === tab.windowId) t.active = false;
      tabs.set(tab.id, { ...tab });
      if (model.focusedWindow === null) model.focusedWindow = tab.windowId;
      return copy(tab);
    },
    removeTab(tabId) {
      tabs.delete(tabId);
      pages.delete(tabId);
    },
    activate(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`no tab ${tabId}`);
      for (const t of tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === tabId;
    },
    tab: (tabId) => {
      const t = tabs.get(tabId);
      return t ? copy(t) : undefined;
    },
    focusedWindow: null,
    onTabMessage(tabId, handler) {
      if (handler) pages.set(tabId, handler);
      else pages.delete(tabId);
    },
    sentTo: (tabId) => [...(sent.get(tabId) ?? [])],
    captures: [],
    failCapture(kind, times = 1) {
      failing = kind === null ? null : { kind, times };
    },
    captureImage: makeJpeg(64, 48),
    granted: new Set(),
    permissionAnswer: false,
    requested: [],
    session: new Map(),
    shortcut: '',
    opened: [],
    sender: { id: opts.id ?? EXTENSION_ID, url: `${base()}popup.html` },
    pageSender(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`no tab ${tabId}`);
      return { id: opts.id ?? EXTENSION_ID, tab: copy(tab), url: tab.url };
    },
    extensionSender: (path = 'popup.html') => ({ id: opts.id ?? EXTENSION_ID, url: `${base()}${path}` }),
    // A path, not a URL: under jsdom the global URL is jsdom's own.
    manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'manifest.json'), 'utf8')) as Record<string, unknown>,
    alarms: new Map(),
    local: new Map(),
    updates: [],
    removed: [],
    navigation: (_tabId, url) => [
      { info: { status: 'loading', url }, url },
      { info: { status: 'complete' }, url },
    ],
    scripts: [],
    onScript: () => [{ frameId: 0, result: undefined }],
    invalidate() {
      dead = true;
      id = undefined;
    },
    uninstall() {
      g.chrome = before;
    },
  };

  const area = (store: () => Map<string, unknown>): StorageArea => ({
    async get(keys) {
      alive();
      const map = store();
      const out: Record<string, unknown> = {};
      const want = keys === undefined || keys === null ? [...map.keys()] : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      for (const k of want) {
        if (map.has(k)) out[k] = structuredClone(map.get(k));
        else if (keys && typeof keys === 'object' && !Array.isArray(keys) && k in keys) out[k] = (keys as Record<string, unknown>)[k];
      }
      return out;
    },
    async set(items) {
      alive();
      for (const [k, v] of Object.entries(items)) store().set(k, structuredClone(v));
    },
    async remove(keys) {
      alive();
      for (const k of typeof keys === 'string' ? [keys] : keys) store().delete(k);
    },
    async clear() {
      alive();
      store().clear();
    },
  });

  const onMessage = new FakeMessageEvent(alive);
  const onUpdated = new FakeUpdatedEvent(alive);
  const onRemoved = new FakeRemovedEvent(alive);
  const chrome: ChromeFake = {
    runtime: {
      get id() {
        return id;
      },
      lastError: undefined,
      getURL(path) {
        alive();
        return `${base()}${path.replace(/^\/+/, '')}`;
      },
      async sendMessage(msg) {
        alive();
        return onMessage.dispatch(msg, model.sender);
      },
      onMessage,
      getManifest() {
        alive();
        return structuredClone(model.manifest);
      },
      onStartup: new FakeSimpleEvent<[]>(alive),
      onInstalled: new FakeSimpleEvent<[{ reason: string }]>(alive),
    },
    alarms: {
      async create(name, info) {
        alive();
        model.alarms.set(name, { name, ...info });
      },
      async get(name) {
        alive();
        const a = model.alarms.get(name);
        return a ? { ...a } : undefined;
      },
      async clear(name) {
        alive();
        return model.alarms.delete(name);
      },
      onAlarm: new FakeSimpleEvent<[{ name: string; scheduledTime: number }]>(alive),
    },
    scripting: {
      async executeScript(call) {
        alive();
        model.scripts.push(call);
        if (!tabs.has(call.target.tabId)) throw new Error(`No tab with id: ${call.target.tabId}`);
        return model.onScript(call);
      },
    },
    tabs: {
      async get(tabId) {
        alive();
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id: ${tabId}.`);
        return copy(t);
      },
      async query(q) {
        alive();
        const win = q.lastFocusedWindow || q.currentWindow ? model.focusedWindow : (q.windowId ?? null);
        return [...tabs.values()].filter((t) => (q.active === undefined || t.active === q.active) && (win === null || t.windowId === win)).map(copy);
      },
      async sendMessage(tabId, msg) {
        alive();
        sent.set(tabId, [...(sent.get(tabId) ?? []), msg]);
        const page = pages.get(tabId);
        if (!page) throw new Error(NO_RECEIVER_ERROR);
        return page(msg);
      },
      async captureVisibleTab(windowId, options) {
        alive();
        model.captures.push({ windowId, options });
        if (failing) {
          const { kind } = failing;
          failing.times -= 1;
          if (failing.times <= 0) failing = null;
          throw new Error(kind === 'permission' ? CAPTURE_PERMISSION_ERROR : kind === 'quota' ? CAPTURE_QUOTA_ERROR : kind);
        }
        return `data:image/jpeg;base64,${model.captureImage.toString('base64')}`;
      },
      async create(p) {
        alive();
        model.opened.push(p.url ?? '');
        const id = Math.max(0, ...tabs.keys()) + 1;
        return model.addTab({ id, windowId: p.windowId ?? model.focusedWindow ?? 1, url: p.url ?? '', active: p.active ?? true });
      },
      onRemoved,
      async update(tabId, p) {
        alive();
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        model.updates.push({ tabId, ...(p.url !== undefined ? { url: p.url } : {}), ...(p.muted !== undefined ? { muted: p.muted } : {}) });
        if (p.muted !== undefined) tab.muted = p.muted;
        if (p.url !== undefined) {
          const steps = model.navigation(tabId, p.url);
          void (async () => {
            for (const step of steps) {
              await new Promise((r) => setTimeout(r, 0));
              const now = tabs.get(tabId);
              if (!now) return;
              if (step.url !== undefined) now.url = step.url;
              onUpdated.dispatch(tabId, step.info, { id: tabId, ...(step.url !== undefined ? { url: step.url } : {}), ...(step.info.status ? { status: step.info.status } : {}) });
            }
          })();
        }
        return copy(tab);
      },
      async remove(tabId) {
        alive();
        if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
        model.removed.push(tabId);
        model.removeTab(tabId);
        onRemoved.dispatch(tabId);
      },
      onUpdated,
    },
    storage: {
      session: area(() => model.session),
      local: area(() => model.local),
    },
    permissions: {
      async contains(p) {
        alive();
        // As Chrome: <all_urls> covers every web origin.
        return (p.origins ?? []).every((o) => model.granted.has(o) || (model.granted.has('<all_urls>') && /^https?:/.test(o)));
      },
      async request(p) {
        alive();
        model.requested.push([...(p.origins ?? [])]);
        if (model.permissionAnswer) for (const o of p.origins ?? []) model.granted.add(o);
        return model.permissionAnswer;
      },
    },
    commands: {
      onCommand: new FakeCommandEvent(alive),
      async getAll() {
        alive();
        // As Chrome lists them: the toolbar action's own entry first, then the manifest's command.
        return [
          { name: '_execute_action', description: '', shortcut: '' },
          { name: 'take-screenshot', description: 'Take a screenshot of the meeting', shortcut: model.shortcut },
        ];
      },
    },
  };
  g.chrome = chrome;
  return { chrome, model };
}
