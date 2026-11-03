/**
 * 0.12.1: the join page without its code. Signing in to Access with the
 * one-time PIN brings her to /p/join without the `#c=`; the page says she is
 * signed in and to open the link once more, or paste it. A pasted link loads
 * the same preview, junk says so, and nothing joins before Accept and join.
 * Synthetic people (Sam and Asha) and codes.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { JoinPreview } from '@jantar/protocol/people';
import type { PersonApi } from '../../src/partner/api.js';
import { Join, NOT_AN_INVITE } from '../../src/partner/screens/Join.js';

const CODE = 'synthetic-invite_code1';
const preview = { owner: 'Sam', name: 'Asha', version: 1, offer: presetAgreement('standard'), fields: [], built: 'P4', modules: { food: false } } as unknown as JoinPreview;

function fakeApi(over: Partial<PersonApi> = {}): PersonApi {
  const base: Partial<PersonApi> = {};
  return new Proxy(base as PersonApi, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

const paste = (text: string) => {
  fireEvent.change(screen.getByLabelText('Paste your invite link'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
};

describe('/p/join without its code (after a one-time PIN sign-in)', () => {
  beforeEach(() => history.replaceState(null, '', '/p/join'));

  it('says she is signed in and to open the link once more, or paste it; nothing is asked of the daemon yet', () => {
    const joinPreview = vi.fn(async () => preview);
    const join = vi.fn(async () => ({}));
    render(<Join api={fakeApi({ joinPreview, join })} mode="join" />);
    expect(screen.getByRole('heading', { name: 'Open your invite link once more' })).toBeTruthy();
    expect(screen.getByText(/You're signed in\. Signing in drops the part of the link that holds your invite, so open the link you were sent once more, or paste it here\./)).toBeTruthy();
    expect(screen.getByLabelText('Paste your invite link')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    expect(joinPreview).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it('a pasted link loads the preview; only Accept and join joins, and the code leaves the address', async () => {
    const joinPreview = vi.fn(async () => preview);
    const join = vi.fn(async () => ({ personId: '01JASHAAAAAAAAAAAAAAAAAAAA', deviceId: '01JDEVICEAAAAAAAAAAAAAAAAA', deviceSecret: 's' }));
    render(<Join api={fakeApi({ joinPreview, join })} mode="join" />);
    paste(`  https://us.example.com/p/join#c=${CODE}\n`);
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
  });

  it('the code alone works too', async () => {
    const joinPreview = vi.fn(async () => preview);
    render(<Join api={fakeApi({ joinPreview })} mode="join" />);
    paste(CODE);
    expect(await screen.findByRole('heading', { name: 'Accountability partner' })).toBeTruthy();
    expect(joinPreview).toHaveBeenCalledWith(CODE);
  });

  it('junk says so in plain words and asks the daemon nothing', () => {
    const joinPreview = vi.fn(async () => preview);
    const join = vi.fn(async () => ({}));
    render(<Join api={fakeApi({ joinPreview, join })} mode="join" />);
    for (const junk of ['hello', 'https://us.example.com/p/join', 'https://us.example.com/p/join#c=short']) {
      paste(junk);
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
    paste(`https://us.example.com/p/join#c=${CODE}`);
    expect((await screen.findByRole('alert')).textContent).toBe('This invite link has expired or was already used. Ask for a new one.');
    expect(screen.getByLabelText('Paste your invite link')).toBeTruthy();
    expect(location.hash).toBe('');
    paste(`https://us.example.com/p/join#c=${CODE}2`);
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
