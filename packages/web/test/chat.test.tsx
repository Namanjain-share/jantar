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
import { EXAMPLES, PRIVACY, PRIVACY_SHORT, byDay, confirmVerb, dayOf, matches, photosOf, turnMeta, undoableChanges } from '../src/ui/screens/chat/model.js';
import { layoutAt } from '../src/ui/shell/layout.js';
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

  it("the examples come before the privacy words; What's sent opens the full words in a sheet, not in the composer", async () => {
    open(list([]));
    const group = await screen.findByRole('group', { name: 'Examples' });
    const words = screen.getAllByText(PRIVACY)[0]!;
    expect(group.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText(PRIVACY)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: "What's sent" }));
    const sheet = await screen.findByRole('dialog', { name: "What's sent" });
    expect(within(sheet).getByText(PRIVACY)).toBeTruthy();
    expect(document.querySelector('form[aria-label="Message Chat"]')?.parentElement?.textContent).not.toContain(PRIVACY);
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
    const why = await screen.findByText("That changed after Chat's edit; change it back by hand.");
    // On its own line under the row, the label still there, and no Undo to be refused again.
    expect(why.closest('li')).toBe(rows[1]);
    expect(within(rows[1]!).getByText('Café · Sample Dosa House · 4★').contains(why)).toBe(false);
    expect(why.parentElement).toBe(rows[1]);
    expect(within(rows[1]!).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(within(rows[0]!).getByRole('button', { name: 'Undo' })).toBeTruthy();
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
    // 0.11: the Confirm button says its verb (open question 11).
    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'Delete' }));
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

describe('photo chips', () => {
  const gif = () => new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], 'receipt.gif', { type: 'image/gif' });
  const pick = (files: File[]) => fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files } });

  it("a photo that didn't upload holds Send, says why under the row with a glyph on its chip, and × takes it off", async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:chip'), revokeObjectURL: vi.fn() }));
    let n = 0;
    const chatPhotoAdd = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new ApiError('refused', 'Chat takes photos only (JPEG, PNG, WebP or GIF).', 422);
      return { id: tid(71) };
    });
    const chatSend = vi.fn(async () => ({ id: tid(5) }));
    open(list([]), { chatPhotoAdd, chatSend });
    await screen.findByText('Ask Jantar anything, or tell it what to add or change.');
    pick([gif(), gif()]);
    const chips = await screen.findByRole('list', { name: 'Photos to send' });
    await waitFor(() => expect(within(chips).getAllByRole('listitem')).toHaveLength(2));
    const why = await screen.findByText("A photo didn't upload: Chat takes photos only (JPEG, PNG, WebP or GIF). Remove it to send.");
    expect(why.getAttribute('role')).toBe('alert');
    expect(within(chips).getByLabelText("A photo that didn't upload: Chat takes photos only (JPEG, PNG, WebP or GIF).")).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'what is on these' } });
    await waitFor(() => expect(chatPhotoAdd).toHaveBeenCalledTimes(2));
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(chatSend).not.toHaveBeenCalled();
    fireEvent.click(within(chips).getAllByRole('button', { name: 'Remove the photo' })[0]!);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(screen.queryByText(/didn't upload/)).toBeNull();
    fireEvent.click(sendButton());
    await waitFor(() => expect(chatSend).toHaveBeenCalledWith('what is on these', [tid(71)], expect.any(String)));
  });

  it('a refused send keeps the text and the chips; the box keeps the focus', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:chip'), revokeObjectURL: vi.fn() }));
    const chatPhotoAdd = vi.fn(async () => ({ id: tid(72) }));
    const chatSend = vi.fn<Api['chatSend']>().mockRejectedValueOnce(new ApiError('conflict', 'Jantar is busy. Try again in a minute.', 409)).mockResolvedValue({ id: tid(6) });
    open(list([]), { chatPhotoAdd, chatSend });
    await screen.findByText('Ask Jantar anything, or tell it what to add or change.');
    pick([gif()]);
    await waitFor(() => expect(chatPhotoAdd).toHaveBeenCalled());
    fireEvent.change(box(), { target: { value: 'what is on this' } });
    box().focus();
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(await screen.findByText('Jantar is busy. Try again in a minute.')).toBeTruthy();
    expect(box().value).toBe('what is on this');
    expect(within(screen.getByRole('list', { name: 'Photos to send' })).getAllByRole('listitem')).toHaveLength(1);
    expect(document.activeElement).toBe(box());
    expect(box().disabled).toBe(false);
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(chatSend).toHaveBeenLastCalledWith('what is on this', [tid(72)], expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Photos to send' })).toBeNull());
    expect(box().value).toBe('');
    expect(document.activeElement).toBe(box());
  });
});

describe('the address and the nav', () => {
  it('/ask is read as Chat and replaced with /chat; the nav says Chat', () => {
    expect(parseRoute('/ask', '', '')).toEqual({ name: 'chat' });
    expect(routePath({ name: 'chat' })).toBe('/chat');
    // 0.11: the day the history has open; anything but a day is left out.
    expect(parseRoute('/chat', '?day=2026-01-14', '')).toEqual({ name: 'chat', day: '2026-01-14' });
    expect(parseRoute('/chat', '?day=yesterday', '')).toEqual({ name: 'chat' });
    expect(routePath({ name: 'chat', day: '2026-01-14' })).toBe('/chat?day=2026-01-14');
    const replaced: string[] = [];
    const history = { location: { pathname: '/ask', search: '', hash: '' }, depth: 0, push: vi.fn(), replace: (p: string) => replaced.push(p), back: vi.fn(), listen: () => () => undefined };
    createRouter(history as unknown as Parameters<typeof createRouter>[0]);
    expect(replaced).toEqual(['/chat']);
    const item = NAV.find((n) => n.route === 'chat');
    expect(item).toMatchObject({ href: '/chat', label: 'Chat', feature: 'ask' });
  });
});

describe('0.11: the history and This chat (pure)', () => {
  const day = (ms: number) => dayOf(ago(ms));
  const turns = [
    turn(1, { at: ago(2 * 86_400_000), text: 'Rate the dosa place\nfour stars', photos: [{ id: tid(80), w: 4, h: 3, gone: false }], changes: [change({ label: 'Café · Sample Dosa House · 4★' })] }),
    turn(2, { at: ago(3_600_000), text: 'Add oat milk', changes: [change(), change({ n: 1, state: 'undone' })], cards: [card()] }),
    turn(3, { at: ago(60_000), text: '', photos: [{ id: tid(81), w: 4, h: 3, gone: true }], via: 'voice' }),
  ];

  it('groups by day, newest day and newest turn first', () => {
    const days = byDay(turns);
    expect(days.map((d) => d.day)).toEqual([...new Set([day(60_000), day(3_600_000), day(2 * 86_400_000)])]);
    expect(days[0]!.turns[0]!.id).toBe(tid(3));
  });

  it('searches every word in what was said, the reply and the changes, any case', () => {
    expect(turns.filter((t) => matches(t, 'DOSA four')).map((t) => t.id)).toEqual([tid(1)]);
    expect(turns.filter((t) => matches(t, 'oat milk')).map((t) => t.id)).toEqual([tid(2)]);
    expect(turns.filter((t) => matches(t, '  ')).length).toBe(3);
    expect(turns.filter((t) => matches(t, 'reply 3.')).map((t) => t.id)).toEqual([tid(3)]);
  });

  it('lists the changes still undoable (a day), newest first, and the photos still there', () => {
    expect(undoableChanges(turns, NOW).map((c) => `${c.turn.id}:${c.change.n}`)).toEqual([`${tid(2)}:0`]);
    expect(photosOf(turns).map((p) => p.photo.id)).toEqual([tid(80)]);
  });

  it("says a turn's photos, changes and time in one mono line", () => {
    expect(turnMeta(turns[0]!)).toMatch(/^photo · 1 change · \d\d:\d\d$/);
    expect(turnMeta(turns[1]!)).toMatch(/^1 change · \d\d:\d\d$/);
  });

  it('names the Confirm button by its verb, and Confirm for an op it does not know', () => {
    expect(['delete', 'stop', 'summarize', 'reread', 'archive'].map(confirmVerb)).toEqual(['Delete', 'Stop', 'Summarize', 'Re-read', 'Confirm']);
  });
});

describe('0.11: Chat in a wide window', () => {
  const wide = (first: ChatList, over: Partial<Api> = {}) => {
    const api = fakeApi({ chatList: vi.fn(async () => first), chatPhoto: vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' })), ...over });
    return { ...renderApp({ path: '/chat', api, state: ON, layout: layoutAt(1440) }), api };
  };

  it('lists the days beside the thread and This chat beside it; a day row scrolls the thread to its turn', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { router } = wide(list([turn(1, { at: ago(2 * 86_400_000), text: 'An older question' }), turn(2, { changes: [change()] })]));
    const days = await screen.findByRole('region', { name: 'Days' });
    expect(within(days).getByRole('searchbox', { name: 'Search the chat' })).toBeTruthy();
    // No segments: This chat has its own column at 1440.
    expect(within(days).queryByRole('group', { name: 'The history shows' })).toBeNull();
    const side = screen.getByRole('complementary', { name: 'This chat' });
    expect(within(within(side).getByRole('region', { name: 'Changes' })).getByText('Todo · Buy oat milk')).toBeTruthy();
    scrolled.mockClear();
    fireEvent.click(within(days).getByRole('button', { name: /An older question/ }));
    expect(scrolled.mock.contexts[0]).toBe(document.querySelector(`[data-turn="${tid(1)}"]`));
    expect(router.getState().route).toEqual({ name: 'chat', day: dayOf(ago(2 * 86_400_000)) });
    expect(within(days).getByRole('button', { name: /An older question/ }).getAttribute('aria-current')).toBe('true');
    scrolled.mockRestore();
  });

  it('the search keeps only the turns with every word', async () => {
    wide(list([turn(1, { text: 'Rate the dosa place' }), turn(2, { text: 'Add oat milk' })]));
    const days = await screen.findByRole('region', { name: 'Days' });
    fireEvent.change(within(days).getByRole('searchbox', { name: 'Search the chat' }), { target: { value: 'dosa' } });
    expect(within(days).getAllByRole('button', { name: /dosa|oat/ }).map((b) => b.textContent)).toEqual([expect.stringContaining('Rate the dosa place')]);
  });

  it('with no turns: no days column, three example rows, and This chat says what Chat can see', async () => {
    wide(list([]));
    expect(await screen.findByText('Ask Jantar anything, or tell it what to add or change.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Days' })).toBeNull();
    const side = screen.getByRole('complementary', { name: 'This chat' });
    expect(within(side).getByRole('heading', { name: 'What Chat can see' })).toBeTruthy();
    expect(within(side).getByText(PRIVACY)).toBeTruthy();
    expect(within(side).getByRole('heading', { name: 'Kept 30 days' })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Examples' })).getAllByRole('button')).toHaveLength(3);
  });
});
