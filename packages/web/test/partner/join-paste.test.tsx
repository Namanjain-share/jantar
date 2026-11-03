/**
 * 0.12.1: the join page without its code. Signing in to Access with the
 * one-time PIN brings her to /p/join without the `#c=`; the page says she is
 * signed in and to open the link once more, or paste it. A pasted link loads
 * the same preview, junk says so, and nothing joins before Accept and join.
 *
 * 0.12.1 after review: the link opened again in the same tab (only the
 * fragment changes) shows its preview; a device that is in already goes on
 * to Today, or back to the first step the address kept after Accept.
 * Synthetic people (Sam and Asha) and codes.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { JoinPreview, PersonMe } from '@jantar/protocol/people';
import { PersonApiError, type PersonApi } from '../../src/partner/api.js';
import { Join, NOT_AN_INVITE } from '../../src/partner/screens/Join.js';

const CODE = 'synthetic-invite_code1';
const joined = { personId: '01JASHAAAAAAAAAAAAAAAAAAAA', deviceId: '01JDEVICEAAAAAAAAAAAAAAAAA', deviceSecret: 's' };
const preview = { owner: 'Sam', name: 'Asha', version: 1, offer: presetAgreement('standard'), fields: [], built: 'P4', modules: { food: false } } as unknown as JoinPreview;
const asha = { person: { id: joined.personId, name: 'Asha', state: 'active' }, owner: { name: 'Sam' }, label: 'Cofounder' } as unknown as PersonMe;
// A device that hasn't joined: her app's check answers 401, as the daemon does.
const notJoined = () => vi.fn(async (): Promise<PersonMe> => {
  throw new PersonApiError('unauthorized', 'not joined', 401);
});

function fakeApi(over: Partial<PersonApi> = {}): PersonApi {
  const base: Partial<PersonApi> = { me: notJoined() };
  return new Proxy(base as PersonApi, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

const paste = async (text: string) => {
  fireEvent.change(await screen.findByLabelText('Paste your invite link'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
};

/** The link opened again in this tab: only the fragment changes. */
const openAgain = async (hash: string, event: 'hashchange' | 'popstate' = 'hashchange') => {
  await act(async () => {
    history.replaceState(null, '', `/p/join${hash}`);
    dispatchEvent(event === 'hashchange' ? new HashChangeEvent('hashchange') : new PopStateEvent('popstate'));
  });
};

describe('/p/join without its code (after a one-time PIN sign-in)', () => {
  beforeEach(() => history.replaceState(null, '', '/p/join'));

  it('says she is signed in and to open the link once more, or paste it; nothing is asked of the daemon yet', async () => {
    const joinPreview = vi.fn(async () => preview);
    const join = vi.fn(async () => joined);
    const me = notJoined();
    render(<Join api={fakeApi({ joinPreview, join, me })} mode="join" />);
    expect(await screen.findByRole('heading', { name: 'Open your invite link once more' })).toBeTruthy();
    expect(me).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/You're signed in\. Signing in drops the part of the link that holds your invite, so open the link you were sent once more, or paste it here\./)).toBeTruthy();
    expect(screen.getByLabelText('Paste your invite link')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    expect(joinPreview).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it('a pasted link loads the preview; only Accept and join joins, and the code leaves the address', async () => {
    const joinPreview = vi.fn(async () => preview);
    const join = vi.fn(async () => joined);
    render(<Join api={fakeApi({ joinPreview, join })} mode="join" />);
    await paste(`  https://us.example.com/p/join#c=${CODE}\n`);
    expect(await screen.findByRole('heading', { name: 'Accountability partner' })).toBeTruthy();
    expect(joinPreview).toHaveBeenCalledTimes(1);
    expect(joinPreview).toHaveBeenCalledWith(CODE);
    // As if she had opened the link.
    expect(location.hash).toBe(`#c=${CODE}`);
    expect(join).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("I'm 18 or older"));
    expect(join).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept and join' }));
    });
    await waitFor(() => expect(join).toHaveBeenCalledTimes(1));
    expect(join).toHaveBeenCalledWith(expect.objectContaining({ code: CODE, acceptedVersion: 1 }));
    expect(await screen.findByRole('button', { name: 'Turn on notifications' })).toBeTruthy();
    expect(location.pathname).toBe('/p/join');
    expect(location.hash).toBe('');
    // The first step stays in the address, so a reload goes back to it (0.12.1 after review).
    expect(location.search).toBe('?step=notify');
  });

  it('the code alone works too', async () => {
    const joinPreview = vi.fn(async () => preview);
    render(<Join api={fakeApi({ joinPreview })} mode="join" />);
    await paste(CODE);
    expect(await screen.findByRole('heading', { name: 'Accountability partner' })).toBeTruthy();
    expect(joinPreview).toHaveBeenCalledWith(CODE);
  });

  it('junk says so in plain words and asks the daemon nothing', async () => {
    const joinPreview = vi.fn(async () => preview);
    const join = vi.fn(async () => joined);
    render(<Join api={fakeApi({ joinPreview, join })} mode="join" />);
    for (const junk of ['hello', 'https://us.example.com/p/join', 'https://us.example.com/p/join#c=short']) {
      await paste(junk);
      expect(screen.getByRole('alert').textContent).toBe(NOT_AN_INVITE);
    }
    expect(NOT_AN_INVITE).toBe("That isn't an invite link. Paste the whole link you were sent.");
    expect(screen.getByRole('heading', { name: 'Open your invite link once more' })).toBeTruthy();
    expect(joinPreview).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it("a spent or expired link shows the daemon's words under the field, and she can paste another", async () => {
    const joinPreview = vi
      .fn<(code: string) => Promise<JoinPreview>>()
      .mockRejectedValueOnce(new Error('This invite link has expired or was already used. Ask for a new one.'))
      .mockResolvedValueOnce(preview);
    render(<Join api={fakeApi({ joinPreview })} mode="join" />);
    await paste(`https://us.example.com/p/join#c=${CODE}`);
    expect((await screen.findByRole('alert')).textContent).toBe('This invite link has expired or was already used. Ask for a new one.');
    expect(screen.getByLabelText('Paste your invite link')).toBeTruthy();
    expect(location.hash).toBe('');
    await paste(`https://us.example.com/p/join#c=${CODE}2`);
    expect(await screen.findByRole('heading', { name: 'Accountability partner' })).toBeTruthy();
    expect(joinPreview).toHaveBeenLastCalledWith(`${CODE}2`);
  });

  it('a link that still has its code shows the preview at once, as before', async () => {
    history.replaceState(null, '', `/p/join#c=${CODE}`);
    const joinPreview = vi.fn(async () => preview);
    render(<Join api={fakeApi({ joinPreview })} mode="join" />);
    expect(await screen.findByRole('heading', { name: 'Accountability partner' })).toBeTruthy();
    expect(screen.queryByLabelText('Paste your invite link')).toBeNull();
    expect(joinPreview).toHaveBeenCalledTimes(1);
  });
});

describe('/p/join: the link opened again in the same tab (0.12.1 after review)', () => {
  beforeEach(() => history.replaceState(null, '', '/p/join'));

  it('the paste page follows a new #c= in the address to its preview', async () => {
    const joinPreview = vi.fn(async () => preview);
    render(<Join api={fakeApi({ joinPreview })} mode="join" />);
    expect(await screen.findByRole('heading', { name: 'Open your invite link once more' })).toBeTruthy();
    expect(joinPreview).not.toHaveBeenCalled();
    await openAgain(`#c=${CODE}`);
    expect(await screen.findByRole('heading', { name: 'Accountability partner' })).toBeTruthy();
    expect(joinPreview).toHaveBeenCalledTimes(1);
    expect(joinPreview).toHaveBeenCalledWith(CODE);
    expect(screen.queryByLabelText('Paste your invite link')).toBeNull();
  });

  it("a spent link's page follows a fresh link opened in the same tab (popstate too)", async () => {
    history.replaceState(null, '', `/p/join#c=${CODE}`);
    const joinPreview = vi
      .fn<(code: string) => Promise<JoinPreview>>()
      .mockRejectedValueOnce(new Error('This invite link has expired or was already used. Ask for a new one.'))
      .mockResolvedValueOnce(preview);
    render(<Join api={fakeApi({ joinPreview })} mode="join" />);
    expect(await screen.findByRole('heading', { name: "This link doesn't work" })).toBeTruthy();
    await openAgain(`#c=${CODE}2`, 'popstate');
    expect(await screen.findByRole('heading', { name: 'Accountability partner' })).toBeTruthy();
    expect(joinPreview).toHaveBeenLastCalledWith(`${CODE}2`);
  });

  it('a preview on show stays put when the address changes', async () => {
    history.replaceState(null, '', `/p/join#c=${CODE}`);
    const joinPreview = vi.fn(async () => preview);
    render(<Join api={fakeApi({ joinPreview })} mode="join" />);
    expect(await screen.findByRole('heading', { name: 'Accountability partner' })).toBeTruthy();
    await openAgain(`#c=${CODE}2`);
    expect(screen.getByRole('heading', { name: 'Accountability partner' })).toBeTruthy();
    expect(joinPreview).toHaveBeenCalledTimes(1);
  });
});

describe('/p/join without a code on a device that is in already (0.12.1 after review)', () => {
  beforeEach(() => history.replaceState(null, '', '/p/join'));

  it('goes on to her Today, in place of the join page (Back does not return to it)', async () => {
    const joinPreview = vi.fn(async () => preview);
    const popped = vi.fn();
    addEventListener('popstate', popped);
    const before = history.length;
    render(<Join api={fakeApi({ joinPreview, me: vi.fn(async () => asha) })} mode="join" />);
    await waitFor(() => expect(location.pathname).toBe('/p'));
    removeEventListener('popstate', popped);
    expect(popped).toHaveBeenCalled();
    expect(history.length).toBe(before);
    expect(screen.queryByText(/Open your invite link once more/)).toBeNull();
    expect(screen.queryByLabelText('Paste your invite link')).toBeNull();
    expect(joinPreview).not.toHaveBeenCalled();
  });

  it('a reload during her first steps goes back to them (the address keeps the step)', async () => {
    history.replaceState(null, '', '/p/join?step=notify');
    render(<Join api={fakeApi({ me: vi.fn(async () => asha) })} mode="join" />);
    expect(await screen.findByRole('heading', { name: 'Turn on notifications' })).toBeTruthy();
    expect(screen.getByText(/alerts from Sam come as notifications/)).toBeTruthy();
    expect(location.pathname).toBe('/p/join');
  });

  it('on an iPhone, step 1 after a reload, then Next keeps step 2 in the address', async () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1');
    try {
      history.replaceState(null, '', '/p/join?step=home');
      render(<Join api={fakeApi({ me: vi.fn(async () => asha) })} mode="join" />);
      expect(await screen.findByRole('heading', { name: 'Step 1 of 2: Add to your Home Screen' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(await screen.findByRole('heading', { name: 'Step 2 of 2: Turn on notifications' })).toBeTruthy();
      expect(location.search).toBe('?step=notify');
    } finally {
      ua.mockRestore();
    }
  });

  it('a device that is not in gets the paste page, a step in the address or not', async () => {
    for (const at of ['/p/join', '/p/join?step=notify']) {
      history.replaceState(null, '', at);
      const me = notJoined();
      const { unmount } = render(<Join api={fakeApi({ me })} mode="join" />);
      expect(await screen.findByLabelText('Paste your invite link')).toBeTruthy();
      expect(me).toHaveBeenCalledTimes(1);
      expect(location.pathname).toBe('/p/join');
      unmount();
    }
  });

  it('after Accept and join, a reload finds the first step again', async () => {
    history.replaceState(null, '', `/p/join#c=${CODE}`);
    const join = vi.fn(async () => joined);
    const first = render(<Join api={fakeApi({ joinPreview: vi.fn(async () => preview), join })} mode="join" />);
    fireEvent.click(await screen.findByLabelText("I'm 18 or older"));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept and join' }));
    });
    expect(await screen.findByRole('heading', { name: 'Turn on notifications' })).toBeTruthy();
    expect(`${location.pathname}${location.search}${location.hash}`).toBe('/p/join?step=notify');
    first.unmount();
    // The reload: no code in the address, and the device is in now.
    render(<Join api={fakeApi({ me: vi.fn(async () => asha) })} mode="join" />);
    expect(await screen.findByRole('heading', { name: 'Turn on notifications' })).toBeTruthy();
    expect(screen.queryByLabelText('Paste your invite link')).toBeNull();
  });
});
