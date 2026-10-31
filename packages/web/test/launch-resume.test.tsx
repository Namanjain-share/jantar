/**
 * v0.4 (WP-LA, spec 5.9): the start sheet's Resume row and single-account
 * mode against the fake API. Resume is Off, Last (the newest one not
 * running) or Pick… (the folder's past sessions in the sheet's place; a
 * running one cannot be picked); either sends `resume: <id>` with the
 * preview and the start, and the command line shows the daemon's
 * `--resume <id>`. A conversation kept on one account pins it (the Account
 * row says so and cannot change). Every state: loading, none, unreadable, a
 * refusal, success. The keyboard: arrows never open the list, focus goes
 * into it and back. With one Claude login there is no Account row. Every
 * name and id here is made up.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaunchStartBodySchema, type LaunchPreview, type LaunchStartBody, type PastSession } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { NO_PAST, PAST_UNREAD, pastLine, pastWhen } from '../src/ui/screens/new/data.js';
import { EFFORT_NOTE } from '../src/ui/screens/new/StartForm.js';
import { NOW, iso, renderApp, stateWith } from './helpers.js';
import { ACCOUNTS, acct, job, launchApi, previewFake } from './launch-fixtures.js';

const FORM = '/new?root=r.1&path=api&start=1';
const NEWEST = '0b4e7c4e-1111-4111-8111-000000000001';
const PINNED = '0b4e7c4e-2222-4222-8222-000000000002';
const RUNNING = '0b4e7c4e-3333-4333-8333-000000000003';
const ON_HELD = '0b4e7c4e-4444-4444-8444-000000000004';

const HISTORY: PastSession[] = [
  { id: NEWEST, account: null, lastAt: iso(-30 * 60_000), first: 'fix the push example in the service worker', live: false },
  { id: PINNED, account: 7, lastAt: iso(-26 * 3600_000), first: 'write tests for the folder browser', live: false },
  { id: RUNNING, account: null, lastAt: iso(-50 * 3600_000), first: 'refactor the parser', live: true },
  { id: ON_HELD, account: 2, lastAt: iso(-80 * 3600_000), live: false },
];

const sheet = () => screen.getByRole('dialog');
const group = (name: string) => within(sheet()).getByRole('radiogroup', { name });
const radio = (name: string) => within(group('Resume')).getByRole('radio', { name }) as HTMLButtonElement;
const checked = (name: string) => within(group(name)).getByRole('radio', { checked: true }).textContent;
const command = () => document.querySelector<HTMLElement>('[data-command]')!;
const resumeLine = () => document.querySelector<HTMLElement>('[data-resume-line]');
const hold = () => within(sheet()).getByRole('button', { name: /^Hold to start\. Hold for/ }) as HTMLButtonElement;
/** The sheet is lazy: its first render can take a while on a loaded machine. */
const ready = () => waitFor(() => expect(hold().disabled).toBe(false), { timeout: 5_000 });

function press(ms: number) {
  const b = hold();
  fireEvent.pointerDown(b, { button: 0 });
  act(() => vi.advanceTimersByTime(ms));
  fireEvent.pointerUp(b);
}

/**
 * The daemon's preview with Resume: the conversation's own account when it
 * is kept on one (every other one not selectable, "This conversation is on
 * 07"), and `--resume <id>` in the command; a running one is refused.
 */
function resumePreview(history: PastSession[] = HISTORY, accounts = ACCOUNTS) {
  const base = previewFake({ accounts });
  return vi.fn(async (q: Parameters<Api['launchPreview']>[0]): Promise<LaunchPreview> => {
    const p = await base(q);
    if (!q.resume) return p;
    const past = history.find((s) => s.id === q.resume);
    if (!past) throw new ApiError('not_found', "That conversation isn't in this folder's history.", 404);
    if (past.live) throw new ApiError('conflict', 'That conversation is running. Open it on the Board.', 409);
    const out: LaunchPreview = { ...p, command: p.command.replace('--session-id <session id>', `--resume ${past.id}`) };
    if (past.account === null) return out;
    const on = `This conversation is on ${String(past.account).padStart(2, '0')}`;
    return {
      ...out,
      account: { pick: past.account, source: 'resume', reason: on },
      accounts: p.accounts.map((a) => (a.id === past.account ? a : { ...a, selectable: false, why: on })),
      command: out.command.replace(/ cs \d+ -- /, ` cs ${past.account} -- `),
    };
  });
}

function api(over: Partial<Api> = {}) {
  return launchApi({ launchHistory: vi.fn(async () => ({ sessions: HISTORY })), launchPreview: resumePreview(), ...over });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Resume on the start sheet', () => {
  it('starts Off, under Name, with Last and Pick… once the folder has past sessions; Off sends no resume', async () => {
    const a = api();
    renderApp({ path: FORM, api: a, state: stateWith({ features: { launch: true } }) });
    await ready();
    expect(a.launchHistory).toHaveBeenCalledWith({ root: 'r.1', path: 'api' });
    expect(within(group('Resume')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Off', 'Last', 'Pick…']);
    expect(checked('Resume')).toBe('Off');
    expect(radio('Last').disabled).toBe(false);
    expect(resumeLine()).toBeNull();
    expect(a.launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api' });
    expect(command().textContent).toContain('--session-id <session id>');
    // The row sits under Name, before the first prompt.
    const labels = Array.from(sheet().querySelectorAll('.w-88')).map((e) => e.textContent);
    expect(labels.slice(labels.indexOf('Name'), labels.indexOf('Name') + 2)).toEqual(['Name', 'Resume']);
  });

  it('Last: the newest conversation, its line under the row, --resume <id> in the command, and the start carries it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi.fn(async (_b: LaunchStartBody, _k: string) => ({ job: job('L1', { resumed: true, sid: NEWEST }) }));
    const a = api({ launchStart });
    const { history } = renderApp({ path: FORM, api: a, state: stateWith({ features: { launch: true } }) });
    await ready();
    fireEvent.click(radio('Last'));
    expect(checked('Resume')).toBe('Last');
    await ready();
    expect(a.launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api', resume: NEWEST });
    // Shared dir: no account in the line, only when and what.
    expect(resumeLine()?.textContent).toBe(pastLine(HISTORY[0]!, NOW, false));
    expect(resumeLine()?.textContent).toBe(`${pastWhen(HISTORY[0]!.lastAt, NOW)} · "fix the push example in the service worker"`);
    expect(command().textContent).toContain(`--resume ${NEWEST} --name api`);
    expect(command().textContent).not.toContain('--session-id');
    expect(within(sheet()).getByRole('button', { name: /^Account/ }).textContent).toBe('Auto → 07');
    press(2000);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(1));
    const [body] = launchStart.mock.calls[0]!;
    expect(LaunchStartBodySchema.parse(body)).toEqual({ root: 'r.1', path: 'api', account: 'auto', flags: expect.any(Object), resume: NEWEST });
    await waitFor(() => expect(history.location.search).toBe('?root=r.1&path=api&launch=L1'));
  });

  it('Pick…: the past sessions take the sheet’s place; a running one cannot be picked; Back changes nothing', async () => {
    const a = api();
    renderApp({ path: FORM, api: a, state: stateWith({ features: { launch: true } }) });
    await ready();
    fireEvent.click(radio('Pick…'));
    const list = within(sheet()).getByRole('list', { name: 'Past sessions' });
    expect(within(sheet()).getByRole('heading', { name: 'Pick a past session' })).toBeTruthy();
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    const newest = list.querySelector<HTMLElement>(`[data-past="${NEWEST}"]`)!;
    expect(within(newest).getByRole('button').textContent).toBe(`${pastWhen(HISTORY[0]!.lastAt, NOW)}fix the push example in the service worker`);
    const pinned = list.querySelector<HTMLElement>(`[data-past="${PINNED}"]`)!;
    expect(within(pinned).getByRole('button', { name: `${pastWhen(HISTORY[1]!.lastAt, NOW)} on 07: write tests for the folder browser` })).toBeTruthy();
    const running = list.querySelector<HTMLElement>(`[data-past="${RUNNING}"]`)!;
    expect(within(running).queryByRole('button')).toBeNull();
    expect(running.querySelector('[aria-disabled="true"]')).not.toBeNull();
    expect(within(running).getByText('running')).toBeTruthy();
    // No first line: the row still shows when and where.
    expect(within(list.querySelector<HTMLElement>(`[data-past="${ON_HELD}"]`)!).getByRole('button').textContent).toBe(`${pastWhen(HISTORY[3]!.lastAt, NOW)}02`);
    // First lines are text, ink-2; nothing here is ember.
    expect(within(newest).getByText('fix the push example in the service worker').className).toContain('text-ink-2');
    expect(sheet().querySelector('.text-signal-text')).toBeNull();

    fireEvent.click(within(sheet()).getByRole('button', { name: 'Back' }));
    expect(checked('Resume')).toBe('Off');
    expect(a.launchPreview).not.toHaveBeenCalledWith(expect.objectContaining({ resume: expect.any(String) }));
  });

  it('a conversation kept on one account pins it: "This conversation is on 07", the Account row cannot change, the start goes there', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi.fn(async (_b: LaunchStartBody, _k: string) => ({ job: job('L2', { account: 7, accountSource: 'resume' }) }));
    const a = api({ launchStart });
    renderApp({ path: '/new?root=r.1&path=api&start=1&account=8', api: a, state: stateWith({ features: { launch: true } }) });
    await ready();
    expect(within(sheet()).getByRole('button', { name: /^Account/ }).textContent).toBe('08acct8');
    fireEvent.click(radio('Pick…'));
    fireEvent.click(within(sheet()).getByRole('button', { name: /write tests for the folder browser/ }));
    expect(checked('Resume')).toBe('Pick…');
    await ready();
    expect(a.launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api', account: 8, resume: PINNED });
    const accountButton = within(sheet()).getByRole('button', { name: /^Account/ }) as HTMLButtonElement;
    expect(accountButton.disabled).toBe(true);
    expect(accountButton.textContent).toBe('07acct7');
    expect(within(sheet()).getByText('This conversation is on 07')).toBeTruthy();
    expect(resumeLine()?.textContent).toBe(`${pastWhen(HISTORY[1]!.lastAt, NOW)} · 07 · "write tests for the folder browser"`);
    expect(command().textContent).toContain(` cs 7 -- `);
    expect(within(sheet()).queryByText('Pick an account to start.')).toBeNull();
    press(2000);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(1));
    expect(launchStart.mock.calls[0]![0]).toMatchObject({ account: 7, resume: PINNED });
    expect(launchStart.mock.calls[0]![0]).not.toHaveProperty('confirmHeld');
  });

  it('a pinned account that is held asks first, then carries confirmHeld', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi.fn(async (_b: LaunchStartBody, _k: string) => ({ job: job('L3') }));
    renderApp({ path: FORM, api: api({ launchStart }), state: stateWith({ features: { launch: true } }) });
    await ready();
    fireEvent.click(radio('Pick…'));
    fireEvent.click(within(sheet()).getByRole('button', { name: /on 02$/ }));
    await waitFor(() => expect(within(sheet()).getByText('This conversation is on 02')).toBeTruthy());
    expect(hold().disabled).toBe(true);
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Use 02 anyway' }));
    await ready();
    // Another choice and back: the confirmation is asked for again, never carried over.
    fireEvent.click(radio('Last'));
    await ready();
    fireEvent.click(radio('Pick…'));
    fireEvent.click(within(sheet()).getByRole('button', { name: /on 02$/ }));
    expect(await within(sheet()).findByRole('button', { name: 'Use 02 anyway' })).toBeTruthy();
    expect(hold().disabled).toBe(true);
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Use 02 anyway' }));
    await ready();
    press(2000);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(1));
    expect(launchStart.mock.calls[0]![0]).toMatchObject({ account: 2, confirmHeld: true, resume: ON_HELD });
  });

  it('Last skips a conversation that runs now (it is open on the Board): the one before it opens', async () => {
    const live: PastSession[] = [{ ...HISTORY[2]!, lastAt: iso(-60_000) }, HISTORY[0]!];
    const a = api({ launchHistory: vi.fn(async () => ({ sessions: live })), launchPreview: resumePreview(live) });
    renderApp({ path: FORM, api: a, state: stateWith({ features: { launch: true } }) });
    await ready();
    fireEvent.click(radio('Last'));
    await ready();
    expect(a.launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api', resume: NEWEST });
    expect(resumeLine()?.textContent).toBe(pastLine(HISTORY[0]!, NOW, false));
    expect(within(group('Resume').parentElement!).queryByText('running')).toBeNull();
    expect(within(sheet()).queryByText('That conversation is running. Open it on the Board.')).toBeNull();
  });

  it('every past conversation running: Last is disabled, Pick… still lists them, Off starts a new one', async () => {
    const live: PastSession[] = [{ ...HISTORY[2]!, lastAt: iso(-60_000) }, { ...HISTORY[0]!, live: true }];
    renderApp({ path: FORM, api: api({ launchHistory: vi.fn(async () => ({ sessions: live })), launchPreview: resumePreview(live) }), state: stateWith({ features: { launch: true } }) });
    await ready();
    await waitFor(() => expect(radio('Pick…').disabled).toBe(false));
    expect(radio('Last').disabled).toBe(true);
    expect(radio('Off').disabled).toBe(false);
    expect(within(sheet()).queryByText(NO_PAST)).toBeNull();
  });
});

describe('Resume from the keyboard', () => {
  it('arrows select Off and Last but only move onto Pick…; Pick… opens on a press, focus goes into the list and back', async () => {
    const a = api();
    renderApp({ path: FORM, api: a, state: stateWith({ features: { launch: true } }) });
    await ready();
    expect(radio('Off').tabIndex).toBe(0);
    fireEvent.keyDown(radio('Off'), { key: 'ArrowRight' });
    expect(checked('Resume')).toBe('Last');
    expect(document.activeElement).toBe(radio('Last'));
    fireEvent.keyDown(radio('Last'), { key: 'ArrowRight' });
    // On Pick…: focused, nothing opened, Last still the choice.
    expect(document.activeElement).toBe(radio('Pick…'));
    expect(within(sheet()).queryByRole('list', { name: 'Past sessions' })).toBeNull();
    expect(checked('Resume')).toBe('Last');
    // Wrapping from Off to the left lands on Pick… the same way.
    fireEvent.keyDown(radio('Pick…'), { key: 'ArrowRight' });
    expect(checked('Resume')).toBe('Off');
    fireEvent.keyDown(radio('Off'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(radio('Pick…'));
    expect(within(sheet()).queryByRole('list', { name: 'Past sessions' })).toBeNull();

    // A press opens it, with focus on the first row that can be picked.
    fireEvent.click(radio('Pick…'));
    const list = within(sheet()).getByRole('list', { name: 'Past sessions' });
    expect(document.activeElement).toBe(within(list.querySelector<HTMLElement>(`[data-past="${NEWEST}"]`)!).getByRole('button'));
    // Back: focus on the Resume row's choice, never lost to the page.
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(document.activeElement).toBe(radio('Off')));
    // Picking a row: back on Pick…, now the choice; reopened, focus is on the row picked.
    fireEvent.click(radio('Pick…'));
    fireEvent.click(within(sheet()).getByRole('button', { name: /write tests for the folder browser/ }));
    await waitFor(() => expect(document.activeElement).toBe(radio('Pick…')));
    expect(checked('Resume')).toBe('Pick…');
    fireEvent.click(radio('Pick…'));
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement?.textContent).toContain('write tests for the folder browser');
  });

  it('a disabled Last is skipped; with no past sessions the arrows stay on Off', async () => {
    const live: PastSession[] = [{ ...HISTORY[2]!, lastAt: iso(-60_000) }];
    const one = renderApp({ path: FORM, api: api({ launchHistory: vi.fn(async () => ({ sessions: live })) }), state: stateWith({ features: { launch: true } }) });
    await ready();
    await waitFor(() => expect(radio('Pick…').disabled).toBe(false));
    fireEvent.keyDown(radio('Off'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radio('Pick…'));
    expect(checked('Resume')).toBe('Off');
    one.unmount();

    renderApp({ path: FORM, api: api({ launchHistory: vi.fn(async () => ({ sessions: [] })) }), state: stateWith({ features: { launch: true } }) });
    await ready();
    await within(sheet()).findByText(NO_PAST);
    radio('Off').focus();
    fireEvent.keyDown(radio('Off'), { key: 'ArrowRight' });
    fireEvent.keyDown(radio('Off'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(radio('Off'));
    expect(checked('Resume')).toBe('Off');
  });
});

describe('Resume: every state of the row', () => {
  it('no past sessions: the row says so and Last and Pick… are disabled; the start still works', async () => {
    renderApp({ path: FORM, api: api({ launchHistory: vi.fn(async () => ({ sessions: [] })) }), state: stateWith({ features: { launch: true } }) });
    await ready();
    expect(within(sheet()).getByText(NO_PAST)).toBeTruthy();
    expect(NO_PAST).toBe('No past sessions in this folder');
    expect(checked('Resume')).toBe('Off');
    expect(radio('Last').disabled).toBe(true);
    expect(radio('Pick…').disabled).toBe(true);
    // Off stays a live choice, so the row is still reached with Tab.
    expect(radio('Off').disabled).toBe(false);
    expect(radio('Off').tabIndex).toBe(0);
  });

  it('loading: Off only until the list is in; the form does not wait for it', async () => {
    renderApp({ path: FORM, api: api({ launchHistory: vi.fn(() => new Promise<never>(() => undefined)) }), state: stateWith({ features: { launch: true } }) });
    await ready();
    expect(checked('Resume')).toBe('Off');
    expect(radio('Last').disabled).toBe(true);
    expect(radio('Off').disabled).toBe(false);
    expect(within(sheet()).queryByText(NO_PAST)).toBeNull();
  });

  it('unreadable: says so with Read again (no alert, no ember), and the start still works with Off', async () => {
    const launchHistory = vi.fn().mockRejectedValueOnce(new ApiError('network', 'down', 0)).mockResolvedValue({ sessions: HISTORY });
    renderApp({ path: FORM, api: api({ launchHistory }), state: stateWith({ features: { launch: true } }) });
    await ready();
    const line = await within(sheet()).findByText(PAST_UNREAD);
    expect(line.getAttribute('role')).toBeNull();
    expect(sheet().querySelector('.text-signal-text')).toBeNull();
    expect(radio('Last').disabled).toBe(true);
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(radio('Last').disabled).toBe(false));
    expect(launchHistory).toHaveBeenCalledTimes(2);
    expect(within(sheet()).queryByText(PAST_UNREAD)).toBeNull();
  });

  it('offline: the row stays readable and the hold says why it waits', async () => {
    renderApp({ path: FORM, api: api(), state: stateWith({ features: { launch: true } }), status: 'offline' });
    await waitFor(() => expect(within(sheet()).getByText("Offline: can't start right now")).toBeTruthy());
    expect(within(group('Resume')).getAllByRole('radio')).toHaveLength(3);
    expect(hold().disabled).toBe(true);
  });
});

describe('single-account mode on the start sheet', () => {
  /** One Claude login: Auto is account 0, with one row and the daemon's reason. */
  function singlePreview() {
    const base = resumePreview(HISTORY, [acct(0, { label: 'Claude', fiveHourPct: undefined, sevenDayPct: undefined, resetsAt: undefined })]);
    return vi.fn(async (q: Parameters<Api['launchPreview']>[0]) => {
      const p = await base({ ...q, account: undefined });
      return { ...p, account: { pick: 0, source: 'auto' as const, reason: 'one Claude login' }, command: p.command.replace(/ cs \d+ -- /, ' /opt/bin/claude ') };
    });
  }

  it('no Account row: Auto is the one login; the start sends auto; Resume shows no account', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi.fn(async (_b: LaunchStartBody, _k: string) => ({ job: job('S1', { account: 0 }) }));
    const sessions: PastSession[] = [{ ...HISTORY[0]!, account: 3 }];
    renderApp({
      path: FORM,
      api: api({ launchPreview: singlePreview(), launchHistory: vi.fn(async () => ({ sessions })), launchStart }),
      state: stateWith({ features: { launch: true }, accountsMode: 'single' }),
    });
    await ready();
    expect(within(sheet()).queryByRole('button', { name: /^Account/ })).toBeNull();
    expect(within(sheet()).queryByText('one Claude login')).toBeNull();
    expect(Array.from(sheet().querySelectorAll('.w-88')).map((e) => e.textContent)).not.toContain('Account');
    // With no account move there is nothing to restart with ultracode effort, whatever the effort.
    fireEvent.click(within(group('Effort')).getByRole('radio', { name: 'high' }));
    await ready();
    expect(within(group('Effort')).getByRole('radio', { name: 'high' }).getAttribute('aria-checked')).toBe('true');
    expect(within(sheet()).queryByText(EFFORT_NOTE)).toBeNull();
    expect(command().textContent).toContain('/opt/bin/claude --dangerously-skip-permissions');
    fireEvent.click(radio('Last'));
    await ready();
    // One login keeps no conversation on an account of its own: the line names none.
    expect(resumeLine()?.textContent).toBe(pastLine(sessions[0]!, NOW, true));
    expect(resumeLine()?.textContent).not.toContain('03');
    press(2000);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(1));
    expect(launchStart.mock.calls[0]![0]).toMatchObject({ account: 'auto', resume: NEWEST });
  });

  it('an account in the URL is not asked for: one login is Auto, and the start goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi.fn(async (_b: LaunchStartBody, _k: string) => ({ job: job('S2', { account: 0 }) }));
    const a = api({ launchPreview: singlePreview(), launchStart });
    renderApp({ path: `${FORM}&account=8`, api: a, state: stateWith({ features: { launch: true }, accountsMode: 'single' }) });
    await ready();
    expect(a.launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api' });
    expect(within(sheet()).queryByText(/There is no account/)).toBeNull();
    press(2000);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(1));
    expect(launchStart.mock.calls[0]![0]).toMatchObject({ account: 'auto' });
  });

  it('the picker has no account column with one login', async () => {
    renderApp({ path: FORM, api: api({ launchPreview: singlePreview() }), state: stateWith({ features: { launch: true }, accountsMode: 'single' }) });
    await ready();
    fireEvent.click(radio('Pick…'));
    const list = within(sheet()).getByRole('list', { name: 'Past sessions' });
    const pinned = list.querySelector<HTMLElement>(`[data-past="${PINNED}"]`)!;
    expect(within(pinned).getByRole('button').textContent).toBe(`${pastWhen(HISTORY[1]!.lastAt, NOW)}write tests for the folder browser`);
  });
});

describe('the Resume line', () => {
  it('when: the time today, else weekday, date and month (24-hour, local)', () => {
    const today = new Date(NOW);
    today.setHours(14, 2, 0, 0);
    expect(pastWhen(today.toISOString(), NOW)).toBe('14:02');
    const earlier = new Date(2026, 9, 30, 14, 2);
    expect(pastWhen(earlier.toISOString(), NOW)).toBe('Fri 30 Oct 14:02');
    expect(pastWhen('not a date', NOW)).toBe('');
    expect(pastLine({ id: NEWEST, account: 3, lastAt: earlier.toISOString(), first: 'fix it', live: false }, NOW, false)).toBe('Fri 30 Oct 14:02 · 03 · "fix it"');
    expect(pastLine({ id: NEWEST, account: null, lastAt: earlier.toISOString(), live: false }, NOW, false)).toBe('Fri 30 Oct 14:02');
  });
});
