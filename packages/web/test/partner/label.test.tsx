/**
 * v0.11 People: the space's name with one person (his label), in both apps,
 * with synthetic people (Sam and Asha).
 *
 * - Hers: the join page is titled with it and says "as your cofounder";
 *   her app's tab title, the Home Screen title iOS offers (at most 12
 *   characters) and, once she is in and he named the space, her own
 *   manifest (/v1/p/manifest); the top of her Today reads "Cofounder ·
 *   Sam". The default changes nothing of p.html's.
 * - His: the name over hers on his screen for her, on his People list and
 *   on his Today card; Sharing › "What this space is called" saves a
 *   preset, his own words (checked: 1 to 40 characters, plain text) or the
 *   default (sent as null); her Activity row reads in both voices.
 * - A label with markup is text everywhere: no element, no `on*` attribute.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_PHASE, closeDependents, presetAgreement } from '@jantar/protocol/people-core';
import type { JoinPreview, PersonActivity, PersonMe, PersonOwnToday, PersonToday, PersonView } from '@jantar/protocol/people';
import type { PersonApi } from '../../src/partner/api.js';
import { App } from '../../src/partner/App.js';
import { PERSON_MANIFEST_URL, nameApp } from '../../src/partner/name.js';
import { Join } from '../../src/partner/screens/Join.js';
import { Today } from '../../src/partner/screens/Today.js';
import { activityText, hisVoice } from '../../src/people-shared/activity.js';
import { joinCopy } from '../../src/people-shared/join-copy.js';
import { createRouter, memoryHistory } from '../../src/lib/router.js';
import { createAppStore } from '../../src/store.js';
import { AppProvider, createToastStore } from '../../src/ui/context.js';
import type { PeopleClient } from '../../src/ui/screens/people/client.js';
import { Partner } from '../../src/ui/screens/people/Partner.js';
import { PeopleCard } from '../../src/ui/screens/people/PeopleCard.js';
import { fakeApi as fakeOwnerApi } from '../helpers.js';

const ASHA = '01JASHAAAAAAAAAAAAAAAAAAAA';
const DAY = '2026-11-03';
const AT = '2026-11-03T08:00:00.000Z';
const HOSTILE = '<img src=x onerror=alert(1)>';

function fake<T extends object>(over: Partial<T> = {}): T {
  const base: Partial<T> = {};
  return new Proxy(base as T, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

const me = (label?: string): PersonMe =>
  ({
    person: { id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, prefs: {} as PersonMe['person']['prefs'] },
    owner: { name: 'Sam' },
    ...(label !== undefined ? { label } : {}),
    peopleOn: true,
    agreement: { ...presetAgreement('standard'), version: 1 },
    pending: null,
    ownerDevices: [],
    built: BUILT_PHASE,
    lifeBroken: false,
  }) as PersonMe;

const ownToday: PersonOwnToday = {
  day: DAY,
  today: DAY,
  meds: null,
  todos: [],
  overdue: 0,
  plan: { day: DAY, plan: null, now: null, next: null, late: [], focus: null, slots: {}, counts: { done: 0, total: 0 } },
  status: null,
  review: null,
  sleep: { open: null, showStart: false, askWake: null },
  sharingCheckin: false,
  alertsUnseen: 0,
  prompt: 'What went well today?',
  food: null,
} as PersonOwnToday;

/** p.html's head: the title, the Home Screen title and the manifest link. */
function pHtmlHead() {
  document.head.innerHTML = '<title>Accountability partner</title><meta name="apple-mobile-web-app-title" content="Partner" /><link rel="manifest" href="/p.webmanifest" crossorigin="use-credentials" />';
}
const homeTitle = () => document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content');
const manifestHref = () => document.querySelector('link[rel="manifest"]')?.getAttribute('href');

const noMarkup = (el: Element) => {
  expect(el.querySelector('img, script, iframe')).toBeNull();
  for (const x of el.querySelectorAll('*')) for (const attr of x.getAttributeNames()) expect(attr.startsWith('on'), attr).toBe(false);
};

describe('her app under the space’s name', () => {
  beforeEach(pHtmlHead);

  it('the join page is titled with it and says "as your cofounder"; the default reads as before', async () => {
    const offer = closeDependents(presetAgreement('standard'));
    expect(joinCopy('Sam', offer, { built: BUILT_PHASE, foodModule: false, label: 'Cofounder' })).toMatchObject({
      heading: 'Cofounder',
      intro: expect.stringMatching(/^Sam invited you to a shared space for your days, as your cofounder\. /),
    });
    expect(joinCopy('Sam', offer, { built: BUILT_PHASE, foodModule: false })).toMatchObject({ heading: 'Accountability partner', intro: expect.stringContaining('as your accountability partner.') });
    location.hash = '#c=AAAAAAAAAAAAAAAAAAAAAA';
    const preview = { owner: 'Sam', name: 'Asha', label: 'Cofounder', version: 1, offer, fields: [], built: BUILT_PHASE, modules: { food: false } } as unknown as JoinPreview;
    render(<Join api={fake<PersonApi>({ joinPreview: vi.fn(async () => preview) })} mode="join" />);
    expect(await screen.findByRole('heading', { name: 'Cofounder' })).toBeTruthy();
    // nameApp runs in an effect after the heading is drawn: wait for it (CI, macOS, 3 Nov).
    await waitFor(() => expect(document.title).toBe('Cofounder'));
    expect(homeTitle()).toBe('Cofounder');
    // Before she is in, the manifest link stays p.html's (her own manifest needs her credential).
    expect(manifestHref()).toBe('/p.webmanifest');
  });

  it('nameApp: the tab, a Home Screen title of at most 12 characters, and her manifest only for a name he set', () => {
    nameApp(undefined, { manifest: true });
    expect([document.title, homeTitle(), manifestHref()]).toEqual(['Accountability partner', 'Partner', '/p.webmanifest']);
    nameApp('My running coach', { manifest: true });
    expect([document.title, homeTitle(), manifestHref()]).toEqual(['My running coach', 'My running', PERSON_MANIFEST_URL]);
    // Review 5, UX 2: the first words that fit, never a lone last word ("Crime", "More").
    nameApp('Partner in crime', { manifest: true });
    expect(homeTitle()).toBe('Partner in');
    nameApp(HOSTILE);
    expect(document.title).toBe(HOSTILE);
    expect(document.head.querySelector('img')).toBeNull();
    expect(Array.from(homeTitle() ?? '').length).toBeLessThanOrEqual(12);
  });

  it('her app names itself from Me once she is in', async () => {
    vi.stubGlobal('WebSocket', undefined);
    history.replaceState(null, '', '/p');
    const api = fake<PersonApi>({ me: vi.fn(async () => me('Teammate')), today: vi.fn(async () => ownToday) });
    render(<App api={api} />);
    await waitFor(() => expect(document.title).toBe('Teammate'));
    expect(homeTitle()).toBe('Teammate');
    expect(manifestHref()).toBe(PERSON_MANIFEST_URL);
    vi.unstubAllGlobals();
  });

  it('the top of her Today: the space’s name and his; markup in it is text', async () => {
    const api = fake<PersonApi>({ today: vi.fn(async () => ownToday) });
    const r = render(<Today me={me('Cofounder')} api={api} reload={() => {}} tick={0} />);
    expect(await screen.findByText('Cofounder · Sam')).toBeTruthy();
    r.unmount();
    const h = render(<Today me={me(HOSTILE)} api={api} reload={() => {}} tick={0} />);
    expect(await screen.findByText(`${HOSTILE} · Sam`)).toBeTruthy();
    noMarkup(h.container);
    h.unmount();
    render(<Today me={me()} api={api} reload={() => {}} tick={0} />);
    expect(await screen.findByText('Accountability partner · Sam')).toBeTruthy();
  });
});

const person = (over: Partial<PersonView> = {}): PersonView =>
  ({ id: ASHA, name: 'Asha', color: 'teal', label: 'Accountability partner', state: 'active', modules: { food: false }, invite: null, agreement: { ...presetAgreement('standard'), version: 2 }, offer: null, pendingProposal: null, ...over }) as PersonView;
const theirToday = { day: DAY, name: 'Asha', state: 'active', todos: { locked: true }, meds: null, weight: { locked: true }, food: null, plan: { locked: true }, status: { locked: true }, review: null, sleep: { locked: true }, concerns: [] } as unknown as PersonToday;

function Wrapped({ client: c, tab, pid = ASHA, children }: { client: PeopleClient; tab?: string; pid?: string | null; children?: React.ReactNode }) {
  const [deps] = useState(() => ({ store: createAppStore(), api: fakeOwnerApi(), router: createRouter(memoryHistory(pid ? `/people/${pid}` : '/people')), toasts: createToastStore() }));
  return <AppProvider deps={deps}>{children ?? <Partner {...(pid ? { pid } : {})} client={c} {...(tab ? { tab } : {})} />}</AppProvider>;
}

describe('his screens name the space', () => {
  afterEach(() => vi.restoreAllMocks());

  it('over her name on his screen for her, and on his People list', async () => {
    const two = [person({ label: 'Cofounder' }), person({ id: '01JBEAAAAAAAAAAAAAAAAAAAAA', name: 'Bea' })];
    const c = fake<PeopleClient>({ list: vi.fn(async () => ({ enabled: true, people: two, ownerName: 'Sam' })), today: vi.fn(async () => theirToday) });
    const r = render(<Wrapped client={c} />);
    const header = (await screen.findByRole('heading', { name: 'Asha' })).closest('header') as HTMLElement;
    expect(within(header).getByText('Cofounder')).toBeTruthy();
    r.unmount();
    render(<Wrapped client={c} pid={null} />);
    expect(await screen.findByRole('button', { name: 'Asha Cofounder' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bea Accountability partner' })).toBeTruthy();
  });

  it('on his Today card, as text', async () => {
    const c = fake<PeopleClient>({ list: vi.fn(async () => ({ enabled: true, people: [person({ label: HOSTILE })] })), today: vi.fn(async () => theirToday) });
    const r = render(
      <Wrapped client={c}>
        <PeopleCard client={c} />
      </Wrapped>,
    );
    expect(await screen.findByRole('button', { name: `${HOSTILE} Asha` })).toBeTruthy();
    noMarkup(r.container);
  });

  it('Sharing › "What this space is called": a preset, his own words, back to the default', async () => {
    const setLabel = vi.fn(async () => undefined);
    let current: string | undefined = 'Accountability partner';
    const c = fake<PeopleClient>({
      list: vi.fn(async () => ({ enabled: true, people: [person({ label: current })], ownerName: 'Sam' })),
      today: vi.fn(async () => theirToday),
      devices: vi.fn(async () => ({ devices: [] })),
      setLabel,
    });
    render(<Wrapped client={c} tab="sharing" />);
    const section = await screen.findByRole('region', { name: 'What this space is called' });
    const pick = within(section).getByRole('combobox', { name: 'What this space is called' }) as HTMLSelectElement;
    expect(Array.from(pick.options).map((o) => o.text)).toEqual(['Accountability partner', 'Cofounder', 'Partner', 'Coach', 'Mentor', 'Teammate', 'Family', 'Friend', 'Your own words…']);
    const save = within(section).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Her Home Screen title shows before he saves (at most 12 characters).
    expect(within(section).getByText("Asha's Home Screen title:", { exact: false }).textContent).toBe("Asha's Home Screen title: Partner");
    fireEvent.change(pick, { target: { value: 'Mentor' } });
    current = 'Mentor';
    await act(async () => {
      fireEvent.click(save);
    });
    expect(setLabel).toHaveBeenLastCalledWith(ASHA, 'Mentor');
    // The list reloads with it: the picker shows it, and saving it again has nothing to do.
    await waitFor(() => expect(within(section).getByText('Mentor', { selector: 'span' })).toBeTruthy());
    expect(save.disabled).toBe(true);
    expect(within(section).getByRole('status').textContent).toBe('Saved. Asha\'s app is called "Mentor" now.');
    // His own words: checked as he types (plain text, up to 40 characters), sent trimmed.
    fireEvent.change(pick, { target: { value: '__own__' } });
    const words = within(section).getByRole('textbox') as HTMLInputElement;
    expect(words.maxLength).toBe(40);
    fireEvent.change(words, { target: { value: '   ' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(words, { target: { value: `Study${String.fromCharCode(9)}buddy` } });
    expect(within(section).getByText('Plain text on one line.')).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(words, { target: { value: 'Study buddy for the March exams and more' } });
    expect(within(section).getByText("Asha's Home Screen title:", { exact: false }).textContent).toBe("Asha's Home Screen title: Study buddy");
    fireEvent.change(words, { target: { value: '  Study buddy ' } });
    current = 'Study buddy';
    await act(async () => {
      fireEvent.click(save);
    });
    expect(setLabel).toHaveBeenLastCalledWith(ASHA, 'Study buddy');
    // Back to the default: sent as null (no label stored).
    await waitFor(() => expect((within(section).getByRole('textbox') as HTMLInputElement).value).toBe('Study buddy'));
    fireEvent.change(pick, { target: { value: 'Accountability partner' } });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(setLabel).toHaveBeenLastCalledWith(ASHA, null);
  });

  it("0.12.2: a name picked the moment Sharing is on screen stays picked, before React's passive effects run", async () => {
    // Sharing comes with the list's answer, outside act(), and React 19 yields for paint before its passive effects:
    // the test above picked Mentor there on a loaded CI runner (findBy returns on a 0 ms timer that fires first), the
    // effect that follows his saved name then put the old one back, and Save had nothing to send. Here the pick is
    // made in the very microtask the commit queued, when the section is in the DOM and its passive effects have not run.
    const setLabel = vi.fn(async () => undefined);
    const c = fake<PeopleClient>({
      list: vi.fn(async () => ({ enabled: true, people: [person({ label: 'Accountability partner' })], ownerName: 'Sam' })),
      today: vi.fn(async () => theirToday),
      devices: vi.fn(async () => ({ devices: [] })),
      setLabel,
    });
    const picked = new Promise<void>((resolve) => {
      const seen = new MutationObserver(() => {
        const pick = document.querySelector<HTMLSelectElement>('select[aria-label="What this space is called"]');
        if (!pick) return;
        seen.disconnect();
        fireEvent.change(pick, { target: { value: 'Mentor' } });
        resolve();
      });
      seen.observe(document.body, { childList: true, subtree: true });
    });
    render(<Wrapped client={c} tab="sharing" />);
    await picked;
    const section = await screen.findByRole('region', { name: 'What this space is called' });
    expect((within(section).getByRole('combobox', { name: 'What this space is called' }) as HTMLSelectElement).value).toBe('Mentor');
    const save = within(section).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });
    expect(setLabel).toHaveBeenLastCalledWith(ASHA, 'Mentor');
  });

  it('his own words with markup show as text; her Activity row reads in both voices', async () => {
    const c = fake<PeopleClient>({ list: vi.fn(async () => ({ enabled: true, people: [person({ label: HOSTILE })], ownerName: 'Sam' })), today: vi.fn(async () => theirToday), devices: vi.fn(async () => ({ devices: [] })) });
    const r = render(<Wrapped client={c} tab="sharing" />);
    const section = await screen.findByRole('region', { name: 'What this space is called' });
    expect(within(section).getByRole('textbox')).toHaveProperty('value', HOSTILE);
    noMarkup(r.container);
    const row = { seq: 1, at: AT, actor: 'owner', action: 'label.changed', changes: [{ field: 'label', from: 'Accountability partner', to: 'Cofounder' }] } as PersonActivity;
    expect(activityText('Sam', row)).toBe('Sam renamed this space: Accountability partner → Cofounder');
    expect(activityText(hisVoice('Asha'), row)).toBe('You renamed the space with Asha: Accountability partner → Cofounder');
  });
});
