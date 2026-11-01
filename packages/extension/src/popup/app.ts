/**
 * The popup (spec 3.10): pairing, the D1 offer, the assign sheet, Start,
 * Screenshot, End and Settings, one view at a time. Everything it knows
 * comes from the worker's `state` answer; everything it does is one
 * message to the worker (it never calls the daemon itself).
 *
 * v0.5.3: Settings shows the screenshot shortcut (with a link to Chrome's
 * shortcuts page) and the last screenshot try: when, from where, and how it
 * ended, with Chrome's own words or the daemon's status. The main view says
 * when this tab's last try failed in the last 10 minutes. It never claims a
 * tab is allowed: opening the popup always grants this tab.
 *
 * Built with DOM calls and textContent only (the page has no inline
 * script, no style attribute and no on* handler). No em dash, no
 * exclamation mark.
 */
import type { Done, FromPopup, LastShot, PopupState, ShotFrom } from '../shared/messages.js';
import type { MeetingSite } from '../shared/sites.js';
import { WIRE_LIMITS } from '../shared/wire.js';
import { JOIN_FIRST, NOT_RUNNING, NO_MEETING_TAB, SHOT, TRY_AGAIN } from '../background/sentences.js';

/** The sites' own way to turn captions on (the adapters' `howTo`, spec 3.4). */
export const HOW_TO: Readonly<Record<MeetingSite, string>> = {
  meet: "No captions on screen. Turn them on with the CC button, or press c. If they are on, Jantar can't read them on this page; screenshots still work.",
  teams:
    "No captions on screen. Turn them on: More (…) › Language and speech › Live captions, or Cmd+Shift+A. If they are on, Jantar can't read them on this page; screenshots still work.",
};
export const NOT_FOUND = "Can't read captions on this page. Screenshots still work.";
/** Until the worker's `state` answers (its info read waits up to 5 s for a Jantar that hangs). */
export const LOADING = 'Connecting to Jantar…';
export const PAIR_PROMPT = 'Pair with Jantar on this Mac.';
export const PAIR_COMMAND = 'jantar pair --extension';
export const CONNECTED = 'Connected to Jantar on this Mac.';
export const OFFER_TITLE = 'Let the screenshot button work on meeting pages';
export const OFFER_WHY =
  'Chrome calls this reading and changing your data on all websites. Jantar still runs only on Meet and Teams pages, and takes a screenshot of the meeting tab only when you click.';
export const TELL_PEOPLE = 'Let people know you keep notes.';
export const ALL_URLS = '<all_urls>';
/** Chrome's page for extension shortcuts (opened in a tab: no permission needed). */
export const SHORTCUTS_URL = 'chrome://extensions/shortcuts';
/** The main view names a failed try in this tab for this long. */
export const RECENT_SHOT_MS = 10 * 60_000;

/** The control a try came from, in Settings' words. */
const FROM_WORDS: Readonly<Record<ShotFrom, string>> = { page: 'camera button', popup: 'popup', command: 'shortcut' };

/** "12:41", in this Mac's time. */
export function clockOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Why a try was not saved, without the flash's own "Not saved: ". */
const reasonOf = (text: string): string => text.replace(/^Not saved: /, '');

export const shortcutLine = (shortcut: string): string => `Shortcut: ${shortcut || 'not set'}`;

/** "Last screenshot: 12:41 · camera button · Saved", or "… · Not saved: <why>". */
export function lastShotLine(last: LastShot | null): string {
  if (!last) return 'Last screenshot: none yet';
  return `Last screenshot: ${clockOf(last.at)} · ${FROM_WORDS[last.from]} · ${last.ok ? SHOT.saved : `Not saved: ${reasonOf(last.text)}`}`;
}

/** The second, quiet line: Chrome's own words, or the status Jantar answered with; null when there is neither. */
export function lastShotDetail(last: LastShot | null): string | null {
  if (last?.chrome) return `Chrome said: ${last.chrome}`;
  if (last?.status !== undefined) return `Jantar answered ${last.status}`;
  return null;
}

/** The main view's line when this tab's last try failed in the last 10 minutes; else null. */
export function missedLine(last: LastShot | null, tabId: number, now: number): string | null {
  if (!last || last.ok || last.tabId !== tabId || now - last.at > RECENT_SHOT_MS) return null;
  return `Last screenshot not saved: ${reasonOf(last.text)}`;
}

type Tab = NonNullable<PopupState['tab']>;
type Projects = PopupState['projects'];

export interface PopupOptions {
  root: HTMLElement;
  /** The tab the popup acts on: `?tab=<id>` when given, else the active tab of the last focused window. */
  tabId?: number | null;
  /** Close the popup (before a screenshot, so it is never in the picture). */
  close?: () => void;
}

export interface Popup {
  /** Ask the worker again and draw. */
  refresh(): Promise<void>;
  readonly tabId: number;
}

/** `?tab=<id>` from the page's query, or null. */
export function tabFromSearch(search: string): number | null {
  const raw = new URLSearchParams(search).get('tab');
  if (raw === null || !/^\d{1,10}$/.test(raw)) return null;
  return Number(raw);
}

export const shotsLine = (n: number): string => `${n} screenshot${n === 1 ? '' : 's'}`;

export function defaultName(tab: Pick<Tab, 'site' | 'title' | 'name'>): string {
  const name = (tab.name ?? tab.title).replace(/\s+/g, ' ').trim().slice(0, WIRE_LIMITS.name);
  return name || (tab.site === 'meet' ? 'Meet call' : 'Teams call');
}

function captionsWords(tab: Tab): string {
  switch (tab.captions) {
    case 'reading':
      return 'Reading captions';
    case 'none':
      return HOW_TO[tab.site];
    case 'notFound':
      return NOT_FOUND;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// DOM helpers

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string | boolean>> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

const para = (text: string, cls?: string) => el('p', cls ? { class: cls } : {}, text);

function button(label: string, onClick: (ev: MouseEvent) => void, opts: { primary?: boolean; link?: boolean; type?: 'button' | 'submit' } = {}): HTMLButtonElement {
  const b = el('button', { type: opts.type ?? 'button', class: opts.primary ? 'primary' : opts.link ? 'link' : undefined }, label);
  b.addEventListener('click', onClick);
  return b;
}

// ---------------------------------------------------------------------------

function isState(v: unknown): v is PopupState {
  return typeof v === 'object' && v !== null && typeof (v as PopupState).connection === 'string';
}

async function ask(msg: FromPopup): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch {
    return undefined;
  }
}

async function activeTabId(): Promise<number> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return typeof tab?.id === 'number' ? tab.id : -1;
  } catch {
    return -1;
  }
}

export async function mountPopup(opts: PopupOptions): Promise<Popup> {
  const { root } = opts;
  const close = opts.close ?? (() => window.close());
  // The view is drawn again on every change; the live line beside it stays, so a screen reader hears only what changed.
  const view = el('div', { class: 'view' });
  const live = el('p', { class: 'live', 'aria-live': 'polite' });
  root.replaceChildren(view, live);

  let loaded = false;
  let state: PopupState | null = null;
  let page: 'main' | 'settings' = 'main';
  /** Just paired here: offer the page button once (D1). */
  let offer = false;
  let error = '';
  let busy = false;
  /** The sheet and the pairing code as typed, kept across redraws. */
  let draft: { name: string; projectId: string; people: string; autoTodos: boolean } | null = null;
  let code = '';

  draw();
  const tabId = typeof opts.tabId === 'number' ? opts.tabId : await activeTabId();

  async function refresh(): Promise<void> {
    const got = await ask({ t: 'state', tabId });
    loaded = true;
    state = isState(got) ? got : null;
    if (!state?.tab || state.tab.notes) draft = null;
    draw();
  }

  /** Run one message with the buttons off; a Done's error shows under the view. */
  async function act(msg: FromPopup): Promise<Done> {
    busy = true;
    error = '';
    draw();
    const got = (await ask(msg)) as Done | undefined;
    const done: Done = got && typeof got.ok === 'boolean' ? got : { ok: false, error: TRY_AGAIN };
    busy = false;
    if (!done.ok) error = done.error ?? TRY_AGAIN;
    return done;
  }

  // --- actions

  async function pair(text: string): Promise<void> {
    code = text;
    const done = await act({ t: 'pair', text });
    if (done.ok) {
      offer = true;
      code = '';
    }
    await refresh();
  }

  /** From the click itself: Chrome asks only on a user gesture, and its prompt may close the popup before this settles. */
  function allow(): void {
    const asked = chrome.permissions.request({ origins: [ALL_URLS] });
    void asked
      .catch(() => false)
      .then(() => {
        offer = false;
        return refresh();
      });
  }

  async function start(tab: Tab): Promise<void> {
    const d = draft ?? { name: defaultName(tab), projectId: '', people: '', autoTodos: false };
    const msg: FromPopup = {
      t: 'start',
      tabId,
      name: d.name,
      ...(d.projectId ? { projectId: d.projectId } : {}),
      ...(d.people.trim() ? { people: d.people } : {}),
      autoTodos: Boolean(d.projectId) && d.autoTodos,
    };
    const done = await act(msg);
    if (done.ok) draft = null;
    await refresh();
  }

  function screenshot(): void {
    // The worker waits for the popup to go before it shoots.
    void ask({ t: 'shot', tabId });
    close();
  }

  async function end(): Promise<void> {
    if (busy) return;
    await act({ t: 'end', tabId });
    await refresh();
  }

  async function unpair(): Promise<void> {
    if (busy) return;
    await act({ t: 'unpair' });
    page = 'main';
    await refresh();
  }

  function openShortcuts(): void {
    void Promise.resolve()
      .then(() => chrome.tabs.create({ url: SHORTCUTS_URL }))
      .catch(() => undefined);
  }

  function notNow(): void {
    offer = false;
    draw();
  }

  function go(to: 'main' | 'settings'): void {
    page = to;
    error = '';
    draw();
  }

  // --- views

  function pairView(sentence: string | undefined): Node[] {
    const input = el('input', { id: 'code', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'jantar-ext:…' });
    input.value = code;
    input.addEventListener('input', () => (code = input.value));
    const form = el('form', { class: 'stack' }, el('label', { for: 'code' }, 'Pairing code'), input, button('Pair', () => undefined, { primary: true, type: 'submit' }));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!busy) void pair(input.value);
    });
    return [para(sentence ?? PAIR_PROMPT, 'lead'), form, el('p', { class: 'mono' }, PAIR_COMMAND)];
  }

  function offerView(): Node[] {
    return [
      para(OFFER_TITLE, 'lead'),
      para(OFFER_WHY, 'quiet'),
      el('div', { class: 'actions' }, button('Allow', allow, { primary: true }), button('Not now', notNow)),
    ];
  }

  function sheetView(tab: Tab, projects: Projects): Node[] {
    const d = (draft ??= { name: defaultName(tab), projectId: '', people: '', autoTodos: false });
    const name = el('input', { id: 'name', type: 'text', maxlength: String(WIRE_LIMITS.name) });
    name.value = d.name;
    name.addEventListener('input', () => (d.name = name.value));
    const people = el('input', { id: 'people', type: 'text', maxlength: String(WIRE_LIMITS.people), placeholder: 'Optional' });
    people.value = d.people;
    people.addEventListener('input', () => (d.people = people.value));

    const parts: Child[] = [el('label', { for: 'name' }, 'Name'), name];
    let toggle: HTMLLabelElement | null = null;
    if (projects !== null) {
      if (!projects.some((p) => p.id === d.projectId)) d.projectId = '';
      const select = el('select', { id: 'project' }, el('option', { value: '' }, 'No project'));
      for (const p of projects) select.append(el('option', { value: p.id }, p.emoji ? `${p.emoji} ${p.name}` : p.name));
      select.value = d.projectId;
      const box = el('input', { id: 'todos', type: 'checkbox', role: 'switch' });
      box.checked = d.autoTodos;
      box.addEventListener('change', () => (d.autoTodos = box.checked));
      const words = el('span');
      toggle = el('label', { class: 'switch', for: 'todos' }, box, words);
      const sync = () => {
        const chosen = projects.find((p) => p.id === d.projectId);
        toggle!.hidden = !chosen;
        words.textContent = chosen ? `Action items go to ${chosen.name}'s todos` : '';
      };
      select.addEventListener('change', () => {
        d.projectId = select.value;
        sync();
      });
      sync();
      parts.push(el('label', { for: 'project' }, 'Project'), select);
    }
    parts.push(el('label', { for: 'people' }, 'People'), people);
    if (toggle) parts.push(toggle);
    const form = el(
      'form',
      { class: 'stack' },
      ...parts,
      para(TELL_PEOPLE, 'quiet'),
      el('div', { class: 'actions' }, button('Start notes', () => undefined, { primary: true, type: 'submit' }), button('Screenshot', screenshot)),
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!busy) void start(tab);
    });
    return tab.shots > 0 ? [form, para(shotsLine(tab.shots), 'mono')] : [form];
  }

  function notesView(tab: Tab): Node[] {
    const out: Node[] = [
      el('p', { class: 'lead' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), `Keeping notes · ${tab.name ?? defaultName(tab)}`),
      para(shotsLine(tab.shots), 'mono'),
    ];
    const words = captionsWords(tab);
    if (words) out.push(para(words, 'quiet'));
    out.push(el('div', { class: 'actions' }, button('Screenshot', screenshot), button('End', () => void end())));
    return out;
  }

  function settingsView(s: PopupState): Node[] {
    const allowed = s.pageButton ? el('span', { class: 'quiet' }, 'Allowed') : button('Allow', allow);
    const detail = lastShotDetail(s.lastShot);
    return [
      el('h2', {}, 'Settings'),
      el('div', { class: 'row' }, el('span', {}, 'Screenshot button on meeting pages'), allowed),
      el('div', { class: 'row quiet' }, el('span', {}, shortcutLine(s.shortcut)), button(s.shortcut ? 'Change' : 'Set', openShortcuts, { link: true })),
      el('div', { class: 'stack quiet' }, el('p', {}, lastShotLine(s.lastShot)), detail && el('p', { class: 'mono' }, detail)),
      el('div', { class: 'row' }, el('span', {}, 'Paired with Jantar on this Mac'), button('Unpair', () => void unpair())),
    ];
  }

  function mainView(s: PopupState): Node[] {
    if (s.connection === 'unpaired') return pairView(s.sentence);
    if (offer && !s.pageButton) return offerView();
    if (s.connection !== 'ok') return [para(s.sentence ?? NOT_RUNNING, 'lead')];
    const tab = s.tab;
    if (!tab) return [para(NO_MEETING_TAB, 'lead'), para(CONNECTED, 'quiet')];
    if (!tab.inCall) return [para(JOIN_FIRST, 'lead')];
    const out = tab.notes ? notesView(tab) : sheetView(tab, s.projects);
    // The popup holds this tab's grant now, so its Screenshot takes it.
    const missed = missedLine(s.lastShot, tabId, Date.now());
    if (missed) out.push(para(missed, 'quiet'));
    return out;
  }

  function draw(): void {
    const body: Node[] = [];
    if (!loaded) body.push(para(LOADING, 'quiet'));
    else if (!state) body.push(para(NOT_RUNNING, 'lead'));
    else if (page === 'settings' && state.connection !== 'unpaired') body.push(...settingsView(state));
    else body.push(...mainView(state));
    if (error) body.push(el('p', { class: 'error', role: 'alert' }, error));
    // Settings while paired; the pairing view is all there is before that.
    if (state && state.connection !== 'unpaired') {
      body.push(el('footer', {}, page === 'settings' ? button('Back', () => go('main'), { link: true }) : button('Settings', () => go('settings'), { link: true })));
    }
    view.replaceChildren(el('header', {}, el('h1', {}, 'Jantar')), ...body);
    for (const b of view.querySelectorAll('button')) b.disabled = busy && !b.classList.contains('link');
    // The view's first line (its lead, or the Settings heading), read out once when it changes.
    const said = view.querySelector('.lead, h2')?.textContent ?? '';
    if (live.textContent !== said) live.textContent = said;
  }

  await refresh();
  return { refresh, tabId };
}

