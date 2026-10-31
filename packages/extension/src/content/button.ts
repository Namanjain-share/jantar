/**
 * The camera button and its bubble (spec 3.7, 3.8). A host element on
 * <html> with a closed shadow root, so the page's CSS and scripts cannot
 * reach in and nothing leaks out. Styles come from one constructable
 * stylesheet (`adoptedStyleSheets`) and CSSOM calls: no <style> element, no
 * style attribute, no innerHTML, so a strict style-src or Trusted Types
 * page cannot block it. The camera is drawn with DOM calls (no image file,
 * no data URL a page's CSP may refuse).
 *
 * The host is on the page only while it shows something: the button (paired
 * and in a call) or a bubble. A click counts only when the browser made it
 * (`isTrusted`): no page script can take a screenshot. For a shot the host
 * hides itself and waits two animation frames (one frame still left the
 * button in a shot, research 4.6) before asking the worker. A hide the
 * worker asked for (a shortcut or popup shot) ends with its `show`, or by
 * itself after HIDE_GIVE_UP_MS should that never come.
 */
import type { ShotAnswer } from '../shared/messages.js';
import type { SiteAdapter } from './adapters/types.js';

export const SHOT_LABEL = 'Take a screenshot (Jantar)';
export const NOTES_TITLE = 'Jantar is keeping notes in this tab';
/** The worker's answer for a saved shot. */
export const SAVED = 'Saved';
/** "Saved" flashes this long; every other sentence stays as a bubble. */
export const FLASH_MS = 1_200;
export const BUBBLE_MS = 8_000;
/** The page-button shot when the worker gave no answer at all. */
export const NO_ANSWER = 'Not saved: the Jantar extension did not answer.';
/** A hide answers after two frames, or after this long when frames stop (a hidden tab). */
const HIDE_MAX_MS = 500;
/**
 * A hide the worker asked for shows the button again by itself after this
 * long, should its `show` never come (the tab navigated, the worker
 * restarted mid-shot). Its capture is done well before: it waits at most
 * shotGapMs and one 600-ms retry.
 */
export const HIDE_GIVE_UP_MS = 5_000;

const SVG = 'http://www.w3.org/2000/svg';

// The six colour properties of the web app's styles/tokens.css, light and dark.
const CSS = `
:host { all: initial; position: fixed; z-index: 2147483647;
  --bg: #f7f5ef; --surface: #fcfbf7; --line-strong: #878b9b; --ink: #16203a; --ink-2: #3d4660; --jup: #a67a0c; }
@media (prefers-color-scheme: dark) {
  :host { --bg: #0f1527; --surface: #141b2f; --line-strong: #717a98; --ink: #efebe1; --ink-2: #bcbfcd; --jup: #e8b84a; }
}
[hidden] { display: none !important; }
.wrap { position: relative; font: 13px/1.35 system-ui, sans-serif; }
.cam { position: relative; display: grid; place-items: center; box-sizing: border-box; width: 36px; height: 36px; margin: 0; padding: 0;
  border: 1px solid var(--line-strong); border-radius: 50%; cursor: pointer; color: var(--ink);
  background: color-mix(in srgb, var(--surface) 92%, transparent); box-shadow: 0 1px 3px rgb(0 0 0 / 0.25); }
.cam:hover { color: var(--ink-2); }
.cam:focus-visible { outline: 2px solid var(--jup); outline-offset: 2px; }
.cam svg { width: 18px; height: 18px; pointer-events: none; }
.dot { position: absolute; top: 1px; right: 1px; width: 6px; height: 6px; border-radius: 50%; background: var(--jup); }
.bubble { position: absolute; top: 0; width: max-content; max-width: 280px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); cursor: default;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.2); white-space: normal; }
.left .bubble { left: 44px; }
.right .bubble { right: 44px; }
`;

export interface CameraButtonOptions {
  doc: Document;
  spot: SiteAdapter['spot'];
  /** A trusted click: ask the worker for a shot of this tab (the host is hidden meanwhile). */
  shoot(): Promise<ShotAnswer | undefined>;
}

export interface CameraButton {
  /** The button shows (paired and in a call) or not. */
  setShown(on: boolean): void;
  /** The notes-on dot and title. */
  setNotes(on: boolean): void;
  /** One bubble beside the button, for `ms` or until clicked; it replaces any other. */
  bubble(text: string, ms?: number): void;
  /** Hidden for a shot the worker takes: resolves after two animation frames; shown again by `show`, or after HIDE_GIVE_UP_MS. */
  hide(): Promise<void>;
  /** Shown again after such a shot, with its flash. */
  show(flash?: string): void;
  /** Off the page for good. */
  remove(): void;
}

export function createCameraButton(o: CameraButtonOptions): CameraButton {
  const doc = o.doc;
  const win = doc.defaultView ?? window;
  let shown = false;
  let bubbleOn = false;
  let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  let hidden = 0;
  /** The worker's hides waiting for their `show`, oldest first: each one's give-up timer. */
  const held: ReturnType<typeof setTimeout>[] = [];
  let shots: Promise<void> = Promise.resolve();

  const host = doc.createElement('jantar-camera');
  const root = host.attachShadow({ mode: 'closed' });
  try {
    const sheet = new win.CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    // Without constructable stylesheets the button still works, unstyled.
  }
  for (const [prop, value] of Object.entries(o.spot)) if (value) host.style.setProperty(prop, value);

  const wrap = doc.createElement('div');
  wrap.className = `wrap ${o.spot.right && !o.spot.left ? 'right' : 'left'}`;
  const cam = doc.createElement('button');
  cam.type = 'button';
  cam.className = 'cam';
  cam.setAttribute('aria-label', SHOT_LABEL);
  cam.append(cameraIcon(doc));
  const dot = doc.createElement('span');
  dot.className = 'dot';
  dot.hidden = true;
  cam.append(dot);
  const tip = doc.createElement('div');
  tip.className = 'bubble';
  tip.setAttribute('role', 'status');
  tip.hidden = true;
  wrap.append(cam, tip);
  root.append(wrap);

  const sync = () => {
    cam.hidden = !shown;
    if (shown || bubbleOn) {
      if (!host.isConnected) doc.documentElement.append(host);
    } else host.remove();
  };

  const closeBubble = () => {
    clearTimeout(bubbleTimer);
    bubbleOn = false;
    tip.hidden = true;
    tip.textContent = '';
    sync();
  };
  tip.addEventListener('click', closeBubble);

  const bubble = (text: string, ms = BUBBLE_MS) => {
    clearTimeout(bubbleTimer);
    tip.textContent = text;
    tip.hidden = false;
    bubbleOn = true;
    sync();
    bubbleTimer = setTimeout(closeBubble, ms);
  };

  const flash = (text: string, ok: boolean) => bubble(text, ok && text === SAVED ? FLASH_MS : BUBBLE_MS);

  const hide = async () => {
    hidden += 1;
    host.style.setProperty('visibility', 'hidden');
    await new Promise<void>((resolve) => {
      const stop = setTimeout(resolve, HIDE_MAX_MS);
      win.requestAnimationFrame(() =>
        win.requestAnimationFrame(() => {
          clearTimeout(stop);
          resolve();
        }),
      );
    });
  };

  const reveal = () => {
    hidden = Math.max(0, hidden - 1);
    if (hidden === 0) host.style.removeProperty('visibility');
  };

  const shoot = async () => {
    await hide();
    let answer: ShotAnswer | undefined;
    try {
      answer = await o.shoot();
    } catch {
      answer = undefined;
    } finally {
      reveal();
    }
    if (answer && typeof answer.text === 'string') flash(answer.text, answer.ok === true);
    else flash(NO_ANSWER, false);
  };

  cam.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    // A second click while one is in flight waits its turn: two clicks, two shots.
    shots = shots.then(shoot, shoot);
  });

  return {
    setShown(on) {
      shown = on;
      sync();
    },
    setNotes(on) {
      dot.hidden = !on;
      if (on) cam.title = NOTES_TITLE;
      else cam.removeAttribute('title');
    },
    bubble,
    hide() {
      const timer = setTimeout(() => {
        const i = held.indexOf(timer);
        if (i < 0) return;
        held.splice(i, 1);
        reveal();
      }, HIDE_GIVE_UP_MS);
      held.push(timer);
      return hide();
    },
    show(text) {
      // The oldest hide still waiting ends; one that gave up already was shown again then.
      const timer = held.shift();
      if (timer !== undefined) {
        clearTimeout(timer);
        reveal();
      }
      if (text) flash(text, text === SAVED);
    },
    remove() {
      clearTimeout(bubbleTimer);
      for (const timer of held.splice(0)) clearTimeout(timer);
      shown = false;
      bubbleOn = false;
      host.remove();
    },
  };
}

/** A camera: a rounded rect and a circle, drawn as our own inline SVG. */
function cameraIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  const shape = (name: string, attrs: Record<string, string>) => {
    const el = doc.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  };
  shape('rect', { x: '3', y: '6', width: '18', height: '14', rx: '3.5' });
  shape('circle', { cx: '12', cy: '13', r: '3.5' });
  return svg;
}
