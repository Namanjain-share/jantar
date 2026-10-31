/**
 * The page tests' world (WP-XC's own; WP0's chrome fake stays as it is): the
 * fake `chrome`, a stand-in worker that answers the page's messages as the
 * real one would, the closed shadow roots the page attaches (captured as
 * they are made: a closed root is unreachable afterwards), and a console
 * watch for MP7.
 *
 *   const w = pageWorld({ paired: true });
 *   startContent({ adapter: meetAdapter });
 *   w.worker.lines = () => ({ ok: false, retry: true });
 *   await w.toPage({ t: 'capture', on: true });
 *
 * In the fake, `runtime.sendMessage` reaches every listener, the page's own
 * too (Chrome never delivers a sender's message back to it): the page ignores
 * its own message types, and the stand-in worker ignores the worker's.
 */
import { createRequire } from 'node:module';
import { MEETING_MARKER } from '@jantar/fixtures';
import { vi } from 'vitest';
import type { CallAnswer, FromPage, LinesAnswer, ShotAnswer, ToPage } from '../../src/shared/messages.js';
import { createChromeFake, type ChromeFake, type ChromeModel } from '../helpers/chrome-fake.js';
export { MEETING_MARKER };

type Of<T extends FromPage['t']> = Extract<FromPage, { t: T }>;
type Maybe<T> = T | undefined | Promise<T | undefined>;

export interface FakeWorker {
  /** Every message the page sent, in order (copies). */
  got: FromPage[];
  /** Only those of one type. */
  of<T extends FromPage['t']>(t: T): Of<T>[];
  /** What a `call` is answered (undefined: no answer). */
  call: (msg: Of<'call'>) => Maybe<CallAnswer>;
  lines: (msg: Of<'lines'>) => Maybe<LinesAnswer>;
  shot: (msg: Of<'shot'>) => Maybe<ShotAnswer>;
}

export interface PageWorld {
  chrome: ChromeFake;
  model: ChromeModel;
  worker: FakeWorker;
  /**
   * A message from the worker to the page, as Chrome delivers tabs.sendMessage; resolves the page's answer.
   * From this worker (no `sender` given), `capture` also sets what its call answers say about notes.
   */
  toPage(msg: ToPage | Record<string, unknown>, sender?: { id?: string; url?: string }): Promise<unknown>;
  done(): void;
}

const PAGE_TYPES = new Set(['call', 'lines', 'captions', 'shot']);

export function pageWorld(opts: { paired?: boolean; notes?: boolean } = {}): PageWorld {
  const { chrome, model } = createChromeFake();
  const got: FromPage[] = [];
  // As the worker does: notes on or off for the tab before it tells the page so.
  let notes = opts.notes ?? false;
  const worker: FakeWorker = {
    got,
    of: <T extends FromPage['t']>(t: T) => got.filter((m): m is Of<T> => m.t === t),
    call: () => ({ button: opts.paired ?? true, notes }),
    lines: () => ({ ok: true }),
    shot: () => ({ ok: true, text: 'Saved' }),
  };
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    const m = msg as FromPage;
    if (!m || typeof m !== 'object' || !PAGE_TYPES.has(m.t)) return undefined;
    got.push(structuredClone(m));
    const answer = m.t === 'call' ? worker.call(m) : m.t === 'lines' ? worker.lines(m) : m.t === 'shot' ? worker.shot(m) : undefined;
    if (answer === undefined) return undefined;
    void Promise.resolve(answer).then((a) => respond(a));
    return true;
  });
  return {
    chrome,
    model,
    worker,
    toPage: (msg, sender) => {
      if (!sender && msg.t === 'capture') notes = msg.on === true;
      return chrome.runtime.onMessage.dispatch(msg, sender ?? model.extensionSender('background.js'));
    },
    done: () => model.uninstall(),
  };
}

/** Record every shadow root attached from now on (the camera's is closed). */
export function captureShadows(): { rootOf(host: Element | null): ShadowRoot | undefined } {
  const roots = new Map<Element, ShadowRoot>();
  const real = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = real.call(this, init);
    roots.set(this, root);
    return root;
  });
  return { rootOf: (host) => (host ? roots.get(host) : undefined) };
}

/** The camera's host element, when it is on the page. */
export function cameraHost(doc: Document = document): HTMLElement | null {
  return doc.querySelector('jantar-camera');
}

/** Everything the page wrote to the console (MP7: never a caption, a name or a title). */
export function watchConsole(): { said(): string[] } {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  return { said: () => spies.flatMap((s) => s.mock.calls.flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a)))) };
}

/** Let promises and MutationObserver callbacks run, and `ms` of fake time pass. */
export async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Point the page at a path (jsdom keeps its origin; the Meet adapter reads only the path). */
export function goTo(path: string): void {
  window.history.pushState({}, '', path);
}

// jsdom's own wrapper-to-implementation map: the one way to dispatch an event
// as the browser does (`isTrusted` true). A script's click() or
// dispatchEvent() is never trusted, in jsdom as in Chrome.
const jsdomIdl = createRequire(import.meta.url)('jsdom/lib/generated/idl/utils.js') as { implForWrapper(wrapper: object): { isTrusted: boolean; _dispatch(event: unknown): boolean } };

/** A click the user made (`isTrusted`), as no page script can. */
export function trustedClick(el: Element): void {
  const event = jsdomIdl.implForWrapper(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
  event.isTrusted = true;
  jsdomIdl.implForWrapper(el)._dispatch(event);
}
