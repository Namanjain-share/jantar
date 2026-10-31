/**
 * The capture loop (spec 3.6): reads the captions only between
 * `capture {on: true}` (or a CallAnswer with `notes: true`, which resumes
 * notes after a reload with a new nonce) and `capture {on: false}`. Nothing
 * is read before: the adapter's `blocks()` is never called and the region
 * never observed (MP6).
 *
 * While on: every poll re-finds the region and observes only it (no
 * observer on the body); a change is read `debounceMs` after it settles, or
 * at once when the first change not yet read is `linesEveryMs` old (a fluent
 * speaker never lets the captions settle), through the tracker, into a
 * pending map of upserts (by lineId, newest revision). One `lines` message
 * of at most 200 goes at most every `linesEveryMs`, one in flight. Lines
 * wait in this page's memory until the worker says the daemon took them:
 * there is no offline queue anywhere else. It keeps reading while the call
 * watch is leaving.
 */
import type { LineUpsert } from '@jantar/protocol';
import type { CaptionsState, FromPage, LinesAnswer } from '../shared/messages.js';
import { TIMING, WIRE_LIMITS } from '../shared/wire.js';
import { showsText } from './adapters/dom.js';
import type { Block, SiteAdapter } from './adapters/types.js';
import { createTracker, type Tracker } from './tracker.js';

export type LinesMessage = Extract<FromPage, { t: 'lines' }>;

/** This many upserts waiting means Jantar has been away too long: notes stop. */
export const PENDING_MAX = 20_000;
/** Failing this long, the page says so (once per outage). */
export const NOT_ANSWERING_MS = 10_000;
export const NOT_ANSWERING = 'Jantar is not answering. Notes wait in this tab until it is back.';
export const UNREACHABLE = 'Notes stopped: Jantar has been unreachable too long.';
export const NOT_FOUND = "Can't read captions on this page. Screenshots still work.";

export interface CaptureOptions {
  adapter: SiteAdapter;
  doc: Document;
  /** Send `lines` to the worker; resolves its answer, or undefined when none came. */
  send(msg: LinesMessage): Promise<LinesAnswer | undefined>;
  /** The captions state changed (the page tells the worker). */
  captions(state: CaptionsState): void;
  /** Show one bubble. */
  bubble(text: string): void;
  /** Notes stopped here (the worker's `retry: false`, or too much waiting). */
  onStop?(): void;
  /** A fresh nonce per start (tests pass their own). */
  nonce?(): string;
}

export interface Capture {
  readonly on: boolean;
  start(): void;
  /**
   * Stop reading. `final` (End, a leave): the open lines are closed and what
   * waits goes in one last `lines` message first. Otherwise what waits is
   * dropped, and `text` shows in the bubble.
   */
  stop(opts?: { final?: boolean; text?: string }): Promise<void>;
  /** The page is going away: one last `lines` message, not awaited (it may never arrive). */
  last(): void;
  /** How many upserts wait. */
  pending(): number;
}

export function createCapture(o: CaptureOptions): Capture {
  let on = false;
  /** Bumped at every start and stop: an answer for an older run changes nothing but the pending map. */
  let run = 0;
  let tracker: Tracker | null = null;
  let region: Element | null = null;
  let observer: MutationObserver | null = null;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  /** This run's waiting upserts (a new run gets a new map: End's last lines never mix with the next meeting's). */
  let pending = new Map<string, LineUpsert>();
  let inFlight: Promise<void> | null = null;
  let sentAt = Number.NEGATIVE_INFINITY;
  let failingSince: number | null = null;
  let toldDown = false;
  let state: CaptionsState | null = null;
  let blocksSeen = 0;
  let noRegionSince: number | null = null;
  let unreadSince: number | null = null;
  /** When the first change not read yet came. */
  let changedAt: number | null = null;

  const setState = (next: CaptionsState) => {
    if (next === state) return;
    state = next;
    o.captions(next);
    if (next === 'none') o.bubble(o.adapter.howTo);
    else if (next === 'notFound') o.bubble(NOT_FOUND);
  };

  const judge = () => {
    const now = Date.now();
    if (!region) {
      noRegionSince ??= now;
      if (now - noRegionSince >= TIMING.noCaptionsMs) setState('none');
      return;
    }
    noRegionSince = null;
    if (blocksSeen > 0) setState('reading');
    else if (unreadSince !== null && now - unreadSince >= TIMING.notFoundMs) setState('notFound');
  };

  const keep = (ups: readonly LineUpsert[]) => {
    for (const up of ups) {
      const had = pending.get(up.lineId);
      if (!had || had.rev < up.rev) pending.set(up.lineId, up);
    }
  };

  /** Read the region now: its blocks through the tracker into the pending map. */
  const read = () => {
    clearTimeout(debounce);
    changedAt = null;
    if (!on || !region || !tracker) return;
    const now = Date.now();
    let blocks: Block[] = [];
    try {
      blocks = o.adapter.blocks(region);
    } catch {
      blocks = [];
    }
    keep(tracker.scan(blocks, now));
    blocksSeen = blocks.length;
    if (blocks.length) unreadSince = null;
    else if (showsText(region)) unreadSince ??= now;
    else unreadSince = null;
    if (pending.size >= PENDING_MAX) {
      void stopHere(UNREACHABLE);
      return;
    }
    judge();
    queue();
  };

  /** Changes have waited a whole send interval unread: the debounce gives way. */
  const overdue = () => changedAt !== null && Date.now() - changedAt >= TIMING.linesEveryMs;

  /** Re-find the region; observe only it; a new one is read at once, one that went closes every line. */
  const refind = () => {
    let next: Element | null = null;
    try {
      next = o.adapter.region(o.doc);
    } catch {
      next = null;
    }
    if (next === region) return;
    observer?.disconnect();
    observer = null;
    if (region && !next) tracker?.flush();
    region = next;
    blocksSeen = 0;
    unreadSince = null;
    if (!next) return;
    observer = new MutationObserver(() => {
      changedAt ??= Date.now();
      if (overdue()) read();
      else {
        clearTimeout(debounce);
        debounce = setTimeout(read, TIMING.debounceMs);
      }
    });
    observer.observe(next, { childList: true, characterData: true, subtree: true });
    read();
  };

  const loop = () => {
    if (!on) return;
    refind();
    if (overdue()) read();
    judge();
    if (on) poll = setTimeout(loop, TIMING.callPollMs);
  };

  /** The oldest waiting upserts, at most one post's worth. */
  const batch = (map: Map<string, LineUpsert>): LineUpsert[] => {
    const out: LineUpsert[] = [];
    for (const up of map.values()) {
      if (out.length >= WIRE_LIMITS.linesPerPost) break;
      out.push(up);
    }
    return out;
  };

  /** One `lines` message from `map`. True when the daemon took it. */
  const post = async (mine: number, map: Map<string, LineUpsert>): Promise<boolean> => {
    const lines = batch(map);
    if (!lines.length) return true;
    sentAt = Date.now();
    let answer: LinesAnswer | undefined;
    try {
      answer = await o.send({ t: 'lines', lines });
    } catch {
      answer = undefined;
    }
    if (answer?.ok) {
      // Drop what went, unless a newer revision arrived meanwhile.
      for (const up of lines) if (map.get(up.lineId)?.rev === up.rev) map.delete(up.lineId);
      failingSince = null;
      toldDown = false;
      return true;
    }
    if (mine !== run) return false;
    if (answer && !answer.ok && !answer.retry) {
      void stopHere(answer.text);
      return false;
    }
    // Jantar did not answer: everything stays, and goes again after linesRetryMs.
    const now = Date.now();
    failingSince ??= now;
    if (!toldDown && now - failingSince >= NOT_ANSWERING_MS) {
      toldDown = true;
      o.bubble(NOT_ANSWERING);
    }
    return false;
  };

  const queue = (wait?: number) => {
    if (!on || inFlight || sendTimer !== undefined || pending.size === 0) return;
    const delay = wait ?? Math.max(0, sentAt + TIMING.linesEveryMs - Date.now());
    const mine = run;
    const map = pending;
    sendTimer = setTimeout(() => {
      sendTimer = undefined;
      if (mine !== run) return;
      const going = post(mine, map).then((ok) => {
        if (inFlight === going) inFlight = null;
        if (mine === run) queue(ok ? undefined : TIMING.linesRetryMs);
      });
      inFlight = going;
    }, delay);
  };

  const halt = () => {
    on = false;
    run += 1;
    clearTimeout(poll);
    clearTimeout(debounce);
    clearTimeout(sendTimer);
    sendTimer = undefined;
    observer?.disconnect();
    observer = null;
  };

  /** Notes stop here and now: what waits is dropped, `text` says why. */
  const stopHere = async (text: string | undefined) => {
    if (!on) return;
    await capture.stop({ text });
    o.onStop?.();
  };

  const capture: Capture = {
    get on() {
      return on;
    },
    start() {
      if (on) return;
      on = true;
      run += 1;
      pending = new Map();
      inFlight = null;
      tracker = createTracker({ nonce: (o.nonce ?? makeNonce)() });
      region = null;
      state = null;
      blocksSeen = 0;
      noRegionSince = Date.now();
      unreadSince = null;
      changedAt = null;
      failingSince = null;
      toldDown = false;
      loop();
    },
    async stop(opts = {}) {
      if (!on) {
        if (opts.text) o.bubble(opts.text);
        return;
      }
      // Catch up on a change still in its debounce, then close every line.
      if (opts.final) read();
      const t = tracker;
      const flying = inFlight;
      const map = pending;
      halt();
      const mine = run;
      tracker = null;
      region = null;
      state = null;
      if (opts.final) {
        t?.flush();
        if (flying) await flying;
        // Notes are ending: no "not answering" bubble for these.
        toldDown = true;
        // Lines that were already waiting go first; stop at the first refusal.
        for (let i = 0; map.size > 0 && i < PENDING_MAX / WIRE_LIMITS.linesPerPost; i += 1) {
          if (!(await post(mine, map))) break;
        }
      }
      map.clear();
      if (run === mine) inFlight = null;
      if (opts.text) o.bubble(opts.text);
    },
    last() {
      if (!on) return;
      read();
      const lines = batch(pending);
      if (lines.length) void o.send({ t: 'lines', lines }).catch(() => undefined);
    },
    pending: () => pending.size,
  };
  return capture;
}

/** 8 characters for line ids (`<nonce>-<counter>`): a reload starts a new counter, never on old ids. */
export function makeNonce(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (const b of bytes) out += abc[b % abc.length];
  return out;
}
