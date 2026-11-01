/**
 * v0.6 Fleet on the session screen (spec 0.4, 0.8, 0.9 and 6): a server's
 * session says where it runs ("build-1 · Linux · tmux"), takes its switches
 * from that machine (no Picture, Files or Rewrite there), and offers the
 * composer, keypad and control bar only where Jantar can type; otherwise
 * the one fixed line for why: not in tmux, Windows watch-only, a watch-only
 * machine, offline. Its cards carry the Mac's name for the machine, say
 * when their input was too large, and are off while it is offline. Show on
 * Mac shows where there is a Terminal window to raise. Every call stays
 * keyed by the session or card. The Mac's own sessions are as before.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FLEET_COPY } from '@jantar/protocol';
import { nodeCard } from '@jantar/fixtures';
import { account, fakeApi, pending, renderApp, session } from './helpers.js';
import { fleetState, preloadCards, SID } from './fleet-helpers.js';

preloadCards();

/** Every v0.3 to v0.5 switch on at the Mac: none of them may reach a server's session. */
const MAC_ON = { controls: true, clearDraft: true, escape: true, files: true, rewrite: true, screenshots: true, launch: true } as const;
const open = (sid: string, api = fakeApi(), parts: Parameters<typeof fleetState>[0] = {}) =>
  renderApp({ path: `/s/${sid}`, api, state: fleetState({ features: MAC_ON, ...parts }) });
const prompt = () => screen.queryByLabelText('Prompt for Claude');
const card = () => screen.getByRole('article');
const where = () => document.querySelector<HTMLElement>('[data-machine-line]');

describe("a server's session", () => {
  it('says where it runs under the header, and offers what its machine allows', async () => {
    const api = fakeApi();
    open(SID.work, api);
    expect(where()?.textContent).toBe('build-1 · Linux · tmux');
    // In tmux: the composer and the control bar.
    expect(prompt()).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Controls' })).toBeTruthy();
    // The Mac's Files, Rewrite and Picture are the Mac's own.
    expect(screen.queryByRole('tab', { name: /^Files/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Rewrite/ })).toBeNull();
    // Clear draft is the server's own switch (off there until verified on tmux).
    expect(screen.queryByRole('button', { name: /Clear draft/ })).toBeNull();
    // Its account is its own: "work", not the Mac's.
    expect(document.body.textContent).toContain('work');
    // No window to raise for a tmux pane.
    expect((screen.getByRole('button', { name: 'Show on Mac' }) as HTMLButtonElement).disabled).toBe(true);

    // Sends stay keyed by the session: the Mac knows where it runs.
    fireEvent.change(prompt()!, { target: { value: 'run the tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalled());
    expect(api.sendPrompt.mock.calls[0]?.[0]).toBe(SID.work);
  });

  it('reads its screen only where there is one; the Screen tab says why not', async () => {
    const api = fakeApi();
    const { unmount } = open(SID.windows, api);
    fireEvent.click(screen.getByRole('tab', { name: 'Screen' }));
    const panel = await screen.findByRole('tabpanel', { name: 'Screen' });
    expect(panel.textContent).toBe(FLEET_COPY.watchOnlyWindows('win-1'));
    unmount();
    open(SID.offline, api);
    fireEvent.click(screen.getByRole('tab', { name: 'Screen' }));
    expect((await screen.findByRole('tabpanel', { name: 'Screen' })).textContent).toBe(FLEET_COPY.offline('build-3'));
    expect(api.getScreen).not.toHaveBeenCalled();
  });

  const cases = [
    { name: 'started outside tmux', sid: SID.noPane, line: FLEET_COPY.notInTmux('build-1'), at: 'build-1 · Linux · tmux' },
    { name: 'on native Windows', sid: SID.windows, line: FLEET_COPY.watchOnlyWindows('win-1'), at: 'win-1 · Windows · watch' },
    { name: 'on a watch-only machine', sid: SID.readOnly, line: FLEET_COPY.readOnlyNode('ro-1'), at: 'ro-1 · Linux · tmux' },
    { name: 'on an offline machine', sid: SID.offline, line: FLEET_COPY.offline('build-3'), at: 'build-3 · Linux · tmux · offline since 14:02' },
  ];
  for (const c of cases) {
    it(`${c.name}: the fixed line instead of the composer, keys and control bar`, () => {
      open(c.sid);
      expect(where()?.textContent).toBe(c.at);
      expect(prompt()).toBeNull();
      expect(screen.getByText(c.line)).toBeTruthy();
      expect(screen.queryByRole('group', { name: 'Controls' })).toBeNull();
      expect(screen.queryByRole('group', { name: /Keypad|Keys/ })).toBeNull();
    });
  }

  it('on a Mac server: types there, and Show on Mac raises its window', async () => {
    const api = fakeApi();
    open(SID.mac, api);
    expect(where()?.textContent).toBe('mini-1 · macOS · Terminal');
    expect(prompt()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show on Mac' }));
    await waitFor(() => expect(api.focus).toHaveBeenCalledWith(SID.mac));
    expect(await screen.findByText('Brought the tab to the front on mini-1')).toBeTruthy();
  });
});

describe("a server's cards", () => {
  it("are headed with the Mac's name for the machine, and answered by card id", async () => {
    const api = fakeApi();
    open(SID.tmux, api);
    expect(within(card()).getByRole('heading').textContent).toBe('build-1 asks · Permission · Bash');
    fireEvent.click(within(card()).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalled());
    expect(api.decide.mock.calls[0]?.[0]).toBe(nodeCard({ sid: SID.tmux }).id);
  });

  it('say when the input was too large to send here (the Mac cut it to {})', () => {
    const big = nodeCard({ sid: SID.work, id: '01JF1EETCARDB1G000000000AAbbCCddEEffGGhh01', input: {} });
    open(SID.work, fakeApi(), { pending: [big] });
    expect(within(card()).getByText(FLEET_COPY.cardTooLarge('build-1'))).toBeTruthy();
  });

  it('are off while the machine is offline, and say so', () => {
    const c = nodeCard({ sid: SID.offline, id: '01JF1EETCARDOFF000000000AAbbCCddEEffGGhh02' });
    open(SID.offline, fakeApi(), { pending: [c] });
    expect(within(card()).getByText('build-3 is offline')).toBeTruthy();
    expect((within(card()).getByRole('button', { name: 'Yes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("are answerable on native Windows and outside tmux (the hooks answer, nothing is typed)", () => {
    const c = nodeCard({ sid: SID.windows, id: '01JF1EETCARDW1N000000000AAbbCCddEEffGGhh03' });
    open(SID.windows, fakeApi(), { pending: [c] });
    expect(within(card()).getByRole('heading').textContent).toBe('win-1 asks · Permission · Bash');
    expect((within(card()).getByRole('button', { name: 'Yes' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the Mac's own session, with machines paired", () => {
  it('is as before: no machine line, its own account, the composer and the Mac\'s switches', () => {
    open('a', fakeApi(), { sessions: [session('a', { status: 'idle', account: 1 })], accounts: [account(1, { alias: 'main' })] });
    expect(where()).toBeNull();
    expect(prompt()).not.toBeNull();
    expect(screen.getByRole('tab', { name: /^Files/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Show on Mac' }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.body.textContent).toContain('main');
  });

  it("keeps a Mac card's title", () => {
    open('a', fakeApi(), { sessions: [session('a', { status: 'waiting' })], pending: [pending('a')] });
    expect(within(card()).getByRole('heading').textContent).toBe('Permission · Bash');
  });
});
