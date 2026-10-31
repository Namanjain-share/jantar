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
 *   const meet = buildMeet(document, { state: 'call' });
 *   const t = meet.say('Sam', 'So the plan');
 *   t.grow('for Friday is to ship.');          // a characterData change, as Meet revises
 *   meet.hooksOff(); meet.hooksOn();          // the in-call hooks gone and back
 *
 * The call's code is in the URL, which the builder never touches: a test
 * sets it with history.pushState (`meetUrl` gives both forms).
 */
import { h, setWords, wordsOf } from './dom.js';

export interface MeetOptions {
  /** The waiting room (no captions button yet) or the call. Default 'call'. */
  state?: 'waiting' | 'call';
  /** The caption region on screen. Default true in a call. */
  captions?: boolean;
  /** Every known caption class renamed: only the structural fallback reads it. */
  renamed?: boolean;
  /** `data-meeting-title`; null for none. Default 'Weekly sync'. */
  title?: string | null;
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
  remove(): void;
}

/** The two URL forms of one call (Meet rewrites the first to the second once you are admitted). */
export function meetUrl(code: string, form: 'short' | 'meet' = 'meet'): string {
  return form === 'meet' ? `/meet/${code}` : `/${code}`;
}

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
  const ccButton = h(doc, 'button', { jsname: 'RrG0hf', 'aria-label': 'Turn off captions', 'aria-pressed': 'true' }, h(doc, 'i', { class: 'google-symbols', 'aria-hidden': 'true' }, 'closed_caption'));
  const leave = h(doc, 'button', { 'aria-label': 'Leave call' }, h(doc, 'i', { class: 'google-symbols', 'aria-hidden': 'true' }, 'call_end'));
  const askToJoin = h(doc, 'button', { class: 'join' }, 'Ask to join');
  root.append(toolbar);

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

  function layout() {
    toolbar.replaceChildren(...(state === 'call' && hooksShown ? [ccButton] : []), leave, ...(state === 'waiting' ? [askToJoin] : []));
    if (captionsShown && hooksShown && state === 'call') {
      if (!region.isConnected) root.append(region);
    } else region.remove();
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

  return {
    doc,
    root,
    turns,
    region: () => region,
    join() {
      state = 'call';
      captionsShown = opts.captions ?? true;
      layout();
    },
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
    remove() {
      root.remove();
    },
  };
}
