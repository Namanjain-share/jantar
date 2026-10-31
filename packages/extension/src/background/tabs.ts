/**
 * What the worker knows per tab, in chrome.storage.session (in memory,
 * kept across the worker's stops, gone when Chrome quits or the extension
 * reloads; not exposed to content scripts). One record per meeting tab,
 * `tab:<id>`, made by the page's first `call` and dropped on tabs.onRemoved.
 *
 * Two kinds of serialising, both in memory (an operation in flight dies
 * with the worker anyway):
 * - `patch` reads, changes and writes one tab's record, one at a time per
 *   tab, so a captions update never undoes a Start that finished meanwhile.
 * - `serial` runs one meeting step per tab at a time (Start, End, a call's
 *   leave, a screenshot's open and upload, a tab closing), so two of them
 *   never make two meetings for one call.
 */
import type { CaptionsState } from '../shared/messages.js';
import type { MeetingSite } from '../shared/sites.js';

export interface TabState {
  site: MeetingSite;
  /** The page's call watch is in a call (not the waiting room). */
  inCall: boolean;
  /** Meet's code; null on Teams (the tab is the call). */
  callKey: string | null;
  /** The page's title, for the Name field. */
  title: string;
  /** This tab's meeting: the uuid its capture routes are keyed by. */
  clientId?: string;
  /** The meeting's name, once there is one. */
  name?: string;
  /** Start was pressed for this meeting: the page reads captions. */
  notes: boolean;
  /** Screenshots saved into this meeting. */
  shots: number;
  captions: CaptionsState | 'unknown';
  /** When the last keep-alive went (ms). */
  lastKeepAlive?: number;
}

/** A tab's record without its meeting (after End, a leave or a 404). */
export function withoutMeeting(s: TabState): TabState {
  return { site: s.site, inCall: s.inCall, callKey: s.callKey, title: s.title, notes: false, shots: 0, captions: 'unknown' };
}

const PREFIX = 'tab:';
const keyOf = (tabId: number) => `${PREFIX}${tabId}`;

/** One promise chain per key: `run` waits for the ones before it. */
function chains() {
  const tails = new Map<number, Promise<unknown>>();
  return <T>(tabId: number, fn: () => Promise<T>): Promise<T> => {
    const before = tails.get(tabId) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(tabId, tail);
    void tail.then(() => {
      if (tails.get(tabId) === tail) tails.delete(tabId);
    });
    return run;
  };
}

export interface Tabs {
  read(tabId: number): Promise<TabState | null>;
  /** Change one tab's record (null drops it); answers what was written. */
  patch(tabId: number, fn: (cur: TabState | null) => TabState | null): Promise<TabState | null>;
  drop(tabId: number): Promise<void>;
  /** Every tab the worker holds a record for. */
  ids(): Promise<number[]>;
  /** One meeting step per tab at a time. */
  serial<T>(tabId: number, fn: () => Promise<T>): Promise<T>;
}

function isTabState(v: unknown): v is TabState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (s.site === 'meet' || s.site === 'teams') && typeof s.inCall === 'boolean' && typeof s.notes === 'boolean' && typeof s.shots === 'number';
}

export function createTabs(): Tabs {
  const patches = chains();
  const read = async (tabId: number): Promise<TabState | null> => {
    const got = await chrome.storage.session.get(keyOf(tabId));
    const v = got[keyOf(tabId)];
    return isTabState(v) ? v : null;
  };
  return {
    read,
    patch: (tabId, fn) =>
      patches(tabId, async () => {
        const next = fn(await read(tabId));
        if (next) await chrome.storage.session.set({ [keyOf(tabId)]: next });
        else await chrome.storage.session.remove(keyOf(tabId));
        return next;
      }),
    drop: (tabId) => patches(tabId, () => chrome.storage.session.remove(keyOf(tabId))),
    async ids() {
      const all = await chrome.storage.session.get(null);
      return Object.keys(all)
        .filter((k) => k.startsWith(PREFIX))
        .map((k) => Number(k.slice(PREFIX.length)))
        .filter((n) => Number.isInteger(n));
    },
    serial: chains(),
  };
}
