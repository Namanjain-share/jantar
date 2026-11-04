/**
 * 0.12.1: the join page without its code. Signing in to Access with the
 * One-time PIN brings her to /p/join without the `#c=`; the page says she is
 * signed in and to open the link once more, or paste it. A pasted link loads
 * the same preview, junk says so, and nothing joins before Accept and join.
 *
 * 0.12.1 after review: the link opened again in the same tab (only the
 * fragment changes) shows its preview; a device that is in already goes on
 * to Today, or back to the first step the address kept after Accept.
 *
 * 0.12.2: /p/link in the words of her Link another device steps. Without a
 * code (a One-time PIN sign-in dropped it) it says to open the link once
 * more, paste it or type its code, and where a link comes from; with one it
 * says the code is filled in. An expired code and five devices show the
 * daemon's words, which say what to do next, and a fresh link opened in the
 * same tab takes their place.
 * Synthetic people (Sam and Asha) and codes.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { JoinPreview, PersonMe } from '@jantar/protocol/people';
import { PersonApiError, type PersonApi } from '../../src/partner/api.js';
import { Join, NOT_AN_INVITE, NOT_A_LINK_CODE } from '../../src/partner/screens/Join.js';

const CODE = 'synthetic-invite_code1';
/** 0.12.2: /p/link's field, by its visible label. */
const LINK_FIELD = 'Paste the link or type the code';
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

describe('/p/join without its code (after a One-time PIN sign-in)', () => {
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

describe('the paste form, to a screen reader (0.12.1 after review)', () => {
  beforeEach(() => history.replaceState(null, '', '/p/join'));

  it('the field is invalid and described by the error, and the same error twice is a new alert', async () => {
    render(<Join api={fakeApi({ joinPreview: vi.fn(async () => preview) })} mode="join" />);
    const field = await screen.findByLabelText('Paste your invite link');
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(field.getAttribute('aria-describedby')).toBeNull();
    await paste('hello');
    const first = screen.getByRole('alert');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(first.id);
    expect(first.id).not.toBe('');
    await paste('hello again');
    const second = screen.getByRole('alert');
    expect(second.textContent).toBe(NOT_AN_INVITE);
    // A new node, so it is announced again.
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(field.getAttribute('aria-describedby')).toBe(second.id);
  });

  it('the paste, name and link-code fields are 16 px (type-input), so iPhone Safari does not zoom in', async () => {
    const { unmount } = render(<Join api={fakeApi({ joinPreview: vi.fn(async () => preview) })} mode="join" />);
    expect((await screen.findByLabelText('Paste your invite link')).classList.contains('type-input')).toBe(true);
    await paste(CODE);
    expect((await screen.findByLabelText('Your name')).classList.contains('type-input')).toBe(true);
    unmount();
    render(<Join api={fakeApi()} mode="link" />);
    expect(screen.getByLabelText(LINK_FIELD).classList.contains('type-input')).toBe(true);
  });

  it('says Loading… while the preview loads', async () => {
    let answer: (p: JoinPreview) => void = () => undefined;
    const joinPreview = vi.fn(() => new Promise<JoinPreview>((r) => (answer = r)));
    render(<Join api={fakeApi({ joinPreview })} mode="join" />);
    await paste(CODE);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer(preview));
    expect(await screen.findByRole('heading', { name: 'Accountability partner' })).toBeTruthy();
  });
});

describe('/p/link reads the code like a pasted invite (0.12.1 after review)', () => {
  beforeEach(() => history.replaceState(null, '', '/p/link'));
  const claim = async (text: string) => {
    fireEvent.change(screen.getByLabelText(LINK_FIELD), { target: { value: text } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link this device' }));
    });
  };

  it('the whole /p/link#c= link, a wrapped one and the code alone all link with the code', async () => {
    for (const text of [`https://us.example.com/p/link#c=${CODE}`, `https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fus.example.com%2Fp%2Flink%23c%3D${CODE}&reserved=0`, ` "${CODE}" `]) {
      const linkClaim = vi.fn(async () => joined);
      const { unmount } = render(<Join api={fakeApi({ linkClaim })} mode="link" />);
      await claim(text);
      expect(linkClaim, text).toHaveBeenCalledWith(CODE, 'Phone');
      unmount();
      history.replaceState(null, '', '/p/link');
    }
  });

  it('junk says so, tied to the field, and claims nothing', async () => {
    const linkClaim = vi.fn(async () => joined);
    render(<Join api={fakeApi({ linkClaim })} mode="link" />);
    await claim('this is not a code at all');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(NOT_A_LINK_CODE);
    expect(screen.getByLabelText(LINK_FIELD).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText(LINK_FIELD).getAttribute('aria-describedby')).toBe(alert.id);
    expect(linkClaim).not.toHaveBeenCalled();
  });

  it('a link opened again in the same tab fills in its code', async () => {
    render(<Join api={fakeApi()} mode="link" />);
    expect((screen.getByLabelText(LINK_FIELD) as HTMLInputElement).value).toBe('');
    await act(async () => {
      history.replaceState(null, '', `/p/link#c=${CODE}`);
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect((screen.getByLabelText(LINK_FIELD) as HTMLInputElement).value).toBe(CODE);
  });
});

describe('/p/link in the words of the Link another device steps (0.12.2)', () => {
  beforeEach(() => history.replaceState(null, '', '/p/link'));
  const claim = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link this device' }));
    });
  };
  // The daemon's words (packages/daemon/src/life/people/module.ts PEOPLE_REASONS).
  const EXPIRED = 'This link has expired or was already used. On a device that is linked already, open Me › Devices › Link another device for a new one, and use it within 15 minutes.';
  const FULL_HERE = 'Five devices are linked already, the most there can be. On one of them, open Me › Devices and revoke one you no longer use, then link this device again.';

  it('without a code (a One-time PIN sign-in dropped it): open the link once more, paste it or type its code, and where a link comes from', () => {
    render(<Join api={fakeApi()} mode="link" />);
    expect(screen.getByRole('heading', { name: 'Link this device' })).toBeTruthy();
    expect(
      screen.getByText('Signing in with a code from your email drops the part of the link that holds its code. Open the link from your other device once more, or paste it here, or type the code shown with it.'),
    ).toBeTruthy();
    expect(screen.getByText('No link yet? On a device that is linked already, open Me › Devices › Link another device. A link works once, for 15 minutes.')).toBeTruthy();
    const field = screen.getByLabelText(LINK_FIELD) as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.getAttribute('autocapitalize')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
    expect(screen.queryByText(/enter the code here/)).toBeNull();
  });

  it('opened with its code: the code is filled in, and one tap links', async () => {
    history.replaceState(null, '', `/p/link#c=${CODE}`);
    const linkClaim = vi.fn(async () => joined);
    render(<Join api={fakeApi({ linkClaim })} mode="link" />);
    expect(screen.getByText('The code from your other device is filled in. Tap Link this device.')).toBeTruthy();
    expect(screen.queryByText(/No link yet\?/)).toBeNull();
    expect((screen.getByLabelText(LINK_FIELD) as HTMLInputElement).value).toBe(CODE);
    await claim();
    expect(linkClaim).toHaveBeenCalledWith(CODE, 'Phone');
    await waitFor(() => expect(location.pathname).toBe('/p'));
  });

  it("an expired code shows the daemon's words (make a new one, use it within 15 minutes); the new link opened in the same tab takes over", async () => {
    history.replaceState(null, '', `/p/link#c=${CODE}`);
    const linkClaim = vi.fn<(code: string, name: string) => Promise<typeof joined>>().mockRejectedValueOnce(new PersonApiError('invalid_request', EXPIRED, 400)).mockResolvedValueOnce(joined);
    render(<Join api={fakeApi({ linkClaim })} mode="link" />);
    await claim();
    expect(screen.getByRole('alert').textContent).toBe(EXPIRED);
    expect(screen.getByLabelText(LINK_FIELD).getAttribute('aria-invalid')).toBe('true');
    await act(async () => {
      history.replaceState(null, '', `/p/link#c=${CODE}2`);
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText(LINK_FIELD) as HTMLInputElement).value).toBe(`${CODE}2`);
    await claim();
    expect(linkClaim).toHaveBeenLastCalledWith(`${CODE}2`, 'Phone');
  });

  it("five devices: the daemon's words say to revoke one on a linked device, then link this one again", async () => {
    const linkClaim = vi.fn(async () => Promise.reject(new PersonApiError('conflict', FULL_HERE, 409)));
    render(<Join api={fakeApi({ linkClaim })} mode="link" />);
    fireEvent.change(screen.getByLabelText(LINK_FIELD), { target: { value: `https://us.example.com/p/link#c=${CODE}` } });
    await claim();
    expect(linkClaim).toHaveBeenCalledWith(CODE, 'Phone');
    expect(screen.getByRole('alert').textContent).toBe(FULL_HERE);
    expect(location.pathname).toBe('/p/link');
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

  it('a device that is in already and opens its spent link goes on to Today', async () => {
    history.replaceState(null, '', `/p/join#c=${CODE}`);
    const spent = vi.fn(async (): Promise<JoinPreview> => {
      throw new PersonApiError('not_found', 'This invite link has expired or was already used. Ask for a new one.', 404);
    });
    render(<Join api={fakeApi({ joinPreview: spent, me: vi.fn(async () => asha) })} mode="join" />);
    await waitFor(() => expect(location.pathname).toBe('/p'));
    expect(screen.queryByText(/expired or was already used/)).toBeNull();
  });

  it('a device that is not in and opens a spent link still reads why', async () => {
    history.replaceState(null, '', `/p/join#c=${CODE}`);
    const spent = vi.fn(async (): Promise<JoinPreview> => {
      throw new PersonApiError('not_found', 'This invite link has expired or was already used. Ask for a new one.', 404);
    });
    render(<Join api={fakeApi({ joinPreview: spent })} mode="join" />);
    expect(await screen.findByText('This invite link has expired or was already used. Ask for a new one.')).toBeTruthy();
    expect(location.pathname).toBe('/p/join');
  });
});
