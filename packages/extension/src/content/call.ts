/**
 * The call watch (spec 3.6): on every page of the four hosts, a setTimeout
 * poll every `callPollMs` (never requestAnimationFrame, which stops in a
 * hidden tab; no observer on the body) asks the adapter whether a call is
 * on, its key and its title. Nothing else is read here.
 *
 *   out ──(in a call)──▶ in ──(hooks gone)──▶ leaving ──(60 s)──▶ out, sends `left`
 *                          ◀──(back, same call)──┘
 *
 * A toolbar re-render, Teams' mini window, a screen share or Meet's
 * picture-in-picture can hide the in-call hooks for a few seconds, so a call
 * is left only after `leaveGraceMs` without them; back in the same call
 * (the same Meet code; on Teams any call) within it is the same meeting. A
 * new Meet code ends the old call at once. A page that was never in a call
 * (the waiting room, also after a reload) never sends `left`, so no meeting
 * is ever made that the call cannot end.
 *
 * `call` goes to the worker when the page loads (it learns whether to show
 * the camera button), on entering a call, on a new key or title, every
 * `keepAliveMs` while in the call (the meeting's keep-alive), and with
 * `left` when the grace runs out. While leaving, the page still counts as in
 * the call: only `left` ends it.
 */
import type { CallAnswer, FromPage } from '../shared/messages.js';
import { TIMING } from '../shared/wire.js';
import type { SiteAdapter } from './adapters/types.js';

export type CallPhase = 'out' | 'in' | 'leaving';
export type CallMessage = Extract<FromPage, { t: 'call' }>;

export interface CallWatchOptions {
  adapter: SiteAdapter;
  doc: Document;
  /** Send `call` to the worker; resolves its answer, or undefined when none came. */
  send(msg: CallMessage): Promise<CallAnswer | undefined>;
  /** Every answer the worker gave. */
  onAnswer?(answer: CallAnswer): void;
  /** The phase changed. */
  onPhase?(phase: CallPhase): void;
}

export interface CallWatch {
  start(): void;
  stop(): void;
  phase(): CallPhase;
}

export function createCallWatch(o: CallWatchOptions): CallWatch {
  let phase: CallPhase = 'out';
  /** The call's key while in or leaving. */
  let key: string | null = null;
  /** What the worker last heard (undefined: nothing yet). */
  let sentKey: string | null | undefined;
  let sentTitle: string | undefined;
  let sentAt = 0;
  /** The last message went unanswered: send it again after linesRetryMs. */
  let unanswered: CallMessage | null = null;
  let goneAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const setPhase = (next: CallPhase) => {
    if (next === phase) return;
    phase = next;
    o.onPhase?.(next);
  };

  const send = (msg: CallMessage, now: number) => {
    sentKey = msg.callKey;
    sentTitle = msg.title;
    sentAt = now;
    unanswered = null;
    void o.send(msg).then(
      (answer) => {
        if (!running) return;
        if (answer && typeof answer === 'object') o.onAnswer?.(answer);
        else unanswered = msg;
      },
      () => {
        if (running) unanswered = msg;
      },
    );
  };

  const tick = () => {
    const now = Date.now();
    let k: string | null = null;
    let inCall = false;
    let title = '';
    try {
      k = o.doc.location ? o.adapter.callKey(o.doc.location) : null;
      inCall = o.adapter.inCall(o.doc);
      title = o.adapter.title(o.doc);
    } catch {
      // A page in the middle of a change: the next poll looks again.
      return;
    }
    let left = false;
    let entered = false;
    if (phase !== 'out' && k !== null && k !== key) {
      // Another Meet code: the old call is over now (the worker ends its meeting).
      key = k;
      setPhase(inCall ? 'in' : 'out');
      entered = inCall;
    } else if (phase === 'out') {
      if (inCall) {
        key = k;
        setPhase('in');
        entered = true;
      }
    } else if (inCall) {
      setPhase('in');
    } else if (phase === 'in') {
      goneAt = now;
      setPhase('leaving');
    } else if (now - goneAt >= TIMING.leaveGraceMs) {
      setPhase('out');
      left = true;
    }

    const site = o.adapter.site;
    // In a call the message names the call's key; out of one, the page's.
    const callKey = phase === 'out' && !left ? k : key;
    if (left) send({ t: 'call', site, inCall: false, left: true, callKey, title }, now);
    else if (entered || callKey !== sentKey || title !== sentTitle || (phase !== 'out' && now - sentAt >= TIMING.keepAliveMs)) {
      send({ t: 'call', site, inCall: phase !== 'out', callKey, title }, now);
    } else if (unanswered && now - sentAt >= TIMING.linesRetryMs) send({ ...unanswered, title }, now);
  };

  const loop = () => {
    if (!running) return;
    tick();
    if (running) timer = setTimeout(loop, TIMING.callPollMs);
  };

  return {
    start() {
      if (running) return;
      running = true;
      loop();
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
    phase: () => phase,
  };
}
