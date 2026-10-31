/**
 * W3: the launch receipt and its dialog card (spec 5.3.4, decision U8)
 * against the fake API and the event stream: loading, the stage rows, the
 * trust card (answered only by a tap, with the title it showed), every
 * failure with its one way out, success, offline, and the stage words that
 * keep every state apart without colour.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaunchStageSchema, type DaemonEvent, type LaunchJob, type State } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import type { AppStore } from '../src/store.js';
import { ghostWord, hms, stepWord } from '../src/ui/screens/launch/stages.js';
import { keepPrompt, takePrompt } from '../src/ui/screens/new/data.js';
import { emit, iso, renderApp, session, stateWith } from './helpers.js';
import { job, launchApi, steps, viewport } from './launch-fixtures.js';

const ON = { launch: true } as const;
const RECEIPT = '/new?root=r.1&path=api&launch=L1';

function stateWithLaunch(j?: LaunchJob, extra: Parameters<typeof stateWith>[0] = {}): State {
  const s = stateWith({ features: ON, ...extra });
  if (j) s.launches[j.id] = j;
  return s;
}

/** A launch.progress event with the store's next seq, as the WebSocket delivers it. */
const progress = (store: AppStore, j: LaunchJob): DaemonEvent =>
  ({ seq: store.getState().state.seq + 1, ts: j.updatedAt, type: 'launch.progress', data: { job: j } }) as DaemonEvent;
const stepRows = () => Array.from(document.querySelectorAll<HTMLElement>('li[data-step]')).map((li) => li.textContent);
const receipt = () => screen.getByRole('region', { name: 'Launch' });

const TRUST: LaunchJob = job('L1', {
  stage: 'dialog',
  tty: '/dev/ttys014',
  dialog: { title: 'Trust this folder?', options: ['Yes, I trust this folder', 'No, exit'], current: 0, since: iso(293_000) },
  steps: steps('queued', ['opening', 'ttys014'], ['starting', 'cs 7'], ['dialog', 'Trust this folder?']),
});

afterEach(() => vi.unstubAllGlobals());

describe('receipt: loading and lookup', () => {
  it('reads the launch while it has nothing to show', async () => {
    renderApp({ path: RECEIPT, api: launchApi({ launchGet: vi.fn(() => new Promise<never>(() => undefined)) }), state: stateWithLaunch() });
    const r = await screen.findByRole('region', { name: 'Launch' });
    expect(r.getAttribute('aria-busy')).toBe('true');
    expect(within(r).getByText('reading the launch')).toBeTruthy();
  });

  it('a launch id that names an Object.prototype member is no launch', async () => {
    for (const id of ['constructor', '__proto__', 'toString']) {
      const api = launchApi({ launchGet: vi.fn(async () => Promise.reject(new ApiError('not_found', 'no such launch', 404))) });
      const { unmount } = renderApp({ path: `/new?root=r.1&path=api&launch=${id}`, api, state: stateWithLaunch() });
      expect(await screen.findByText('That launch is no longer here.')).toBeTruthy();
      unmount();
    }
  });

  it('says a launch is gone, and goes back to the folders', async () => {
    const api = launchApi({ launchGet: vi.fn(async () => Promise.reject(new ApiError('not_found', 'no such launch', 404))) });
    const { history } = renderApp({ path: RECEIPT, api, state: stateWithLaunch() });
    expect(await screen.findByText('That launch is no longer here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pick a folder' }));
    expect(history.entries.at(-1)).toBe('/new');
  });

  it('tries again after a network failure', async () => {
    const launchGet = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'fetch failed', 0))
      .mockResolvedValue({ job: job('L1', { stage: 'opening', steps: steps('queued', 'opening') }) });
    renderApp({ path: RECEIPT, api: launchApi({ launchGet }), state: stateWithLaunch() });
    expect(await screen.findByText('Could not reach the Mac. Check the connection and try again.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(stepRows().length).toBe(2));
  });
});

describe('receipt: stages', () => {
  it('lists each step in mono with its time, stage and detail, and follows the event stream', async () => {
    const j = job('L1', { stage: 'starting', tty: '/dev/ttys014', steps: steps('queued', ['opening', 'ttys014'], ['starting', 'cs 7']) });
    const api = launchApi({ launchGet: vi.fn(async () => ({ job: j })) });
    const { store } = renderApp({ path: RECEIPT, api, state: stateWithLaunch(j) });
    await waitFor(() => expect(stepRows().length).toBe(3));
    const t = (ms: number) => hms(iso(290_000 + ms));
    expect(stepRows()).toEqual([`${t(0)}Checked`, `${t(1000)}Opened a windowttys014`, `${t(2000)}Starting on 07cs 7`]);
    expect(within(receipt()).getByRole('heading', { name: 'Start in api' })).toBeTruthy();
    expect(within(receipt()).getByText('~/Desktop/work/api · api')).toBeTruthy();
    // No way out yet while it starts.
    expect(within(receipt()).queryByRole('button')).toBeNull();
    const ready = { ...j, stage: 'ready' as const, updatedAt: iso(299_000), steps: steps('queued', ['opening', 'ttys014'], ['starting', 'cs 7'], 'ready') };
    act(() => emit(store, [progress(store, ready)]));
    expect(stepRows().at(-1)).toBe(`${t(3000)}Ready`);
    expect(stepRows()[2]).toBe(`${t(2000)}Started on 07cs 7`);
    expect(within(receipt()).getByRole('button', { name: 'Open session' })).toBeTruthy();
  });

  it('says the session really started on another account when its config dir said so', async () => {
    const j = job('L1', { stage: 'ready', actualAccount: 8, steps: steps('queued', 'opening', ['starting', 'cs 7'], 'ready') });
    renderApp({ path: RECEIPT, api: launchApi({ launchGet: vi.fn(async () => ({ job: j })) }), state: stateWithLaunch(j) });
    await waitFor(() => expect(stepRows()[2]).toContain('Started on 08'));
  });

  it('ends with the first prompt delivered, Open session and Show on Mac', async () => {
    const j = job('L1', { stage: 'done', prompt: { hash: 'sha256:x', length: 12, sendJobId: 'S1' }, steps: steps('queued', 'opening', 'starting', 'ready', 'prompting', ['done', 'delivered 10:05']) });
    const api = launchApi({ launchGet: vi.fn(async () => ({ job: j })) });
    const { history, toasts } = renderApp({ path: RECEIPT, api, state: stateWithLaunch(j, { sessions: [session('sid-L1', { status: 'working' })] }) });
    await waitFor(() => expect(stepRows().at(-1)).toContain('First promptdelivered 10:05'));
    expect(within(receipt()).getByLabelText('delivered')).toBeTruthy();
    fireEvent.click(within(receipt()).getByRole('button', { name: 'Show on Mac' }));
    await waitFor(() => expect(api.focus).toHaveBeenCalledWith('sid-L1'));
    await waitFor(() => expect(toasts.getState().toasts.map((t) => t.text)).toContain('Brought the window to the front on the Mac'));
    fireEvent.click(within(receipt()).getByRole('button', { name: 'Open session' }));
    expect(history.entries.at(-1)).toBe('/s/sid-L1');
  });
});

describe('receipt: the trust card (U8)', () => {
  it('shows Claude\'s own question, options and masked screen as text, and answers only on a tap', async () => {
    const launchGet = vi.fn(async () => ({ job: TRUST, screenTail: 'Do you trust the files in this folder?\n<b>x</b> u***@e***.com' }));
    const launchAnswer = vi.fn(async () => ({ job: { ...TRUST, stage: 'starting' as const } }));
    renderApp({ path: RECEIPT, api: launchApi({ launchGet, launchAnswer }), state: stateWithLaunch(TRUST) });
    const card = await waitFor(() => {
      const c = document.querySelector<HTMLElement>('[data-dialog]');
      if (!c) throw new Error('no card');
      return c;
    });
    expect(within(card).getByRole('heading').textContent).toBe('Needs you·Trust this folder?');
    expect(within(card).getByText('Needs you').className).toContain('text-signal-text');
    const tail = await within(card).findByLabelText('The window on the Mac');
    expect(tail.textContent).toBe('Do you trust the files in this folder?\n<b>x</b> u***@e***.com');
    expect(tail.querySelector('b')).toBeNull();
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['Yes, I trust this folder', 'No, exit']);
    await new Promise((r) => setTimeout(r, 50));
    expect(launchAnswer).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Yes, I trust this folder' }));
    await waitFor(() => expect(launchAnswer).toHaveBeenCalledWith('L1', { option: 0, title: 'Trust this folder?' }));
    expect(await within(card).findByText('answered · waiting for Claude')).toBeTruthy();
    expect((within(card).getByRole('button', { name: 'No, exit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reads the launch again for a dialog the stream brings', async () => {
    const opening = job('L1', { stage: 'opening', steps: steps('queued', 'opening') });
    const launchGet = vi.fn().mockResolvedValueOnce({ job: opening }).mockResolvedValue({ job: TRUST, screenTail: 'Trust?' });
    const { store } = renderApp({ path: RECEIPT, api: launchApi({ launchGet }), state: stateWithLaunch(opening) });
    await waitFor(() => expect(launchGet).toHaveBeenCalledTimes(1));
    act(() => emit(store, [progress(store, TRUST)]));
    await waitFor(() => expect(launchGet).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText('The window on the Mac')).toBeTruthy();
  });

  it('says the question changed when the daemon refuses the answer, and reads it again', async () => {
    const launchGet = vi.fn(async () => ({ job: TRUST }));
    const launchAnswer = vi.fn(async () => Promise.reject(new ApiError('conflict', 'the dialog changed', 409)));
    renderApp({ path: RECEIPT, api: launchApi({ launchGet, launchAnswer }), state: stateWithLaunch(TRUST) });
    fireEvent.click(await screen.findByRole('button', { name: 'No, exit' }));
    expect(await screen.findByText('The question on the Mac changed. Check it again.')).toBeTruthy();
    await waitFor(() => expect(launchGet.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('names the Mac command when this device may not answer (no launch scope)', async () => {
    const launchAnswer = vi.fn(async () => Promise.reject(new ApiError('forbidden', 'this device does not have the launch scope', 403)));
    renderApp({ path: RECEIPT, api: launchApi({ launchGet: vi.fn(async () => ({ job: TRUST })), launchAnswer }), state: stateWithLaunch(TRUST) });
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, I trust this folder' }));
    await waitFor(() => expect(document.querySelector('[data-no-scope]')?.textContent).toMatch(/can't start sessions\. On your Mac run jantar devices grant .+ launch\./));
  });

  it('keeps the options off while offline', async () => {
    const launchAnswer = vi.fn();
    renderApp({ path: RECEIPT, api: launchApi({ launchGet: vi.fn(async () => ({ job: TRUST })), launchAnswer }), state: stateWithLaunch(TRUST), status: 'offline' });
    const yes = (await screen.findByRole('button', { name: 'Yes, I trust this folder' })) as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    expect(screen.getByText("Offline: can't answer right now")).toBeTruthy();
    fireEvent.click(yes);
    expect(launchAnswer).not.toHaveBeenCalled();
  });
});

describe('receipt: failures', () => {
  const FAILED = job('L1', {
    stage: 'failed',
    reason: '07 needs a re-login on the Mac (cswap)',
    steps: steps('queued', ['opening', 'ttys014'], ['starting', 'cs 7'], 'failed'),
  });

  it('shows the reason in ember, the masked screen and Try again back to the same folder', async () => {
    const api = launchApi({ launchGet: vi.fn(async () => ({ job: FAILED, screenTail: 'Please run /login' })) });
    const { history } = renderApp({ path: RECEIPT, api, state: stateWithLaunch(FAILED) });
    const reason = await screen.findByText('07 needs a re-login on the Mac (cswap)');
    expect(reason.getAttribute('role')).toBe('alert');
    expect(reason.className).toContain('text-signal-text');
    expect((await screen.findByLabelText('The window on the Mac')).textContent).toBe('Please run /login');
    expect(stepRows().at(-1)).toContain("Didn't start");
    const buttons = within(receipt()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Try again']);
    fireEvent.click(buttons[0]!);
    expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api&start=1&from=L1');
  });

  it('finds the folder for Try again from the root when the link had no path (a ghost row)', async () => {
    const api = launchApi({ launchGet: vi.fn(async () => ({ job: FAILED })) });
    const { history } = renderApp({ path: '/new?root=r.1&launch=L1', api, state: stateWithLaunch(FAILED) });
    await waitFor(() => expect(api.foldersRoots).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api&start=1&from=L1');
  });

  it('Try again starts the form with the failed launch\'s first prompt, Name and account', async () => {
    keepPrompt('L1', 'PROMPT-MARKER fix the login');
    const refused = job('L1', { stage: 'failed', name: 'api-fix', requested: 8, reason: 'No, exit was chosen', steps: steps('queued', 'opening', 'starting', 'dialog', 'failed') });
    const api = launchApi({ launchGet: vi.fn(async () => ({ job: refused })) });
    const { history } = renderApp({ path: RECEIPT, api, state: stateWithLaunch(refused) });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api&start=1&from=L1');
    const form = await screen.findByRole('region', { name: 'Start a session' });
    await waitFor(() => expect((within(form).getByRole('textbox', { name: 'First prompt (optional)' }) as HTMLTextAreaElement).value).toBe('PROMPT-MARKER fix the login'));
    expect((within(form).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('api-fix');
    await waitFor(() => expect(api.launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api', account: 8, name: 'api-fix' }));
    // The text stays out of the URL.
    expect(history.entries.join('\n')).not.toContain('PROMPT-MARKER');
    takePrompt('L1');
  });

  it('offers Show on Mac instead when the window is there with a session in it', async () => {
    const stalled = { ...FAILED, stage: 'stalled' as const, reason: undefined };
    const api = launchApi({ launchGet: vi.fn(async () => ({ job: stalled })) });
    renderApp({ path: RECEIPT, api, state: stateWithLaunch(stalled, { sessions: [session('sid-L1', { status: 'waiting' })] }) });
    expect(await screen.findByText('Nothing moved for 30 minutes. Check the window on the Mac.')).toBeTruthy();
    expect(within(receipt()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Show on Mac']);
  });

  it('with a first prompt never typed, offers it back beside Show on Mac', async () => {
    keepPrompt('L1', 'PROMPT-MARKER fix the login');
    const stalled = { ...FAILED, stage: 'stalled' as const, reason: undefined };
    const api = launchApi({ launchGet: vi.fn(async () => ({ job: stalled })) });
    const { history } = renderApp({ path: RECEIPT, api, state: stateWithLaunch(stalled, { sessions: [session('sid-L1', { status: 'waiting' })] }) });
    await waitFor(() => expect(within(receipt()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Show on Mac', 'Edit and resend']));
    fireEvent.click(within(receipt()).getByRole('button', { name: 'Edit and resend' }));
    expect(history.entries.at(-1)).toBe('/s/sid-L1');
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it('puts an undelivered first prompt back in the session composer, never sending it', async () => {
    keepPrompt('L1', 'PROMPT-MARKER fix the login');
    const failed = job('L1', { stage: 'ready-prompt-failed', steps: steps('queued', 'opening', 'starting', 'ready', 'prompting', 'ready-prompt-failed') });
    const api = launchApi({ launchGet: vi.fn(async () => ({ job: failed })) });
    const { history } = renderApp({ path: RECEIPT, api, state: stateWithLaunch(failed, { sessions: [session('sid-L1', { status: 'idle' })] }) });
    expect(await screen.findByText("The session is running, but the first prompt didn't arrive.")).toBeTruthy();
    // The prompt text itself is never on the receipt.
    expect(receipt().textContent).not.toContain('PROMPT-MARKER');
    expect(within(receipt()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Edit and resend', 'Show on Mac']);
    fireEvent.click(within(receipt()).getByRole('button', { name: 'Edit and resend' }));
    expect(history.entries.at(-1)).toBe('/s/sid-L1');
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('PROMPT-MARKER fix the login'));
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it('offers Open session when the undelivered prompt is no longer in memory', async () => {
    const failed = job('L2', { stage: 'ready-prompt-failed', steps: steps('ready', 'ready-prompt-failed') });
    renderApp({ path: '/new?root=r.1&path=api&launch=L2', api: launchApi({ launchGet: vi.fn(async () => ({ job: failed })) }), state: stateWithLaunch(failed) });
    await waitFor(() => expect(within(receipt()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open session']));
  });
});

describe('receipt: desktop', () => {
  it('fills the detail pane, beside the browser', async () => {
    viewport(1440);
    const j = job('L1', { stage: 'opening', steps: steps('queued', 'opening') });
    const { history } = renderApp({ path: RECEIPT, api: launchApi({ launchGet: vi.fn(async () => ({ job: j })) }), state: stateWithLaunch(j) });
    const pane = screen.getByRole('region', { name: 'Detail' });
    await waitFor(() => expect(within(pane).getByRole('region', { name: 'Launch' })).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(pane).getByRole('button', { name: 'Close' }));
    expect(history.entries.at(-1)).toBe('/new?root=r.1');
  });
});

describe('stage words (status never by colour alone)', () => {
  const stages = LaunchStageSchema.options;
  const j = { account: 7, actualAccount: null };

  it('gives every stage its own word, done and in progress', () => {
    const past = stages.map((s) => stepWord(s, j, false));
    expect(new Set(past).size).toBe(stages.length);
    const now = stages.map((s) => stepWord(s, j, true));
    expect(new Set(now).size).toBe(stages.length);
    expect(stepWord('starting', j, false)).toBe('Started on 07');
  });

  it('names no account with one Claude login, and still tells every stage apart', () => {
    const single = { account: 0, actualAccount: null };
    expect([stepWord('starting', single, true, true), stepWord('starting', single, false, true)]).toEqual(['Starting Claude', 'Started Claude']);
    expect(new Set(stages.map((s) => stepWord(s, single, false, true))).size).toBe(stages.length);
    expect(stages.map((s) => stepWord(s, single, true, true)).join(' ')).not.toMatch(/\b00\b/);
  });

  it('gives every unfinished stage its own ghost-row words', () => {
    const live = ['queued', 'opening', 'starting', 'dialog', 'ready', 'prompting'] as const;
    const words = live.map((stage) => ghostWord({ stage, dialog: stage === 'dialog' ? { title: 'Trust this folder?', options: [], current: 0, since: iso(0) } : undefined }));
    expect(new Set(words).size).toBe(live.length);
    expect(words[3]).toBe('Claude asks: Trust this folder?');
  });
});
