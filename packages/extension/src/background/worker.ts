/**
 * The service worker's parts, put together: the three listeners the entry
 * adds (index.ts) and what each message does. Every accepted message is
 * answered through sendResponse, later (the listener returns true), so it
 * works on every Chrome from 120; an ignored one gets no answer.
 *
 * The worker never logs caption text, names, titles, keys or images.
 */
import type { CallAnswer, Done, FromPopup, PopupState, ShotAnswer } from '../shared/messages.js';
import { acceptPage, acceptPopup, onMeetingPage, type PageMessage } from './accept.js';
import { createClient, type Reply } from './client.js';
import { sendToTab, type Ctx } from './ctx.js';
import { createLines, pickLines } from './lines.js';
import { createMeetings } from './meetings.js';
import { createPairing } from './pairing.js';
import { MISMATCH, PAIR_AGAIN, SHOT, TRY_AGAIN } from './sentences.js';
import { createShots } from './shots.js';
import type { KeyStore } from './store.js';
import { createTabs } from './tabs.js';

export interface WorkerDeps {
  keys: KeyStore;
  fetch: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  uuid?: () => string;
  timeouts?: { call: number; shot: number };
}

/** The command manifest.json names for the shortcut. */
export const SHOT_COMMAND = 'take-screenshot';
/** The page-button grant (D1). */
export const ALL_URLS = '<all_urls>';

type Respond = (answer?: unknown) => void;

export interface Worker {
  onMessage(msg: unknown, sender: chrome.runtime.MessageSender, respond: Respond): boolean;
  onCommand(command: string, tab?: chrome.tabs.Tab): void;
  onRemoved(tabId: number): void;
  /** What the popup shows (also its `state` answer). */
  popupState(tabId: number): Promise<PopupState>;
}

/** The info read's connection (spec 3.10, the notes' PopupState rules). */
function connectionOf(reply: Reply<unknown>): Pick<PopupState, 'connection' | 'sentence'> {
  switch (reply.kind) {
    case 'ok':
      return { connection: 'ok' };
    case 'down':
      return { connection: 'down' };
    case 'unpaired':
      return reply.forgotten ? { connection: 'unpaired', sentence: PAIR_AGAIN } : { connection: 'unpaired' };
    case 'error':
      // Every 403 is Jantar answering and taking nothing now: the switch, or the gate (another Origin, not loopback).
      if (reply.status === 403) return { connection: 'off', sentence: reply.sentence };
      return { connection: 'down', sentence: reply.status === 400 ? MISMATCH : reply.sentence };
  }
}

/** The info reply's projects, each as the sheet needs it; null when Todos are off (or the reply is not a list). */
function projectsOf(body: unknown): PopupState['projects'] {
  const list = (body as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) return null;
  const out: NonNullable<PopupState['projects']> = [];
  for (const p of list.slice(0, 200)) {
    const v = p as { id?: unknown; name?: unknown; emoji?: unknown } | null;
    if (typeof v?.id !== 'string' || typeof v.name !== 'string') continue;
    out.push({ id: v.id, name: v.name, ...(typeof v.emoji === 'string' && v.emoji ? { emoji: v.emoji } : {}) });
  }
  return out;
}

/** The popup holds activeTab for its tab, so Chrome shows that tab's URL to the worker. */
async function stillOnMeetingPage(tabId: number): Promise<boolean> {
  try {
    return onMeetingPage(await chrome.tabs.get(tabId));
  } catch {
    // Chrome has no such tab now.
    return false;
  }
}

export function createWorker(deps: WorkerDeps): Worker {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  // The client is made before pairing exists; its 401 hook reaches pairing through this late binding.
  let onForgotten: () => Promise<void> = async () => undefined;
  const client = createClient({ keys: deps.keys, fetch: deps.fetch, onUnpaired: () => onForgotten(), ...(deps.timeouts ? { timeouts: deps.timeouts } : {}) });
  const ctx: Ctx = { keys: deps.keys, client, tabs: createTabs(), now, sleep, uuid, toTab: sendToTab };
  const lines = createLines(ctx);
  const meetings = createMeetings(ctx, lines);
  const shots = createShots(ctx, meetings);
  const pairing = createPairing(ctx, meetings);
  onForgotten = () => pairing.forgotten(PAIR_AGAIN);

  async function popupState(tabId: number): Promise<PopupState> {
    const [pairingNow, pageButton] = await Promise.all([deps.keys.get(), chrome.permissions.contains({ origins: [ALL_URLS] }).catch(() => false)]);
    let head: Pick<PopupState, 'connection' | 'sentence'> = { connection: 'unpaired' };
    let projects: PopupState['projects'] = null;
    if (pairingNow) {
      const info = await client.call('info');
      head = connectionOf(info);
      if (info.kind === 'ok') projects = projectsOf(info.body);
    }
    // Read after the info call: a 401 there forgets the tab's meeting too.
    const record = await ctx.tabs.read(tabId);
    // A meeting tab that went to another site is not one now: no Start, Screenshot or End offered there.
    const view = record && (await stillOnMeetingPage(tabId)) ? record : null;
    return {
      ...head,
      pageButton,
      projects,
      // v0.5.3 wave 0: the Meetings package reads the last try and the shortcut.
      lastShot: null,
      shortcut: '',
      tab: view
        ? {
            site: view.site,
            inCall: view.inCall,
            title: view.title,
            ...(view.clientId && view.name ? { name: view.name } : {}),
            notes: Boolean(view.clientId && view.notes),
            shots: view.clientId ? view.shots : 0,
            captions: view.captions,
          }
        : null,
    };
  }

  async function fromPage(m: PageMessage): Promise<unknown> {
    switch (m.msg.t) {
      case 'call':
        return meetings.call(m.tabId, m.msg, m.site);
      case 'lines':
        return lines.forward(m.tabId, pickLines(m.msg.lines));
      case 'captions':
        await meetings.captions(m.tabId, m.msg.state);
        return undefined;
      case 'shot':
        return shots.take(m.tabId, 'page');
    }
  }

  async function fromPopup(msg: FromPopup): Promise<PopupState | Done | ShotAnswer> {
    switch (msg.t) {
      case 'state':
        return popupState(msg.tabId);
      case 'pair':
        return pairing.pair(msg.text);
      case 'unpair':
        return pairing.unpair();
      case 'start':
        return meetings.start(msg);
      case 'shot':
        return shots.take(msg.tabId, 'popup');
      case 'end':
        return meetings.end(msg.tabId);
    }
  }

  /** What an answer is when a handler fails in a way it never should. */
  function fallback(t: string, page: boolean): unknown {
    if (page) {
      if (t === 'call') return { button: false, notes: false } satisfies CallAnswer;
      if (t === 'lines') return { ok: false, retry: true };
      if (t === 'shot') return { ok: false, text: SHOT.tryAgain } satisfies ShotAnswer;
      return undefined;
    }
    if (t === 'state') return { connection: 'down', pageButton: false, projects: null, tab: null, lastShot: null, shortcut: '' } satisfies PopupState;
    if (t === 'shot') return { ok: false, text: SHOT.tryAgain } satisfies ShotAnswer;
    return { ok: false, error: TRY_AGAIN } satisfies Done;
  }

  return {
    onMessage(msg, sender, respond) {
      const popup = acceptPopup(msg, sender);
      const page = popup ? null : acceptPage(msg, sender);
      if (!popup && !page) return false;
      const t = popup ? popup.t : (page as PageMessage).msg.t;
      const run = popup ? fromPopup(popup) : fromPage(page as PageMessage);
      run.then(
        (answer) => respond(answer),
        () => respond(fallback(t, page !== null)),
      );
      return true;
    },

    onCommand(command, tab) {
      if (command !== SHOT_COMMAND || typeof tab?.id !== 'number') return;
      const tabId = tab.id;
      // With no key stored the shortcut does nothing.
      void deps.keys.get().then((p) => (p ? shots.take(tabId, 'command') : undefined)).catch(() => undefined);
    },

    onRemoved(tabId) {
      void meetings.removed(tabId).catch(() => undefined);
    },

    popupState,
  };
}

