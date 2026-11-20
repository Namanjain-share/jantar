/**
 * 0.15 Messages' Settings (`/messages?view=settings`): the data note on
 * first open, the morning and call-back times, the skip list (search a chat,
 * Skip it after a confirm, and the Mac's note when its todos leave Life
 * later; no remove on the phone, only the Mac's command),
 * the last run's report with what was left out per chat, and the read log
 * (when, who read, from which folder, which chat, how many). Every name,
 * folder and number is made up.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { preloadPlaces, renderApp } from '../helpers.js';
import { IDS, ON, messagesApi, readEntry, requested, run, skipEntry, today } from './helpers.js';

preloadPlaces('messages');

const PATH = '/messages?view=settings';
const open = (api = messagesApi()) => renderApp({ path: PATH, api, state: ON });
const section = (name: string) => screen.findByRole('region', { name });

describe('Messages: Settings', () => {
  it('skip list has no remove button on the phone', async () => {
    open(messagesApi({ 'GET /v1/messages/skip': { skip: [skipEntry(IDS.ravi, 'Ravi Test'), skipEntry(IDS.group, 'Group One', { kind: 'group' })] } }));
    const skip = await section('Skip list');
    const list = await within(skip).findByRole('list', { name: 'Skipped chats' });
    expect(within(list).getByText('Ravi Test')).toBeTruthy();
    expect(within(list).getByText('Group One')).toBeTruthy();
    // No control on a skipped row, and nothing anywhere that removes one.
    expect(within(list).queryAllByRole('button')).toEqual([]);
    expect(within(list).queryAllByRole('link')).toEqual([]);
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    // The Mac's command instead, in mono.
    const code = within(skip).getByText('jantar messages skip remove <chat>');
    expect(code.tagName).toBe('CODE');
    expect(code.parentElement?.textContent).toContain('Remove at the Mac:');
  });

  it('finds a chat 300 ms after typing stops and skips it after a confirm', async () => {
    let skipped = false;
    const api = messagesApi({
      'GET /v1/messages/chats': (init: { query?: Record<string, unknown> }) =>
        init.query?.q === 'Asha' ? { chats: [{ chatKey: IDS.asha, name: 'Asha Test', kind: 'dm', lastAt: '2026-01-15T07:00:00.000Z', unread: 0, lastFromMe: false, archived: false }], total: 1 } : { chats: [], total: 0 },
      'POST /v1/messages/skip': () => {
        skipped = true;
        return { ok: true };
      },
      'GET /v1/messages/skip': () => ({ skip: [skipEntry(IDS.ravi, 'Ravi Test'), ...(skipped ? [skipEntry(IDS.asha, 'Asha Test')] : [])] }),
    });
    open(api);
    const skip = await section('Skip list');
    const box = within(skip).getByRole('searchbox', { name: 'Find a chat to skip' });
    // Blank: nothing is asked for.
    fireEvent.change(box, { target: { value: '   ' } });
    await act(async () => new Promise((r) => setTimeout(r, 350)));
    expect(requested(api, 'GET', '/v1/messages/chats').filter((c) => c.query?.q !== undefined)).toEqual([]);
    fireEvent.change(box, { target: { value: 'Asha' } });
    const found = await within(skip).findByRole('list', { name: 'Chats found' });
    expect(requested(api, 'GET', '/v1/messages/chats').at(-1)?.query).toMatchObject({ q: 'Asha', limit: 20 });
    fireEvent.click(within(found).getByRole('button', { name: 'Skip Asha Test' }));
    // Asks first: only the Mac can read it again.
    expect(requested(api, 'POST', '/v1/messages/skip')).toHaveLength(0);
    expect(within(skip).getByText(/Only the Mac can read it again/)).toBeTruthy();
    // What the morning made from it goes with it.
    expect(within(skip).getByText(/Its reply drafts, and the open todos and call-backs the morning made from it, go too\./)).toBeTruthy();
    fireEvent.click(within(skip).getByRole('button', { name: 'Yes, skip' }));
    await waitFor(() => expect(requested(api, 'POST', '/v1/messages/skip')).toEqual([expect.objectContaining({ body: { chatKey: IDS.asha } })]));
    const list = await within(skip).findByRole('list', { name: 'Skipped chats' });
    await waitFor(() => expect(within(list).getByText('Asha Test')).toBeTruthy());
    // Life's todos answered: nothing more is said.
    expect(within(skip).queryByRole('status')).toBeNull();
  });

  it("a skip while Life isn't open says, as the Mac says it, that the chat's todos leave Life later", async () => {
    const note =
      "Life isn't open right now (every Life module and People have been off since Jantar started, or Life needs attention), so any open todos and call-backs the morning made from this chat leave Life once it opens.";
    const api = messagesApi({
      'GET /v1/messages/chats': () => ({ chats: [{ chatKey: IDS.asha, name: 'Asha Test', kind: 'dm', lastAt: '2026-01-15T07:00:00.000Z', unread: 0, lastFromMe: false, archived: false }], total: 1 }),
      'POST /v1/messages/skip': () => ({ ok: true, note }),
    });
    open(api);
    const skip = await section('Skip list');
    fireEvent.change(within(skip).getByRole('searchbox', { name: 'Find a chat to skip' }), { target: { value: 'Asha' } });
    const found = await within(skip).findByRole('list', { name: 'Chats found' });
    fireEvent.click(within(found).getByRole('button', { name: 'Skip Asha Test' }));
    fireEvent.click(within(skip).getByRole('button', { name: 'Yes, skip' }));
    const said = await within(skip).findByRole('status');
    expect(said.textContent).toBe(note);
  });

  it('sets the morning and call-back times, and turns each off', async () => {
    const api = messagesApi({ 'PATCH /v1/messages/prefs': { ok: true } });
    open(api);
    const times = await section('Times');
    const morning = (await within(times).findByLabelText('Morning run')) as HTMLInputElement;
    await waitFor(() => expect(morning.value).toBe('08:00'));
    expect(within(times).queryByRole('button', { name: 'Save the morning time' })).toBeNull();
    fireEvent.change(morning, { target: { value: '07:30' } });
    fireEvent.click(within(times).getByRole('button', { name: 'Save the morning time' }));
    await waitFor(() => expect(requested(api, 'PATCH', '/v1/messages/prefs')).toEqual([expect.objectContaining({ body: { morningAt: '07:30' } })]));
    fireEvent.click(within(times).getByRole('button', { name: 'Turn the morning run off' }));
    await waitFor(() => expect(requested(api, 'PATCH', '/v1/messages/prefs')[1]).toMatchObject({ body: { morningAt: null } }));
    fireEvent.click(within(times).getByRole('button', { name: 'Turn call-back reminders off' }));
    await waitFor(() => expect(requested(api, 'PATCH', '/v1/messages/prefs')[2]).toMatchObject({ body: { callbackAt: null } }));
  });

  it('a time that is off says what that means', async () => {
    open(messagesApi({ 'GET /v1/messages/prefs': { morningAt: null, callbackAt: null } }));
    const times = await section('Times');
    expect(await within(times).findByText(/Off: the morning run waits for Run now/)).toBeTruthy();
    expect(within(times).getByText(/Off: call-backs get a day, no ring/)).toBeTruthy();
  });

  it('shows the data note on the first open, until it is put away', async () => {
    const a = open();
    const note = await screen.findByText("The morning run sends other people's messages to Claude under your account.");
    expect(note).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText("The morning run sends other people's messages to Claude under your account.")).toBeNull();
    a.unmount();
    open();
    await section('Times');
    expect(screen.queryByRole('button', { name: 'Got it' })).toBeNull();
  });

  it("the last run's report: when, freshness, counts, the calls not read and what was left out per chat", async () => {
    open(
      messagesApi({
        'GET /v1/messages/today': today({
          run: run({ counts: { chats: 3, messages: 12, calls: 2, todos: 1, replies: 2, callbacks: 1, dropped: 4994 }, dropped: [{ chatName: 'Group One', kept: 6, left: 4994 }], phoneCalls: false }),
        }),
      }),
    );
    const report = await section('Last run');
    expect(await within(report).findByText('Thu 08:00 · at the morning time')).toBeTruthy();
    expect(within(report).getByText('WhatsApp data up to Thu 07:58')).toBeTruthy();
    expect(within(report).getByText('Read 3 chats, 12 messages and 2 missed calls. Made 1 todo, 2 reply drafts and 1 call-back.')).toBeTruthy();
    expect(within(report).getByText("The iPhone call log wasn't read.")).toBeTruthy();
    const left = within(report).getByRole('list', { name: 'Left out for size' });
    expect(within(left).getByText('Group One')).toBeTruthy();
    expect(within(left).getByText('6 kept · 4,994 left out')).toBeTruthy();
  });

  it('what was left out lists missed calls by person, and says how many more the list leaves out', async () => {
    const dropped = [
      { chatKey: IDS.ravi, chatName: 'Ravi Test', kept: 1, left: 2, call: true as const },
      { chatKey: IDS.asha, chatName: 'Asha Test', kept: 0, left: 4 },
    ];
    open(messagesApi({ 'GET /v1/messages/today': today({ run: run({ counts: { chats: 0, messages: 0, calls: 1, todos: 0, replies: 0, callbacks: 0, dropped: 4 }, dropped, droppedMore: 7 }) }) }));
    const report = await section('Last run');
    const left = await within(report).findByRole('list', { name: 'Left out for size' });
    expect(within(left).getByText('1 kept · 2 missed calls left out')).toBeTruthy();
    expect(within(left).getByText('0 kept · 4 left out')).toBeTruthy();
    expect(within(left).getByText('and 7 more')).toBeTruthy();
  });

  it('the read log names the chat, who read it, from which folder, and how many', async () => {
    const api = messagesApi({
      'GET /v1/messages/reads': {
        reads: [
          readEntry(),
          readEntry({ at: '2026-01-15T08:00:00.000Z', via: 'morning', pid: undefined, folder: undefined, op: 'morning', chatKey: IDS.group, count: 12 }),
          readEntry({ at: '2026-01-14T19:00:00.000Z', via: 'phone', pid: undefined, folder: undefined, op: 'search', chatKey: undefined, count: 2 }),
          readEntry({ at: '2026-01-14T18:00:00.000Z', via: 'cli', pid: undefined, folder: undefined, op: 'read', chatKey: IDS.ravi, count: 50 }),
          // A dry run from the Terminal: the morning's read, under who asked.
          readEntry({ at: '2026-01-14T17:00:00.000Z', via: 'cli', pid: undefined, folder: undefined, op: 'morning', chatKey: IDS.asha, count: 5 }),
        ],
      },
      'GET /v1/messages/chats': { chats: [{ chatKey: IDS.group, name: 'Group One', kind: 'group', lastAt: '2026-01-15T07:00:00.000Z', unread: 0, lastFromMe: false, archived: false, members: 4 }, { chatKey: IDS.asha, name: 'Asha Test', kind: 'dm', lastAt: '2026-01-15T07:00:00.000Z', unread: 0, lastFromMe: false, archived: false }], total: 2 },
    });
    open(api);
    const log = await within(await section('Read log')).findByRole('list', { name: 'Read log' });
    const rows = await waitFor(() => {
      const r = within(log).getAllByRole('listitem');
      expect(r.map((li) => li.querySelector('[data-chat]')?.textContent)).toEqual(['Asha Test', 'Group One', 'Search', 'Ravi Test', 'Asha Test']);
      return r;
    });
    expect(rows[0]!.textContent).toContain('3 messages');
    expect(rows[0]!.textContent).toContain('Thu 15 Jan 07:30 · Claude session · example-app');
    expect(rows[1]!.textContent).toContain('Thu 15 Jan 08:00 · Morning run');
    expect(rows[2]!.textContent).toContain('2 found');
    expect(rows[2]!.textContent).toContain('Phone');
    // Ravi is skipped now: his name comes from the skip list.
    expect(rows[3]!.textContent).toContain('Terminal');
    expect(rows[4]!.textContent).toContain('Wed 14 Jan 17:00 · Morning run (Terminal)');
    // The names were asked for once.
    expect(requested(api, 'GET', '/v1/messages/chats')).toEqual([expect.objectContaining({ query: { limit: 200 } })]);
  });

  it('goes back to Today from its back link', async () => {
    const { history } = open();
    await screen.findByRole('heading', { level: 1, name: 'Messages settings' });
    fireEvent.click(within(screen.getByRole('main')).getByRole('link', { name: 'Messages' }));
    expect(history.location.pathname + history.location.search).toBe('/messages');
    expect(await screen.findByRole('heading', { level: 1, name: 'Messages' })).toBeTruthy();
  });
});
