/**
 * v0.12 People: every control a phone review measured under 44 px (390x844,
 * a coarse pointer) carries what makes it at least 44 px, on his People
 * screen and in her app, with synthetic people (Sam and Asha).
 *
 * jsdom has no layout, so this pins the classes: a height of 44 (min-h-44,
 * h-44, size-44, h-48, or the kit Button's coarse:min-h-44) and, for a
 * control whose label is a glyph or a short word (×, ⓘ, OK, ♥, 3★, a
 * tick), a width of 44 too.
 *
 * - His Lists: the tick is a 44 px label around the checkbox; × is 44 wide.
 * - His Alerts: each row is 44 tall; the reply chips 44 wide.
 * - His Chat: "Asha's messages a day" and its box are 44 tall.
 * - Hers: × on a list item, ⓘ in Chat, the café stars, alert rows and
 *   reply chips, Me › Notifications' Quiet hours and every select and time
 *   box, and the download links on Leave and after leaving.
 */
import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PlaceDetail } from '@jantar/protocol';
import { ALERT_CAPS_DEFAULT, presetAgreement } from '@jantar/protocol/people-core';
import { PersonPrefsSchema, type AlertsResponse, type PersonAlert, type PersonChatList, type PersonMe, type PersonView, type SharedItemsResponse } from '@jantar/protocol/people';
import type { PersonApi } from '../../src/partner/api.js';
import Alerts from '../../src/partner/screens/Alerts.js';
import Chat from '../../src/partner/screens/Chat.js';
import { Left } from '../../src/partner/screens/Left.js';
import Lists from '../../src/partner/screens/Lists.js';
import { Me } from '../../src/partner/screens/Me.js';
import { createRouter, memoryHistory } from '../../src/lib/router.js';
import { createAppStore } from '../../src/store.js';
import { AppProvider, createToastStore } from '../../src/ui/context.js';
import type { PeopleClient } from '../../src/ui/screens/people/client.js';
import { Partner } from '../../src/ui/screens/people/Partner.js';
import { fakeApi as ownerFakeApi } from '../helpers.js';

const ASHA = '01JASHAAAAAAAAAAAAAAAAAAAA';
const SID = 's:01JSPACEAAAAAAAAAAAAAAAAAA';
const LIST = '01JLISTAAAAAAAAAAAAAAAAAAA';
const CAFE = '01JCAFEAAAAAAAAAAAAAAAAAAA';
const ALERT = '01JALERTAAAAAAAAAAAAAAAAAA';
const AT = new Date(Date.now() - 60_000).toISOString();

const TALL = ['min-h-44', 'h-44', 'size-44', 'h-48', 'coarse:min-h-44'];
const WIDE = ['min-w-44', 'size-44'];
const has = (el: Element | null | undefined, any: string[]) => Boolean(el && any.some((c) => el.classList.contains(c)));
/** At least 44 px tall (and wide, for a glyph or a short word) on a phone. */
function expect44(el: Element | null | undefined, opts: { wide?: boolean } = {}) {
  const what = el?.outerHTML.slice(0, 120) ?? 'nothing';
  expect(has(el, TALL), `44 tall: ${what}`).toBe(true);
  if (opts.wide) expect(has(el, WIDE), `44 wide: ${what}`).toBe(true);
}

function proxy<T extends object>(over: Partial<T>): T {
  const base: Partial<T> = {};
  return new Proxy(base as T, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

function me(prefs: Partial<PersonMe['person']['prefs']> = {}): PersonMe {
  return {
    person: { id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, prefs: { ...PersonPrefsSchema.parse({}), ...prefs } },
    owner: { name: 'Sam' },
    peopleOn: true,
    agreement: { ...presetAgreement('everything', 'P4'), version: 1 },
    pending: null,
    ownerDevices: [],
    built: 'P4',
    lifeBroken: false,
  } as PersonMe;
}

const items: SharedItemsResponse = {
  list: { id: LIST, name: 'Weekly shop', kind: 'shopping', open: 1, done: 0, createdAt: AT, updatedAt: AT },
  items: [{ id: '01JITEMAAAAAAAAAAAAAAAAAA1', title: 'Eggs', by: ASHA, createdAt: AT, updatedAt: AT }],
};

const alert = (from: string, to: string): PersonAlert => ({ id: ALERT, from, to, kind: 'check_in', urgency: 'normal', at: AT, delivery: 'sent', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) as PersonAlert;
const alerts = (a: PersonAlert): AlertsResponse => ({ alerts: [a], unseen: 1, sheet: { caps: { ...ALERT_CAPS_DEFAULT }, sent: { hour: 0, day: 0, urgentDay: 0 }, hold: null } });

// ---------------------------------------------------------------------------- his People screen

const TODAY = { day: '2026-11-03', name: 'Asha', state: 'active', todos: { locked: true }, meds: null, weight: { locked: true }, food: null, plan: { locked: true }, status: { locked: true }, review: null, sleep: { locked: true }, concerns: [] } as never;
const person = (chat: boolean): PersonView =>
  ({
    id: ASHA,
    name: 'Asha',
    color: 'teal',
    state: 'active',
    modules: { food: false },
    invite: null,
    agreement: { ...presetAgreement('everything', 'P4'), see: { ...presetAgreement('everything', 'P4').see, chat }, version: 1 },
    offer: null,
    pendingProposal: null,
    sharedSpace: SID,
    chatPerDay: 30,
  }) as PersonView;

function His({ client, tab, id }: { client: PeopleClient; tab: string; id?: string }) {
  const [deps] = useState(() => ({
    store: createAppStore(),
    api: ownerFakeApi({ placesList: vi.fn(async () => ({ places: [], tags: [], areas: [] })) as never }),
    router: createRouter(memoryHistory(`/people/${ASHA}`)),
    toasts: createToastStore(),
  }));
  return (
    <AppProvider deps={deps}>
      <Partner pid={ASHA} client={client} tab={tab as never} {...(id ? { id } : {})} />
    </AppProvider>
  );
}
const hisClient = (over: Partial<PeopleClient> = {}, chat = true) =>
  proxy<PeopleClient>({ list: vi.fn(async () => ({ enabled: true, people: [person(chat)] })), today: vi.fn(async () => TODAY), lists: vi.fn(async () => ({ space: SID, lists: [] })), ...over });

describe('his People screen', () => {
  it('Lists: the tick is a 44 px label around its checkbox, and × is 44 wide', async () => {
    render(<His client={hisClient({ listItems: vi.fn(async () => items) })} tab="lists" id={LIST} />);
    const box = await screen.findByRole('checkbox', { name: 'Eggs' });
    const label = box.closest('label');
    expect(label?.classList.contains('size-44')).toBe(true);
    expect44(screen.getByRole('button', { name: 'Delete Eggs' }), { wide: true });
  });

  it('Alerts: each row is 44 tall and the reply chips 44 wide', async () => {
    render(<His client={hisClient({ alerts: vi.fn(async () => alerts(alert(ASHA, ''))) })} tab="alerts" />);
    const ok = await screen.findByRole('button', { name: 'OK' });
    expect44(ok, { wide: true });
    expect44(screen.getByRole('button', { name: "Can't right now, I'm safe" }));
    expect44(screen.getByText('Check in, please').closest('button'));
  });

  it("Chat: Asha's messages a day and its box are 44 tall", async () => {
    render(<His client={hisClient({}, false)} tab="chat" />);
    const input = await screen.findByLabelText("Asha's messages a day");
    expect44(input);
    expect44(document.querySelector('label[for="chat-cap"]'));
    expect44(screen.getByRole('button', { name: 'Save' }));
  });
});

// ---------------------------------------------------------------------------- her app

describe('her app', () => {
  it('Lists: × on an item is 44 wide; the café stars are 44 by 44', async () => {
    const r = render(<Lists me={me()} api={proxy<PersonApi>({ listItems: vi.fn(async () => items) })} tab="lists" id={null} list={LIST} tick={0} />);
    expect44(await screen.findByRole('button', { name: 'Delete Eggs' }), { wide: true });
    r.unmount();
    const detail: PlaceDetail = {
      place: { id: CAFE, name: 'Blue Door', tried: true, dishes: [], best: null, tags: [], visits: { count: 0, last: null, avgSpend: null }, createdAt: AT, updatedAt: AT, space: SID, by: '' },
      visits: [],
      more: false,
    };
    render(<Lists me={me()} api={proxy<PersonApi>({ place: vi.fn(async () => detail) })} tab="cafes" id={CAFE} list={null} tick={0} />);
    expect44(await screen.findByRole('button', { name: '3★' }), { wide: true });
  });

  it('Chat: ⓘ is 44 by 44', async () => {
    const list: PersonChatList = { turns: [], older: null, ready: { ok: true }, keepDays: 30, left: 12, perDay: 30, ownerCanRead: true, disclosure: 'Sam can read this chat.' };
    render(<Chat me={me()} api={proxy<PersonApi>({ chat: vi.fn(async () => list) })} tick={0} />);
    expect44(await screen.findByRole('button', { name: 'Who can read this chat' }), { wide: true });
  });

  it('Alerts: each row is 44 tall and the reply chips 44 wide', async () => {
    render(<Alerts me={me()} api={proxy<PersonApi>({ alerts: vi.fn(async () => alerts(alert('', ASHA))) })} id={null} tick={0} />);
    expect44(await screen.findByRole('button', { name: 'OK' }), { wide: true });
    expect44(screen.getByText('Check in, please').closest('button'));
  });

  it('Me › Notifications: Quiet hours and every select and time box are 44 tall', () => {
    const { container } = render(<Me me={me({ quiet: { from: '22:00', to: '07:00' } })} api={proxy<PersonApi>({})} reload={() => {}} tab="notifications" />);
    expect44(screen.getByText('Quiet hours', { selector: 'label' }));
    const boxes = [...container.querySelectorAll('select, input[type="time"]')];
    expect(boxes.length).toBeGreaterThan(8);
    for (const b of boxes) expect44(b);
  });

  it('the download links on Leave and after leaving are 44 tall', () => {
    const api = proxy<PersonApi>({ exportUrl: (f: string) => `/v1/p/export?format=${f}` });
    const r = render(<Me me={me()} api={api} reload={() => {}} tab="leave" />);
    expect44(screen.getByRole('link', { name: 'Download as a page' }));
    expect44(screen.getByRole('link', { name: 'data file (JSON)' }));
    r.unmount();
    render(<Left me={{ ...me(), person: { ...me().person, state: 'ending' } } as PersonMe} api={api} />);
    expect44(screen.getByRole('link', { name: 'Download as a page' }));
    expect44(screen.getByRole('link', { name: 'data file (JSON)' }));
  });
});
