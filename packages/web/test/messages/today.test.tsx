/**
 * 0.15 Messages' Today screen (`/messages`, ui/screens/messages/Messages.tsx)
 * against the fake API: the freshness line (and the stale warning), the
 * summary, the todos the morning made (each opens its Life todo), Waiting on
 * you (Copy, Open in WhatsApp only for a 1:1 with a number, Done and Dismiss
 * with Undo), Call back, Run now and Undo this morning, the reader's
 * problems, and the switch off. Every name and number is made up.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api.js';
import { preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { ASHA_PHONE, IDS, ON, draft, messagesApi, requested, run, status, today } from './helpers.js';

preloadPlaces('messages');

let clipboard: { writeText: ReturnType<typeof vi.fn> };
beforeEach(() => {
  clipboard = { writeText: vi.fn(async () => undefined) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

const open = (api = messagesApi(), state = ON) => renderApp({ path: '/messages', api, state });
const section = (name: string) => screen.findByRole('region', { name });
const row = async (name: string) => (await within(await section('Waiting on you')).findByText(name)).closest('li') as HTMLElement;

describe('Messages: Today', () => {
  it('Open in WhatsApp shows only with a phone and encodes the draft', async () => {
    open();
    const asha = await row('Asha Test');
    const link = within(asha).getByRole('link', { name: 'Open in WhatsApp: Asha Test' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`https://wa.me/${ASHA_PHONE}?text=Sure%2C%20sending%20it%20by%20Friday%205pm%20%26%20before%20the%20call%3F`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // A group (no number): Copy only.
    const group = await row('Group One');
    expect(within(group).queryByRole('link')).toBeNull();
    expect(within(group).getByRole('button', { name: 'Copy the reply to Group One' })).toBeTruthy();
    // They asked, then the draft, as text.
    expect(within(asha).getByText('Can you send the deck by Friday 5pm?')).toBeTruthy();
    expect(within(asha).getByText('Sure, sending it by Friday 5pm & before the call?')).toBeTruthy();
  });

  it('a number that is not digits only never makes a link', async () => {
    open(messagesApi({ 'GET /v1/messages/today': today({ drafts: [draft(IDS.draftAsha, { phone: '91999 javascript:alert(1)' })] }) }));
    const asha = await row('Asha Test');
    expect(within(asha).queryByRole('link')).toBeNull();
  });

  it('Copy puts the draft on the clipboard', async () => {
    open();
    fireEvent.click(within(await row('Group One')).getByRole('button', { name: 'Copy the reply to Group One' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('Checking it now.'));
  });

  it('stale run shows the warning', async () => {
    const a = open(messagesApi({ 'GET /v1/messages/today': today({ run: run({ stale: true }) }) }));
    const warning = await screen.findByText(/WhatsApp wasn't open and synced in time/);
    expect(warning.textContent).toContain('Thu 07:58');
    a.unmount();
    // Fresh: the line says how far the data goes, and no warning.
    open();
    expect(await screen.findByText('WhatsApp data up to Thu 07:58')).toBeTruthy();
    expect(screen.queryByText(/wasn't open and synced/)).toBeNull();
  });

  it('off shows NotFound with messages on', async () => {
    renderApp({ path: '/messages', api: messagesApi(), state: stateWith({ features: { life: true } }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'That is off on this Mac.' })).toBeTruthy();
    const code = screen.getByText('jantar messages on');
    expect(code.tagName).toBe('CODE');
  });

  it("shows the summary, the run's counts, the todos it made and the call-backs, each opening its Life todo", async () => {
    const { history } = open();
    expect(await screen.findByText('Asha Test asked for the deck by Friday. Group One wants the invoice checked.')).toBeTruthy();
    expect(screen.getByText('Last run Thu 08:00 · 3 chats · 12 messages · 2 calls')).toBeTruthy();
    const todos = await section('Todos made');
    const todo = await within(todos).findByRole('link', { name: /Send the deck to Asha Test/ });
    expect(todo.getAttribute('href')).toBe(`/todos?id=${IDS.todo}`);
    const calls = await section('Call back');
    const ravi = within(calls).getByRole('link', { name: /Call back Ravi Test/ });
    expect(ravi.textContent).toContain('Rings Thu 11:00');
    fireEvent.click(ravi);
    expect(history.location.pathname + history.location.search).toBe(`/todos?id=${IDS.callback}`);
  });

  it('Done and Dismiss mark a draft, take it off the list, and Undo opens it again', async () => {
    const api = messagesApi({ [`PATCH /v1/messages/drafts/:id`]: { ok: true } });
    open(api);
    fireEvent.click(within(await row('Asha Test')).getByRole('button', { name: 'Done: Asha Test' }));
    await waitFor(() => expect(requested(api, 'PATCH', '/v1/messages/drafts/:id')).toHaveLength(1));
    expect(requested(api, 'PATCH', '/v1/messages/drafts/:id')[0]).toMatchObject({ params: { id: IDS.draftAsha }, body: { state: 'done' } });
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Waiting on you' })).queryByText('Asha Test')).toBeNull());
    expect(screen.getByText('Done: Asha Test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(requested(api, 'PATCH', '/v1/messages/drafts/:id')).toHaveLength(2));
    expect(requested(api, 'PATCH', '/v1/messages/drafts/:id')[1]).toMatchObject({ params: { id: IDS.draftAsha }, body: { state: 'open' } });
    expect(await row('Asha Test')).toBeTruthy();
    // Dismiss is the same, with its own word.
    fireEvent.click(within(await row('Group One')).getByRole('button', { name: 'Dismiss: Group One' }));
    await waitFor(() => expect(requested(api, 'PATCH', '/v1/messages/drafts/:id')).toHaveLength(3));
    expect(requested(api, 'PATCH', '/v1/messages/drafts/:id')[2]).toMatchObject({ params: { id: IDS.draftGroup }, body: { state: 'dismissed' } });
  });

  it('a draft that could not be marked stays, with Not saved', async () => {
    open(messagesApi({ 'PATCH /v1/messages/drafts/:id': new ApiError('not_found', 'No such reply draft.', 404) }));
    fireEvent.click(within(await row('Asha Test')).getByRole('button', { name: 'Done: Asha Test' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No such reply draft.');
    expect(await row('Asha Test')).toBeTruthy();
  });

  it('Run now runs the morning pass and shows its report', async () => {
    let n = 0;
    const api = messagesApi({
      'POST /v1/messages/morning/run': () => run({ id: '01JMSGRVN00000000000000002', trigger: 'now' }),
      'GET /v1/messages/today': () => (n++ === 0 ? today({ run: null, drafts: [], callbacks: [] }) : today({ run: run({ id: '01JMSGRVN00000000000000002', trigger: 'now', at: '2026-01-15T10:04:00.000Z' }) })),
    });
    open(api);
    expect(await screen.findByText(/No morning run yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(requested(api, 'POST', '/v1/messages/morning/run')).toEqual([expect.objectContaining({ body: {} })]));
    expect(await screen.findByText('Last run Thu 10:04 · 3 chats · 12 messages · 2 calls')).toBeTruthy();
  });

  it("Run now's refusal says the daemon's sentence", async () => {
    open(messagesApi({ 'POST /v1/messages/morning/run': new ApiError('conflict', 'A morning run is going. Wait for it to finish.', 409) }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    expect((await screen.findByRole('alert')).textContent).toContain('A morning run is going. Wait for it to finish.');
  });

  it('Undo this morning asks first, then undoes the run', async () => {
    const api = messagesApi({ 'POST /v1/messages/morning/:runId/undo': { ok: true } });
    open(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo this morning' }));
    expect(requested(api, 'POST', '/v1/messages/morning/:runId/undo')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByRole('button', { name: 'Undo it' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo this morning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo it' }));
    await waitFor(() => expect(requested(api, 'POST', '/v1/messages/morning/:runId/undo')).toEqual([expect.objectContaining({ params: { runId: IDS.run } })]));
    expect(await screen.findByText(/This morning was undone/)).toBeTruthy();
  });

  it("a later Run now that made nothing keeps the morning's summary, the todos it made and its Undo", async () => {
    const noon = run({ id: '01JMSGRVN00000000000000002', trigger: 'now', at: '2026-01-15T13:00:00.000Z', counts: { chats: 0, messages: 0, calls: 0, todos: 0, replies: 0, callbacks: 0, dropped: 0 }, todoIds: [], summary: undefined });
    const api = messagesApi({ 'GET /v1/messages/today': today({ run: noon, made: run() }), 'POST /v1/messages/morning/:runId/undo': { ok: true } });
    open(api);
    // The newest run's line; the morning's summary and todos.
    expect(await screen.findByText(/^Last run Thu 13:00/)).toBeTruthy();
    expect(await screen.findByText('Asha Test asked for the deck by Friday. Group One wants the invoice checked.')).toBeTruthy();
    expect(await within(await section('Todos made')).findByRole('link', { name: /Send the deck to Asha Test/ })).toBeTruthy();
    // Undo this morning undoes the morning's run, not the empty one.
    fireEvent.click(screen.getByRole('button', { name: 'Undo this morning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo it' }));
    await waitFor(() => expect(requested(api, 'POST', '/v1/messages/morning/:runId/undo')).toEqual([expect.objectContaining({ params: { runId: IDS.run } })]));
    expect(await screen.findByText(/This morning was undone/)).toBeTruthy();
  });

  it("a failed run says why, and a run still going says so", async () => {
    const a = open(messagesApi({ 'GET /v1/messages/today': today({ run: run({ state: 'failed', why: "Claude's answer couldn't be used, so nothing was made. Try again." }) }) }));
    expect(await screen.findByText("Claude's answer couldn't be used, so nothing was made. Try again.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo this morning' })).toBeNull();
    a.unmount();
    open(messagesApi({ 'GET /v1/messages/today': today({ run: run({ state: 'running' }), drafts: [], callbacks: [] }) }));
    expect(await screen.findByText('The morning run is going now.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the reader's problem shows its sentence, the command in mono", async () => {
    open(
      messagesApi({
        'GET /v1/messages/status': status({ reader: { state: 'down', detail: "Messages can't read WhatsApp right now: the reader isn't running. At the Mac: jantar messages status" } }),
      }),
    );
    expect(await screen.findByText('jantar messages status')).toBeTruthy();
    expect(screen.getByText('jantar messages status').tagName).toBe('CODE');
  });

  it("a 503 from the Mac says the daemon's sentence, with no Try again", async () => {
    const sentence = "Messages can't read WhatsApp right now: the reader isn't running. At the Mac: jantar messages status";
    open(messagesApi({ 'GET /v1/messages/today': new ApiError('messages_unavailable', sentence, 503) }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Messages' })).toBeTruthy();
    expect((await screen.findByText('jantar messages status')).tagName).toBe('CODE');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('other people\'s words render as text, never as markup', async () => {
    const evil = '<img src=x onerror=window.__pwned=1>';
    open(messagesApi({ 'GET /v1/messages/today': today({ run: run({ summary: evil }), drafts: [draft(IDS.draftAsha, { chatName: evil, theyAsked: evil, draft: evil })] }) }));
    expect((await screen.findAllByText(evil)).length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector('#main img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('opens Settings from its button', async () => {
    const { history } = open();
    fireEvent.click(await screen.findByRole('link', { name: 'Messages settings' }));
    expect(history.location.pathname + history.location.search).toBe('/messages?view=settings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Messages settings' })).toBeTruthy();
    await act(async () => undefined);
  });
});
