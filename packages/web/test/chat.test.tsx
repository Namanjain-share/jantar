/**
 * Chat (v0.10, spec 0.10 B14) against the fake API: the empty thread (the
 * privacy line and three examples that fill the box), a reply that stays
 * text, the change rows from the journal with Undo (and the Mac's 409
 * sentence), cards (Confirm, Do it, Dismiss), running with Stop, failed
 * with Try again, Clear asks first, the Siri tag, paging with Earlier, a
 * photo chip uploaded with progress and removed, no data: URL, `/ask`
 * landing on `/chat`, and the nav entry "Chat" (none on a device paired
 * without control). Every name and value here is made up.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCard, ChatChange, ChatList, ChatTurn } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { createRouter, parseRoute, routePath } from '../src/lib/router.js';
import { EXAMPLES, PRIVACY, PRIVACY_SHORT } from '../src/ui/screens/chat/model.js';
import { NAV } from '../src/ui/shell/nav.js';
import { NOW, fakeApi, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('chat');

afterEach(() => vi.unstubAllGlobals());

const ON = stateWith({ features: { ask: true, life: true } });
const tid = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N7${String(n).padStart(2, '0')}`;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function turn(n: number, over: Partial<ChatTurn> = {}): ChatTurn {
  return { id: tid(n), at: ago(60_000), via: 'phone', text: `message ${n}`, photos: [], state: 'done', reply: `Reply ${n}.`, changes: [], cards: [], tainted: false, refused: 0, ...over };
}
const change = (over: Partial<ChatChange> = {}): ChatChange => ({ n: 0, module: 'todos', op: 'add', ref: tid(90), label: 'Todo · Buy oat milk', state: 'done', undoable: true, ...over });
const card = (over: Partial<ChatCard> = {}): ChatCard => ({ n: 0, kind: 'confirm', module: 'places', op: 'delete', ref: tid(91), label: 'Delete café Example Café and its 3 visits?', state: 'waiting', ...over });
const list = (turns: ChatTurn[], over: Partial<ChatList> = {}): ChatList => ({ turns, older: null, ready: { ok: true }, keepDays: 30, ...over });

function open(first: ChatList, over: Partial<Api> = {}, opts: { state?: ReturnType<typeof stateWith>; path?: string } = {}) {
  let current = first;
  const api = fakeApi({ chatList: vi.fn(async () => current), chatPhoto: vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' })), ...over });
  const r = renderApp({ path: opts.path ?? '/chat', api, state: opts.state ?? ON });
  return { ...r, api, set: (next: ChatList) => (current = next) };
}

const box = () => screen.getByRole('textbox', { name: 'A message to Chat' }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;

describe('Chat', () => {
  it('empty: the privacy words and three examples that fill the box without sending', async () => {
    const { api } = open(list([]));
    expect(await screen.findByText('Ask Jantar anything, or tell it what to add or change.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Chat' })).toBeTruthy();
    expect(screen.getAllByText(PRIVACY).length).toBeGreaterThan(0);
    expect(screen.getByText(PRIVACY_SHORT)).toBeTruthy();
    const chips = within(screen.getByRole('group', { name: 'Examples' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual([...EXAMPLES]);
    fireEvent.click(chips[2]!);
    expect(box().value).toBe('Rate Example Café 4 stars, great Wi-Fi');
    expect(api.chatSend).not.toHaveBeenCalled();
  });

  it('sends the text with a new Idempotency-Key and clears the box', async () => {
    const chatSend = vi.fn(async () => ({ id: tid(1) }));
    open(list([]), { chatSend });
    await screen.findByText('Ask Jantar anything, or tell it what to add or change.');
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: 'Add oat milk to my list' } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(chatSend).toHaveBeenCalledWith('Add oat milk to my list', [], expect.any(String)));
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('a reply stays text; changes come from the journal with Undo; a 409 says it changed since', async () => {
    const chatUndo = vi.fn(async () => {
      throw new ApiError('conflict', "That changed after Chat's edit; change it back by hand.", 409);
    });
    open(list([turn(1, { reply: 'Added it. [link](https://example.com) **bold**', changes: [change(), change({ n: 1, op: 'edit', label: 'Café · Sample Dosa House · 4★' }), change({ n: 2, state: 'undone', label: 'Food · Dal · 180 kcal' })] })]), { chatUndo });
    const reply = await screen.findByText('Added it. [link](https://example.com) **bold**');
    expect(reply.querySelector('a')).toBeNull();
    const rows = within(screen.getByRole('list', { name: 'What Chat changed' })).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['AddedTodo · Buy oat milkUndo', 'ChangedCafé · Sample Dosa House · 4★Undo', 'UndoneFood · Dal · 180 kcal']);
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(chatUndo).toHaveBeenCalledWith(tid(1), 1, expect.any(String)));
    expect(await screen.findByText("That changed after Chat's edit; change it back by hand.")).toBeTruthy();
  });

  it('no Undo past a day', async () => {
    open(list([turn(1, { at: ago(25 * 3600_000), changes: [change()] })]));
    await screen.findByText('Todo · Buy oat milk');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('cards: Confirm, Do it and Dismiss run their own calls', async () => {
    const chatCard = vi.fn(async () => ({ ok: true as const }));
    const chatCardDismiss = vi.fn(async () => ({ ok: true as const }));
    open(list([turn(1, { cards: [card(), card({ n: 1, kind: 'do', module: 'todos', op: 'todo', ref: null, label: 'Add todo Follow up on the page?' })] })]), { chatCard, chatCardDismiss });
    const cards = within(await screen.findByRole('list', { name: 'Waiting for your tap' })).getAllByRole('listitem');
    expect(within(cards[0]!).getByText('Delete café Example Café and its 3 visits?')).toBeTruthy();
    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(chatCard).toHaveBeenCalledWith(tid(1), 0, expect.any(String)));
    fireEvent.click(within(cards[1]!).getByRole('button', { name: 'Do it' }));
    await waitFor(() => expect(chatCard).toHaveBeenCalledWith(tid(1), 1, expect.any(String)));
    fireEvent.click(within(cards[1]!).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(chatCardDismiss).toHaveBeenCalledWith(tid(1), 1, expect.any(String)));
  });

  it('running shows Working… with Stop; failed shows the reason in ember and Try again resends', async () => {
    const chatCancel = vi.fn(async () => ({ ok: true as const }));
    const chatSend = vi.fn(async () => ({ id: tid(3) }));
    open(list([turn(1, { state: 'failed', reply: undefined, reason: "Claude couldn't answer. Try again.", text: 'how many calories today' }), turn(2, { state: 'running', reply: undefined })]), { chatCancel, chatSend });
    expect((await screen.findAllByText('Working…')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(chatCancel).toHaveBeenCalledWith(tid(2), expect.any(String)));
    const reason = screen.getByText("Claude couldn't answer. Try again.");
    expect(reason.getAttribute('role')).toBe('alert');
    expect(reason.className).toContain('text-signal-text');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('Try again resends the text and the photos still there, then goes', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:synthetic'), revokeObjectURL: vi.fn() }));
    const chatSend = vi.fn(async () => ({ id: tid(3) }));
    const photos = [
      { id: tid(80), w: 10, h: 10, gone: false },
      { id: tid(81), w: 10, h: 10, gone: true },
    ];
    open(list([turn(1, { state: 'failed', reply: undefined, reason: "Claude couldn't answer. Try again.", text: 'what is on this bill', photos })]), { chatSend });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(chatSend).toHaveBeenCalledWith('what is on this bill', [tid(80)], expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    expect(screen.getByText('Sent again.')).toBeTruthy();
  });

  it('a Siri turn has its tag; a removed photo says so; photos show through blob: URLs, never data:', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:synthetic'), revokeObjectURL: vi.fn() }));
    open(list([turn(1, { via: 'voice', text: 'how many calories today' }), turn(2, { photos: [{ id: tid(80), w: 10, h: 10, gone: false }, { id: tid(81), w: 10, h: 10, gone: true }] })]));
    expect(await screen.findByText('Siri')).toBeTruthy();
    expect(screen.getByText('Photo removed')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('img[src="blob:synthetic"]')).not.toBeNull());
    expect(document.querySelector('img[src^="data:"]')).toBeNull();
  });

  it('Earlier pages back with the cursor', async () => {
    const chatList = vi.fn(async (before?: string) => (before ? list([turn(1)], { older: null }) : list([turn(2)], { older: tid(2) })));
    open(list([]), { chatList });
    fireEvent.click(await screen.findByRole('button', { name: 'Earlier' }));
    await waitFor(() => expect(chatList).toHaveBeenCalledWith(tid(2)));
    expect(await screen.findByText('message 1')).toBeTruthy();
  });

  it('Clear asks first, then clears', async () => {
    const chatClear = vi.fn(async () => ({ ok: true as const }));
    open(list([turn(1)]), { chatClear });
    await screen.findByText('Reply 1.');
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear chat…' }));
    expect(await screen.findByText('Clear chat? Its messages, photos and Undo go. What it added stays.')).toBeTruthy();
    expect(chatClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(chatClear).toHaveBeenCalledWith(expect.any(String)));
  });

  it("not ready: the Mac's sentence takes the box's place", async () => {
    open(list([], { ready: { ok: false, reason: "Chat can't run while Jantar is read-only." } }));
    expect(await screen.findByText("Chat can't run while Jantar is read-only.")).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'A message to Chat' })).toBeNull();
  });

  it('a GIF photo uploads with its chip and is sent with the text; × removes one', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:chip'), revokeObjectURL: vi.fn() }));
    const chatPhotoAdd = vi.fn(async () => ({ id: tid(70) }));
    const chatSend = vi.fn(async () => ({ id: tid(4) }));
    const chatPhotoDelete = vi.fn(async () => undefined);
    open(list([]), { chatPhotoAdd, chatSend, chatPhotoDelete });
    await screen.findByText('Ask Jantar anything, or tell it what to add or change.');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const gif = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], 'receipt.gif', { type: 'image/gif' });
    fireEvent.change(input, { target: { files: [gif] } });
    await waitFor(() => expect(chatPhotoAdd).toHaveBeenCalled());
    const chips = await screen.findByRole('list', { name: 'Photos to send' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(1);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(chatSend).toHaveBeenCalledWith('', [tid(70)], expect.any(String)));
    fireEvent.change(input, { target: { files: [gif] } });
    const again = await screen.findByRole('list', { name: 'Photos to send' });
    await waitFor(() => expect(chatPhotoAdd).toHaveBeenCalledTimes(2));
    fireEvent.click(within(again).getByRole('button', { name: 'Remove the photo' }));
    await waitFor(() => expect(chatPhotoDelete).toHaveBeenCalledWith(tid(70)));
  });
});

describe('the address and the nav', () => {
  it('/ask is read as Chat and replaced with /chat; the nav says Chat', () => {
    expect(parseRoute('/ask', '', '')).toEqual({ name: 'chat' });
    expect(routePath({ name: 'chat' })).toBe('/chat');
    const replaced: string[] = [];
    const history = { location: { pathname: '/ask', search: '', hash: '' }, depth: 0, push: vi.fn(), replace: (p: string) => replaced.push(p), back: vi.fn(), listen: () => () => undefined };
    createRouter(history as unknown as Parameters<typeof createRouter>[0]);
    expect(replaced).toEqual(['/chat']);
    const item = NAV.find((n) => n.route === 'chat');
    expect(item).toMatchObject({ href: '/chat', label: 'Chat', feature: 'ask' });
  });
});
