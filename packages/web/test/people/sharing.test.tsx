/**
 * v0.11 People: his Partner › Sharing and Activity tabs, and someone invited
 * on his People list (spec 4.2, 2.3, 2.9, 8.3, C23, Q16), with synthetic
 * people (Sam and Asha) and a fake People client.
 *
 * - Sharing: what Asha agreed to, in the words her page used (his name on
 *   them); Ask for more sends only the picked fields and a note to the
 *   propose route, and its refusal is the daemon's sentence; a pending
 *   request reads "Waiting for Asha's answer"; her devices with the Access
 *   email and no last seen; his pushes about her (the day summary off until
 *   he picks a time, the review push, quiet hours) saved with one PATCH.
 * - Activity: her rows in his voice ("You looked at Asha's Today"), his
 *   views grouped per day, and Earlier.
 * - Invited: a row with the link's expiry and Copy link again (an admin
 *   device); People isn't an empty heading.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OwnerPeoplePrefsSchema, type PersonActivity, type PersonToday, type PersonView } from '@jantar/protocol/people';
import { AGREEMENT_FIELDS, presetAgreement } from '@jantar/protocol/people-core';
import { activityText, herVoice, hisVoice } from '../../src/people-shared/activity.js';
import { createRouter, memoryHistory } from '../../src/lib/router.js';
import { createAppStore } from '../../src/store.js';
import { AppProvider, createToastStore } from '../../src/ui/context.js';
import type { PeopleClient } from '../../src/ui/screens/people/client.js';
import { Partner } from '../../src/ui/screens/people/Partner.js';
import { askCommand, askable, proposePatch } from '../../src/ui/screens/people/PartnerSharing.js';
import { writeLocal } from '../../src/lib/storage.js';
import { LOCAL_DEVICE_KEY } from '../../src/ui/screens/devices/local.js';
import { fakeApi } from '../helpers.js';

const PID = '01JASHAAAAAAAAAAAAAAAAAAAA';
const DAY = '2026-11-03';
const AT = '2026-11-03T08:00:00.000Z';
const PREFS = OwnerPeoplePrefsSchema.parse({});

function client(over: Partial<PeopleClient> = {}): PeopleClient {
  const base: Partial<PeopleClient> = {};
  return new Proxy(base as PeopleClient, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

const standard = () => ({ ...presetAgreement('standard'), version: 2 });
const person = (over: Partial<PersonView> = {}): PersonView =>
  ({ id: PID, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, invite: null, agreement: standard(), offer: null, pendingProposal: null, ...over }) as PersonView;
const today = { day: DAY, name: 'Asha', state: 'active', todos: { locked: true }, meds: null, weight: { locked: true }, food: null, plan: { locked: true }, status: { locked: true }, review: null, sleep: { locked: true }, concerns: [] } as unknown as PersonToday;

function Wrapped({ client: c, tab, pid = PID }: { client: PeopleClient; tab?: string; pid?: string | null }) {
  const [deps] = useState(() => ({ store: createAppStore(), api: fakeApi(), router: createRouter(memoryHistory(pid ? `/people/${pid}` : '/people')), toasts: createToastStore() }));
  return (
    <AppProvider deps={deps}>
      <Partner {...(pid ? { pid } : {})} client={c} {...(tab ? { tab } : {})} />
    </AppProvider>
  );
}

describe('his Sharing tab', () => {
  it('has the Sharing and Activity tabs', async () => {
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [person()], ownerName: 'Sam', ownerPrefs: PREFS })), today: vi.fn(async () => today) });
    render(<Wrapped client={c} />);
    expect(await screen.findByRole('tab', { name: 'Sharing' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeTruthy();
  });

  it('shows what Asha agreed to in her page\'s words, her devices, and asks for more with a note', async () => {
    const propose = vi.fn(async () => undefined);
    const devices = vi.fn(async () => ({ devices: [{ id: '01JDEVAAAAAAAAAAAAAAAAAAAA', name: 'Asha phone', createdAt: AT, accessEmail: 'asha@example.com' }] }));
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [person()], ownerName: 'Sam', ownerPrefs: PREFS })), today: vi.fn(async () => today), propose, devices });
    render(<Wrapped client={c} tab="sharing" />);
    const agreed = await screen.findByRole('region', { name: 'What Asha agreed to' });
    expect(agreed.textContent).toMatch(/Sam/);
    expect(agreed.textContent).not.toMatch(/\beverything\b|full access/i);
    const devs = await screen.findByRole('region', { name: "Asha's devices" });
    expect(await within(devs).findByText('Asha phone')).toBeTruthy();
    expect(devs.textContent).toContain('asha@example.com');
    expect(devs.textContent).not.toMatch(/last (seen|used)/i);

    const ask = screen.getByRole('region', { name: 'Ask for more' });
    const button = within(ask).getByRole('button', { name: 'Ask Asha' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(within(ask).getByLabelText("See Asha's sleep"));
    fireEvent.click(within(ask).getByLabelText("See Asha's evening review: in full"));
    fireEvent.change(within(ask).getByLabelText('A note for Asha (optional)'), { target: { value: 'For the bedtime plan' } });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(propose).toHaveBeenCalledWith(PID, { see: { sleep: true, review: 'full' }, note: 'For the bedtime plan' }));
    expect(await within(ask).findByRole('status')).toBeTruthy();
  });

  it('on a phone paired the default way (no admin), Ask for more shows the Mac command, not a button that can only fail (review 4, B2)', async () => {
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-1', name: 'iPhone', scopes: ['read', 'control'] });
    const propose = vi.fn(async () => undefined);
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [person()], ownerName: 'Sam', ownerPrefs: PREFS })), today: vi.fn(async () => today), propose, devices: vi.fn(async () => ({ devices: [] })) });
    render(<Wrapped client={c} tab="sharing" />);
    const ask = await screen.findByRole('region', { name: 'Ask for more' });
    expect(within(ask).queryByRole('button', { name: 'Ask Asha' })).toBeNull();
    expect(ask.textContent).toContain("Asking needs a device paired with admin, and this one isn't.");
    expect(within(ask).getByText('jantar people ask Asha --see <area>')).toBeTruthy();
    fireEvent.click(within(ask).getByLabelText("See Asha's sleep"));
    fireEvent.click(within(ask).getByLabelText("See Asha's evening review: in full"));
    expect(within(ask).getByText('jantar people ask Asha --see sleep,review=full')).toBeTruthy();
    expect(propose).not.toHaveBeenCalled();
    expect(askCommand('Asha B', { 'see.journal': true, 'assign.plan': true, 'editHers.todos': true })).toBe('jantar people ask "Asha B" --see journal --assign plan --edit-hers todos');
  });

  it("shows the daemon's sentence when Asha said not to ask again; a pending request is a wait", async () => {
    const propose = vi.fn(async () => {
      throw new Error('That was declined with "Don\'t ask me about this again".');
    });
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [person()], ownerName: 'Sam', ownerPrefs: PREFS })), today: vi.fn(async () => today), propose, devices: vi.fn(async () => ({ devices: [] })) });
    const r = render(<Wrapped client={c} tab="sharing" />);
    const ask = await screen.findByRole('region', { name: 'Ask for more' });
    fireEvent.click(within(ask).getByLabelText("Read Asha's journal"));
    await act(async () => {
      fireEvent.click(within(ask).getByRole('button', { name: 'Ask Asha' }));
    });
    expect((await within(ask).findByRole('status')).textContent).toBe('That was declined with "Don\'t ask me about this again".');
    r.unmount();

    const fields = { ...presetAgreement('standard'), see: { ...presetAgreement('standard').see, sleep: true } };
    const waiting = client({ list: vi.fn(async () => ({ enabled: true, people: [person({ pendingProposal: { version: 3, fields } })], ownerName: 'Sam' })), today: vi.fn(async () => today), devices: vi.fn(async () => ({ devices: [] })) });
    render(<Wrapped client={waiting} tab="sharing" />);
    const wait = await screen.findByRole('region', { name: 'Ask for more' });
    expect(wait.textContent).toContain("Waiting for Asha's answer");
    expect(wait.textContent).toContain("See Asha's sleep");
    expect(within(wait).queryByRole('button', { name: 'Ask Asha' })).toBeNull();
  });

  it('his pushes about her: the day summary off until he picks a time, the review push and quiet hours, in one PATCH', async () => {
    const setPrefs = vi.fn(async () => ({ prefs: PREFS }));
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [person()], ownerName: 'Sam', ownerPrefs: PREFS })), today: vi.fn(async () => today), setPrefs, devices: vi.fn(async () => ({ devices: [] })) });
    render(<Wrapped client={c} tab="sharing" />);
    const box = await screen.findByRole('region', { name: 'Your pushes about Asha' });
    expect((within(box).getByLabelText('Day summary time') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(box).getByLabelText(/A day summary at/));
    fireEvent.change(within(box).getByLabelText('Day summary time'), { target: { value: '21:30' } });
    fireEvent.click(within(box).getByLabelText('Tell me when Asha sends the evening review'));
    fireEvent.change(within(box).getByLabelText('Quiet from'), { target: { value: '23:00' } });
    expect((within(box).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(box).getByLabelText('Quiet until'), { target: { value: '07:00' } });
    await act(async () => {
      fireEvent.click(within(box).getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(setPrefs).toHaveBeenCalledWith({ summaryAt: '21:30', reviewPush: false, quiet: { from: '23:00', to: '07:00' } }));
  });

  it('a field with two levels above hers is a choice of level (Light: medicines off)', async () => {
    const propose = vi.fn(async () => undefined);
    const light = { ...presetAgreement('light'), version: 2 };
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [person({ agreement: light })], ownerName: 'Sam' })), today: vi.fn(async () => today), propose, devices: vi.fn(async () => ({ devices: [] })) });
    render(<Wrapped client={c} tab="sharing" />);
    const ask = await screen.findByRole('region', { name: 'Ask for more' });
    fireEvent.change(within(ask).getByLabelText(/See Asha's medicines/), { target: { value: 'adherence' } });
    await act(async () => {
      fireEvent.click(within(ask).getByRole('button', { name: 'Ask Asha' }));
    });
    await waitFor(() => expect(propose).toHaveBeenCalledWith(PID, { see: { meds: 'adherence' } }));
  });

  it('askable lists only built fields above her level; the patch names each picked field', () => {
    const a = presetAgreement('standard');
    const keys = askable(a, false).map((x) => x.f.key);
    expect(keys).toContain('see.sleep');
    expect(keys).not.toContain('see.todos');
    expect(keys).not.toContain('see.food');
    expect(keys).not.toContain('assistant');
    expect(askable(a, false).find((x) => x.f.key === 'see.review')?.levels).toEqual(['full']);
    expect(askable({ ...presetAgreement('everything') }, false).map((x) => x.f.key)).toEqual([]);
    expect(proposePatch({ 'see.sleep': true, 'comment.journal': true })).toEqual({ see: { sleep: true }, comment: { journal: true } });
    expect(AGREEMENT_FIELDS.length).toBeGreaterThan(0);
  });
});

describe('his Activity tab', () => {
  const row = (seq: number, at: string, action: string, over: Partial<PersonActivity> = {}): PersonActivity => ({ seq, at, actor: 'owner', action, ...over });

  it('her rows in his voice, his views grouped per day, and Earlier', async () => {
    const activity = vi.fn(async (_pid: string, before?: number) =>
      before === undefined
        ? { activity: [row(5, '2026-11-03T10:00:00', 'view', { area: 'today' }), row(4, '2026-11-03T09:00:00', 'view', { area: 'today' }), row(3, '2026-11-03T08:00:00', 'todo.added', { title: 'Call the bank' })], before: 3 }
        : { activity: [row(2, '2026-11-02T08:00:00', 'joined', { actor: 'her' })], before: null },
    );
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [person()], ownerName: 'Sam' })), today: vi.fn(async () => today), activity });
    render(<Wrapped client={c} tab="activity" />);
    expect(await screen.findByText(/You looked at Asha's Today 2 times/)).toBeTruthy();
    expect(screen.getByText(/You added a to-do: Call the bank/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier' }));
    expect(await screen.findByText(/Asha joined/)).toBeTruthy();
    expect(activity).toHaveBeenLastCalledWith(PID, 3);
    expect(screen.queryByRole('button', { name: 'Earlier' })).toBeNull();
  });

  it('one row, two voices', () => {
    const r = row(1, AT, 'weight.corrected', { ref: '2026-11-02', changes: [{ field: 'kg', from: '61.4', to: '61.2' }] });
    expect(activityText(herVoice('Sam'), r)).toBe('Sam corrected your weight for Mon 2 Nov: 61.4 → 61.2 kg');
    expect(activityText(hisVoice('Asha'), r)).toBe("You corrected Asha's weight for Mon 2 Nov: 61.4 → 61.2 kg");
    expect(activityText(hisVoice('Asha'), row(2, AT, 'agreement.narrowed', { actor: 'her' }))).toBe('Asha changed what they share');
    expect(activityText(hisVoice('Asha'), row(3, AT, 'alert.sent', { fields: ['check_in'] }))).toBe('You sent Asha an alert: Check in, please');
    expect(activityText(hisVoice('Asha'), row(4, AT, 'journal.commented', { title: 'your entry of Thu 5 Nov' }))).toBe("You commented on Asha's entry of Thu 5 Nov");
    expect(activityText('Sam', row(5, AT, 'owner.device', { device: 'Sam iPad' }))).toBe('Sam added a device that can open your space: Sam iPad');
    expect(activityText(hisVoice('Asha'), row(6, AT, 'something.new'))).toBe("You changed something in Asha's space");
  });
});

describe('his People list: someone invited', () => {
  it('a row with the link expiry and Copy link again, not an empty heading', async () => {
    const inviteLink = vi.fn(async () => ({ url: 'https://us.example.com/p/join#c=synthetic', expiresAt: '2026-11-04T10:00:00.000Z' }));
    const invited = person({ state: 'invited', agreement: null, invite: { expiresAt: '2026-11-04T10:00:00.000Z', linkAvailable: true } });
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [invited], ownerName: 'Sam' })), inviteLink });
    render(<Wrapped client={c} pid={null} />);
    expect(await screen.findByText(/Invited · the link works once, until/)).toBeTruthy();
    expect(screen.getByText('jantar people invite Asha')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link again' }));
    });
    expect(inviteLink).toHaveBeenCalledWith(PID);
    expect(await screen.findByText('https://us.example.com/p/join#c=synthetic')).toBeTruthy();
  });

  it('on a device without admin, no Copy link again: the Mac command is the way (review 4, B2)', async () => {
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-1', name: 'iPhone', scopes: ['read', 'control'] });
    const invited = person({ state: 'invited', agreement: null, invite: { expiresAt: '2026-11-04T10:00:00.000Z', linkAvailable: true } });
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [invited], ownerName: 'Sam' })) });
    render(<Wrapped client={c} pid={null} />);
    expect(await screen.findByText(/Invited · the link works once, until/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy link again' })).toBeNull();
    expect(screen.getByText('jantar people invite Asha')).toBeTruthy();
  });

  it('someone who left is a row with what happened and the next step, not an empty heading (review 4, B4)', async () => {
    const left = person({ state: 'left', agreement: null });
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [left], ownerName: 'Sam' })) });
    render(<Wrapped client={c} pid={null} />);
    expect(await screen.findByText(/Sharing has ended\. Nothing of Asha's shows here now: their data stays on this Mac for 30 days after it ended, then it is deleted\./)).toBeTruthy();
    expect(screen.getByText('jantar people add Asha --email <address>')).toBeTruthy();
    expect(screen.getByText('jantar people invite Asha')).toBeTruthy();
    expect(screen.getByText(`jantar people remove ${PID} --forget`)).toBeTruthy();
    expect(screen.queryByText(/Nobody yet/)).toBeNull();
  });

  it('nobody yet says how to add someone', async () => {
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [] })) });
    render(<Wrapped client={c} pid={null} />);
    expect(await screen.findByText('jantar people add <name> --email <address>')).toBeTruthy();
  });
});
