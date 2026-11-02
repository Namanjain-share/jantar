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
 *
 * v0.10: a start with `cc` (the worker's Settings switch, on by default)
 * also switches the call's captions on (captions.ts), stopped with notes.
 * The caption watch: no caption line in the first TIMING.noCaptionsMs of
 * notes is `none`, with the bubble naming this client's way to turn captions
 * on; still none TIMING.captionsRecheckMs later, the bubble once more. That
 * is all: once lines came, a silence says nothing (nobody may be talking),
 * only the captions gone for TIMING.noCaptionsMs does. A line clears it.
 */
import type { LineUpsert } from '@jantar/protocol';
import { noCaptions } from '../shared/captions.js';
import type { CaptionsState, CcResult, FromPage, LinesAnswer } from '../shared/messages.js';
import { TIMING, WIRE_LIMITS } from '../shared/wire.js';
import { showsText } from './adapters/dom.js';
import type { Block, HookId, SiteAdapter } from './adapters/types.js';
import { switchCaptionsOn, type CaptionsSwitch } from './captions.js';
import { createTracker, type Tracker } from './tracker.js';

export type LinesMessage = Extract<FromPage, { t: 'lines' }>;

/** This many upserts waiting means Jantar has been away too long: notes stop. */
export const PENDING_MAX = 20_000;
/** Failing this long, the page says so (once per outage). */
export const NOT_ANSWERING_MS = 10_000;
export const NOT_ANSWERING = 'Jantar is not answering. Notes wait in this tab until it is back.';
export const UNREACHABLE = 'Notes stopped: Jantar has been unreachable too long.';
export const NOT_FOUND = "Can't read captions on this page. Screenshots still work.";
/** v0.10: the no-captions bubble stays this long (it was easy to miss at 8 s). */
export const NO_CAPTIONS_BUBBLE_MS = 20_000;

export interface CaptureOptions {
  adapter: SiteAdapter;
  doc: Document;
  /** Send `lines` to the worker; resolves its answer, or undefined when none came. */
  send(msg: LinesMessage): Promise<LinesAnswer | undefined>;
  /** The captions state changed (the page tells the worker). */
  captions(state: CaptionsState): void;
  /** v0.10: how switching the captions on went (a start with `cc`). */
  cc?(result: CcResult, hook: HookId): void;
  /** Show one bubble (for `ms`, else the button's own time). */
  bubble(text: string, ms?: number): void;
  /** Notes stopped here (the worker's `retry: false`, or too much waiting). */
  onStop?(): void;
  /** A fresh nonce per start (tests pass their own). */
  nonce?(): string;
}

export interface Capture {
  readonly on: boolean;
  /** v0.10: `cc`: also switch the call's captions on. */
  start(opts?: { cc?: boolean }): void;
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
  let unreadSince: number | null = null;
  /** When the first change not read yet came. */
  let changedAt: number | null = null;
  /** v0.10: when notes started here; whether a line was ever read since; the no-captions bubbles shown (two at most); since when the captions went after lines came. */
  let startedAt = 0;
  let everRead = false;
  let nudges = 0;
  let goneSince: number | null = null;
  let ccSwitch: CaptionsSwitch | null = null;

  const setState = (next: CaptionsState) => {
    if (next === state) return;
    state = next;
    o.captions(next);
    if (next === 'none') o.bubble(noCaptions(o.adapter.cc.client(o.doc)), NO_CAPTIONS_BUBBLE_MS);
    else if (next === 'notFound') o.bubble(NOT_FOUND);
  };

  const judge = () => {
    const now = Date.now();
    if (region && blocksSeen > 0) {
      everRead = true;
      goneSince = null;
      setState('reading');
      return;
    }
    if (region && unreadSince !== null && now - unreadSince >= TIMING.notFoundMs) {
      setState('notFound');
      return;
    }
    if (!everRead) {
      // The first minute of notes, then one recheck: nothing tells whether anyone is speaking, so no more than that.
      if (nudges < 2 && now - startedAt >= TIMING.noCaptionsMs + nudges * TIMING.captionsRecheckMs) {
        nudges += 1;
        if (state === 'none') o.bubble(noCaptions(o.adapter.cc.client(o.doc)), NO_CAPTIONS_BUBBLE_MS);
        else setState('none');
      }
      return;
    }
    // Lines came, and then the captions went (turned off, or lost on a reconnect).
    if (region) goneSince = null;
    else if (now - (goneSince ??= now) >= TIMING.noCaptionsMs) setState('none');
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
    ccSwitch?.stop();
    ccSwitch = null;
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
    start(opts = {}) {
      if (on) return;
      on = true;
      run += 1;
      pending = new Map();
      inFlight = null;
      tracker = createTracker({ nonce: (o.nonce ?? makeNonce)() });
      region = null;
      state = null;
      blocksSeen = 0;
      startedAt = Date.now();
      everRead = false;
      nudges = 0;
      goneSince = null;
      unreadSince = null;
      changedAt = null;
      failingSince = null;
      toldDown = false;
      if (opts.cc) ccSwitch = switchCaptionsOn({ cc: o.adapter.cc, doc: o.doc, report: (result, hook) => o.cc?.(result, hook) });
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
