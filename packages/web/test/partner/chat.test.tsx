/**
 * v0.12 People (P3, spec 7.6, 7.8; 9.7.4): her Chat and his read-only Chat
 * tab, against fake clients with synthetic people (Sam and Asha).
 *
 * - Her Chat: the permanent "Sam can read this chat" line while he can,
 *   none when he can't; the disclosure as the first message of a new
 *   thread and behind ⓘ, for each value of see.chat; "N messages left
 *   today"; Undo on a fresh change and the card buttons.
 * - His Chat tab: no composer, no Undo, no card button, no delete; a locked
 *   tile while she keeps it private.
 * - Hostile text in her chat renders as text in his tab: no script, no
 *   on* handler, no javascript: or data: link, no remote image.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatTurn } from '@jantar/protocol';
import { chatDisclosure, presetAgreement } from '@jantar/protocol/people-core';
import type { OwnerChatView, PersonChatList, PersonMe, PersonView } from '@jantar/protocol/people';
import type { PersonApi } from '../../src/partner/api.js';
import Chat from '../../src/partner/screens/Chat.js';
import { createRouter, memoryHistory } from '../../src/lib/router.js';
import { createAppStore } from '../../src/store.js';
import { AppProvider, createToastStore } from '../../src/ui/context.js';
import type { PeopleClient } from '../../src/ui/screens/people/client.js';
import { Partner } from '../../src/ui/screens/people/Partner.js';
import { fakeApi as ownerFakeApi } from '../helpers.js';

const ASHA = '01JASHAAAAAAAAAAAAAAAAAAAA';
const AT = new Date(Date.now() - 60_000).toISOString();

function me(): PersonMe {
  return {
    person: { id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, prefs: {} as PersonMe['person']['prefs'] },
    owner: { name: 'Sam' },
    peopleOn: true,
    agreement: { ...presetAgreement('everything', 'P3'), version: 1 },
    pending: null,
    ownerDevices: [],
    built: 'P3',
    lifeBroken: false,
  } as PersonMe;
}

const turn = (over: Partial<ChatTurn> = {}): ChatTurn => ({
  id: '01JTURNAAAAAAAAAAAAAAAAAAA',
  at: AT,
  via: 'phone',
  text: 'Add a stretch at six',
  photos: [],
  state: 'done',
  reply: 'Added a stretch at 18:00.',
  changes: [{ n: 0, module: 'plan', op: 'add', ref: 'STEPAAAAA1', label: 'Step · Stretch · 18:00 · 2026-11-03', state: 'done', undoable: true }],
  cards: [{ n: 0, kind: 'do', module: 'alerts', op: 'alert', ref: null, label: 'Send Sam "Running late"?', state: 'waiting' }],
  tainted: false,
  refused: 0,
  ...over,
});

function chatList(canRead: boolean, turns: ChatTurn[] = []): PersonChatList {
  return { turns, older: null, ready: { ok: true }, keepDays: 30, left: 12, perDay: 30, ownerCanRead: canRead, disclosure: chatDisclosure('Sam', 30, canRead, 'P3') };
}

function herApi(over: Partial<PersonApi> = {}): PersonApi {
  const base: Partial<PersonApi> = {};
  return new Proxy(base as PersonApi, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

describe('her Chat (spec 7.6)', () => {
  it('while Sam can read it: the permanent line, the disclosure first in a new thread, and messages left', async () => {
    render(<Chat me={me()} api={herApi({ chat: vi.fn(async () => chatList(true)) })} tick={0} />);
    expect(await screen.findByRole('note')).toHaveProperty('textContent', 'Sam can read this chat');
    expect(screen.getByText(/Sam can read this chat in Jantar: what you write, its answers, photos you send and what it changes for you\./)).toBeTruthy();
    expect(screen.getByText('12 messages left today')).toBeTruthy();
  });

  it("while he can't: no line, and the disclosure says he can't open it", async () => {
    render(<Chat me={me()} api={herApi({ chat: vi.fn(async () => chatList(false)) })} tick={0} />);
    expect(await screen.findByText(/Sam can't open this chat in Jantar, and sees only how many messages you send each day\./)).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('a fresh change has Undo; a waiting card has Do it and Dismiss; the reason replaces the box when used up', async () => {
    const chatUndo = vi.fn(async () => {});
    const chatCard = vi.fn(async () => {});
    const api = herApi({ chat: vi.fn(async () => chatList(true, [turn()])), chatUndo, chatCard });
    const r = render(<Chat me={me()} api={api} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(chatUndo).toHaveBeenCalledWith('01JTURNAAAAAAAAAAAAAAAAAAA', 0));
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    await waitFor(() => expect(chatCard).toHaveBeenCalledWith('01JTURNAAAAAAAAAAAAAAAAAAA', 0));
    r.unmount();
    render(<Chat me={me()} api={herApi({ chat: vi.fn(async () => ({ ...chatList(true), left: 0, ready: { ok: false, reason: "Today's messages are used up." } })) })} tick={0} />);
    expect(await screen.findByText("Today's messages are used up.")).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

const person = (chat: boolean): PersonView =>
  ({ id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, invite: null, agreement: { ...presetAgreement('everything', 'P3'), see: { ...presetAgreement('everything', 'P3').see, chat }, version: 1 }, offer: null, pendingProposal: null, chatPerDay: 30 }) as PersonView;

function peopleClient(over: Partial<PeopleClient>): PeopleClient {
  const base: Partial<PeopleClient> = {};
  return new Proxy(base as PeopleClient, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

function Wrapped({ client }: { client: PeopleClient }) {
  const [deps] = useState(() => ({ store: createAppStore(), api: ownerFakeApi(), router: createRouter(memoryHistory(`/people/${ASHA}`)), toasts: createToastStore() }));
  return (
    <AppProvider deps={deps}>
      <Partner pid={ASHA} client={client} tab="chat" />
    </AppProvider>
  );
}

const TODAY = { day: '2026-11-03', name: 'Asha', state: 'active', todos: { locked: true }, meds: null, weight: { locked: true }, food: null, plan: { locked: true }, status: { locked: true }, review: null, sleep: { locked: true }, concerns: [] } as never;

const HOSTILE = [
  '<script>window.__x = 1</script>',
  '<img src=x onerror="window.__y = 1">',
  '[click](javascript:alert(1)) and [data](data:text/html,hi)',
  '![remote](https://example.com/tracker.png)',
  `‮evil​ ${'x'.repeat(100_000)}`,
].join('\n');

describe('his Chat tab (spec 7.8)', () => {
  it('reads her thread with no composer, Undo, card button or delete; hostile text stays text', async () => {
    const view: OwnerChatView = { turns: [turn({ text: HOSTILE, reply: 'See [the docs](https://example.com/docs).' })], older: null, keepDays: 30 };
    const { container } = render(<Wrapped client={peopleClient({ list: vi.fn(async () => ({ enabled: true, people: [person(true)] })), today: vi.fn(async () => TODAY), chat: vi.fn(async () => view), chatPhotoUrl: (pid, id) => `/v1/people/${pid}/chat/photos/${id}` })} />);
    expect(await screen.findByText(/Read only\. Asha's assistant runs on your Claude account\./)).toBeTruthy();
    expect(await screen.findByText(/Her assistant: Added · Step · Stretch/)).toBeTruthy();
    expect(screen.getByText(/Asked her: Send Sam "Running late"\? · Waiting for her tap/)).toBeTruthy();
    for (const name of ['Undo', 'Do it', 'Confirm', 'Dismiss', 'Delete', 'Send', 'Clear']) expect(screen.queryByRole('button', { name }), name).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    for (const el of Array.from(container.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) expect(attr.name.startsWith('on'), `${el.tagName} ${attr.name}`).toBe(false);
    }
    for (const a of Array.from(container.querySelectorAll('a'))) expect(a.getAttribute('href') ?? '').toMatch(/^(https?:|\/v1\/people\/)/);
    for (const img of Array.from(container.querySelectorAll('img'))) expect(img.getAttribute('src') ?? '').toMatch(/^\/v1\/people\//);
    expect((window as unknown as { __x?: number; __y?: number }).__x).toBeUndefined();
    expect((window as unknown as { __y?: number }).__y).toBeUndefined();
  });

  it('a locked tile while she keeps it private', async () => {
    render(<Wrapped client={peopleClient({ list: vi.fn(async () => ({ enabled: true, people: [person(false)] })), today: vi.fn(async () => TODAY) })} />);
    expect(await screen.findByText('Chat: Asha keeps this private')).toBeTruthy();
  });
});
