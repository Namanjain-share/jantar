/**
 * v0.10: the call's own live captions switched on when notes start
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
 * rounds bound it all. It never turns captions off, and once they were
 * seen on, or a click was made that nothing on the page confirms, it never
 * touches them again: if he turns them off, they stay off. How it went, and
 * the hook id that decided it, goes to `report` (Settings › Call check).
 */
import type { CcResult } from '../shared/messages.js';
import type { CaptionsControl, HookId } from './adapters/types.js';

export const CC_TIMING = Object.freeze({
  tries: 3,
  gapMs: 10_000,
  verifyMs: 5_000,
  pollMs: 500,
  rounds: 12,
});

export interface CaptionsSwitch {
  /** Notes stopped: no more tries, and nothing reported. */
  stop(): void;
}

export interface CaptionsSwitchOptions {
  cc: CaptionsControl;
  doc: Document;
  report(result: CcResult, hook: HookId): void;
}

export function switchCaptionsOn(o: CaptionsSwitchOptions): CaptionsSwitch {
  let stopped = false;
  /** Each wait in progress: its timer, and how to let it go at once (stop). */
  const waits = new Map<ReturnType<typeof setTimeout>, () => void>();
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      const timer = setTimeout(() => {
        waits.delete(timer);
        resolve();
      }, ms);
      waits.set(timer, resolve);
    });
  const done = (result: CcResult, hook: HookId) => {
    if (stopped) return;
    stopped = true;
    o.report(result, hook);
  };

  const run = async () => {
    /** The hook of the last click or key, while nothing has shown captions on since. */
    let clicked: HookId | null = null;
    let last: HookId = '';
    let tries = 0;
    for (let round = 0; round < CC_TIMING.rounds && tries < CC_TIMING.tries && !stopped; round += 1) {
      const began = Date.now();
      const now = o.cc.state(o.doc);
      last = now.hook;
      if (now.state === 'on') return done(clicked ? 'turned-on' : 'was-on', clicked ?? now.hook);
      // A click nothing on the page confirms (Teams shows captions once someone speaks): never a second blind one.
      if (clicked && now.state === 'unknown') return done('clicked', clicked);
      const step = await o.cc.turnOn(o.doc, { wait, attempt: tries + 1 });
      if (stopped) return;
      last = step.hook;
      if (step.result === 'on') return done(clicked ? 'turned-on' : 'was-on', clicked ?? step.hook);
      if (step.result === 'unavailable') return done('failed', step.hook);
      if (step.result !== 'busy') tries += 1;
      if (step.result === 'clicked') {
        clicked = step.hook;
        for (let waited = 0; waited < CC_TIMING.verifyMs && !stopped; waited += CC_TIMING.pollMs) {
          await wait(CC_TIMING.pollMs);
          if (o.cc.state(o.doc).state === 'on') return done('turned-on', clicked);
        }
      }
      if (tries < CC_TIMING.tries) await wait(Math.max(0, began + CC_TIMING.gapMs - Date.now()));
    }
    if (stopped) return;
    const end = o.cc.state(o.doc);
    if (end.state === 'on') return done(clicked ? 'turned-on' : 'was-on', clicked ?? end.hook);
    // Clicked and still unconfirmed is "clicked"; still saying off, or nothing found to click, is "failed".
    done(clicked && end.state === 'unknown' ? 'clicked' : 'failed', clicked ?? last);
  };
  void run().catch(() => done('failed', 'cc:error'));

  return {
    stop() {
      stopped = true;
      for (const [timer, resolve] of waits) {
        clearTimeout(timer);
        resolve();
      }
      waits.clear();
    },
  };
}
