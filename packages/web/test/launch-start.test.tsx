/**
 * W3: the start form (spec 5.3.3 with decisions U7 and U8) against the fake
 * API: the flags pickers starting from this device's last flags, the
 * command line verbatim, the hold timings, the account picker (Auto never
 * a held account, held needs a confirmation), name and prompt, and every
 * answer the start can get. The tests named after a security rule prove the
 * phone's half of it (spec 6).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { V03_LAUNCH_FLAGS, LaunchStartBodySchema, type LaunchFlags, type LaunchStartBody } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { renderApp, stateWith } from './helpers.js';
import { commandFor, job, launchApi, previewFake, viewport } from './launch-fixtures.js';

const ON = { launch: true } as const;
const state = () => stateWith({ features: ON });
const FORM = '/new?root=r.1&path=api&start=1';
const PLAN: LaunchFlags = { permission: 'plan', chrome: false, effort: 'high', model: 'sonnet' };
/** /v1/plan while the legacy ccw tool runs: the only thing that moves sessions between accounts. */
const CCW_PLAN = { source: 'ccw-legacy' as const, next: null, accounts: [], updatedAt: null, ceiling: 97, weeklyCeiling: 95 };

const sheet = () => screen.getByRole('dialog');
const group = (name: string) => within(sheet()).getByRole('radiogroup', { name });
const checked = (name: string) => within(group(name)).getByRole('radio', { checked: true }).textContent;
const command = () => document.querySelector<HTMLElement>('[data-command]')!;
const hold = () => within(sheet()).getByRole('button', { name: /^Hold to start\. Hold for/ }) as HTMLButtonElement;
const ready = () => waitFor(() => expect(hold().disabled).toBe(false));

/** Press and hold the start button for `ms`. */
function press(ms: number) {
  const b = hold();
  fireEvent.pointerDown(b, { button: 0 });
  act(() => vi.advanceTimersByTime(ms));
  fireEvent.pointerUp(b);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('start form: flags (U7)', () => {
  it('starts from the daemon defaults, shows the command verbatim and the skip sentence, holds 2.0 s', async () => {
    const api = launchApi();
    renderApp({ path: FORM, api, state: state() });
    await ready();
    expect(within(sheet()).getByRole('heading', { name: 'Start in api' })).toBeTruthy();
    expect(api.launchPreview).toHaveBeenCalledWith({ root: 'r.1', path: 'api' });
    expect(checked('Permissions')).toBe('Skip all checks');
    expect(checked('Chrome')).toBe('On');
    expect(checked('Effort')).toBe('ultracode');
    expect(checked('Model')).toBe('Default');
    expect(command().textContent).toBe("cd -- '/synthetic/home/Desktop/work/api' && cs 7 -- --dangerously-skip-permissions --chrome --effort ultracode --session-id <session id> --name api");
    // It breaks between words only: a flag never splits at its own dashes.
    const flags = Array.from(command().querySelectorAll('span.whitespace-nowrap')).map((e) => e.textContent);
    expect(flags).toEqual(['--', '--', '--dangerously-skip-permissions', '--chrome', '--effort', '--session-id', '--name']);
    expect(within(sheet()).getByText("Claude won't ask before running commands in this session.").className).toContain('text-ink-2');
    expect(within(sheet()).queryByText(/An account move restarts it with ultracode effort/)).toBeNull();
    expect(hold().getAttribute('aria-label')).toBe('Hold to start. Hold for 2 seconds');
    // The danger sentence is ink, never ember (spec 5.0).
    expect(sheet().querySelector('.text-signal-text')).toBeNull();
  });

  it("starts from this device's last flags, and then holds only 1.2 s", async () => {
    // The legacy ccw tool runs (its plan), so a move could restart the session: the effort note shows.
    const api = launchApi({ launchPreview: previewFake({ last: PLAN }), getPlan: vi.fn(async () => CCW_PLAN) });
    renderApp({ path: FORM, api, state: state() });
    await ready();
    expect(checked('Permissions')).toBe('Plan');
    expect(checked('Chrome')).toBe('Off');
    expect(checked('Effort')).toBe('high');
    expect(checked('Model')).toBe('sonnet');
    expect(command().textContent).toContain('-- --permission-mode plan --effort high --model sonnet --session-id');
    expect(within(sheet()).queryByText("Claude won't ask before running commands in this session.")).toBeNull();
    expect(await within(sheet()).findByText('An account move restarts it with ultracode effort.')).toBeTruthy();
    expect(hold().getAttribute('aria-label')).toBe('Hold to start. Hold for 1.2 seconds');
  });

  it('says nothing about ultracode effort without the legacy ccw tool: nothing moves a session', async () => {
    const api = launchApi({ launchPreview: previewFake({ last: PLAN }) });
    renderApp({ path: FORM, api, state: state() });
    await ready();
    expect(checked('Effort')).toBe('high');
    await waitFor(() => expect(api.getPlan).toHaveBeenCalled());
    expect(within(sheet()).queryByText(/ultracode effort/)).toBeNull();
  });

  it('asks the daemon again with only the picks changed, and holds the start until the line matches', async () => {
    let answer: (() => void) | null = null;
    const base = previewFake();
    const launchPreview = vi.fn((q: Parameters<typeof base>[0]) =>
      q.flags ? new Promise<Awaited<ReturnType<typeof base>>>((res) => (answer = () => void base(q).then(res))) : base(q),
    );
    renderApp({ path: FORM, api: launchApi({ launchPreview }), state: state() });
    await ready();
    fireEvent.click(within(group('Permissions')).getByRole('radio', { name: 'Accept edits' }));
    expect(checked('Permissions')).toBe('Accept edits');
    expect(launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api', flags: { permission: 'acceptEdits' } });
    // The old line stays on screen, marked busy, and the hold waits for the new one.
    expect(command().getAttribute('aria-busy')).toBe('true');
    expect(hold().disabled).toBe(true);
    await act(async () => answer?.());
    await ready();
    expect(command().textContent).toContain('-- --permission-mode acceptEdits --chrome --effort ultracode --session-id');
    expect(hold().getAttribute('aria-label')).toBe('Hold to start. Hold for 1.2 seconds');
    fireEvent.click(within(group('Model')).getByRole('radio', { name: 'opus' }));
    expect(launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api', flags: { permission: 'acceptEdits', model: 'opus' } });
  });

  it('shows the auto-mode sentence and a 2.0 s hold for Auto, and moves with arrow keys', async () => {
    renderApp({ path: FORM, api: launchApi(), state: state() });
    await ready();
    const skip = within(group('Permissions')).getByRole('radio', { name: 'Skip all checks' });
    fireEvent.keyDown(skip, { key: 'ArrowRight' });
    expect(checked('Permissions')).toBe('Auto');
    await ready();
    expect(within(sheet()).getByText("Claude won't ask before running commands in this session.")).toBeTruthy();
    expect(hold().getAttribute('aria-label')).toBe('Hold to start. Hold for 2 seconds');
    expect(command().textContent).toContain('-- --permission-mode auto --chrome');
  });

  it('Ask me names its mode on the command line (with no flag the account\'s own default would win)', async () => {
    renderApp({ path: FORM, api: launchApi(), state: state() });
    await ready();
    fireEvent.click(within(group('Permissions')).getByRole('radio', { name: 'Ask me' }));
    expect(checked('Permissions')).toBe('Ask me');
    await ready();
    expect(command().textContent).toContain('-- --permission-mode manual --chrome --effort ultracode --session-id');
    expect(within(sheet()).queryByText("Claude won't ask before running commands in this session.")).toBeNull();
    expect(hold().getAttribute('aria-label')).toBe('Hold to start. Hold for 1.2 seconds');
  });

  it('offers exactly the allowlisted values for each picker', async () => {
    renderApp({ path: FORM, api: launchApi(), state: state() });
    await ready();
    const labels = (name: string) => within(group(name)).getAllByRole('radio').map((r) => r.textContent);
    expect(labels('Permissions')).toEqual(['Skip all checks', 'Auto', 'Accept edits', 'Plan', 'Ask me']);
    expect(labels('Chrome')).toEqual(['On', 'Off']);
    expect(labels('Effort')).toEqual(['Default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
    expect(labels('Model')).toEqual(['Default', 'opus', 'sonnet', 'haiku', 'fable']);
    // No free-text flag field and no trust box (U8): the only text fields are the name and the prompt.
    expect(within(sheet()).queryByRole('checkbox')).toBeNull();
    expect(within(sheet()).getAllByRole('textbox').length).toBe(2);
    expect(within(sheet()).getByRole('textbox', { name: 'Name' })).toBeTruthy();
    expect(within(sheet()).getByRole('textbox', { name: 'First prompt (optional)' })).toBeTruthy();
  });
});

describe('start form: hold', () => {
  it('commits only after the full 2.0 s with skip, and the body carries only allowlisted picks (L2, U8)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi.fn(async (_body: LaunchStartBody, _key: string) => ({ job: job('L1') }));
    const api = launchApi({ launchStart });
    const { history } = renderApp({ path: FORM, api, state: state() });
    await ready();
    press(1999);
    expect(launchStart).not.toHaveBeenCalled();
    press(2000);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(1));
    const [body, key] = launchStart.mock.calls[0]!;
    // Strict schema: an unknown key (args, extraArgs, profile, trust, ...) would throw.
    expect(LaunchStartBodySchema.parse(body)).toEqual({
      root: 'r.1',
      path: 'api',
      account: 'auto',
      flags: { permission: 'skip', chrome: true, effort: 'ultracode', model: 'default' },
    });
    expect(Object.keys(body as object).sort()).toEqual(['account', 'flags', 'path', 'root']);
    expect(key).toMatch(/^[0-9a-f-]{32,36}$/);
    await waitFor(() => expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api&launch=L1'));
  });

  it('commits after 1.2 s when Claude will ask first', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi.fn(async (_body: LaunchStartBody, _key: string) => ({ job: job('L1') }));
    renderApp({ path: FORM, api: launchApi({ launchStart, launchPreview: previewFake({ last: PLAN }) }), state: state() });
    await ready();
    press(1199);
    expect(launchStart).not.toHaveBeenCalled();
    press(1200);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(1));
    expect(launchStart.mock.calls[0]?.[0].flags).toEqual(PLAN);
  });

  it('L10: keeps one Idempotency-Key per start across a network failure, and a new one after a refusal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'fetch failed', 0))
      .mockRejectedValueOnce(new ApiError('rate_limited', 'slow down', 429))
      .mockResolvedValue({ job: job('L1') });
    renderApp({ path: FORM, api: launchApi({ launchStart }), state: state() });
    await ready();
    press(2000);
    expect(await screen.findByText('Could not reach the Mac. Check the connection and try again.')).toBeTruthy();
    await ready();
    press(2000);
    expect(await screen.findByText('Too many tries. Wait a minute and try again.')).toBeTruthy();
    await ready();
    press(2000);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(3));
    const keys = launchStart.mock.calls.map((c) => c[1]);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('sends a typed name and the trimmed first prompt, and keeps the prompt out of the URL and storage', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi.fn(async (_body: LaunchStartBody, _key: string) => ({ job: job('L1') }));
    const { history } = renderApp({ path: FORM, api: launchApi({ launchStart }), state: state() });
    await ready();
    const name = within(sheet()).getByRole('textbox', { name: 'Name' });
    expect(name.getAttribute('placeholder')).toBe('api');
    fireEvent.change(name, { target: { value: 'api two' } });
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(within(sheet()).getByText(/No spaces\./)).toBeTruthy();
    expect(hold().disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'api-2' } });
    await ready();
    fireEvent.change(within(sheet()).getByRole('textbox', { name: 'First prompt (optional)' }), { target: { value: '  PROMPT-MARKER fix the login  ' } });
    press(2000);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(1));
    expect(launchStart.mock.calls[0]?.[0]).toMatchObject({ name: 'api-2', prompt: 'PROMPT-MARKER fix the login' });
    await waitFor(() => expect(history.entries.at(-1)).toContain('launch=L1'));
    expect(history.entries.join('\n')).not.toContain('PROMPT-MARKER');
    const stored = [...Array(localStorage.length).keys()].map((i) => localStorage.getItem(localStorage.key(i) ?? '') ?? '').join('\n');
    expect(stored).not.toContain('PROMPT-MARKER');
    expect(sessionStorage.length).toBe(0);
  });

  it('U7: the command line carries the typed Name once typing pauses, and Hold waits for it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = launchApi({ launchPreview: previewFake({ taken: ['api-busy'] }) });
    renderApp({ path: FORM, api, state: state() });
    await ready();
    const name = within(sheet()).getByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'my-custom-name' } });
    // Until the preview has the new Name, the old line is not the one a start would type.
    expect(hold().disabled).toBe(true);
    expect(command().getAttribute('aria-busy')).toBe('true');
    act(() => vi.advanceTimersByTime(300));
    await ready();
    expect(api.launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api', name: 'my-custom-name' });
    expect(command().textContent).toBe(commandFor('api', 7, V03_LAUNCH_FLAGS, 'my-custom-name'));
    // A taken name says so under the field, and Hold stays off.
    fireEvent.change(name, { target: { value: 'api-busy' } });
    act(() => vi.advanceTimersByTime(300));
    expect(await within(sheet()).findByText('A session named api-busy is already running or starting. Pick another name.')).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(hold().disabled).toBe(true);
    // Cleared: back to the suggestion.
    fireEvent.change(name, { target: { value: '' } });
    act(() => vi.advanceTimersByTime(300));
    await ready();
    expect(command().textContent).toMatch(/--name api$/);
  });

  it('says what the Mac would refuse in the first prompt before the hold (a leading !, /clear, control characters)', async () => {
    const api = launchApi();
    renderApp({ path: FORM, api, state: state() });
    await ready();
    const box = within(sheet()).getByRole('textbox', { name: 'First prompt (optional)' });
    for (const [text, said] of [
      ['!rm -rf build', /bash mode/],
      ['/clear', /starts a new transcript/],
      ['fix it\u001b[Z', /control characters/],
    ] as const) {
      fireEvent.change(box, { target: { value: text } });
      expect(within(sheet()).getByText(said).className).toContain('text-ink-2');
      expect(box.getAttribute('aria-invalid')).toBe('true');
      expect(hold().disabled).toBe(true);
    }
    fireEvent.change(box, { target: { value: 'fix the login\nthen run the tests' } });
    await ready();
    expect(box.getAttribute('aria-invalid')).toBe('false');
  });

  it('keeps the hold off while offline, with the reason', async () => {
    const api = launchApi();
    renderApp({ path: FORM, api, state: state(), status: 'offline' });
    await waitFor(() => expect(within(sheet()).getByText("Offline: can't start right now")).toBeTruthy());
    expect(hold().disabled).toBe(true);
  });
});

describe('start form: refusals', () => {
  it('names the Mac command on a 403 for the launch scope, with no grant button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem('jantar:device', JSON.stringify({ id: 'dev-1', name: 'iPhone', scopes: ['read', 'control'] }));
    const launchStart = vi.fn(async () => Promise.reject(new ApiError('forbidden', 'this device does not have the launch scope', 403)));
    renderApp({ path: FORM, api: launchApi({ launchStart }), state: state() });
    await ready();
    press(2000);
    await waitFor(() => expect(sheet().querySelector('[data-no-scope]')).not.toBeNull());
    expect(sheet().querySelector('[data-no-scope]')!.textContent).toBe("This browser can't start sessions. On your Mac run jantar devices grant iPhone launch.");
    expect(within(sheet()).queryByRole('button', { name: /grant/i })).toBeNull();
  });

  it("shows the daemon's sentence as a failure line when it refuses the start", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi.fn(async () => Promise.reject(new ApiError('conflict', '07 already has a session starting. Wait for it, or pick another account.', 409)));
    renderApp({ path: FORM, api: launchApi({ launchStart }), state: state() });
    await ready();
    press(2000);
    const line = await within(sheet()).findByText('07 already has a session starting. Wait for it, or pick another account.');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.className).toContain('text-signal-text');
  });

  it('shows the reason and Try again when the preview fails, then recovers', async () => {
    const base = previewFake();
    const launchPreview = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('not_found', 'That folder is no longer there.', 404))
      .mockImplementation((q) => base(q));
    renderApp({ path: FORM, api: launchApi({ launchPreview }), state: state() });
    expect(await within(sheet()).findByText('That folder is no longer there.')).toBeTruthy();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Try again' }));
    await ready();
  });

  it('shows static placeholder rows while the first preview loads', async () => {
    renderApp({ path: FORM, api: launchApi({ launchPreview: vi.fn(() => new Promise<never>(() => undefined)) }), state: state() });
    const s = await screen.findByRole('region', { name: 'Start a session' });
    expect(s.getAttribute('aria-busy')).toBe('true');
    expect(within(s).getByRole('heading', { name: 'Start in api' })).toBeTruthy();
    expect(within(s).queryByRole('button', { name: /Hold to start/ })).toBeNull();
  });
});

describe('start form: account (L6)', () => {
  const openPicker = async () => {
    await ready();
    fireEvent.click(within(sheet()).getByRole('button', { name: /^Account/ }));
    return within(sheet()).getByRole('list', { name: 'Accounts' });
  };

  it('shows Auto and its pick with the reason, and the rows with held tags and unusable reasons', async () => {
    renderApp({ path: FORM, api: launchApi(), state: state() });
    await ready();
    expect(within(sheet()).getByRole('button', { name: /^Account/ }).textContent).toBe('Auto → 07');
    expect(within(sheet()).getByText('most room · 5h 12% · resets in 3h40 · 14:20')).toBeTruthy();
    const list = await openPicker();
    expect(within(sheet()).getByRole('heading', { name: 'Pick an account' })).toBeTruthy();
    const auto = within(list).getByRole('button', { name: /^Auto/ });
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    expect(auto.textContent).toContain('most room → 07');
    const held = list.querySelector<HTMLElement>('[data-account="2"]')!;
    expect(within(held).getByText('held')).toBeTruthy();
    const expired = list.querySelector<HTMLElement>('[data-account="5"]')!;
    expect(within(expired).getByText('token expired')).toBeTruthy();
    expect(within(expired).queryByRole('button')).toBeNull();
    expect(within(list).getByRole('meter', { name: '07 5-hour usage' })).toBeTruthy();
  });

  it('never offers a held account as Auto, even when the reply names one', async () => {
    const api = launchApi({ launchPreview: previewFake({ auto: 1 }) });
    renderApp({ path: FORM, api, state: state() });
    await waitFor(() => expect(within(sheet()).getByText('No account has room for Auto.')).toBeTruthy());
    expect(within(sheet()).getByRole('button', { name: /^Account/ }).textContent).toBe('Auto');
    expect(hold().disabled).toBe(true);
    expect(within(sheet()).getByText('Pick an account to start.')).toBeTruthy();
    fireEvent.click(within(sheet()).getByRole('button', { name: /^Account/ }));
    const list = within(sheet()).getByRole('list', { name: 'Accounts' });
    expect((within(list).getByRole('button', { name: /^Auto/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Auto when nothing has room, and a manual pick still starts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi.fn(async (_body: LaunchStartBody, _key: string) => ({ job: job('L1', { account: 8, accountSource: 'manual', requested: 8 }) }));
    const api = launchApi({ launchStart, launchPreview: previewFake({ auto: null, autoReason: 'No account has room until 14:20 (03 resets)' }) });
    renderApp({ path: FORM, api, state: state() });
    await waitFor(() => expect(within(sheet()).getByText('No account has room until 14:20 (03 resets)')).toBeTruthy());
    expect(hold().disabled).toBe(true);
    fireEvent.click(within(sheet()).getByRole('button', { name: /^Account/ }));
    const list = within(sheet()).getByRole('list', { name: 'Accounts' });
    expect((within(list).getByRole('button', { name: /^Auto/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(list).getByRole('button', { name: /^08/ }));
    await waitFor(() => expect(api.launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api', account: 8 }));
    await ready();
    expect(within(sheet()).getByRole('button', { name: /^Account/ }).textContent).toBe('08acct8');
    press(2000);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(1));
    expect(launchStart.mock.calls[0]?.[0]).toMatchObject({ account: 8 });
    expect(launchStart.mock.calls[0]?.[0]).not.toHaveProperty('confirmHeld');
  });

  it('asks before a held account, and sends confirmHeld once you say "Use 02 anyway"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const launchStart = vi.fn(async (_body: LaunchStartBody, _key: string) => ({ job: job('L1') }));
    const api = launchApi({ launchStart });
    renderApp({ path: FORM, api, state: state() });
    const list = await openPicker();
    fireEvent.click(within(list).getByRole('button', { name: '02 acct2, held' }));
    expect(api.launchPreview).not.toHaveBeenCalledWith(expect.objectContaining({ account: 2 }));
    expect(within(list).getByText('Held for other work. ccw will never move this session, even when 02 fills up.')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Use 02 anyway' }));
    await waitFor(() => expect(api.launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api', account: 2 }));
    await ready();
    press(2000);
    await waitFor(() => expect(launchStart).toHaveBeenCalledTimes(1));
    expect(launchStart.mock.calls[0]?.[0]).toMatchObject({ account: 2, confirmHeld: true });
  });

  it('offers the group quick choice, and asks again before a held one', async () => {
    const warnings = [
      { kind: 'group' as const, text: 'Group web+api is on 06. Starting on 07 splits it; ccw may move it.', account: 6 },
      { kind: 'effort' as const, text: 'ccw adds --effort ultracode if it moves this session.' },
      { kind: 'stale' as const, text: 'Usage is 14 minutes old.' },
    ];
    const api = launchApi({ launchPreview: previewFake({ warnings, last: PLAN }), getPlan: vi.fn(async () => CCW_PLAN) });
    renderApp({ path: FORM, api, state: state() });
    await ready();
    expect(within(sheet()).getByText('Usage is 14 minutes old.')).toBeTruthy();
    // The effort fact shows once: U7's note under Effort, not the daemon's line too.
    expect(within(sheet()).queryByText('ccw adds --effort ultracode if it moves this session.')).toBeNull();
    expect((await within(sheet()).findAllByText(/ultracode effort/)).length).toBe(1);
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Use 06' }));
    await waitFor(() => expect(api.launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api', account: 6 }));
    await waitFor(() => expect(within(sheet()).getByText(/Held for other work\. ccw will never move this session, even when 06 fills up\./)).toBeTruthy());
    expect(hold().disabled).toBe(true);
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Use 06 anyway' }));
    await ready();
  });
});

describe('start form: desktop', () => {
  it('sits in the detail pane beside the browser, with the account list in a popover', async () => {
    viewport(1440);
    const api = launchApi();
    const { history } = renderApp({ path: FORM, api, state: state() });
    const pane = screen.getByRole('region', { name: 'Detail' });
    await waitFor(() => expect(within(pane).getByRole('heading', { name: 'Start in api' })).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(pane).getByRole('button', { name: /^Account/ }));
    const pop = await screen.findByRole('dialog', { name: 'Pick an account' });
    fireEvent.click(within(pop).getByRole('button', { name: /^08/ }));
    await waitFor(() => expect(api.launchPreview).toHaveBeenLastCalledWith({ root: 'r.1', path: 'api', account: 8 }));
    fireEvent.click(within(pane).getByRole('button', { name: 'Close' }));
    expect(history.entries.at(-1)).toBe('/new?root=r.1');
  });
});

describe('start form: the sheet', () => {
  it('closes back to the folder you browsed', async () => {
    const api = launchApi();
    const { history } = renderApp({ path: '/new?root=r.1&path=api', api, state: state() });
    fireEvent.click(await screen.findByRole('button', { name: 'Start here' }));
    await ready();
    expect(command().textContent).toBe(commandFor('api', 7, { permission: 'skip', chrome: true, effort: 'ultracode', model: 'default' }, 'api'));
    // The browser behind the sheet did not move.
    expect(screen.getByRole('navigation', { name: 'Folder path', hidden: true }).textContent).toBe('~/Desktop/work/api');
    fireEvent.keyDown(sheet(), { key: 'Escape' });
    await waitFor(() => expect(history.entries.at(-1)).toBe('/new?root=r.1&path=api'));
  });
});
