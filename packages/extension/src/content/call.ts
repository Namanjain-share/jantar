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
 *
 * v0.10, the stage (Start when I join), beside the phases and changing none
 * of them. Each poll's raw stage is the call (an in-call hook), else the
 * adapter's join screen or waiting room, else none. The page reports a stage
 * only once it held STAGE_STABLE_POLLS polls in a row, so the call (`in`)
 * needs the in-call hooks Start trusts on two polls running: a one-poll
 * flicker in the waiting room never reports it. While leaving the stage
 * stays as it was. After this page sent `left` (having been in the call) the
 * stage is `left` until a real join or waiting-room hook, the call, or a new
 * Meet code. Every `call` carries the stage and its hook id; one more goes
 * whenever the stage changes, every keepAliveMs while the page shows a join
 * screen, a waiting room or `left` (the worker's sign the page is still
 * there), and once on pagehide (`hide`, stage none, hook `page:hide`).
 * Where this page saw a join hook is kept in memory only (`joinHookAt`, for
 * Teams' waiting room after Join now) and never sent.
 */
import type { CallAnswer, CallStage, FromPage } from '../shared/messages.js';
import { STAGE_STABLE_POLLS, TIMING } from '../shared/wire.js';
import { pageAt } from './adapters/dom.js';
import type { HookId, SiteAdapter, Waiting } from './adapters/types.js';

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
  /** v0.10: the stage as the worker last heard it. */
  stage(): CallStage;
  /** v0.10: the page is going away (a reload, a navigation, the tab closing): one last `call`, not awaited. */
  hide(): void;
}

/** v0.10: the stages that beat every keepAliveMs (the arm's sign the page is still there). */
const WAITING: ReadonlySet<CallStage> = new Set(['prejoin', 'lobby', 'left']);

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
  // v0.10: the stable stage and its hook, and what the worker last heard.
  let stage: CallStage = 'none';
  let hook: HookId = '';
  let sentStage: CallStage | undefined;
  /** The last poll's raw stage, and how many polls in a row it held. */
  let rawStage: CallStage | null = null;
  let held = 0;
  /** This page sent `left` from the call: the code it left (null on Teams); undefined when it did not. */
  let leftFrom: string | null | undefined;
  /** Where this page last saw a join hook (path, query and hash, in memory only). */
  let joinHookAt: string | null = null;

  const setStage = (next: CallStage, by: HookId) => {
    stage = next;
    hook = by;
  };

  const setPhase = (next: CallPhase) => {
    if (next === phase) return;
    phase = next;
    o.onPhase?.(next);
  };

  const send = (msg: CallMessage, now: number) => {
    sentKey = msg.callKey;
    sentTitle = msg.title;
    sentStage = msg.stage;
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
    let inHook: HookId | null = null;
    let wait: Waiting | null = null;
    let title = '';
    try {
      k = o.doc.location ? o.adapter.callKey(o.doc.location) : null;
      inHook = o.adapter.inCallHook(o.doc);
      if (inHook === null) wait = o.adapter.waiting(o.doc, { joinHookAt });
      title = o.adapter.title(o.doc);
    } catch {
      // A page in the middle of a change: the next poll looks again.
      return;
    }
    const inCall = inHook !== null;
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

    // v0.10: the stage, from this poll's raw stage once it held STAGE_STABLE_POLLS polls in a row.
    const raw: CallStage = inHook !== null ? 'in' : (wait?.stage ?? 'none');
    const rawHook = inHook ?? wait?.hook ?? '';
    if (wait?.stage === 'prejoin' && wait.strong) joinHookAt = pageAt(o.doc.location);
    held = raw === rawStage ? held + 1 : 1;
    rawStage = raw;
    const stable = held >= STAGE_STABLE_POLLS;
    if (left) {
      // Only a page that was in the call has left it; a waiting room's one-poll flicker keeps its stage.
      if (stage === 'in') {
        setStage('left', 'page:left');
        leftFrom = key;
      }
    } else if (phase === 'in') {
      if (raw === 'in' && stable) {
        setStage('in', rawHook);
        // In the call: the join screen seen before is no proof of a waiting room any more.
        joinHookAt = null;
        leftFrom = undefined;
      }
    } else if (phase === 'out') {
      if (leftFrom !== undefined && k !== null && k !== leftFrom) leftFrom = undefined;
      if (stable && (leftFrom === undefined || wait?.strong === true)) {
        leftFrom = undefined;
        setStage(raw, rawHook);
      }
    }

    const site = o.adapter.site;
    // In a call the message names the call's key; out of one, the page's.
    const callKey = phase === 'out' && !left ? k : key;
    const tag = { stage, ...(hook ? { hook } : {}) };
    if (left) send({ t: 'call', site, inCall: false, left: true, callKey, title, ...tag }, now);
    else if (entered || callKey !== sentKey || title !== sentTitle || stage !== sentStage || ((phase !== 'out' || WAITING.has(stage)) && now - sentAt >= TIMING.keepAliveMs)) {
      send({ t: 'call', site, inCall: phase !== 'out', callKey, title, ...tag }, now);
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
    stage: () => stage,
    hide() {
      if (!running) return;
      // What the worker last heard of the call, so a reload never reads as another call; the next poll (a page kept in
      // the back-forward cache and shown again) says where the page is.
      const msg: CallMessage = { t: 'call', site: o.adapter.site, inCall: phase !== 'out', callKey: sentKey ?? null, title: sentTitle ?? '', stage: 'none', hook: 'page:hide' };
      sentStage = undefined;
      void o.send(msg).catch(() => undefined);
    },
  };
}
