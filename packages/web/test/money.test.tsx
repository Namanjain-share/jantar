/**
 * Finance (v0.4 spec 4.8, 5.7, 5.10) against the fake API: the month's
 * totals and entries in hundredths through lib/money.ts, the plain-number
 * line with no currency, categories with budgets (over budget in ember),
 * bills (due today or past in ember, Paid with the amount prefilled, `?bill=`
 * opening Paid), the entry, budget and bill sheets (an amount the field
 * cannot read says the rule: a dot for decimals, commas for thousands), an
 * entry's Delete with no confirm (held back under a 5 s Undo that puts it
 * back exactly), stepping months, and every state with the <h1>.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CATEGORIES, type Bill, type LifeStatus, type MoneyEntry, type MoneyMonth } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { formatAmount } from '../src/lib/money.js';
import { AMOUNT_HINT, categoriesFor } from '../src/ui/screens/life/money/fields.js';
import { NO_CURRENCY } from '../src/ui/screens/life/money/Money.js';
import { fakeApi, iso, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('money');

afterEach(() => vi.useRealTimers());

const DAY = '2026-01-15';
const id = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`;

function status(over: Partial<LifeStatus> = {}): LifeStatus {
  return {
    open: true,
    timezone: 'UTC',
    today: DAY,
    currency: 'INR',
    lockScreenDetails: false,
    modules: { todos: false, medicines: false, food: false, places: false, finance: true, posts: false },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
    ...over,
  };
}

function money(n: number, over: Partial<MoneyEntry> = {}): MoneyEntry {
  return { id: id(n), kind: 'expense', amount: 124_000, category: 'Groceries', day: DAY, createdAt: iso(0), updatedAt: iso(0), ...over };
}

function bill(n: number, over: Partial<Bill> = {}): Bill {
  return { id: id(n), name: `Example Stream ${n}`, amount: 64_900, category: 'Bills', repeat: 'monthly', nextDue: DAY, createdAt: iso(0), updatedAt: iso(0), ...over };
}

function month(over: Partial<MoneyMonth> = {}): MoneyMonth {
  return {
    month: '2026-01',
    currency: 'INR',
    entries: [money(1, { note: 'milk, eggs' }), money(2, { kind: 'income', amount: 12_000_000, category: 'Salary', day: '2026-01-01' })],
    spent: 1_084_000,
    income: 12_000_000,
    byCategory: [
      { category: 'Food', spent: 960_000, budget: 840_000 },
      { category: 'Groceries', spent: 124_000, budget: 1_000_000 },
      { category: 'Rent', spent: 0, budget: null },
    ],
    categories: [...DEFAULT_CATEGORIES.expense, 'Salary', 'Pets'],
    bills: [bill(10), bill(11, { nextDue: '2026-02-03', repeat: 'yearly', name: 'Example Domain' })],
    ...over,
  };
}

function render(opts: { load?: (m?: string) => Promise<MoneyMonth>; status?: LifeStatus; path?: string; api?: Parameters<typeof fakeApi>[0]; conn?: 'live' | 'offline' } = {}) {
  const api = fakeApi({
    lifeStatus: vi.fn(async () => opts.status ?? status()),
    moneyMonth: vi.fn(opts.load ?? (async (m?: string) => month(m ? { month: m, entries: [], spent: 0, income: 0, byCategory: [] } : {}))),
    ...opts.api,
  });
  return renderApp({ path: opts.path ?? '/money', api, state: stateWith({ features: { life: true } }), ...(opts.conn ? { status: opts.conn } : {}) });
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'Finance' });
const inr = (h: number) => formatAmount(h, 'INR');

describe('Finance: states and totals', () => {
  it('shows its title while loading and with an error', async () => {
    let fail!: (e: unknown) => void;
    render({ load: () => new Promise((_, rej) => (fail = rej)) });
    await heading();
    // The <h1> can paint before the effect that calls the loader has run.
    await waitFor(() => expect(fail).toBeTypeOf('function'));
    await act(async () => fail(new ApiError('forbidden', 'Finance is off. Turn it on at your Mac: jantar life on finance', 403)));
    expect((await screen.findByText('jantar life on finance')).tagName).toBe('CODE');
    expect(screen.getByRole('heading', { level: 1, name: 'Finance' })).toBeTruthy();
  });

  it('says Life is broken with the restore command in mono, and no retry', async () => {
    render({ load: async () => Promise.reject(new ApiError('life_unavailable', 'Life data could not be opened. The file is untouched. Restore a backup at your Mac: jantar life restore <file>', 503)) });
    expect((await screen.findByText('jantar life restore <file>')).tagName).toBe('CODE');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await heading();
  });

  it('says so when this device has no control scope', async () => {
    render({ load: async () => Promise.reject(new ApiError('forbidden', 'this device does not have the control scope', 403)) });
    expect(await screen.findByText(/Life needs control access/)).toBeTruthy();
    await heading();
  });

  it('shows spent and income in the currency, in mono', async () => {
    render();
    const line = await screen.findByText(`Spent ${inr(1_084_000)} · Income ${inr(12_000_000)}`);
    expect(line.className).toContain('type-mono');
    expect(screen.queryByText(/Set a currency/)).toBeNull();
  });

  it('with no currency: plain numbers and the Mac command in mono', async () => {
    render({ load: async () => month({ currency: null }), status: status({ currency: null }) });
    expect(await screen.findByText(`Spent ${formatAmount(1_084_000, null)} · Income ${formatAmount(12_000_000, null)}`)).toBeTruthy();
    expect((screen.getByText('jantar life set currency USD')).tagName).toBe('CODE');
    expect(NO_CURRENCY.startsWith('Amounts show as plain numbers.')).toBe(true);
  });

  it('says "No entries this month." for an empty month', async () => {
    render({ load: async () => month({ entries: [] }) });
    expect(await screen.findByText('No entries this month.')).toBeTruthy();
  });

  it('steps back a month and never past this one', async () => {
    const { api, router } = render();
    await screen.findByText('January 2026');
    expect((screen.getByRole('button', { name: 'Next month' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(router.getState().route).toEqual({ name: 'money', month: '2025-12' });
    await waitFor(() => expect(api.moneyMonth).toHaveBeenLastCalledWith('2025-12'));
    expect(await screen.findByText('December 2025')).toBeTruthy();
  });

  it('offline: the month stays and adding is off', async () => {
    render({ conn: 'offline' });
    await screen.findByText(/^Spent /);
    for (const name of ['Expense', 'Income', 'Paid Example Stream 10']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled, name).toBe(true);
    // No header "+" beside them: one way to add.
    expect(screen.queryByRole('button', { name: 'Add expense' })).toBeNull();
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
  });
});

describe('Finance: categories and budgets', () => {
  it('shows spend against the budget, ember only past it, and no bar without one', async () => {
    render();
    const cats = await screen.findByRole('region', { name: 'By category' });
    const [food, groceries, rent] = within(cats).getAllByRole('listitem');
    expect(within(food!).getByText(`${inr(120_000)} over`).className).toContain('text-signal-text');
    expect(food!.querySelector('[data-bar]')?.getAttribute('data-bar')).toBe('100');
    expect(groceries!.querySelector('.text-signal-text')).toBeNull();
    expect(groceries!.querySelector('[data-bar]')?.getAttribute('data-bar')).toBe('12');
    expect(rent!.querySelector('[data-bar]')).toBeNull();
  });

  it('sets a budget from a category row, and removes one', async () => {
    const budgetSet = vi.fn(async () => ({ ok: true as const }));
    render({ api: { budgetSet } });
    const cats = await screen.findByRole('region', { name: 'By category' });
    fireEvent.click(within(cats).getByText('Rent'));
    let sheet = await screen.findByRole('dialog', { name: 'Monthly budget for Rent' });
    fireEvent.change(within(sheet).getByLabelText('A month'), { target: { value: '25,000' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save budget' }));
    await waitFor(() => expect(budgetSet).toHaveBeenCalledWith({ category: 'Rent', amount: 2_500_000 }, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(within(cats).getByText('Food'));
    sheet = await screen.findByRole('dialog', { name: 'Monthly budget for Food' });
    expect((within(sheet).getByLabelText('A month') as HTMLInputElement).value).toBe('8400');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(budgetSet).toHaveBeenLastCalledWith({ category: 'Food', amount: null }, expect.any(String)));
  });

  it('Save with the amount untouched keeps the stored budget, not the field rounding it', async () => {
    // 15,050 hundredths set before the currency was yen: the field shows "151".
    const yen = month({ currency: 'JPY', byCategory: [{ category: 'Food', spent: 0, budget: 15_050 }] });
    const budgetSet = vi.fn(async () => ({ ok: true as const }));
    render({ status: status({ currency: 'JPY' }), load: async () => yen, api: { budgetSet } });
    const cats = await screen.findByRole('region', { name: 'By category' });
    fireEvent.click(within(cats).getByText('Food'));
    const sheet = await screen.findByRole('dialog', { name: 'Monthly budget for Food' });
    expect((within(sheet).getByLabelText('A month') as HTMLInputElement).value).toBe('151');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save budget' }));
    await waitFor(() => expect(budgetSet).toHaveBeenCalledWith({ category: 'Food', amount: 15_050 }, expect.any(String)));
  });

  it('sets a budget for a category not spent on yet', async () => {
    const budgetSet = vi.fn(async () => ({ ok: true as const }));
    render({ api: { budgetSet } });
    fireEvent.click(await screen.findByRole('button', { name: 'Set a budget' }));
    const sheet = await screen.findByRole('dialog', { name: 'Monthly budget' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Fun' }));
    fireEvent.change(within(sheet).getByLabelText('A month'), { target: { value: '3000' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save budget' }));
    await waitFor(() => expect(budgetSet).toHaveBeenCalledWith({ category: 'Fun', amount: 300_000 }, expect.any(String)));
  });
});

describe('Finance: bills', () => {
  it('shows due today (or past) in ember, and a later one in ink', async () => {
    render();
    const bills = await screen.findByRole('region', { name: 'Bills' });
    const due = bills.querySelector(`[data-bill="${id(10)}"]`) as HTMLElement;
    expect(within(due).getByText('Today').className).toContain('text-signal-text');
    expect(within(due).getByText(inr(64_900))).toBeTruthy();
    const later = bills.querySelector(`[data-bill="${id(11)}"]`) as HTMLElement;
    expect(later.querySelector('.text-signal-text')).toBeNull();
    expect(within(later).getByText('yearly')).toBeTruthy();
  });

  it('Paid asks for the amount (prefilled) and the day, then logs it', async () => {
    const billPaid = vi.fn(async () => ({ id: id(60) }));
    render({ api: { billPaid } });
    fireEvent.click(await screen.findByRole('button', { name: 'Paid Example Stream 10' }));
    const sheet = await screen.findByRole('dialog', { name: 'Paid Example Stream 10' });
    const amount = within(sheet).getByLabelText('Amount') as HTMLInputElement;
    expect(amount.value).toBe('649');
    expect(amount.inputMode).toBe('decimal');
    expect((within(sheet).getByLabelText('Paid on') as HTMLInputElement).value).toBe(DAY);
    fireEvent.change(amount, { target: { value: '699.50' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Paid' }));
    await waitFor(() => expect(billPaid).toHaveBeenCalledWith(id(10), { day: DAY, amount: 69_950 }, expect.any(String)));
  });

  it('Paid with the amount untouched leaves it to the bill', async () => {
    const billPaid = vi.fn(async () => ({ id: id(60) }));
    render({ api: { billPaid } });
    fireEvent.click(await screen.findByRole('button', { name: 'Paid Example Stream 10' }));
    const sheet = await screen.findByRole('dialog', { name: 'Paid Example Stream 10' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Paid' }));
    await waitFor(() => expect(billPaid).toHaveBeenCalledWith(id(10), { day: DAY }, expect.any(String)));
  });

  it('?bill= opens that bill Paid sheet', async () => {
    render({ path: `/money?bill=${id(11)}` });
    expect(await screen.findByRole('dialog', { name: 'Paid Example Domain' })).toBeTruthy();
  });

  it('adds a bill, and edits one', async () => {
    const billCreate = vi.fn(async () => ({ id: id(61) }));
    const billUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ api: { billCreate, billUpdate } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add bill' }));
    let sheet = await screen.findByRole('dialog', { name: 'New bill' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Example Cloud' } });
    fireEvent.change(within(sheet).getByLabelText('Amount'), { target: { value: '199' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Every year' }));
    fireEvent.change(within(sheet).getByLabelText('Next due'), { target: { value: '2026-03-31' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add bill' }));
    await waitFor(() => expect(billCreate).toHaveBeenCalledWith({ name: 'Example Cloud', amount: 19_900, category: 'Bills', repeat: 'yearly', nextDue: '2026-03-31' }, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByText('Example Domain'));
    sheet = await screen.findByRole('dialog', { name: 'Example Domain' });
    fireEvent.change(within(sheet).getByLabelText('Next due'), { target: { value: '2026-02-28' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(billUpdate).toHaveBeenCalledWith(id(11), { nextDue: '2026-02-28' }, expect.any(String)));
  });
});

describe('Finance: entries', () => {
  it('lists entries with day, category, note and amount; income with a plus', async () => {
    render();
    const list = await screen.findByRole('list', { name: 'Entries' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(within(first!).getByText('15 Jan').className).toContain('type-mono');
    expect(within(first!).getByText('Groceries')).toBeTruthy();
    expect(within(first!).getByText('milk, eggs')).toBeTruthy();
    expect(first!.textContent).toContain(inr(124_000));
    expect(second!.textContent).toContain(`+${inr(12_000_000)}`);
  });

  it('adds an expense typed with grouping, under a chosen category, on today', async () => {
    const moneyAdd = vi.fn(async () => ({ id: id(70) }));
    render({ api: { moneyAdd } });
    await screen.findByText(/^Spent /);
    fireEvent.click(screen.getByRole('button', { name: 'Expense' }));
    const sheet = await screen.findByRole('dialog', { name: 'New expense' });
    expect(within(sheet).getByText('₹')).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText('Amount'), { target: { value: '1,240.50' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Groceries' }));
    fireEvent.change(within(sheet).getByLabelText('Note'), { target: { value: 'weekly shop' } });
    expect((within(sheet).getByLabelText('Date') as HTMLInputElement).value).toBe(DAY);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add expense' }));
    await waitFor(() => expect(moneyAdd).toHaveBeenCalledWith({ kind: 'expense', amount: 124_050, category: 'Groceries', day: DAY, note: 'weekly shop' }, expect.any(String)));
  });

  it('adds income under a new category typed with Other…', async () => {
    const moneyAdd = vi.fn(async () => ({ id: id(71) }));
    render({ api: { moneyAdd } });
    await screen.findByText(/^Spent /);
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    const sheet = await screen.findByRole('dialog', { name: 'New income' });
    expect(within(sheet).getByRole('button', { name: 'Salary' })).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Groceries' })).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Amount'), { target: { value: '5000' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Other…' }));
    fireEvent.change(within(sheet).getByLabelText('New category'), { target: { value: 'Freelance' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add income' }));
    await waitFor(() => expect(moneyAdd).toHaveBeenCalledWith({ kind: 'income', amount: 500_000, category: 'Freelance', day: DAY }, expect.any(String)));
  });

  it('a past month starts a new entry on its first day', async () => {
    render({ path: '/money?month=2025-12' });
    await screen.findByText('December 2025');
    fireEvent.click(screen.getByRole('button', { name: 'Expense' }));
    const sheet = await screen.findByRole('dialog', { name: 'New expense' });
    expect((within(sheet).getByLabelText('Date') as HTMLInputElement).value).toBe('2025-12-01');
  });

  it('edits an entry, sending only the change, and Delete asks nothing: held back under a 5 s Undo', async () => {
    const moneyUpdate = vi.fn(async () => ({ ok: true as const }));
    const moneyDelete = vi.fn(async () => ({ ok: true as const }));
    const { api } = render({ api: { moneyUpdate, moneyDelete } });
    fireEvent.click(await screen.findByText('milk, eggs'));
    let sheet = await screen.findByRole('dialog', { name: 'Edit expense' });
    expect((within(sheet).getByLabelText('Amount') as HTMLInputElement).value).toBe('1240');
    fireEvent.change(within(sheet).getByLabelText('Amount'), { target: { value: '1300' } });
    fireEvent.change(within(sheet).getByLabelText('Note'), { target: { value: '' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(moneyUpdate).toHaveBeenCalledWith(id(1), { amount: 130_000, note: null }, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const remove = async () => {
      fireEvent.click(screen.getByText('milk, eggs'));
      sheet = await screen.findByRole('dialog', { name: 'Edit expense' });
      fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };
    await remove();
    const entries = screen.getByRole('region', { name: 'Entries' });
    expect(within(entries).queryByText('milk, eggs')).toBeNull();
    // The Undo is the bar pinned at the bottom of the page, not a line inside Entries.
    const bar = screen.getAllByRole('status').find((x) => x.textContent?.includes('Undo')) as HTMLElement;
    expect(bar.textContent).toContain(`Deleted: Groceries ${inr(124_000)}`);
    expect(bar.className).toContain('sticky bottom-0');
    fireEvent.click(within(bar).getByRole('button', { name: 'Undo' }));
    expect(within(entries).getAllByRole('listitem').map((li) => li.querySelector('.type-row')?.textContent)).toEqual(['Groceries', 'Salary']);
    expect(moneyDelete).not.toHaveBeenCalled();
    await remove();
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(moneyDelete).toHaveBeenCalledWith(id(1), expect.any(String));
    await waitFor(() => expect(api.moneyMonth).toHaveBeenCalledTimes(3));
  });

  it('never sends an amount it was not given, where the field rounds the stored one', async () => {
    // 150 hundredths logged before the currency was set to yen: the field shows "2".
    const yen = month({ currency: 'JPY', entries: [money(1, { amount: 150, note: 'milk, eggs' })] });
    const moneyUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ status: status({ currency: 'JPY' }), load: async () => yen, api: { moneyUpdate } });
    fireEvent.click(await screen.findByText('milk, eggs'));
    const sheet = await screen.findByRole('dialog', { name: 'Edit expense' });
    expect((within(sheet).getByLabelText('Amount') as HTMLInputElement).value).toBe('2');
    fireEvent.change(within(sheet).getByLabelText('Note'), { target: { value: 'milk' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(moneyUpdate).toHaveBeenCalledWith(id(1), { note: 'milk' }, expect.any(String)));
  });

  it('saves a note on a stored amount the field shows as "0", and Paid leaves such an amount to the bill', async () => {
    // Under half a yen: the field cannot show it, but it was not typed, so it neither blocks a save nor is sent.
    const yen = month({ currency: 'JPY', entries: [money(1, { amount: 40, note: 'milk, eggs' })], bills: [bill(10, { amount: 40 })] });
    const moneyUpdate = vi.fn(async () => ({ ok: true as const }));
    const billPaid = vi.fn(async () => ({ id: id(60) }));
    render({ status: status({ currency: 'JPY' }), load: async () => yen, api: { moneyUpdate, billPaid } });
    fireEvent.click(await screen.findByText('milk, eggs'));
    let sheet = await screen.findByRole('dialog', { name: 'Edit expense' });
    expect((within(sheet).getByLabelText('Amount') as HTMLInputElement).value).toBe('0');
    expect(within(sheet).queryByText(AMOUNT_HINT)).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Note'), { target: { value: 'milk' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(moneyUpdate).toHaveBeenCalledWith(id(1), { note: 'milk' }, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Paid Example Stream 10' }));
    sheet = await screen.findByRole('dialog', { name: 'Paid Example Stream 10' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Paid' }));
    await waitFor(() => expect(billPaid).toHaveBeenCalledWith(id(10), { day: DAY }, expect.any(String)));
  });

  it('refuses an amount that is not one, and a failed save keeps the sheet', async () => {
    const moneyAdd = vi.fn(async (): Promise<never> => {
      throw new ApiError('conflict', 'This month has 2,000 entries. That is the most it keeps.', 409);
    });
    render({ api: { moneyAdd } });
    await screen.findByText(/^Spent /);
    fireEvent.click(screen.getByRole('button', { name: 'Expense' }));
    const sheet = await screen.findByRole('dialog', { name: 'New expense' });
    fireEvent.change(within(sheet).getByLabelText('Amount'), { target: { value: '12abc' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Food' }));
    expect(within(sheet).getByText(AMOUNT_HINT)).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: 'Add expense' }) as HTMLButtonElement).disabled).toBe(true);
    // A comma is never a decimal mark: "12,50" is refused, not read as 1250 or 12.50.
    fireEvent.change(within(sheet).getByLabelText('Amount'), { target: { value: '12,50' } });
    expect(within(sheet).getByText(AMOUNT_HINT)).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: 'Add expense' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('Amount'), { target: { value: '12' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add expense' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Not saved. This month has 2,000 entries. That is the most it keeps.');
    expect((within(sheet).getByLabelText('Amount') as HTMLInputElement).value).toBe('12');
  });

  it('offers expense chips without income-only ones, and income its own', () => {
    expect(categoriesFor('expense', ['Food', 'Salary', 'Pets'])).toEqual(['Food', 'Pets']);
    expect(categoriesFor('income', ['Food', 'Salary'], ['Freelance', 'Salary'])).toEqual(['Salary', 'Other', 'Freelance']);
  });
});
