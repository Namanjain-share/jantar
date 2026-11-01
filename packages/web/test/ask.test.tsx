/**
 * Ask (v0.5.3 spec 1 and 12.3) against the fake API: every page state
 * (not ready, empty, sending, waiting, done, failed, cancelled, offline, a
 * load error), every card state (proposed, too old, editing, added, Undo
 * gone after a day, skipped, a refused Add, Skip, Undo or Save and add),
 * one Idempotency-Key per tap, Add all (todo, food and post only, in order,
 * stopping at the first refusal, every card off while it runs, waiting
 * while a card is open in Edit), money through formatAmount, a reply that
 * stays text, the show cards read from `GET /v1/life/today` alone (the
 * served target, a part that is off, the doses, a failed read), the
 * example chips (gone while Ask can't run), Clear, a refused Send, Cancel
 * or Clear and when its sentence goes, Try again's wait, the privacy line
 * and its What's sent, Enter and Shift+Enter, and Ask in the places (none
 * on a device paired without control); v0.7's post card (its words, its
 * Edit with no text, notes or link, Add all).
 * Every name and amount here is made up.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_FEATURES, type AskCard, type AskList, type AskTurn, type LifeStatus, type MedsDay, type ProjectView, type Today, type Todo } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { parseRoute, routePath } from '../src/lib/router.js';
import { writeLocal } from '../src/lib/storage.js';
import { LOCAL_DEVICE_KEY } from '../src/ui/screens/devices/local.js';
import { PRIVACY, PRIVACY_SHORT } from '../src/ui/screens/ask/model.js';
import { navItems, tabItems } from '../src/ui/shell/nav.js';
import { NOW, fakeApi, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('ask');

afterEach(() => vi.unstubAllGlobals());

const TODAY = '2026-01-15';
const ON = stateWith({ features: { ask: true, life: true } });
const tid = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N7${String(n).padStart(2, '0')}`;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const DAY_MS = 24 * 3600_000;

const STATUS: LifeStatus = {
  open: true,
  timezone: 'UTC',
  today: TODAY,
  currency: 'INR',
  lockScreenDetails: false,
  modules: { todos: true, medicines: true, food: true, places: false, finance: true, posts: false },
  estimate: { available: true },
  backups: { last: null, count: 0 },
  push: { devices: 1, webpush: true },
};

const todoCard = (title: string, over: Partial<Extract<AskCard['action'], { type: 'todo' }>> = {}, card: Partial<AskCard> = {}): AskCard => ({
  action: { type: 'todo', title, ...over },
  state: 'proposed',
  ...card,
});
const foodCard = (name: string, kcal: number, card: Partial<AskCard> = {}): AskCard => ({ action: { type: 'food', day: TODAY, name, kcal }, state: 'proposed', ...card });
const moneyCard = (amount: number, card: Partial<AskCard> = {}): AskCard => ({
  action: { type: 'money', kind: 'expense', amount, category: 'Food', note: 'lunch', day: TODAY },
  state: 'proposed',
  ...card,
});
const showCard = (what: 'due' | 'calories' | 'meds'): AskCard => ({ action: { type: 'show', what }, state: 'proposed' });
const postCard = (over: Partial<Extract<AskCard['action'], { type: 'post' }>> = {}, card: Partial<AskCard> = {}): AskCard => ({
  action: { type: 'post', platform: 'instagram', kind: 'reel', ...over },
  state: 'proposed',
  ...card,
});

function turn(n: number, over: Partial<AskTurn> = {}): AskTurn {
  return { id: tid(n), at: ago(60_000), text: `message ${n}`, state: 'done', reply: `Reply ${n}.`, cards: [], dropped: 0, ...over };
}

const list = (turns: AskTurn[], over: Partial<AskList> = {}): AskList => ({ ready: true, turns, ...over });

/** An API whose askList answers `current()` each time (a test may change it between calls). */
function askApi(first: AskList, over: Partial<Api> = {}) {
  let current = first;
  const api = fakeApi({
    askList: vi.fn(async () => current),
    lifeStatus: vi.fn(async () => STATUS),
    projectsList: vi.fn(async () => ({ projects: [] as ProjectView[] })),
    ...over,
  });
  return { api, set: (next: AskList) => (current = next) };
}

const open = (first: AskList, over: Partial<Api> = {}, opts: { status?: 'offline' } = {}) => {
  const a = askApi(first, over);
  const r = renderApp({ path: '/ask', api: a.api, state: ON, ...opts });
  return { ...r, api: a.api, set: a.set };
};

const box = () => screen.getByRole('textbox', { name: 'What to add, or a question about today' }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('the page', () => {
  it("says it goes to Claude in one line under the box; What's sent opens the exact words", async () => {
    open(list([]));
    await screen.findByText('Tell Ask what to add, or ask about today.');
    expect(PRIVACY_SHORT).toBe('Sent to Claude on your account.');
    expect(screen.getByText(PRIVACY_SHORT).parentElement?.className).toMatch(/\btype-small\b.*\btext-ink-3\b/);
    expect(PRIVACY).toBe(
      'Sent to Claude on your account: only what you type here (medicine names or amounts you type do go), the date, time and time zone, which Life parts are on, the currency code and the fixed category names. Your saved lists, medicines and money stay on the Mac. Nothing is added until you tap Add.',
    );
    const more = button("What's sent");
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(PRIVACY)).toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const words = screen.getByText(PRIVACY);
    expect(words.className).toMatch(/\btype-small\b.*\btext-ink-3\b/);
    expect(more.getAttribute('aria-controls')).toBe(words.id);
    fireEvent.click(more);
    expect(screen.queryByText(PRIVACY)).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Ask' })).toBeTruthy();
  });

  it('empty: one line and six examples that fill the box without sending', async () => {
    const { api } = open(list([]));
    const chips = within(await screen.findByRole('group', { name: 'Examples' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual([
      'todo add call the bank',
      'remind me to stretch at 6 pm',
      'had 2 rotis and dal',
      'spent 250 on lunch',
      'calories left?',
      'reel tomorrow 7pm about the launch',
    ]);
    fireEvent.click(chips[3]!);
    expect(box().value).toBe('spent 250 on lunch');
    expect(api.askSend).not.toHaveBeenCalled();
  });

  it('sends with a new Idempotency-Key per tap, disables the box meanwhile, then clears it', async () => {
    let finish: (v: { id: string }) => void = () => undefined;
    const askSend = vi.fn((_text: string, _key?: string) => new Promise<{ id: string }>((res) => (finish = res)));
    const { api, set } = open(list([]), { askSend });
    await screen.findByText('Tell Ask what to add, or ask about today.');
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: '  todo add buy milk  ' } });
    fireEvent.click(sendButton());
    expect(askSend).toHaveBeenCalledWith('todo add buy milk', expect.any(String));
    await waitFor(() => expect(box().disabled).toBe(true));
    expect(sendButton().disabled).toBe(true);
    set(list([turn(1, { text: 'todo add buy milk', state: 'queued', reply: undefined })]));
    await act(async () => finish({ id: tid(1) }));
    await waitFor(() => expect(box().value).toBe(''));
    expect(await screen.findByText('Asking Claude…')).toBeTruthy();
    expect(api.askList).toHaveBeenCalledTimes(2);
  });

  it('Enter and Cmd+Enter send; a second send gets a key of its own; a refusal shows in ember and keeps the words', async () => {
    const askSend = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('rate_limited', 'Too many messages from this device; try again in a minute.', 429))
      .mockResolvedValueOnce({ id: tid(1) })
      .mockResolvedValueOnce({ id: tid(2) });
    open(list([]), { askSend });
    await screen.findByText('Tell Ask what to add, or ask about today.');
    fireEvent.change(box(), { target: { value: 'had 2 rotis and dal' } });
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    const alert = await screen.findByRole('alert');
    // Ask's limits say their own sentence (the day's limit is not a minute's wait).
    expect(alert.textContent).toBe('Too many messages from this device; try again in a minute.');
    expect(alert.className).toMatch(/text-signal-text/);
    expect(box().value).toBe('had 2 rotis and dal');
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(askSend).toHaveBeenCalledTimes(2));
    const keys = askSend.mock.calls.map((c) => c[1]);
    expect(keys[0]).not.toBe(keys[1]);
    await waitFor(() => expect(box().value).toBe(''));
    // The phone keyboard's Send key is Enter: it sends. Shift+Enter is a new line, and an IME's Enter picks its word.
    expect(box().getAttribute('enterkeyhint')).toBe('send');
    fireEvent.change(box(), { target: { value: 'spent 250 on lunch' } });
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(askSend).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(askSend).toHaveBeenCalledTimes(3));
    expect(askSend.mock.calls[2]?.[0]).toBe('spent 250 on lunch');
  });

  it('counts the characters past 900, up to 1000', async () => {
    open(list([]));
    await screen.findByText('Tell Ask what to add, or ask about today.');
    expect(box().maxLength).toBe(1000);
    fireEvent.change(box(), { target: { value: 'x'.repeat(900) } });
    expect(screen.queryByText('900 / 1000')).toBeNull();
    fireEvent.change(box(), { target: { value: 'x'.repeat(901) } });
    expect(screen.getByText('901 / 1000')).toBeTruthy();
  });

  it('not ready: the Mac’s sentence takes the box’s place, with its command in mono, and the history stays', async () => {
    open(list([turn(1)], { ready: false, reason: 'Turn a Life part on first: jantar life on todos' }));
    expect(await screen.findByText('Reply 1.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'What to add, or a question about today' })).toBeNull();
    expect(screen.getByText('jantar life on todos').tagName).toBe('CODE');
    expect(screen.getByText(PRIVACY_SHORT)).toBeTruthy();
    expect(button("What's sent")).toBeTruthy();
  });

  it('not ready with no history: no empty line and no examples, as there is no box for them to fill', async () => {
    open(list([], { ready: false, reason: 'Turn a Life part on first: jantar life on todos' }));
    expect(await screen.findByText('jantar life on todos')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Examples' })).toBeNull();
    expect(screen.queryByText('Tell Ask what to add, or ask about today.')).toBeNull();
    expect(screen.getByText(PRIVACY_SHORT)).toBeTruthy();
  });

  it("a refused Send's sentence goes when the words change, and when the newest turn does", async () => {
    const LIMIT = 'Too many messages from this device; try again in a minute.';
    const askSend = vi.fn().mockRejectedValue(new ApiError('rate_limited', LIMIT, 429));
    const { set } = open(list([turn(1)]), { askSend });
    await screen.findByText('Reply 1.');
    fireEvent.change(box(), { target: { value: 'todo add milk' } });
    fireEvent.click(sendButton());
    expect(await screen.findByText(LIMIT)).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'todo add oat milk' } });
    expect(screen.queryByText(LIMIT)).toBeNull();
    fireEvent.click(sendButton());
    expect(await screen.findByText(LIMIT)).toBeTruthy();
    // The list read after the refusal changes nothing, so the sentence stays until the newest turn changes.
    await waitFor(() => expect(askSend).toHaveBeenCalledTimes(2));
    expect(screen.getByText(LIMIT)).toBeTruthy();
    set(list([turn(1), turn(2)]));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(await screen.findByText('Reply 2.')).toBeTruthy();
    expect(screen.queryByText(LIMIT)).toBeNull();
  });

  it('a refused Cancel shows in ember under the waiting turn', async () => {
    const askCancel = vi.fn().mockRejectedValue(new ApiError('conflict', 'That answer already came.', 409));
    open(list([turn(1, { state: 'running', reply: undefined })]), { askCancel });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('That answer already came.');
    expect(alert.closest('li')?.textContent).toContain('message 1');
  });

  it('Try again waits while another turn is waiting, and is off offline', async () => {
    const failed = turn(1, { state: 'failed', reply: undefined, reason: 'Claude took too long to answer. Try again.' });
    const askSend = vi.fn(async () => ({ id: tid(3) }));
    const { unmount } = open(list([failed, turn(2, { state: 'running', reply: undefined })]), { askSend });
    const retry = (await screen.findByRole('button', { name: 'Try again' })) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    unmount();
    open(list([failed]), { askSend }, { status: 'offline' });
    expect(((await screen.findByRole('button', { name: 'Try again' })) as HTMLButtonElement).disabled).toBe(true);
    expect(askSend).not.toHaveBeenCalled();
  });

  it('a waiting turn: "Asking Claude…" with Cancel; Send waits for it while the box still takes words', async () => {
    const askCancel = vi.fn(async (_id: string, _key?: string) => ({ ok: true as const }));
    const { set } = open(list([turn(1, { state: 'running', reply: undefined })]), { askCancel });
    expect(await screen.findByText('Asking Claude…')).toBeTruthy();
    expect(screen.getByText('Wait for the answer, or cancel it.')).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'spent 250 on lunch' } });
    expect(box().disabled).toBe(false);
    expect(sendButton().disabled).toBe(true);
    set(list([turn(1, { state: 'cancelled', reply: undefined, reason: 'Cancelled.' })]));
    fireEvent.click(button('Cancel'));
    await waitFor(() => expect(askCancel).toHaveBeenCalledWith(tid(1), expect.any(String)));
    expect(await screen.findByText('Cancelled.')).toBeTruthy();
    expect(screen.queryByText('Wait for the answer, or cancel it.')).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it('a failed turn: its reason in ember, and Try again sends the same words as a new turn', async () => {
    const askSend = vi.fn(async () => ({ id: tid(2) }));
    open(list([turn(1, { text: 'todo add call the bank', state: 'failed', reply: undefined, reason: 'Claude took too long to answer. Try again.' })]), { askSend });
    const reason = await screen.findByText('Claude took too long to answer. Try again.');
    expect(reason.className).toMatch(/text-signal-text/);
    fireEvent.click(button('Try again'));
    await waitFor(() => expect(askSend).toHaveBeenCalledWith('todo add call the bank', expect.any(String)));
  });

  it('a load error shows the retry; the switch off says the Mac command', async () => {
    const askList = vi.fn().mockRejectedValueOnce(new ApiError('internal', 'boom', 500)).mockResolvedValueOnce(list([turn(1)]));
    const { unmount } = open(list([]), { askList });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Reply 1.')).toBeTruthy();
    unmount();
    open(list([]), { askList: vi.fn().mockRejectedValue(new ApiError('forbidden', 'Ask is off. Turn it on at your Mac: jantar ask on', 403)) });
    expect(await screen.findByText('jantar ask on')).toBeTruthy();
  });

  it('offline: the line under the title, and Send, Add, Add all, Skip and Undo are off', async () => {
    const t = turn(1, { cards: [todoCard('Call the bank'), foodCard('Roti', 240), foodCard('Dal', 180, { state: 'added', ref: tid(50) })] });
    open(list([t]), {}, { status: 'offline' });
    await screen.findByText('Reply 1.');
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'todo add milk' } });
    expect(sendButton().disabled).toBe(true);
    for (const name of ['Add: Call the bank', 'Skip: Call the bank', 'Undo: Dal', 'Add all 2']) expect(button(name).disabled, name).toBe(true);
  });

  it('Clear history asks first, then forgets the list', async () => {
    const askClear = vi.fn(async (_key?: string) => ({ ok: true as const }));
    const { set } = open(list([turn(1)]), { askClear });
    await screen.findByText('Reply 1.');
    fireEvent.click(screen.getByRole('button', { name: 'Ask history' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear history' }));
    expect(await screen.findByText("Forget this phone's Ask history? Items you added stay in Life.")).toBeTruthy();
    expect(askClear).not.toHaveBeenCalled();
    set(list([]));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(askClear).toHaveBeenCalledWith(expect.any(String)));
    expect(await screen.findByText('Tell Ask what to add, or ask about today.')).toBeTruthy();
  });

  it('a refused Clear shows in the sheet and keeps the list; the sheet opens again without it', async () => {
    const askClear = vi.fn().mockRejectedValue(new ApiError('internal', 'boom', 500));
    open(list([turn(1)]), { askClear });
    await screen.findByText('Reply 1.');
    const confirm = "Forget this phone's Ask history? Items you added stay in Life.";
    const openSheet = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ask history' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear history' }));
      expect(await screen.findByText(confirm)).toBeTruthy();
    };
    await openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('boom');
    expect(alert.className).toMatch(/text-signal-text/);
    expect(screen.getByText('Reply 1.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(confirm)).toBeNull());
    await openSheet();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("Claude's reply is plain text: a Markdown link stays words, never an <a>", async () => {
    const { container } = open(list([turn(1, { reply: 'See [bank](https://bank.example) and **this**.\nNext line.' })]));
    const reply = await screen.findByText(/See \[bank\]\(https:\/\/bank\.example\)/);
    expect(reply.textContent).toBe('See [bank](https://bank.example) and **this**.\nNext line.');
    expect(reply.className).toMatch(/whitespace-pre-wrap/);
    expect(container.querySelector('main a[href^="https://bank"]')).toBeNull();
  });

  it('your words show right-aligned, as typed', async () => {
    open(list([turn(1, { text: 'remind me to stretch at 6 pm' })]));
    const mine = await screen.findByText('remind me to stretch at 6 pm');
    expect(mine.className).toMatch(/text-right/);
  });

  it('says how many suggestions were left out', async () => {
    const { set } = open(list([turn(1, { dropped: 1 })]));
    expect(await screen.findByText('1 suggestion was left out.')).toBeTruthy();
    set(list([turn(1, { dropped: 5 })]));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(await screen.findByText('5 suggestions were left out.')).toBeTruthy();
  });
});

describe('cards', () => {
  it('words a todo, a reminder, a repeat, a priority, a project and each flag', async () => {
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-1', name: 'iPhone', scopes: ['read', 'control'] });
    const project: ProjectView = { id: tid(90), name: 'Example app', emoji: '🧪', status: 'active', createdAt: ago(1000), updatedAt: ago(1000), open: 0, overdue: 0 };
    const t = turn(1, {
      cards: [
        todoCard('Call the bank', { due: { day: '2026-01-16' } }),
        todoCard('Stretch', { due: { day: TODAY, time: '17:00' }, repeat: 'daily', priority: 'high', projectId: tid(90) }),
        todoCard('Water plants', { due: { day: '2026-01-17', time: '09:00' }, notes: 'The ones by the window' }, { flag: 'no_project' }),
        todoCard('Take Examplocin', { due: { day: TODAY, time: '08:00' } }, { flag: 'past_time' }),
        todoCard('Pay rent', {}, { flag: 'no_time' }),
      ],
    });
    open(list([t]), { projectsList: vi.fn(async () => ({ projects: [project] })) });
    const cards = within(await screen.findByRole('list', { name: 'Suggestions' })).getAllByRole('listitem');
    expect(cards[0]!.textContent).toContain('TodoCall the bank');
    expect(cards[0]!.textContent).toContain('Tomorrow, Fri 16 Jan');
    expect(cards[1]!.textContent).toContain('ReminderStretch');
    await waitFor(() => expect(cards[1]!.textContent).toContain('Today · 17:00 · Every day · High · 🧪 Example app'));
    expect(cards[2]!.textContent).toContain('Sat 17 Jan · 09:00');
    expect(cards[2]!.textContent).toContain('The ones by the window');
    expect(cards[2]!.textContent).toContain('No project by that name. It will be added without one.');
    expect(cards[3]!.textContent).toContain("That time has passed, so it won't ring.");
    expect(cards[4]!.textContent).toContain("No time, so it won't ring. Edit to add one.");
  });

  it('words a post: platform and kind, its title, where it goes, the day and time; a time gone says so', async () => {
    const t = turn(1, {
      cards: [
        postCard({ title: 'About the launch', due: { day: '2026-01-16', time: '19:00' } }),
        postCard({ platform: 'reddit', kind: 'post', where: 'r/exampletools', due: { day: TODAY, time: '08:00' } }, { flag: 'past_time' }),
        postCard({ platform: 'other', kind: 'thread', title: 'Launch notes' }),
        postCard({ platform: 'hn', kind: 'link', title: 'Show HN' }, { state: 'added', ref: tid(66) }),
      ],
    });
    open(list([t]));
    const cards = within(await screen.findByRole('list', { name: 'Suggestions' })).getAllByRole('listitem');
    expect(cards[0]!.textContent).toContain('Instagram reelAbout the launch');
    expect(cards[0]!.textContent).toContain('Tomorrow, Fri 16 Jan · 19:00');
    expect(cards[1]!.textContent).toContain('Reddit post');
    expect(cards[1]!.textContent).toContain('r/exampletools · Today · 08:00');
    expect(cards[1]!.textContent).toContain("That time has passed, so it won't ring.");
    expect(button('Add: Reddit post')).toBeTruthy();
    expect(cards[2]!.textContent).toContain('ThreadLaunch notes');
    expect(cards[3]!.textContent).toContain('Hacker News linkShow HN');
    expect(button('Undo: Show HN')).toBeTruthy();
  });

  it('money shows the amount through formatAmount, its category and note; food its kcal and a day not today', async () => {
    const t = turn(1, {
      cards: [moneyCard(25000), { action: { type: 'money', kind: 'income', amount: 12345, category: 'Salary', day: '2026-01-14' }, state: 'proposed' }, foodCard('Roti', 1240), { ...foodCard('Dal', 180), action: { type: 'food', day: '2026-01-14', name: 'Dal', kcal: 180 } }],
    });
    open(list([t]));
    const cards = within(await screen.findByRole('list', { name: 'Suggestions' })).getAllByRole('listitem');
    await waitFor(() => expect(cards[0]!.textContent).toContain('Expense₹250'));
    expect(cards[0]!.textContent).toContain('Food · lunch');
    expect(cards[1]!.textContent).toContain('Income₹123.45');
    expect(cards[1]!.textContent).toContain('Salary · Yesterday, Wed 14 Jan');
    expect(cards[2]!.textContent).toContain('FoodRoti');
    expect(cards[2]!.textContent).toContain('1,240 kcal');
    expect(cards[2]!.textContent).not.toContain('Today');
    expect(cards[3]!.textContent).toContain('180 kcal · Yesterday, Wed 14 Jan');
  });

  it('Add, Skip and Undo call their routes, each tap with its own key, and the list reloads', async () => {
    const askAdd = vi.fn(async (_id: string, _n: number, _edit?: unknown, _key?: string) => ({ id: tid(60) }));
    const askSkip = vi.fn(async (_id: string, _n: number, _key?: string) => ({ ok: true as const }));
    const askUndo = vi.fn(async (_id: string, _n: number, _key?: string) => ({ ok: true as const }));
    const first = turn(1, { cards: [todoCard('Call the bank'), moneyCard(25000)] });
    const { api, set } = open(list([first]), { askAdd, askSkip, askUndo });
    await screen.findByText('Reply 1.');
    set(list([turn(1, { cards: [todoCard('Call the bank', {}, { state: 'added', ref: tid(60) }), moneyCard(25000)] })]));
    fireEvent.click(button('Add: Call the bank'));
    await waitFor(() => expect(askAdd).toHaveBeenCalledWith(tid(1), 0, undefined, expect.any(String)));
    expect(await screen.findByText('Added')).toBeTruthy();
    set(list([turn(1, { cards: [todoCard('Call the bank', {}, { state: 'added', ref: tid(60) }), moneyCard(25000, { state: 'skipped' })] })]));
    fireEvent.click(button('Skip: ₹250'));
    await waitFor(() => expect(askSkip).toHaveBeenCalledWith(tid(1), 1, expect.any(String)));
    expect(await screen.findByText('Skipped')).toBeTruthy();
    // A skipped card is its first line alone, with no buttons.
    expect(screen.queryByRole('button', { name: 'Add: ₹250' })).toBeNull();
    set(list([turn(1, { cards: [todoCard('Call the bank'), moneyCard(25000, { state: 'skipped' })] })]));
    fireEvent.click(button('Undo: Call the bank'));
    await waitFor(() => expect(askUndo).toHaveBeenCalledWith(tid(1), 0, expect.any(String)));
    expect(await screen.findByRole('button', { name: 'Add: Call the bank' })).toBeTruthy();
    const keys = [askAdd.mock.calls[0]![3], askSkip.mock.calls[0]![2], askUndo.mock.calls[0]![2]];
    expect(new Set(keys).size).toBe(3);
    expect((api.askList as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("a refused Add shows the Mac's sentence in ember under that card, which keeps its state", async () => {
    const askAdd = vi.fn().mockRejectedValue(new ApiError('conflict', 'Over a day old. Ask again.', 409));
    open(list([turn(1, { cards: [foodCard('Roti', 240)] })]), { askAdd });
    fireEvent.click(await screen.findByRole('button', { name: 'Add: Roti' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Over a day old. Ask again.');
    expect(alert.className).toMatch(/text-signal-text/);
    expect(alert.closest('li')?.textContent).toContain('Roti');
    expect(button('Add: Roti').disabled).toBe(false);
  });

  it('a refused Skip or Undo shows in ember under its own card, which keeps its state', async () => {
    const askSkip = vi.fn().mockRejectedValue(new ApiError('internal', 'boom', 500));
    const askUndo = vi.fn().mockRejectedValue(new ApiError('conflict', 'That was changed in Life since. Undo it there.', 409));
    open(list([turn(1, { cards: [todoCard('Call the bank'), foodCard('Roti', 240, { state: 'added', ref: tid(61) })] })]), { askSkip, askUndo });
    fireEvent.click(await screen.findByRole('button', { name: 'Skip: Call the bank' }));
    const skipped = await screen.findByRole('alert');
    expect(skipped.textContent).toBe('boom');
    expect(skipped.closest('li')?.textContent).toContain('Call the bank');
    expect(button('Add: Call the bank')).toBeTruthy();
    fireEvent.click(button('Undo: Roti'));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    const undone = screen.getByText('That was changed in Life since. Undo it there.');
    expect(undone.className).toMatch(/text-signal-text/);
    expect(undone.closest('li')?.textContent).toContain('Roti');
    expect(undone.closest('li')?.textContent).toContain('Added');
  });

  it('a turn over a day old: Add and Edit are off with why; an added card keeps "Added" but loses Undo', async () => {
    const old = turn(1, { at: ago(DAY_MS + 60_000), cards: [todoCard('Call the bank'), foodCard('Roti', 240, { state: 'added', ref: tid(61) }), foodCard('Dal', 180), foodCard('Rice', 200)] });
    open(list([old]));
    await screen.findByText('Reply 1.');
    expect(button('Add: Call the bank').disabled).toBe(true);
    expect(button('Edit: Call the bank').disabled).toBe(true);
    expect(button('Skip: Call the bank').disabled).toBe(false);
    expect(screen.getAllByText('Over a day old. Ask again.').length).toBe(3);
    expect(screen.getByText('Added')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo: Roti' })).toBeNull();
    // Add all is for a turn at most a day old.
    expect(screen.queryByRole('button', { name: /^Add all/ })).toBeNull();
  });

  it('Undo shows on an added card while the turn is at most a day old', async () => {
    open(list([turn(1, { at: ago(DAY_MS - 60_000), cards: [foodCard('Roti', 240, { state: 'added', ref: tid(61) })] })]));
    expect(await screen.findByRole('button', { name: 'Undo: Roti' })).toBeTruthy();
  });

  it('Edit a todo: title, day and time change, the rest is kept; Save and add sends the whole action', async () => {
    const askAdd = vi.fn(async () => ({ id: tid(62) }));
    open(list([turn(1, { cards: [todoCard('Stretch', { due: { day: TODAY, time: '17:00' }, repeat: 'daily', priority: 'high', notes: 'Five minutes' })] })]), { askAdd });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: Stretch' }));
    const form = screen.getByRole('form', { name: 'Edit the suggestion' });
    expect(within(form).getByText('Every day')).toBeTruthy();
    expect(within(form).getByText('High')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Stretch well' } });
    fireEvent.change(within(form).getByLabelText('Due day'), { target: { value: '2026-01-16' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Clear time' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save and add' }));
    await waitFor(() =>
      expect(askAdd).toHaveBeenCalledWith(
        tid(1),
        0,
        { type: 'todo', title: 'Stretch well', notes: 'Five minutes', priority: 'high', due: { day: '2026-01-16' }, repeat: 'daily' },
        expect.any(String),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit the suggestion' })).toBeNull());
  });

  it('Edit a repeating todo: clearing its day stops Save and says why', async () => {
    open(list([turn(1, { cards: [todoCard('Stretch', { due: { day: TODAY, time: '17:00' }, repeat: 'daily' })] })]));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: Stretch' }));
    const form = screen.getByRole('form', { name: 'Edit the suggestion' });
    const save = within(form).getByRole('button', { name: 'Save and add' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(within(form).queryByText('A repeat needs a day.')).toBeNull();
    fireEvent.change(within(form).getByLabelText('Due day'), { target: { value: '' } });
    expect(save.disabled).toBe(true);
    expect(within(form).getByText('A repeat needs a day.').className).toMatch(/text-ink-3/);
    fireEvent.change(within(form).getByLabelText('Due day'), { target: { value: '2026-01-16' } });
    expect(save.disabled).toBe(false);
    expect(within(form).queryByText('A repeat needs a day.')).toBeNull();
  });

  it('Edit food: a day after today or a bad kcal stops Save; Cancel leaves the card as it was', async () => {
    const askAdd = vi.fn(async () => ({ id: tid(63) }));
    open(list([turn(1, { cards: [foodCard('Roti', 240)] })]), { askAdd });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: Roti' }));
    const form = screen.getByRole('form', { name: 'Edit the suggestion' });
    const save = within(form).getByRole('button', { name: 'Save and add' }) as HTMLButtonElement;
    fireEvent.change(within(form).getByLabelText('Day'), { target: { value: '2026-01-16' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Day'), { target: { value: '2026-01-14' } });
    fireEvent.change(within(form).getByLabelText('kcal'), { target: { value: 'lots' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('kcal'), { target: { value: '300' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Two rotis' } });
    fireEvent.click(save);
    await waitFor(() => expect(askAdd).toHaveBeenCalledWith(tid(1), 0, { type: 'food', day: '2026-01-14', name: 'Two rotis', kcal: 300 }, expect.any(String)));
    fireEvent.click(button('Edit: Roti'));
    fireEvent.click(within(screen.getByRole('form', { name: 'Edit the suggestion' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Edit the suggestion' })).toBeNull();
    expect(button('Add: Roti')).toBeTruthy();
  });

  it('Edit money: the categories are the defaults for its kind (no month is loaded), the amount in hundredths', async () => {
    const askAdd = vi.fn(async () => ({ id: tid(64) }));
    const { api } = open(list([turn(1, { cards: [moneyCard(25000)] })]), { askAdd });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: ₹250' }));
    const form = screen.getByRole('form', { name: 'Edit the suggestion' });
    const chips = () => within(within(form).getByRole('group', { name: 'Category' })).getAllByRole('button').map((b) => b.textContent);
    expect(chips()).toEqual(['Food', 'Groceries', 'Transport', 'Bills', 'Rent', 'Shopping', 'Health', 'Fun', 'Other']);
    expect((within(form).getByLabelText('Amount') as HTMLInputElement).value).toBe('250');
    fireEvent.click(within(form).getByRole('button', { name: 'Income' }));
    expect(chips()).toEqual(['Salary', 'Other']);
    expect(within(form).getByRole('button', { name: 'Other' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(form).getByRole('button', { name: 'Salary' }));
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '1,240.50' } });
    fireEvent.change(within(form).getByLabelText('Note'), { target: { value: 'refund' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save and add' }));
    await waitFor(() =>
      expect(askAdd).toHaveBeenCalledWith(tid(1), 0, { type: 'money', kind: 'income', amount: 124050, category: 'Salary', note: 'refund', day: TODAY }, expect.any(String)),
    );
    expect(api.moneyMonth).not.toHaveBeenCalled();
  });

  it('Edit a post: platform, kind, where, title, day and time; no text, notes or link; Save and add sends the plan', async () => {
    const askAdd = vi.fn(async () => ({ id: tid(67) }));
    open(list([turn(1, { cards: [postCard({ title: 'About the launch', due: { day: '2026-01-16', time: '19:00' } })] })]), { askAdd });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: About the launch' }));
    const form = screen.getByRole('form', { name: 'Edit the suggestion' });
    expect((within(form).getByLabelText('Platform') as HTMLSelectElement).value).toBe('instagram');
    expect((within(form).getByLabelText('Kind') as HTMLSelectElement).value).toBe('reel');
    expect(within(form).queryByLabelText(/Text|Caption|Notes|Link/)).toBeNull();
    expect((within(form).getByLabelText('Where') as HTMLInputElement).maxLength).toBe(80);
    fireEvent.change(within(form).getByLabelText('Platform'), { target: { value: 'reddit' } });
    fireEvent.change(within(form).getByLabelText('Kind'), { target: { value: 'post' } });
    fireEvent.change(within(form).getByLabelText('Where'), { target: { value: ' r/examplecode ' } });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Launch day' } });
    fireEvent.change(within(form).getByLabelText('Due time'), { target: { value: '19:30' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save and add' }));
    await waitFor(() =>
      expect(askAdd).toHaveBeenCalledWith(
        tid(1),
        0,
        { type: 'post', platform: 'reddit', kind: 'post', where: 'r/examplecode', title: 'Launch day', due: { day: '2026-01-16', time: '19:30' } },
        expect.any(String),
      ),
    );
  });

  it('Edit a post: a cleared day clears the time and leaves both out; a cleared title is left out', async () => {
    const askAdd = vi.fn(async () => ({ id: tid(68) }));
    open(list([turn(1, { cards: [postCard({ title: 'About the launch', due: { day: '2026-01-16', time: '19:00' } })] })]), { askAdd });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: About the launch' }));
    const form = screen.getByRole('form', { name: 'Edit the suggestion' });
    fireEvent.change(within(form).getByLabelText('Due day'), { target: { value: '' } });
    expect((within(form).getByLabelText('Due time') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: '  ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save and add' }));
    await waitFor(() => expect(askAdd).toHaveBeenCalledWith(tid(1), 0, { type: 'post', platform: 'instagram', kind: 'reel' }, expect.any(String)));
  });
});

describe('Add all', () => {
  it('counts post cards (ideas, with Undo) beside todo and food', async () => {
    const askAdd = vi.fn(async () => ({ id: tid(76) }));
    open(list([turn(1, { cards: [postCard({ title: 'About the launch' }), moneyCard(25000), postCard({ platform: 'x', kind: 'thread', title: 'Beta notes' })] })]), { askAdd });
    fireEvent.click(await screen.findByRole('button', { name: 'Add all 2' }));
    await waitFor(() => expect(askAdd).toHaveBeenCalledTimes(2));
    expect(askAdd.mock.calls.map((c) => (c as unknown[])[1])).toEqual([0, 2]);
  });

  it('shows only for two or more proposed todo or food cards, counting neither money nor show cards', async () => {
    const { set } = open(list([turn(1, { cards: [todoCard('Call the bank'), moneyCard(25000), showCard('due')] })]), { lifeToday: vi.fn(async () => ({ day: TODAY })) });
    await screen.findByText('Reply 1.');
    expect(screen.queryByRole('button', { name: /^Add all/ })).toBeNull();
    set(list([turn(1, { cards: [todoCard('Call the bank'), moneyCard(25000), foodCard('Roti', 240), foodCard('Dal', 180, { state: 'added', ref: tid(65) })] })]));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(await screen.findByRole('button', { name: 'Add all 2' })).toBeTruthy();
  });

  it('adds each in order with its own key, never the money card, and stops at the first refusal', async () => {
    const askAdd = vi
      .fn()
      .mockResolvedValueOnce({ id: tid(70) })
      .mockRejectedValueOnce(new ApiError('forbidden', 'Food is off. Turn it on at your Mac: jantar life on food', 403))
      .mockResolvedValue({ id: tid(71) });
    const t = turn(1, { cards: [foodCard('Roti', 240), moneyCard(25000), foodCard('Dal', 180), todoCard('Buy rice')] });
    open(list([t]), { askAdd });
    fireEvent.click(await screen.findByRole('button', { name: 'Add all 3' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Food is off. Turn it on at your Mac: jantar life on food');
    expect(alert.closest('li')?.textContent).toContain('Dal');
    expect(askAdd.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [tid(1), 0, undefined],
      [tid(1), 2, undefined],
    ]);
    expect(askAdd.mock.calls[0]![3]).not.toBe(askAdd.mock.calls[1]![3]);
  });

  it("turns every card's buttons off while it runs", async () => {
    const pending: Array<(v: { id: string }) => void> = [];
    const askAdd = vi.fn(() => new Promise<{ id: string }>((res) => pending.push(res)));
    open(list([turn(1, { cards: [foodCard('Roti', 240), moneyCard(25000), todoCard('Buy rice')] })]), { askAdd });
    await screen.findByRole('button', { name: 'Skip: ₹250' });
    fireEvent.click(button(/Add all 2/));
    await waitFor(() => expect(askAdd).toHaveBeenCalledTimes(1));
    const names = ['Add: Roti', 'Edit: Roti', 'Skip: Roti', 'Add: ₹250', 'Edit: ₹250', 'Skip: ₹250', 'Add: Buy rice', 'Edit: Buy rice', 'Skip: Buy rice'];
    for (const name of [...names, /Add all 2/]) expect(button(name).disabled, String(name)).toBe(true);
    await act(async () => pending[0]!({ id: tid(73) }));
    await waitFor(() => expect(askAdd).toHaveBeenCalledTimes(2));
    for (const name of names) expect(button(name).disabled, name).toBe(true);
    await act(async () => pending[1]!({ id: tid(74) }));
    await waitFor(() => expect(button('Skip: ₹250').disabled).toBe(false));
    expect(askAdd.mock.calls.map((c) => (c as unknown[])[1])).toEqual([0, 2]);
  });

  it('waits while a card is open in Edit, so it never adds the suggestion being changed', async () => {
    const askAdd = vi.fn().mockRejectedValueOnce(new ApiError('internal', 'boom', 500)).mockResolvedValue({ id: tid(75) });
    open(list([turn(1, { cards: [foodCard('Roti', 240), foodCard('Dal', 180)] })]), { askAdd });
    expect(((await screen.findByRole('button', { name: 'Add all 2' })) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button('Edit: Roti'));
    const form = screen.getByRole('form', { name: 'Edit the suggestion' });
    fireEvent.change(within(form).getByLabelText('kcal'), { target: { value: '90' } });
    expect(button('Add all 2').disabled).toBe(true);
    fireEvent.click(button('Add all 2'));
    expect(askAdd).not.toHaveBeenCalled();
    // A refused Save and add keeps the form and its words, and Add all still waits.
    fireEvent.click(within(form).getByRole('button', { name: 'Save and add' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('boom');
    expect(screen.getByRole('form', { name: 'Edit the suggestion' })).toBe(form);
    expect((within(form).getByLabelText('kcal') as HTMLInputElement).value).toBe('90');
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Save and add' }).hasAttribute('disabled')).toBe(false));
    expect(button('Add all 2').disabled).toBe(true);
    expect(askAdd.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([[tid(1), 0, { type: 'food', day: TODAY, name: 'Roti', kcal: 90 }]]);
    // Cancel closes the form and the card shows the suggestion again, so Add all may add it.
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Edit the suggestion' })).toBeNull();
    expect(button('Add all 2').disabled).toBe(false);
  });
});

describe('show cards', () => {
  const today = (over: Partial<Today> = {}): Today => ({ day: TODAY, ...over });
  const todo = (n: number, title: string, over: Partial<Todo> = {}): Todo => ({ id: tid(n), title, priority: 'normal', createdAt: ago(5000), updatedAt: ago(5000), ...over });

  it('fill from GET /v1/life/today alone: calories against the served target with what is left', async () => {
    const lifeToday = vi.fn(async () => today({ food: { kcal: 1100, target: 1500, weight: null } }));
    const { api } = open(list([turn(1, { reply: 'Here is today.', cards: [showCard('calories')] })]), { lifeToday });
    expect(await screen.findByText('1,100 / 1,500 kcal')).toBeTruthy();
    expect(screen.getByText('400 kcal left')).toBeTruthy();
    expect(screen.getByText('Now')).toBeTruthy();
    expect(lifeToday).toHaveBeenCalledTimes(1);
    for (const read of ['foodDay', 'medsGet', 'todosList', 'moneyMonth'] as const) expect(api[read]).not.toHaveBeenCalled();
    // No Add on a show card.
    expect(screen.queryByRole('button', { name: /^Add/ })).toBeNull();
  });

  it('calories over the target: "+N over" and no left line', async () => {
    open(list([turn(1, { cards: [showCard('calories')] })]), { lifeToday: vi.fn(async () => today({ food: { kcal: 1700, target: 1500, weight: null } })) });
    expect(await screen.findByText('+200 over')).toBeTruthy();
    expect(screen.queryByText(/kcal left/)).toBeNull();
  });

  it('due: the todos due today and overdue as rows; none: "Nothing due today."', async () => {
    const lifeToday = vi.fn(async () => today({ todos: { overdue: [todo(80, 'Renew the card', { due: { day: '2026-01-13' } })], today: [todo(81, 'Call the bank', { due: { day: TODAY } })] } }));
    const { unmount } = open(list([turn(1, { cards: [showCard('due')] })]), { lifeToday });
    expect(await screen.findByText('Renew the card')).toBeTruthy();
    expect(screen.getByText('Call the bank')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark done: Call the bank' })).toBeTruthy();
    unmount();
    open(list([turn(1, { cards: [showCard('due')] })]), { lifeToday: vi.fn(async () => today({ todos: { overdue: [], today: [] } })) });
    expect(await screen.findByText('Nothing due today.')).toBeTruthy();
  });

  it('a part that is off now says so', async () => {
    open(list([turn(1, { cards: [showCard('calories'), showCard('meds'), showCard('due')] })]), { lifeToday: vi.fn(async () => today()) });
    expect(await screen.findByText('Food is off.')).toBeTruthy();
    expect(screen.getByText('Medicines are off.')).toBeTruthy();
    expect(screen.getByText('Todos are off.')).toBeTruthy();
  });

  it("meds: the day's doses from today; Taken logs that dose with its own key, then today is read again", async () => {
    const MED = tid(85);
    const meds: MedsDay = {
      day: TODAY,
      today: TODAY,
      groups: [{ period: 'morning', items: [{ medId: MED, name: 'Placebin', dose: '10 mg', slot: '08:00', status: 'pending', overdue: true }] }],
    };
    const lifeToday = vi.fn(async () => today({ meds }));
    const doseLog = vi.fn(async () => ({ id: tid(86) }));
    const { api } = open(list([turn(1, { cards: [showCard('meds')] })]), { lifeToday, doseLog });
    fireEvent.click(await screen.findByRole('button', { name: 'Taken: Placebin 10 mg at 08:00' }));
    await waitFor(() => expect(doseLog).toHaveBeenCalledWith(MED, { day: TODAY, slot: '08:00', status: 'taken' }, expect.any(String)));
    await waitFor(() => expect(lifeToday).toHaveBeenCalledTimes(2));
    expect(api.medsGet).not.toHaveBeenCalled();
    expect(api.askAdd).not.toHaveBeenCalled();
  });

  it('a failed today read shows in the card with Try again, which reads it again', async () => {
    const lifeToday = vi.fn().mockRejectedValueOnce(new ApiError('internal', 'boom', 500)).mockResolvedValue(today({ food: { kcal: 1100, target: 1500, weight: null } }));
    open(list([turn(1, { reply: 'Here is today.', cards: [showCard('calories')] })]), { lifeToday });
    expect(await screen.findByText('boom')).toBeTruthy();
    expect(screen.getByText('Here is today.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('1,100 / 1,500 kcal')).toBeTruthy();
    expect(lifeToday).toHaveBeenCalledTimes(2);
  });

  it('nothing is read from today while no show card is on screen', async () => {
    const { api } = open(list([turn(1, { cards: [todoCard('Call the bank')] })]));
    await screen.findByText('Reply 1.');
    expect(api.lifeToday).not.toHaveBeenCalled();
  });
});

describe('Ask in the places', () => {
  const labels = (f: Partial<typeof NO_FEATURES>) => {
    const t = tabItems({ ...NO_FEATURES, ...f });
    return { tabs: t.tabs.map((i) => i.label), more: t.more.map((i) => i.label) };
  };

  it('only while Ask is on, right after Today; with everything on the phone shows Board, Today, Ask, Files, More', () => {
    expect(navItems({ ...NO_FEATURES }).map((i) => i.label)).not.toContain('Ask');
    expect(navItems({ ...NO_FEATURES, life: true, ask: true }).map((i) => i.label)).toEqual(['Board', 'Today', 'Ask', 'Accounts', 'Alerts', 'Devices']);
    expect(navItems({ ...NO_FEATURES, ask: true }).find((i) => i.label === 'Ask')?.href).toBe('/ask');
    expect(labels({ life: true, files: true, ask: true, intel: true, meetings: true })).toEqual({
      tabs: ['Board', 'Today', 'Ask', 'Files', 'More'],
      more: ['Accounts', 'Alerts', 'Devices', 'Intel', 'Meetings'],
    });
  });

  it('on a phone the tab bar has Ask, lit on /ask (Today is not)', async () => {
    renderApp({ path: '/ask', api: askApi(list([])).api, state: stateWith({ features: { life: true, files: true, ask: true, intel: true, meetings: true } }) });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const tabs = within(nav)
      .getAllByRole('link')
      .map((l) => l.getAttribute('aria-label') ?? l.textContent?.trim().replace(/\d+$/, ''));
    expect(tabs).toEqual(['Board', 'Today', 'Ask', 'Files', 'More']);
    expect(within(nav).getByRole('link', { name: /Ask/ }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: /Today/ }).getAttribute('aria-current')).toBeNull();
    await screen.findByText('Tell Ask what to add, or ask about today.');
  });

  it('no Ask tab on a device paired without control (every Ask call needs it); a browser with no pairing record keeps it', () => {
    const ALL = stateWith({ features: { life: true, files: true, ask: true, intel: true, meetings: true } });
    const tabs = () =>
      within(screen.getByRole('navigation', { name: 'Main' }))
        .getAllByRole('link')
        .map((l) => l.getAttribute('aria-label') ?? l.textContent?.trim().replace(/\d+$/, ''));
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-2', name: 'Tablet', scopes: ['read'] });
    const r = renderApp({ path: '/', state: ALL });
    expect(tabs()).toEqual(['Board', 'Today', 'Files', 'Accounts', 'More']);
    r.unmount();
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-1', name: 'iPhone', scopes: ['read', 'control'] });
    const r2 = renderApp({ path: '/', state: ALL });
    expect(tabs()).toEqual(['Board', 'Today', 'Ask', 'Files', 'More']);
    r2.unmount();
    localStorage.clear();
    renderApp({ path: '/', state: ALL });
    expect(tabs()).toEqual(['Board', 'Today', 'Ask', 'Files', 'More']);
  });

  it('/ask while Ask is off says so, with the Mac command', () => {
    renderApp({ path: '/ask', state: stateWith({ features: { life: true } }) });
    expect(screen.getByText('That is off on this Mac.')).toBeTruthy();
    expect(screen.getByText('jantar ask on')).toBeTruthy();
  });

  it('/ask parses and round-trips', () => {
    expect(parseRoute('/ask')).toEqual({ name: 'ask' });
    expect(parseRoute('/ask/')).toEqual({ name: 'ask' });
    expect(routePath({ name: 'ask' })).toBe('/ask');
    expect(parseRoute(routePath(parseRoute('/ask', '?x=1')))).toEqual({ name: 'ask' });
  });
});
