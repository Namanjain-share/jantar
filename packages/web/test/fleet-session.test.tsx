/**
 * v0.6 Fleet on the session screen (spec 0.4, 0.8, 0.9 and 6): a server's
 * session says where it runs ("build-1 · Linux · tmux"), takes its switches
 * from that machine (no Picture, Files or Rewrite there), and offers the
 * composer, keypad and control bar only where Jantar can type; otherwise
 * the one fixed line for why: not in tmux, Windows watch-only, a watch-only
 * machine, offline. Its cards carry the Mac's name for the machine, say
 * when their input was too large, and are off while it is offline. Show on
 * Mac shows where there is a Terminal window to raise. Every call stays
 * keyed by the session or card. Its terminal dialog follows the server's
 * own Controls switch, and names the machine in the dock's own words only.
 * The Mac's own sessions are as before.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_COPY, type TerminalDialog } from '@jantar/protocol';
import { nodeCard } from '@jantar/fixtures';
import { ApiError, type Api } from '../src/lib/api.js';
import { TAP_GUARD_MS } from '../src/ui/screens/session/answer.js';
import { cardMachine, machineLine, screenReadable, tooLarge } from '../src/ui/screens/session/Info.js';
import { BLOCKED, PLAN_PARTIAL, atMachine, blocksLine, controlsOffOn, peekOf } from '../src/ui/screens/session/TermDialog.js';
import fixtures from './term-dialog-fixtures.json';
import { account, fakeApi, iso, NOW, pending, renderApp, session } from './helpers.js';
import { fleetState, IDS, preloadCards, SID } from './fleet-helpers.js';

preloadCards();

afterEach(() => vi.useRealTimers());

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

  it('waiting where nothing can be typed or read: the dock says what waits, and why', () => {
    const api = fakeApi();
    const s = fleetState({ features: MAC_ON });
    s.sessions[SID.noPane] = { ...s.sessions[SID.noPane]!, status: 'waiting', statusSince: iso(0) };
    const { unmount } = renderApp({ path: `/s/${SID.noPane}`, api, state: s });
    expect(within(card()).getByRole('heading').textContent).toBe('Claude is waiting in the terminal');
    expect(within(card()).getByText(FLEET_COPY.notInTmux('build-1'))).toBeTruthy();
    expect(prompt()).toBeNull();
    expect(screen.queryByRole('group', { name: /Keypad|Keys/ })).toBeNull();
    unmount();

    // A subagent's ask on native Windows: which tool waits, and that it is answered there.
    const w = fleetState({ features: MAC_ON, pending: [pending(SID.windows, { kind: 'subagent-info', tool: 'Bash', agentId: 'agent-1' })] });
    renderApp({ path: `/s/${SID.windows}`, api, state: w });
    expect(within(card()).getByRole('heading').textContent).toBe('A subagent asks · Bash');
    expect(within(card()).getByText('A subagent is waiting in the terminal (Bash).')).toBeTruthy();
    expect(within(card()).getByText(FLEET_COPY.watchOnlyWindows('win-1'))).toBeTruthy();
    expect(prompt()).toBeNull();
    expect(api.getScreen).not.toHaveBeenCalled();
  });

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

  it('a plan with no plan text sends you to read it on that machine, cut or not', async () => {
    const plan = nodeCard({ sid: SID.mac, id: '01JF1EETCARDP1AN00000000AAbbCCddEEffGGhh05', kind: 'plan', tool: 'ExitPlanMode', input: {} });
    const api = fakeApi();
    open(SID.mac, api, { pending: [plan] });
    expect(within(card()).getByRole('heading').textContent).toBe('mini-1 asks · Plan');
    expect(within(card()).getByText(/doesn't carry the plan\. Read it at mini-1 before you approve\./u)).toBeTruthy();
    expect(within(card()).queryByText(FLEET_COPY.cardTooLarge('mini-1'))).toBeNull();
    fireEvent.click(within(card()).getByRole('button', { name: 'Show on mini-1' }));
    await waitFor(() => expect(api.focus).toHaveBeenCalledWith(SID.mac));
  });

  it('only a permission reads an empty input as cut: a plan or question says what it lacks itself', () => {
    const m = { name: 'build-1', blocked: null };
    expect(tooLarge({ kind: 'permission', input: {} }, m)).toBe(true);
    expect(tooLarge({ kind: 'permission', input: { command: 'ls' } }, m)).toBe(false);
    expect(tooLarge({ kind: 'plan', input: {} }, m)).toBe(false);
    expect(tooLarge({ kind: 'question', input: {} }, m)).toBe(false);
    // The Mac's own cards are never cut.
    expect(tooLarge({ kind: 'permission', input: {} }, undefined)).toBe(false);
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

describe('S19: a server cannot pass for the Mac', () => {
  it('a session and card named "Mac" still carry the name the Mac gave the machine', () => {
    const fake = { sid: '7a1c0000-0000-4000-8000-0000000000aa', folder: 'Mac', name: 'Mac', node: IDS.build1 };
    const c = nodeCard({ sid: fake.sid, id: '01JF1EETCARDMAC000000000AAbbCCddEEffGGhh04', tool: 'Mac' });
    const s = fleetState({ features: MAC_ON, pending: [c] });
    s.sessions[fake.sid] = { ...s.sessions[SID.tmux]!, ...fake, paneId: '%8', status: 'waiting' };
    const { unmount } = renderApp({ path: '/', state: s });
    const chip = document.querySelector(`a[data-sid="${fake.sid}"] [data-machine]`);
    expect(chip?.textContent).toBe('build-1');
    unmount();
    renderApp({ path: `/s/${fake.sid}`, state: s });
    expect(where()?.textContent).toBe('build-1 · Linux · tmux');
    expect(within(card()).getByRole('heading').textContent).toBe('build-1 asks · Permission · Mac');
  });
});

describe('the words', () => {
  it("read a screen only where there is one: the Mac's, a pane on tmux, a Mac server's; online", () => {
    const s = fleetState();
    const at = (sid: string) => s.sessions[sid]!;
    expect(screenReadable(s, session('a'))).toBe(true);
    expect(screenReadable(s, at(SID.tmux))).toBe(true);
    expect(screenReadable(s, at(SID.mac))).toBe(true);
    // A watch-only machine's screen still reads; nothing is typed there.
    expect(screenReadable(s, at(SID.readOnly))).toBe(true);
    expect(screenReadable(s, { ...at(SID.readOnly), paneId: undefined })).toBe(false);
    expect(screenReadable(s, at(SID.noPane))).toBe(false);
    expect(screenReadable(s, at(SID.windows))).toBe(false);
    expect(screenReadable(s, at(SID.offline))).toBe(false);
    expect(screenReadable(s, { node: 'unknown', paneId: '%1' })).toBe(false);
  });

  it("name the machine: the session's line, and its cards (off while offline or watch-only)", () => {
    const s = fleetState();
    expect(machineLine(s, session('a'), NOW)).toBeNull();
    expect(machineLine(s, { node: IDS.build2 }, NOW)).toBe('build-2 · Linux (WSL) · tmux');
    expect(machineLine(s, { node: 'unknown' }, NOW)).toBe('a server');
    expect(cardMachine(s, session('a'))).toBeUndefined();
    expect(cardMachine(s, s.sessions[SID.tmux]!)).toEqual({ name: 'build-1', blocked: null });
    expect(cardMachine(s, s.sessions[SID.noPane]!)).toEqual({ name: 'build-1', blocked: null });
    expect(cardMachine(s, s.sessions[SID.offline]!)).toEqual({ name: 'build-3', blocked: 'build-3 is offline' });
    expect(cardMachine(s, s.sessions[SID.readOnly]!)).toEqual({ name: 'ro-1', blocked: FLEET_COPY.readOnlyNode('ro-1') });
  });
});

describe("a server's terminal dialog", () => {
  const PERM = (fixtures as unknown as Record<string, { dialog: TerminalDialog }>).PERM_WORKFLOW_133!.dialog;

  it('says the machine where the dock says "the Mac", and offers no window to raise on tmux', async () => {
    const getScreen = vi.fn(async (_sid: string, _lines?: number) => ({ text: 'synthetic terminal text', lines: 40, at: iso(0), backend: 'tmux', screenKey: 'a'.repeat(64), dialog: { ...PERM, blocksIn: '1:30' } }));
    const s = fleetState({ features: MAC_ON });
    s.sessions[SID.work] = { ...s.sessions[SID.work]!, status: 'waiting' };
    renderApp({ path: `/s/${SID.work}`, api: fakeApi({ getScreen }), state: s });
    // The dock is its own chunk.
    const choices = await screen.findByRole('group', { name: 'Choices' }, { timeout: 10_000 });
    const dock = choices.closest('article')!;
    // Headed with the Mac's name for the machine, as its hook cards are.
    expect(within(dock).getByRole('heading').textContent).toMatch(/^build-1 asks · /u);
    expect(dock.textContent).toMatch(/Claude blocks this at build-1 in /u);
    expect(dock.textContent).not.toMatch(/the Mac/u);
    expect(within(dock).queryByRole('button', { name: /^Show on/u })).toBeNull();
    expect(getScreen.mock.calls[0]?.[0]).toBe(SID.work);
  });

  /** build-1's work session waiting on `dialog`, with these switches on the Mac and on build-1. */
  const openDialog = (dialog: TerminalDialog, opts: { macControls?: boolean; serverControls?: boolean; sessionDialog?: Api['sessionDialog'] } = {}) => {
    const getScreen = vi.fn(async (_sid: string, _lines?: number) => ({ text: 'synthetic terminal text', lines: 40, at: iso(0), backend: 'tmux', screenKey: 'a'.repeat(64), dialog }));
    const s = fleetState({ features: { ...MAC_ON, controls: opts.macControls ?? true } });
    s.sessions[SID.work] = { ...s.sessions[SID.work]!, status: 'waiting' };
    s.nodes![IDS.build1] = { ...s.nodes![IDS.build1]!, features: { ...s.nodes![IDS.build1]!.features, controls: opts.serverControls ?? true } };
    const api = fakeApi({ getScreen, ...(opts.sessionDialog ? { sessionDialog: opts.sessionDialog } : {}) });
    return renderApp({ path: `/s/${SID.work}`, api, state: s });
  };
  const dockOf = async () => (await screen.findByRole('group', { name: 'Choices' }, { timeout: 10_000 })).closest('article') as HTMLElement;
  const rowButtons = (dock: HTMLElement) => within(within(dock).getByRole('group', { name: 'Choices' })).getAllByRole('button') as HTMLButtonElement[];

  it("leaves the terminal's own text and the Mac's errors as they were said", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sessionDialog = vi.fn().mockRejectedValue(new ApiError('network', 'offline', 0));
    openDialog({ ...PERM, question: 'Edit the Mac build script?' }, { sessionDialog });
    const dock = await dockOf();
    expect(within(dock).getByText('Edit the Mac build script?')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TAP_GUARD_MS);
    });
    fireEvent.click(rowButtons(dock)[0]!);
    // The phone can't reach the Mac: that error is the Mac's, never the server's.
    expect((await within(dock).findByRole('alert')).textContent).toBe('Could not reach the Mac. Check the connection and try again.');
    expect(sessionDialog.mock.calls[0]?.[0]).toBe(SID.work);
  });

  it("is answered under the server's own Controls switch, not the Mac's", async () => {
    // Controls off on build-1, on at the Mac: the server would refuse, so the rows are off and say why.
    const { unmount } = openDialog(PERM, { serverControls: false });
    let dock = await dockOf();
    expect(within(dock).getByText(controlsOffOn('build-1'))).toBeTruthy();
    expect(rowButtons(dock).every((b) => b.disabled)).toBe(true);
    unmount();

    // Off at the Mac, on at build-1: nothing stops the answer here.
    openDialog(PERM, { macControls: false });
    dock = await dockOf();
    expect(within(dock).queryByText(/Controls are off/u)).toBeNull();
    await waitFor(() => expect(rowButtons(dock).some((b) => !b.disabled)).toBe(true));
  });

  it('names the machine in the folded peek before the question, never inside it', () => {
    const at = (t: string) => atMachine(t, 'build-1');
    const { blocksIn: _blocksIn, ...still } = PERM;
    const asked = { ...still, question: 'Edit the Mac build script?' };
    expect(peekOf({ ...asked, blocksIn: '1:30' }, 0, at)).toBe('Blocked at build-1 by now · Edit the Mac build script?');
    expect(peekOf({ ...asked, blocksIn: '1:30' }, 0)).toBe('Blocked at the Mac by now · Edit the Mac build script?');
    expect(peekOf({ ...asked, blocksIn: '1:30' }, 75, at)).toBe('1 min 15 s left · Edit the Mac build script?');
    expect(peekOf(asked, null, at)).toBe('Edit the Mac build script?');
    expect(controlsOffOn('build-1')).toBe('Controls are off on build-1. Turn them on there: jantar controls on');
  });

  it("keeps the Mac's own words for the Mac's sessions", () => {
    expect(atMachine(BLOCKED, undefined)).toBe(BLOCKED);
    expect(atMachine(BLOCKED, null)).toBe(BLOCKED);
    expect(atMachine(blocksLine('2 min'), 'build-1')).toBe('Claude blocks this at build-1 in 2 min if nobody answers');
    expect(atMachine(PLAN_PARTIAL, 'mini-1')).toBe('mini-1 shows only part of this plan. Read the rest at mini-1 before you approve.');
    // "your Mac" names the Mac's own switch: never rewritten.
    expect(atMachine('Turn them on at your Mac', 'build-1')).toBe('Turn them on at your Mac');
  });
});
