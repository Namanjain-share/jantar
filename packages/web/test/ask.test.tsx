/**
 * Ask (v0.5.3 spec 1 and 12.3) against the fake API: every page state
 * (not ready, empty, sending, waiting, done, failed, cancelled, offline, a
 * load error), every card state (proposed, too old, editing, added, Undo
 * gone after a day, skipped, a refused Add), one Idempotency-Key per tap,
 * Add all (todo and food only, in order, stopping at the first refusal),
 * money through formatAmount, a reply that stays text, the show cards read
 * from `GET /v1/life/today` alone (the served target, a part that is off),
 * the example chips, Clear, the privacy line, and Ask in the places.
 * Every name and amount here is made up.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_FEATURES, type AskCard, type AskList, type AskTurn, type LifeStatus, type ProjectView, type Today, type Todo } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { parseRoute, routePath } from '../src/lib/router.js';
import { writeLocal } from '../src/lib/storage.js';
import { LOCAL_DEVICE_KEY } from '../src/ui/screens/devices/local.js';
import { PRIVACY } from '../src/ui/screens/ask/model.js';
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
  modules: { todos: true, medicines: true, food: true, places: false, finance: true },
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
  it('says what goes to Claude, in these exact words, under the box', async () => {
    open(list([]));
    await screen.findByText('Tell Ask what to add, or ask about today.');
    expect(PRIVACY).toBe(
      'Sent to Claude on your account: only what you type here (medicine names or amounts you type do go), the date and time, and which Life parts are on. Your saved lists, medicines and money stay on the Mac. Nothing is added until you tap Add.',
    );
    expect(screen.getByText(PRIVACY).className).toMatch(/\btype-small\b.*\btext-ink-3\b/);
    expect(screen.getByRole('heading', { level: 1, name: 'Ask' })).toBeTruthy();
  });

  it('empty: one line and five examples that fill the box without sending', async () => {
    const { api } = open(list([]));
    const chips = within(await screen.findByRole('group', { name: 'Examples' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['todo add call the bank', 'remind me to stretch at 6 pm', 'had 2 rotis and dal', 'spent 250 on lunch', 'calories left?']);
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

  it('Cmd+Enter sends; a second send gets a key of its own; a refusal shows in ember and keeps the words', async () => {
    const askSend = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('rate_limited', 'Too many messages from this device; try again in a minute.', 429))
      .mockResolvedValueOnce({ id: tid(1) });
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
    // Plain Enter is a new line, not a send.
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(askSend).toHaveBeenCalledTimes(2);
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
    expect(screen.getByText(PRIVACY)).toBeTruthy();
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
    expect(cards[3]!.textContent).toContain("That time has passed today, so it won't ring.");
    expect(cards[4]!.textContent).toContain("No time, so it won't ring. Edit to add one.");
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
});

describe('Add all', () => {
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
