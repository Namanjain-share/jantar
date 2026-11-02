/**
 * A synthetic Google Meet page (spec 9.2), hand-built from research 1.1:
 * no captured HTML, made-up names. The caption region › list › one child per
 * turn › [name (an avatar and the name), text], then the list's two trailing
 * children, which hold controls (a button and a [role=button]); the captions
 * button and the call_end icon in the call's toolbar; the waiting room (the
 * call_end icon without the captions button); the meeting title; and a
 * variant with every known caption class renamed (the structural fallback,
 * MX9).
 *
 * v0.10 adds the screens around the call, each with its own made-up words
 * (never read by the adapter): the join screen ('prejoin', an "Ask to join"
 * button with Meet's join jsname), the waiting room after it ('lobby', the
 * call_end icon only), and the screen after Leave ('left', a Rejoin button),
 * with the steps between them: askToJoin, admit (join is the same step) and
 * leave. 'waiting' stays v0.5's waiting room: the call_end icon and an Ask to
 * join button without the jsname (it reads as the lobby).
 *
 * v0.10, captions switched on (research captions-research.md 2.2, as of
 * 2026-11-02): the captions control says whether captions are on, and a
 * click on it changes them. `cc: 'old'` is the one toggle (Meet's captions
 * jsname, `aria-pressed`, the closed_caption / closed_caption_off icon);
 * `cc: 'popup'` is the "Captions and translation" button of 2026-10-22,
 * which opens a pop-up holding the toggle (and two buttons that open
 * more). The key `c` toggles captions in either shape. `emptyContainer`
 * leaves an empty caption container on the page while captions are off
 * (an unverified report: R-C3). `popupMs` opens the pop-up that long after
 * the click (a slow page). `ccLog` lists what was clicked or pressed.
 *
 *   const meet = buildMeet(document, { state: 'call' });
 *   const t = meet.say('Sam', 'So the plan');
 *   t.grow('for Friday is to ship.');          // a characterData change, as Meet revises
 *   meet.hooksOff(); meet.hooksOn();          // the in-call hooks gone and back
 *
 * The call's code is in the URL, which the builder never touches: a test
 * sets it with history.pushState (`meetUrl` gives both forms).
 */
import { h, setWords, wordsOf } from './dom.js';

/** v0.10: the screens around the call (see the header). */
export type MeetState = 'prejoin' | 'lobby' | 'call' | 'left' | 'waiting';

export interface MeetOptions {
  /** Which screen the page shows. Default 'call'. */
  state?: MeetState;
  /** The caption region on screen. Default true in a call. */
  captions?: boolean;
  /** Every known caption class renamed: only the structural fallback reads it. */
  renamed?: boolean;
  /** `data-meeting-title`; null for none. Default 'Weekly sync'. */
  title?: string | null;
  /** v0.10: the captions control's shape (see the header). Default 'old'. */
  cc?: 'old' | 'popup';
  /** v0.10: an empty caption container stays on the page while captions are off. */
  emptyContainer?: true;
  /** v0.10: the pop-up opens this long after the click. */
  popupMs?: number;
}

export interface MeetTurn {
  /** The turn's element (the list child); a redraw replaces it. */
  readonly el: HTMLElement;
  text(): string;
  set(text: string): void;
  grow(more: string): void;
  /** Meet trims a long turn at the front. */
  trimFront(words: number): void;
  setSpeaker(name: string | null): void;
  remove(): void;
}

export interface MeetFixture {
  readonly doc: Document;
  readonly root: HTMLElement;
  readonly turns: MeetTurn[];
  /** The region element, on the page or not. */
  region(): HTMLElement;
  /** Admitted from the waiting room: the captions button appears. */
  join(): void;
  /** v0.10: Ask to join pressed: the join screen becomes the waiting room. */
  askToJoin(): void;
  /** v0.10: let in (the same step as join). */
  admit(): void;
  /** v0.10: Leave pressed: the call's controls go and a Rejoin button shows. */
  leave(): void;
  /** v0.10: the captions button alone, on or off whatever the screen (a re-render's one-poll flicker). */
  captionsButton(on: boolean): void;
  /** v0.10: the screen the page shows now. */
  state(): MeetState;
  /** A new turn, before the list's trailing controls. A null speaker leaves the name empty. */
  say(speaker: string | null, text: string): MeetTurn;
  captionsOff(): void;
  /** The region back; `fresh` draws an empty one (no history). */
  captionsOn(opts?: { fresh?: boolean }): void;
  /** The in-call hooks gone (captions button and region off the page); speech goes on into the region meanwhile. */
  hooksOff(): void;
  hooksOn(): void;
  /** The region drawn again: new region, list and turn elements with the same words. */
  replaceRegion(): void;
  /** v0.10: the captions are on (what the control says). */
  captionsShown(): boolean;
  /** v0.10: what was clicked or pressed on the captions controls, in order. */
  readonly ccLog: string[];
  /** v0.10: the captions pop-up (cc 'popup') is open. */
  popupOpen(): boolean;
  remove(): void;
}

/** The two URL forms of one call (Meet rewrites the first to the second once you are admitted). */
export function meetUrl(code: string, form: 'short' | 'meet' = 'meet'): string {
  return form === 'meet' ? `/meet/${code}` : `/${code}`;
}

/** Each screen's own words, made up; the adapter never reads them. */
const SCREEN_WORDS: Readonly<Record<MeetState, string>> = {
  prejoin: 'Ready to join?',
  lobby: 'Asking to be let in…',
  waiting: 'Asking to be let in…',
  call: '',
  left: 'You left the meeting',
};

const KNOWN = { turn: 'nMcdL', nameBox: 'adE6rb', nameInner: 'KcIKyf', name: 'NWpY1d', text: 'ygicle VbkSUe' };
const RENAMED = { turn: 'q7Lw2', nameBox: 'p0Zr8', nameInner: 'u3Kd1', name: 'x9Tq4', text: 'm2Hv6' };

export function buildMeet(doc: Document, opts: MeetOptions = {}): MeetFixture {
  const cls = opts.renamed ? RENAMED : KNOWN;
  const title = opts.title === undefined ? 'Weekly sync' : opts.title;
  let state = opts.state ?? 'call';
  let captionsShown = opts.captions ?? state === 'call';
  let hooksShown = true;

  const root = h(doc, 'div', { 'data-jantar-fixture': 'meet' });
  if (title !== null) root.append(h(doc, 'div', { 'data-meeting-title': title, class: 'title' }, title));
  const toolbar = h(doc, 'div', { class: 'toolbar', role: 'toolbar' });
  const popup = opts.cc === 'popup';
  const ccIcon = h(doc, 'i', { class: 'google-symbols', 'aria-hidden': 'true' }, popup ? 'translate_cc' : 'closed_caption');
  const ccButton = popup
    ? h(doc, 'button', { 'aria-label': 'Captions and translation', 'aria-haspopup': 'dialog', 'aria-pressed': 'true', 'aria-expanded': 'false' }, ccIcon)
    : h(doc, 'button', { jsname: 'RrG0hf', 'aria-label': 'Turn off captions', 'aria-pressed': 'true' }, ccIcon);
  // v0.10: the pop-up of 2026-10-22: the toggle first, then translation and its settings (each opens more).
  const ccToggle = h(doc, 'button', { 'aria-label': 'Turn off captions' }, 'Captions');
  const ccDialog = h(
    doc,
    'div',
    { role: 'dialog', 'aria-label': 'Captions and translation' },
    ccToggle,
    h(doc, 'button', { 'aria-haspopup': 'menu', 'aria-label': 'Translate to' }, 'Translation'),
    h(doc, 'button', { 'aria-haspopup': 'dialog', 'aria-label': 'Caption settings' }, 'Settings'),
  );
  const ccLog: string[] = [];
  const container = h(doc, 'div', { jscontroller: 'D1tHje' });
  const leave = h(doc, 'button', { 'aria-label': 'Leave call' }, h(doc, 'i', { class: 'google-symbols', 'aria-hidden': 'true' }, 'call_end'));
  const askToJoin = h(doc, 'button', { class: 'join' }, 'Ask to join');
  // v0.10: the join screen's button (jsname as research names it, unverified on a real Mac: R12), and the left screen's.
  const joinButton = h(doc, 'button', { jsname: 'Qx7uuf', class: 'join' }, 'Ask to join');
  const rejoin = h(doc, 'button', { class: 'rejoin' }, 'Rejoin');
  const screen = h(doc, 'div', { class: 'screen' });
  root.append(screen, toolbar);
  let flicker = false;

  let region = makeRegion();
  let list = region.firstElementChild as HTMLElement;
  const turns: (MeetTurn & { rebuild(): HTMLElement })[] = [];

  function makeRegion(): HTMLElement {
    const l = h(doc, 'div', { class: 'list' });
    l.append(...trailing());
    return h(doc, 'div', { role: 'region', 'aria-label': 'Captions', tabindex: '0', jsname: 'dsyhDe' }, l);
  }

  function trailing(): HTMLElement[] {
    return [
      h(doc, 'div', { class: 'tail-a' }, h(doc, 'button', { 'aria-label': 'Jump to the newest' }, 'Jump to bottom')),
      h(doc, 'div', { class: 'tail-b' }, h(doc, 'div', { role: 'button', 'aria-label': 'Caption settings' }, 'Settings')),
    ];
  }

  /** v0.10: the control says what the captions are. */
  function paintCc() {
    ccButton.setAttribute('aria-pressed', String(captionsShown));
    if (popup) {
      ccToggle.setAttribute('aria-label', captionsShown ? 'Turn off captions' : 'Turn on captions');
      return;
    }
    ccButton.setAttribute('aria-label', captionsShown ? 'Turn off captions' : 'Turn on captions');
    ccIcon.textContent = captionsShown ? 'closed_caption' : 'closed_caption_off';
  }

  function setCaptions(on: boolean) {
    captionsShown = on;
    layout();
  }

  function closePopup() {
    ccDialog.remove();
    ccButton.setAttribute('aria-expanded', 'false');
  }

  ccButton.addEventListener('click', () => {
    if (!popup) {
      ccLog.push('button');
      setCaptions(!captionsShown);
    } else if (ccDialog.isConnected) {
      ccLog.push('popup-close');
      closePopup();
    } else {
      ccLog.push('popup-open');
      const open = () => {
        root.append(ccDialog);
        ccButton.setAttribute('aria-expanded', 'true');
      };
      if (opts.popupMs) setTimeout(open, opts.popupMs);
      else open();
    }
  });
  ccToggle.addEventListener('click', () => {
    ccLog.push('toggle');
    setCaptions(!captionsShown);
  });
  doc.addEventListener('keydown', (ev) => {
    if (!root.isConnected) return;
    if (ev.key === 'Escape' && ccDialog.isConnected) {
      ccLog.push('escape');
      closePopup();
    } else if (ev.key === 'c' && state === 'call') {
      ccLog.push('key-c');
      setCaptions(!captionsShown);
    }
  });

  function layout() {
    const inCall = state === 'call';
    paintCc();
    screen.textContent = SCREEN_WORDS[state];
    toolbar.replaceChildren(
      ...((inCall && hooksShown) || flicker ? [ccButton] : []),
      ...(inCall || state === 'waiting' || state === 'lobby' ? [leave] : []),
      ...(state === 'waiting' ? [askToJoin] : []),
      ...(state === 'prejoin' ? [joinButton] : []),
      ...(state === 'left' ? [rejoin] : []),
    );
    if (captionsShown && hooksShown && inCall) {
      if (!region.isConnected) root.append(region);
    } else region.remove();
    if (opts.emptyContainer && inCall && !captionsShown) {
      if (!container.isConnected) root.append(container);
    } else container.remove();
  }

  function makeTurn(speaker: string | null, words: string): MeetTurn & { rebuild(): HTMLElement } {
    let name = '';
    let said = '';
    let el!: HTMLElement;
    let nameEl!: HTMLElement;
    let textEl!: HTMLElement;
    const build = () => {
      nameEl = h(doc, 'span', { class: cls.name }, name);
      textEl = h(doc, 'div', { class: cls.text }, said);
      el = h(doc, 'div', { class: cls.turn }, h(doc, 'div', { class: cls.nameBox }, h(doc, 'img', { alt: '' }), h(doc, 'div', { class: cls.nameInner }, nameEl)), textEl);
      return el;
    };
    name = speaker ?? '';
    said = words;
    build();
    return {
      get el() {
        return el;
      },
      text: () => wordsOf(textEl),
      set(text) {
        said = text;
        setWords(textEl, text);
      },
      grow(more) {
        this.set(`${wordsOf(textEl)} ${more}`.trim());
      },
      trimFront(n) {
        this.set(wordsOf(textEl).split(' ').slice(n).join(' '));
      },
      setSpeaker(next) {
        name = next ?? '';
        setWords(nameEl, name);
      },
      remove() {
        el.remove();
        const i = turns.indexOf(this as MeetTurn & { rebuild(): HTMLElement });
        if (i >= 0) turns.splice(i, 1);
      },
      rebuild: build,
    };
  }

  layout();
  doc.body.append(root);

  const admit = () => {
    state = 'call';
    captionsShown = opts.captions ?? true;
    layout();
  };

  return {
    doc,
    root,
    turns,
    region: () => region,
    join: admit,
    admit,
    askToJoin() {
      state = 'lobby';
      layout();
    },
    leave() {
      state = 'left';
      layout();
    },
    captionsButton(on) {
      flicker = on;
      layout();
    },
    state: () => state,
    say(speaker, text) {
      const t = makeTurn(speaker, text);
      turns.push(t);
      list.insertBefore(t.el, list.querySelector('.tail-a'));
      return t;
    },
    captionsOff() {
      captionsShown = false;
      layout();
    },
    captionsOn(o = {}) {
      if (o.fresh) {
        region = makeRegion();
        list = region.firstElementChild as HTMLElement;
        turns.length = 0;
      }
      captionsShown = true;
      layout();
    },
    hooksOff() {
      hooksShown = false;
      layout();
    },
    hooksOn() {
      hooksShown = true;
      layout();
    },
    replaceRegion() {
      const next = makeRegion();
      const nextList = next.firstElementChild as HTMLElement;
      for (const t of turns) nextList.insertBefore(t.rebuild(), nextList.querySelector('.tail-a'));
      const was = region.isConnected;
      region.replaceWith(next);
      region = next;
      list = nextList;
      if (!was) layout();
    },
    captionsShown: () => captionsShown,
    ccLog,
    popupOpen: () => ccDialog.isConnected,
    remove() {
      root.remove();
    },
  };
}
