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
 * v0.8: Settings has the Read saved links switch (off by default). Turning
 * it on asks Chrome for the six post sites on the click itself (Chrome asks
 * only on a user gesture), then tells the worker; turning it off tells the
 * worker only.
 *
 * v0.10, Start when I join: on a call's join screen, in its waiting room or
 * after leaving it, the sheet is the arm sheet (the same fields, Start when
 * I join, no Screenshot); an armed tab shows the armed view (Change, and
 * Cancel or Not this call), which asks the worker again every
 * ARM_TIMING.popupPollMs so it turns into the notes view by itself once
 * notes start; so does "Join the call first." on a meeting tab, so it turns
 * into the arm sheet once the page shows its join screen (a page in its
 * first second, Teams still loading). Never while a form is on screen: a
 * redraw would lose the typing. The notes view says when notes started by themselves; the sheet
 * says why they did not, and that this call is skipped (an `off` arm). Settings has Always start when I join a call (off
 * by default) and Call check (the page's stage and hook id, for reports), first. While Jantar takes nothing (Meetings
 * off) or does not answer, an armed tab says its arm cannot start, with Cancel or Not this call; while not paired with
 * Always on, the pairing view says nothing can start and offers to turn Always off. After a redraw the keyboard stays in
 * the view: on the same control, else the view's first one.
 *
 * Built with DOM calls and textContent only (the page has no inline
 * script, no style attribute and no on* handler). No em dash, no
 * exclamation mark.
 */
import type { ArmView, CallStage, Done, FromPopup, LastShot, PopupState, ShotFrom } from '../shared/messages.js';
import type { MeetingSite } from '../shared/sites.js';
import { ARM_TIMING, WIRE_LIMITS } from '../shared/wire.js';
import { ALWAYS, ARM, CALL_CHECK, JOIN_FIRST, NOT_RUNNING, NO_MEETING_TAB, READS, SHOT, TRY_AGAIN } from '../background/sentences.js';
import { postOrigins } from '../shared/post-sites.js';
import { noCaptions } from '../shared/captions.js';

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

/** v0.10: the stages Start when I join is offered on. */
const WAITING: ReadonlySet<CallStage> = new Set(['prejoin', 'lobby', 'left']);

/**
 * v0.10: in the call as the popup means it: the page says so, or its call
 * watch is in a call whose stage is not known yet. A waiting room's one-poll
 * flicker of an in-call control keeps the arm views.
 */
export function inTheCall(tab: Pick<Tab, 'inCall' | 'stage'>): boolean {
  return tab.inCall && (tab.stage === 'in' || tab.stage === 'none');
}

const armLead = (stage: CallStage): string => (stage === 'lobby' ? ARM.leadLobby : stage === 'left' ? ARM.leadLeft : ARM.leadPrejoin);
const armedLead = (stage: CallStage): string => (stage === 'lobby' ? ARM.armedLobby : stage === 'left' ? ARM.armedLeft : ARM.armedPrejoin);

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
      // v0.10: the page's own bubble, with the way to turn captions on in this client (shared/captions.ts).
      return noCaptions(tab.site === 'meet' ? 'meet' : 'teams');
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

/** `name`: what a screen reader says when the label alone says too little ("Change"). */
function button(label: string, onClick: (ev: MouseEvent) => void, opts: { primary?: boolean; link?: boolean; type?: 'button' | 'submit'; name?: string } = {}): HTMLButtonElement {
  const b = el('button', { type: opts.type ?? 'button', class: opts.primary ? 'primary' : opts.link ? 'link' : undefined, 'aria-label': opts.name }, label);
  b.addEventListener('click', onClick);
  return b;
}

/** A control as a redraw finds it again: its id, else its label. */
const focusKey = (n: Element): string => (n.id ? `#${n.id}` : (n.textContent ?? ''));

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
  /** The sheet and the pairing code as typed, kept across redraws. `nameTouched`: the Name was typed in (else Start when I join sends '': the page's title then). */
  let draft: { name: string; projectId: string; people: string; autoTodos: boolean; nameTouched: boolean } | null = null;
  let code = '';
  /** v0.10: the armed view's Change: the arm sheet, filled from the arm. */
  let editing = false;
  /** v0.10: the timer of a view that follows the page (asks the worker again while it shows). */
  let polling: ReturnType<typeof setTimeout> | undefined;
  let following = false;
  /** The control that had the keyboard before a redraw (its id or label), until a redraw gives the keyboard back. */
  let refocus: string | null = null;

  draw();
  const tabId = typeof opts.tabId === 'number' ? opts.tabId : await activeTabId();

  async function refresh(): Promise<void> {
    const got = await ask({ t: 'state', tabId });
    loaded = true;
    state = isState(got) ? got : null;
    if (!state?.tab || state.tab.notes) {
      draft = null;
      editing = false;
    }
    draw();
  }

  const newDraft = (tab: Tab) => ({ name: defaultName(tab), projectId: '', people: '', autoTodos: false, nameTouched: false });

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

  /** v0.8: Read saved links. On: Chrome's prompt for the post sites, from the click itself; then the worker. */
  function setReads(on: boolean): void {
    if (busy) return;
    if (!on) {
      void act({ t: 'reads', on: false }).then(() => refresh());
      return;
    }
    const asked = chrome.permissions.request({ origins: postOrigins() });
    void asked
      .catch(() => false)
      .then(async (granted) => {
        if (!granted) {
          error = READS.denied;
          return refresh();
        }
        await act({ t: 'reads', on: true });
        return refresh();
      });
  }

  async function start(tab: Tab): Promise<void> {
    const d = draft ?? newDraft(tab);
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

  /** v0.10: Start when I join, with the sheet's fields; an untouched Name is the page's title once in the call. */
  async function armIt(tab: Tab): Promise<void> {
    const d = draft ?? newDraft(tab);
    const done = await act({
      t: 'arm',
      tabId,
      name: d.nameTouched ? d.name : '',
      ...(d.projectId ? { projectId: d.projectId } : {}),
      ...(d.people.trim() ? { people: d.people } : {}),
      autoTodos: Boolean(d.projectId) && d.autoTodos,
    });
    if (done.ok) {
      draft = null;
      editing = false;
    }
    await refresh();
  }

  /** v0.10: Cancel, or Not this call. */
  async function disarm(): Promise<void> {
    if (busy) return;
    await act({ t: 'disarm', tabId });
    draft = null;
    editing = false;
    await refresh();
  }

  /** v0.10: Change: the arm sheet with the arm's fields. */
  function change(tab: Tab, arm: ArmView): void {
    draft = { name: arm.name || defaultName(tab), projectId: arm.projectId ?? '', people: arm.people ?? '', autoTodos: arm.autoTodos, nameTouched: arm.name !== '' };
    editing = true;
    error = '';
    draw();
  }

  function back(): void {
    draft = null;
    editing = false;
    error = '';
    draw();
  }

  /** v0.10: Always start when I join a call (no Chrome prompt: nothing new is asked of Chrome). */
  function setAlways(on: boolean): void {
    if (busy) return;
    void act({ t: 'always', on }).then(() => refresh());
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

  /** v0.10: Cancel (a popup arm) or Not this call (an Always arm). */
  const disarmButton = (arm: ArmView) => button(arm.from === 'always' ? ARM.notThisCall : ARM.cancel, () => void disarm(), arm.from === 'always' ? {} : { name: ARM.cancelName });

  function pairView(sentence: string | undefined, always: boolean): Node[] {
    const input = el('input', { id: 'code', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'jantar-ext:…' });
    input.value = code;
    input.addEventListener('input', () => (code = input.value));
    const form = el('form', { class: 'stack' }, el('label', { for: 'code' }, 'Pairing code'), input, button('Pair', () => undefined, { primary: true, type: 'submit' }));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!busy) void pair(input.value);
    });
    const out: Node[] = [para(sentence ?? PAIR_PROMPT, 'lead'), form, el('p', { class: 'mono' }, PAIR_COMMAND)];
    // v0.10: Always kept through a 401 arms nothing until paired; it can be turned off here (Settings needs pairing).
    if (always) out.push(para(ALWAYS.unpaired, 'quiet'), el('div', { class: 'actions' }, button(ALWAYS.turnOff, () => setAlways(false), { name: ALWAYS.turnOffName })));
    return out;
  }

  function offerView(): Node[] {
    return [
      para(OFFER_TITLE, 'lead'),
      para(OFFER_WHY, 'quiet'),
      el('div', { class: 'actions' }, button('Allow', allow, { primary: true }), button('Not now', notNow)),
    ];
  }

  /** The assign sheet: Start notes in the call, or (v0.10) Start when I join before it. */
  function sheetView(tab: Tab, projects: Projects, mode: 'start' | 'arm' = 'start'): Node[] {
    const d = (draft ??= newDraft(tab));
    const name = el('input', { id: 'name', type: 'text', maxlength: String(WIRE_LIMITS.name) });
    name.value = d.name;
    name.addEventListener('input', () => {
      d.name = name.value;
      d.nameTouched = true;
    });
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
    if (mode === 'arm') {
      const form = el(
        'form',
        { class: 'stack' },
        ...parts,
        para(TELL_PEOPLE, 'quiet'),
        para(ARM.hint, 'quiet'),
        el('div', { class: 'actions' }, button(ARM.button, () => undefined, { primary: true, type: 'submit' }), editing && button('Back', back, { link: true })),
      );
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (!busy) void armIt(tab);
      });
      // Not this call (or End) while Always is on: nothing starts by itself unless he arms it here.
      return [para(armLead(tab.stage), 'lead'), tab.arm?.off ? para(ARM.skipped, 'quiet') : null, form].filter((n) => n !== null) as Node[];
    }
    // v0.10: notes did not start by themselves lately: why, above Start notes.
    const failed = tab.auto && !tab.auto.ok ? el('p', { class: 'error', role: 'alert' }, ARM.failed(tab.auto.text ?? TRY_AGAIN)) : null;
    const form = el(
      'form',
      { class: 'stack' },
      ...parts,
      para(TELL_PEOPLE, 'quiet'),
      failed,
      el('div', { class: 'actions' }, button('Start notes', () => undefined, { primary: true, type: 'submit' }), button('Screenshot', screenshot)),
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!busy) void start(tab);
    });
    return tab.shots > 0 ? [form, para(shotsLine(tab.shots), 'mono')] : [form];
  }

  /** v0.10: an armed tab: what starts when he is in the call, Change, and Cancel or Not this call. */
  function armedView(tab: Tab, arm: ArmView, projects: Projects): Node[] {
    following = true;
    const project = arm.projectId ? projects?.find((p) => p.id === arm.projectId) : undefined;
    // No name of its own: the page's title once in the call (shown as it reads now, when the page has one).
    const name = arm.name || (tab.title.trim() ? ARM.fromPage(defaultName(tab)) : ARM.nameFromPage);
    const what = [name, projects === null ? '' : (project?.name ?? ARM.noProject), project && arm.autoTodos ? ARM.todos : ''].filter(Boolean).join(' · ');
    return [
      el('p', { class: 'lead' }, el('span', { class: 'dot ring', 'aria-hidden': 'true' }), armedLead(tab.stage)),
      para(what),
      arm.people ? para(`People: ${arm.people}`) : null,
      para(TELL_PEOPLE, 'quiet'),
      arm.from === 'always' ? para(ARM.byAlways, 'quiet') : null,
      el(
        'div',
        { class: 'actions' },
        button(ARM.change, () => change(tab, arm), { name: 'Change what starts when you join' }),
        disarmButton(arm),
      ),
    ].filter((n) => n !== null) as Node[];
  }

  /** v0.10: not in the call: the armed view, the arm sheet, or why there is nothing to arm. */
  function beforeView(tab: Tab, projects: Projects): Node[] {
    const arm = tab.arm && !tab.arm.off ? tab.arm : null;
    if (!tab.notes && arm && !editing) return armedView(tab, arm, projects);
    if (!tab.notes && (arm || WAITING.has(tab.stage))) return sheetView(tab, projects, 'arm');
    // Nothing to press here: follow the page until it shows a join screen, a waiting room or the call.
    following = true;
    // Notes on, not in the call (a reload into the join screen): they go on once the call is on again.
    if (tab.notes) return [para(JOIN_FIRST, 'lead')];
    return [para(JOIN_FIRST, 'lead'), para(ARM.where, 'quiet')];
  }

  function notesView(tab: Tab): Node[] {
    const out: Node[] = [
      el('p', { class: 'lead' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), `Keeping notes · ${tab.name ?? defaultName(tab)}`),
      para(shotsLine(tab.shots), 'mono'),
    ];
    const words = captionsWords(tab);
    if (words) out.push(para(words, 'quiet'));
    // v0.10: notes started by themselves when he was let in.
    if (tab.auto?.ok) out.push(para(ARM.startedAt(clockOf(tab.auto.at)), 'quiet'));
    out.push(el('div', { class: 'actions' }, button('Screenshot', screenshot), button('End', () => void end())));
    return out;
  }

  function settingsView(s: PopupState): Node[] {
    const allowed = s.pageButton ? el('span', { class: 'quiet' }, 'Allowed') : button('Allow', allow);
    const detail = lastShotDetail(s.lastShot);
    const box = el('input', { id: 'reads', type: 'checkbox', role: 'switch' });
    box.checked = s.reads;
    box.addEventListener('change', () => setReads(box.checked));
    const always = el('input', { id: 'always', type: 'checkbox', role: 'switch' });
    always.checked = s.always;
    always.addEventListener('change', () => setAlways(always.checked));
    return [
      el('h2', {}, 'Settings'),
      // v0.10: the meeting settings first, together: Always, then what the page shows (by our own hook id, never page text).
      el('div', { class: 'setting' }, el('label', { class: 'switch', for: 'always' }, always, el('span', {}, ALWAYS.title)), para(ALWAYS.why, 'quiet')),
      // The hook id keeps to one line (at 320 px it moves to the next line whole).
      s.tab ? el('p', { class: 'mono check' }, CALL_CHECK.line(CALL_CHECK[s.tab.stage], ''), s.tab.hook && ' · ', s.tab.hook && el('span', { class: 'hook' }, s.tab.hook)) : null,
      el('div', { class: 'row' }, el('span', {}, 'Screenshot button on meeting pages'), allowed),
      el('div', { class: 'setting' }, el('label', { class: 'switch', for: 'reads' }, box, el('span', {}, READS.title)), para(READS.why, 'quiet')),
      el(
        'div',
        { class: 'row quiet' },
        el('span', {}, shortcutLine(s.shortcut)),
        button(s.shortcut ? 'Change' : 'Set', openShortcuts, { link: true, name: s.shortcut ? 'Change the screenshot shortcut' : 'Set the screenshot shortcut' }),
      ),
      el('div', { class: 'stack quiet' }, el('p', {}, lastShotLine(s.lastShot)), detail && el('p', { class: 'mono' }, detail)),
      el('div', { class: 'row' }, el('span', {}, 'Paired with Jantar on this Mac'), button('Unpair', () => void unpair())),
    ].filter((n) => n !== null) as Node[];
  }

  function mainView(s: PopupState): Node[] {
    if (s.connection === 'unpaired') return pairView(s.sentence, s.always);
    if (offer && !s.pageButton) return offerView();
    if (s.connection !== 'ok') {
      // v0.10: an armed tab keeps its arm, which cannot start until this is fixed: say so, and let him drop it.
      const arm = s.tab && !s.tab.notes && s.tab.arm && !s.tab.arm.off ? s.tab.arm : null;
      const why = para(s.sentence ?? NOT_RUNNING, 'lead');
      return arm ? [why, para(ARM.blocked, 'quiet'), el('div', { class: 'actions' }, disarmButton(arm))] : [why];
    }
    const tab = s.tab;
    if (!tab) return [para(NO_MEETING_TAB, 'lead'), para(CONNECTED, 'quiet')];
    if (!(tab.notes ? tab.inCall : inTheCall(tab))) return beforeView(tab, s.projects);
    const out = tab.notes ? notesView(tab) : sheetView(tab, s.projects);
    // The popup holds this tab's grant now, so its Screenshot takes it.
    const missed = missedLine(s.lastShot, tabId, Date.now());
    if (missed) out.push(para(missed, 'quiet missed'));
    return out;
  }

  /** v0.10: a view that follows the page asks again while it shows (and the popup is still on screen). */
  function poll(): void {
    polling = undefined;
    if (view.isConnected) void refresh();
  }

  function draw(): void {
    following = false;
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
    const had = document.activeElement;
    if (had && had !== document.body && view.contains(had)) refocus = focusKey(had);
    view.replaceChildren(el('header', {}, el('h1', {}, 'Jantar')), ...body);
    for (const b of view.querySelectorAll('button')) b.disabled = busy && !b.classList.contains('link');
    // The keyboard stays in the view (not on <body>): the same control, else the first; never while the buttons are off.
    if (refocus !== null && !busy) {
      const controls = [...view.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, select, button')].filter((n) => !n.disabled);
      const to = controls.find((n) => focusKey(n) === refocus) ?? controls[0];
      to?.focus();
      refocus = null;
    }
    // The view's first line (its lead, or the Settings heading) and a failed try in this tab, read out once when they change.
    const said = [view.querySelector('.lead, h2'), view.querySelector('.missed')].map((n) => n?.textContent ?? '').filter(Boolean).join(' ');
    if (live.textContent !== said) live.textContent = said;
    if (following && !busy && page === 'main') polling ??= setTimeout(poll, ARM_TIMING.popupPollMs);
    else if (polling !== undefined) {
      clearTimeout(polling);
      polling = undefined;
    }
  }

  await refresh();
  return { refresh, tabId };
}

