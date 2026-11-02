/**
 * The service worker's parts, put together: the three listeners the entry
 * adds (index.ts) and what each message does. Every accepted message is
 * answered through sendResponse, later (the listener returns true), so it
 * works on every Chrome from 120; an ignored one gets no answer.
 *
 * The worker never logs caption text, names, titles, keys or images.
 *
 * v0.8: Read saved links (reads.ts): the popup's switch, the read alarm
 * (`onAlarm`), and the alarm put back when the browser starts or the
 * extension is installed or updated (`onStartup`).
 *
 * v0.10: Start when I join (arms.ts, meetings.ts): the popup's `arm`,
 * `disarm` and `always`; the arm alarm beside the read alarm, cleared on
 * startup (session storage is empty then); the popup state's stage, arm and
 * last start by itself; each tab's toolbar badge painted after every
 * message about it.
 *
 * v0.10, captions on when notes start: the popup's `autoCaptions` (Settings,
 * on by default), the page's `cc` (how switching them on went), and the
 * badge painted again on the page's captions state (`!` while notes are on
 * with no captions yet).
 */
import type { AutoStart, CallAnswer, Done, FromPopup, PopupState, ShotAnswer } from '../shared/messages.js';
import { ARM_TIMING } from '../shared/wire.js';
import { acceptPage, acceptPopup, onMeetingPage, type PageMessage } from './accept.js';
import { createArms, viewOf, type Arms } from './arms.js';
import { createClient, type Reply } from './client.js';
import { sendToTab, type Ctx } from './ctx.js';
import { createLines, pickLines } from './lines.js';
import { autoCaptions, createMeetings, setAutoCaptions } from './meetings.js';
import { createPairing } from './pairing.js';
import { createReads, type Reads } from './reads.js';
import { MISMATCH, PAIR_AGAIN, SHOT, TRY_AGAIN } from './sentences.js';
import { createShots, readLastShot } from './shots.js';
import type { KeyStore } from './store.js';
import { createTabs } from './tabs.js';

export interface WorkerDeps {
  keys: KeyStore;
  fetch: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  uuid?: () => string;
  timeouts?: { call: number; shot: number };
  /** v0.8: a read's own limits (tests shorten them). */
  readLimits?: { jobMs?: number; completeMs?: number };
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
  /** v0.8: chrome.alarms.onAlarm (the read alarm wakes the reads). */
  onAlarm(alarm: { name: string }): void;
  /** v0.8: chrome.runtime.onStartup and onInstalled: the read alarm back while the switch is on. */
  onStartup(): void;
  /** What the popup shows (also its `state` answer). */
  popupState(tabId: number): Promise<PopupState>;
  /** v0.8: Read saved links. */
  readonly reads: Reads;
  /** v0.10: Start when I join. */
  readonly arms: Arms;
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

/** The shortcut Chrome holds for the screenshot as it shows it ("⌥⇧S"); '' when none is set (another extension took the key). */
async function shortcutOf(): Promise<string> {
  try {
    const all = await chrome.commands.getAll();
    return all.find((c) => c.name === SHOT_COMMAND)?.shortcut ?? '';
  } catch {
    return '';
  }
}

/** v0.10: the last start by itself the popup shows: one that started while notes are on, one that failed lately while they are off. */
function autoOf(auto: AutoStart | undefined, notes: boolean, now: number): AutoStart | null {
  if (!auto) return null;
  if (auto.ok) return notes ? auto : null;
  return !notes && now - auto.at < ARM_TIMING.failedShowMs ? auto : null;
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
  const arms = createArms(ctx);
  const meetings = createMeetings(ctx, lines, arms);
  const shots = createShots(ctx, meetings);
  const pairing = createPairing(ctx, meetings, arms);
  onForgotten = () => pairing.forgotten(PAIR_AGAIN);
  const readLimits = deps.readLimits;
  const reads = createReads(ctx, readLimits ? { limits: readLimits } : {});

  async function popupState(tabId: number): Promise<PopupState> {
    const [pairingNow, pageButton, shortcut, lastShot, readsOn, always, ccOn] = await Promise.all([
      deps.keys.get(),
      chrome.permissions.contains({ origins: [ALL_URLS] }).catch(() => false),
      shortcutOf(),
      readLastShot(),
      reads.on().catch(() => false),
      arms.always(),
      autoCaptions(),
    ]);
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
    // v0.10: and its arm ends there and then.
    if (!view && (await arms.read(tabId))) {
      await ctx.tabs.serial(tabId, () => arms.drop(tabId));
      await arms.schedule();
    }
    const at = ctx.now();
    const arm = view ? await arms.live(tabId, at) : null;
    const notes = Boolean(view?.clientId && view.notes);
    await arms.paint(tabId);
    return {
      ...head,
      pageButton,
      projects,
      lastShot,
      shortcut,
      reads: readsOn,
      tab: view
        ? {
            site: view.site,
            inCall: view.inCall,
            title: view.title,
            ...(view.clientId && view.name ? { name: view.name } : {}),
            notes,
            shots: view.clientId ? view.shots : 0,
            captions: view.captions,
            client: view.client ?? (view.site === 'meet' ? 'meet' : 'teams'),
            ...(view.captions === 'none' && view.why ? { why: view.why } : {}),
            cc: notes && view.cc ? view.cc : null,
            stage: view.stage ?? (view.inCall ? 'in' : 'none'),
            hook: view.hook ?? '',
            arm: arm ? viewOf(arm) : null,
            auto: autoOf(view.auto, notes, at),
          }
        : null,
      always,
      autoCaptions: ccOn,
    };
  }

  /** Answer `answer`, after the tab's badge is painted again. */
  const painted = async <T>(tabId: number, answer: T): Promise<T> => {
    await arms.paint(tabId);
    return answer;
  };

  async function fromPage(m: PageMessage): Promise<unknown> {
    switch (m.msg.t) {
      case 'call':
        return painted(m.tabId, await meetings.call(m.tabId, m.msg, m.site));
      case 'lines': {
        const answer = await lines.forward(m.tabId, pickLines(m.msg.lines));
        // Notes stopped (a refusal): the badge says so.
        return !answer.ok && !answer.retry ? painted(m.tabId, answer) : answer;
      }
      case 'captions':
        // v0.10: the badge says `!` while notes are on with no captions yet, and clears with the first line.
        return painted(m.tabId, await meetings.captions(m.tabId, m.msg.state, m.msg.client, m.msg.why));
      case 'cc':
        return meetings.cc(m.tabId, { result: m.msg.result, hook: m.msg.hook });
      case 'shot':
        return painted(m.tabId, await shots.take(m.tabId, 'page'));
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
        return painted(msg.tabId, await meetings.start(msg));
      case 'shot':
        return painted(msg.tabId, await shots.take(msg.tabId, 'popup'));
      case 'end':
        return painted(msg.tabId, await meetings.end(msg.tabId));
      case 'reads':
        return reads.set(msg.on);
      case 'arm':
        return painted(msg.tabId, await meetings.arm(msg));
      case 'disarm':
        return painted(msg.tabId, await meetings.disarm(msg.tabId));
      case 'always':
        return arms.setAlways(msg.on);
      case 'autoCaptions':
        return setAutoCaptions(msg.on);
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
    if (t === 'state') return { connection: 'down', pageButton: false, projects: null, tab: null, lastShot: null, shortcut: '', reads: false, always: false, autoCaptions: true } satisfies PopupState;
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
      void deps.keys
        .get()
        .then((p) => (p ? shots.take(tabId, 'command').then(() => arms.paint(tabId)) : undefined))
        .catch(() => undefined);
    },

    onRemoved(tabId) {
      void meetings.removed(tabId).catch(() => undefined);
    },

    onAlarm(alarm) {
      reads.onAlarm(alarm);
      arms.onAlarm(alarm);
    },

    onStartup() {
      reads.restore();
      arms.restore();
    },

    popupState,
    reads,
    arms,
  };
}

