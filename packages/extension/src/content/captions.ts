/**
 * v0.9.1: the call's own live captions switched on when notes start
 * (research captions-research.md 6). Jantar writes notes from them, and
 * Teams and Meet start every call with them off. Captions are personal:
 * only this user sees them, and nobody in the call is told.
 *
 * It runs only while notes are on (the capture loop starts and stops it:
 * MP6), once per notes run, and only when the worker says the Settings
 * switch is on. Each try reads the control's state first and goes through
 * the adapter's captions path only (its control, More, Language and speech,
 * Meet's pop-up), never anything else, and closes what it opened; then it
 * checks for CC_TIMING.verifyMs that captions came on. At most
 * CC_TIMING.tries tries, CC_TIMING.gapMs apart; a round that finds the
 * site's own menu open (he is in it) counts no try, and CC_TIMING.rounds
 * rounds bound it all. A menu without captions ends it only the second
 * time. Notes stopping ends it at once: nothing more is clicked.
 *
 * It clicks only a control that says off, so it never means to turn
 * captions off. The page's memory (CcMemory) outlives a
 * notes run: once captions were seen on in this call, or Jantar clicked
 * them on, no later notes run in the page clicks again (End then Start, or
 * a second Start): if he turned them off, they stay off. A captions item
 * that says nothing (a Teams guest's) is clicked blind at most once per
 * page, and only when notes start within CC_TIMING.blindMs of the page
 * coming into the call (captions start off). How it went, and the hook id
 * that decided it, goes to `report` (Settings › Call check).
 */
import type { CcResult } from '../shared/messages.js';
import type { CaptionsControl, HookId } from './adapters/types.js';

export const CC_TIMING = Object.freeze({
  tries: 3,
  gapMs: 10_000,
  verifyMs: 5_000,
  pollMs: 500,
  rounds: 12,
  blindMs: 60_000,
});

/** v0.9.1: the page's memory of switching captions on, for the page load (a reload forgets it). */
export interface CcMemory {
  /** The call it holds: Meet's code, '' on Teams (the tab is the call). */
  key: string | null;
  /** Captions were on in this call, Jantar turned them on, or Jantar clicked them on: no notes run clicks again. */
  seen: CcResult | null;
  /** This page's one blind click is spent. */
  blind: boolean;
}

export const ccMemory = (): CcMemory => ({ key: null, seen: null, blind: false });

/** The memory for the call `key` (null: forget the call, as on leaving it); the blind click stays spent. */
export function ccCall(m: CcMemory, key: string | null): CcMemory {
  if (m.key !== key) Object.assign(m, { key, seen: null });
  return m;
}

export interface CaptionsSwitch {
  /** Notes stopped: no more tries, and nothing reported. */
  stop(): void;
}

export interface CaptionsSwitchOptions {
  cc: CaptionsControl;
  doc: Document;
  /** The page's memory for this call. */
  memory: CcMemory;
  /** Notes started soon enough after the page came into the call for a blind click. */
  blind: boolean;
  report(result: CcResult, hook: HookId): void;
}

export function switchCaptionsOn(o: CaptionsSwitchOptions): CaptionsSwitch {
  const m = o.memory;
  let stopped = false;
  let reported = false;
  /** The hook of the last click or key, while nothing has shown captions on since. */
  let clicked: HookId | null = null;
  /** Lets the wait in progress go at once (stop); the run waits for one thing at a time. */
  let wake = () => {};
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const done = (result: CcResult, hook: HookId) => {
    if (stopped) return;
    stopped = reported = true;
    if (result === 'was-on' || result === 'turned-on' || result === 'clicked') m.seen ??= result;
    o.report(result, hook);
  };
  const on = (hook: HookId) => done(clicked ? 'turned-on' : 'was-on', clicked ?? hook);

  const run = async () => {
    const at = o.cc.state(o.doc);
    // On earlier in this call: never touched again (he may have turned them off since).
    if (m.seen) return at.state === 'on' ? done('was-on', at.hook) : done('kept', at.hook);
    let last: HookId = at.hook;
    let tries = 0;
    let unavailable = 0;
    for (let round = 0; round < CC_TIMING.rounds && tries < CC_TIMING.tries && !stopped; round += 1) {
      const began = Date.now();
      const now = o.cc.state(o.doc);
      last = now.hook;
      if (now.state === 'on') return on(now.hook);
      // A click nothing on the page confirms (Teams shows captions once someone speaks): never a second blind one.
      if (clicked && now.state === 'unknown') return done('clicked', clicked);
      const step = await o.cc.turnOn(o.doc, { wait, attempt: tries + 1, blind: o.blind && !m.blind, live: () => !stopped });
      if (step.result === 'clicked') clicked = step.hook;
      if (step.blind) m.blind = true;
      if (stopped) return;
      last = step.hook;
      if (step.result === 'on') return on(step.hook);
      if (step.result === 'unsure') return done('unsure', step.hook);
      // No captions in the menu: final the second time (its items may have come late).
      if (step.result === 'unavailable' && ++unavailable > 1) return done('unavailable', step.hook);
      if (step.result !== 'busy') tries += 1;
      if (step.result === 'clicked') {
        for (let waited = 0; waited < CC_TIMING.verifyMs && !stopped; waited += CC_TIMING.pollMs) {
          await wait(CC_TIMING.pollMs);
          if (o.cc.state(o.doc).state === 'on') return on(step.hook);
        }
      }
      if (tries < CC_TIMING.tries) await wait(Math.max(0, began + CC_TIMING.gapMs - Date.now()));
    }
    if (stopped) return;
    const end = o.cc.state(o.doc);
    if (end.state === 'on') return on(end.hook);
    // Clicked and still unconfirmed is "clicked"; still saying off, or nothing found to click, is "failed".
    done(clicked && end.state === 'unknown' ? 'clicked' : 'failed', clicked ?? last);
  };
  void run().catch(() => done('failed', 'cc:error'));

  return {
    stop() {
      // Stopped after a click nothing confirmed yet: it counts as clicked on (never a second one in this call).
      if (!reported && clicked) m.seen ??= 'clicked';
      stopped = true;
      wake();
    },
  };
}
