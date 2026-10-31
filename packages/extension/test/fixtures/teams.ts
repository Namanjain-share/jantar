/**
 * A synthetic Microsoft Teams page (spec 9.2), hand-built from research
 * 2.2: no captured HTML, made-up names. Four caption layouts:
 * - 'v2': the v2 window wrapper with its virtual list, Fluent UI items;
 * - '2026-bottom': the 2026 renderer wrapper, a list of Fluent UI items;
 * - '2026-right': the same wrapper as a side panel, items without the
 *   Fluent UI class (the author found through the nearest ancestor);
 * - 'loose': a container only the loose `[data-tid*="closed-caption"]`
 *   match finds, after the toolbar's Captions control in the page.
 * The 2026 layouts have the toolbar's Captions toggle (whose data-tid also
 * contains "closed-caption") before the captions. The lobby shows
 * #prejoin-join-button only; the call a hang-up button (an anonymous guest's
 * with `anon`).
 *
 *   const teams = buildTeams(document, { layout: 'v2' });
 *   const a = teams.say('Sam', 'Can everyone see my screen?');
 *   teams.unmount(a); teams.remount(a);      // the virtual list drops and redraws an item
 */
import { h, setWords, wordsOf } from './dom.js';

export type TeamsLayout = 'v2' | '2026-bottom' | '2026-right' | 'loose';

export interface TeamsOptions {
  layout?: TeamsLayout;
  /** The lobby or the call. Default 'call'. */
  state?: 'lobby' | 'call';
  /** An anonymous guest's hang-up button. */
  anon?: boolean;
  /** The captions on screen. Default true in a call. */
  captions?: boolean;
}

export interface TeamsItem {
  /** The item's element; a remount replaces it. */
  readonly el: HTMLElement;
  text(): string;
  set(text: string): void;
  grow(more: string): void;
  /** null: the user chose not to be identified (no author element). */
  setAuthor(name: string | null): void;
}

export interface TeamsFixture {
  readonly doc: Document;
  readonly root: HTMLElement;
  readonly items: TeamsItem[];
  region(): HTMLElement;
  join(): void;
  say(author: string | null, text: string): TeamsItem;
  /** The virtual list drops an item (scrolled out). */
  unmount(item: TeamsItem): void;
  /** And draws it again: a new element with the same words, in its place. */
  remount(item: TeamsItem): void;
  captionsOff(): void;
  captionsOn(): void;
  hooksOff(): void;
  hooksOn(): void;
  replaceRegion(): void;
  remove(): void;
}

const WRAPPER: Record<TeamsLayout, string> = {
  v2: 'closed-caption-v2-window-wrapper',
  '2026-bottom': 'closed-caption-renderer-wrapper',
  '2026-right': 'closed-caption-renderer-wrapper',
  loose: 'closed-caption-panel-next',
};

export function buildTeams(doc: Document, opts: TeamsOptions = {}): TeamsFixture {
  const layout = opts.layout ?? '2026-bottom';
  let state = opts.state ?? 'call';
  let captionsShown = opts.captions ?? state === 'call';
  let hooksShown = true;
  const is2026 = layout !== 'v2';

  const root = h(doc, 'div', { 'data-jantar-fixture': 'teams' });
  const appBar = h(doc, 'nav', { class: 'app-bar', 'aria-label': 'App bar' }, h(doc, 'button', { 'aria-label': 'Chat' }, 'Chat'));
  const toolbar = h(doc, 'div', { role: 'toolbar', class: 'call-controls' });
  const ccToggle = h(doc, 'button', { id: 'closed-captions-button', 'data-tid': 'closed-captions-button-on', 'aria-pressed': 'true' }, 'Captions');
  const hangup = opts.anon
    ? h(doc, 'button', { 'data-tid': 'anon-hangup-button', 'aria-label': 'Leave' }, 'Leave')
    : h(doc, 'button', { id: 'hangup-button', 'data-tid': 'hangup-main-btn', 'aria-label': 'Leave' }, 'Leave');
  const join = h(doc, 'button', { id: 'prejoin-join-button' }, 'Join now');
  root.append(appBar, toolbar);

  const items: (TeamsItem & { build(): HTMLElement })[] = [];
  let region = makeRegion();
  let list = listOf(region);

  function makeRegion(): HTMLElement {
    const l = layout === 'v2' ? h(doc, 'div', { 'data-tid': 'closed-caption-v2-virtual-list-content' }) : h(doc, 'div', { role: 'list' });
    const inner = layout === '2026-right' || layout === 'loose' ? h(doc, 'aside', { 'aria-label': 'Live captions' }, l) : l;
    return h(doc, 'div', { 'data-tid': WRAPPER[layout], 'data-position': layout === '2026-right' ? 'right' : 'bottom' }, inner);
  }

  function listOf(r: HTMLElement): HTMLElement {
    return (r.querySelector('[role="list"]') ?? r.querySelector('[data-tid="closed-caption-v2-virtual-list-content"]')) as HTMLElement;
  }

  function layoutPage() {
    const inCall = state === 'call';
    toolbar.replaceChildren(...(inCall && is2026 ? [ccToggle] : []), ...(inCall && hooksShown ? [hangup] : []), ...(inCall ? [] : [join]));
    if (inCall && captionsShown && hooksShown) {
      if (!region.isConnected) root.append(region);
    } else region.remove();
  }

  function makeItem(author: string | null, words: string): TeamsItem & { build(): HTMLElement } {
    let who = author;
    let said = words;
    let el!: HTMLElement;
    let textEl!: HTMLElement;
    let authorEl: HTMLElement | null = null;
    const build = () => {
      textEl = h(doc, 'span', { 'data-tid': 'closed-caption-text' }, said);
      authorEl = who === null ? null : h(doc, 'span', { 'data-tid': 'author' }, who);
      const head = h(doc, 'div', { class: 'head' }, authorEl);
      const body = h(doc, 'div', { class: 'body' }, textEl);
      if (layout === '2026-right' || layout === 'loose') el = h(doc, 'div', { role: 'listitem' }, head, body);
      else if (layout === 'v2') el = h(doc, 'div', { class: 'fui-ChatMessageCompact' }, head, body);
      else el = h(doc, 'div', { role: 'listitem' }, h(doc, 'div', { class: 'fui-ChatMessageCompact' }, head, body));
      return el;
    };
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
      setAuthor(name) {
        who = name;
        if (name === null) authorEl?.remove();
        else if (authorEl) setWords(authorEl, name);
        else {
          authorEl = h(doc, 'span', { 'data-tid': 'author' }, name);
          el.querySelector('.head')?.append(authorEl);
        }
      },
      build,
    };
  }

  layoutPage();
  doc.body.append(root);

  return {
    doc,
    root,
    items,
    region: () => region,
    join() {
      state = 'call';
      captionsShown = opts.captions ?? true;
      layoutPage();
    },
    say(author, text) {
      const item = makeItem(author, text);
      items.push(item);
      list.append(item.el);
      return item;
    },
    unmount(item) {
      item.el.remove();
    },
    remount(item) {
      const i = items.indexOf(item as TeamsItem & { build(): HTMLElement });
      const next = items.slice(i + 1).find((x) => x.el.isConnected);
      const el = items[i]!.build();
      list.insertBefore(el, next ? next.el : null);
    },
    captionsOff() {
      captionsShown = false;
      layoutPage();
    },
    captionsOn() {
      captionsShown = true;
      layoutPage();
    },
    hooksOff() {
      hooksShown = false;
      layoutPage();
    },
    hooksOn() {
      hooksShown = true;
      layoutPage();
    },
    replaceRegion() {
      const next = makeRegion();
      const nextList = listOf(next);
      for (const item of items) nextList.append(item.build());
      const was = region.isConnected;
      region.replaceWith(next);
      region = next;
      list = nextList;
      if (!was) layoutPage();
    },
    remove() {
      root.remove();
    },
  };
}
