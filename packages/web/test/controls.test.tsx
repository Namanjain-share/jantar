/**
 * The control bar, the mode chip and the command sheets (C8), against the
 * fake API: every state renders (loading, success, refused, error,
 * offline), Interrupt needs its hold, /clear and /rewind need their confirm
 * sheet, and nothing in session/controls/ uses ember or a colour literal.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { INTERRUPT_HOLD_MS } from '../src/ui/screens/session/controls/ControlBar.js';
import { resetUnavailable } from '../src/ui/screens/session/controls/modes.js';
import { emit, fakeApi, iso, pending, renderApp, session, stateWith } from './helpers.js';

/** Pretend the window is `width` px wide (jsdom has no matchMedia). */
function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: m ? width >= Number(m[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
}

const on = (over: Partial<Session> = {}) => stateWith({ sessions: [session('a', { status: 'working', mode: 'default', ...over })], features: { controls: true, clearDraft: true } });
const bar = () => screen.getByRole('group', { name: 'Controls' });
const chip = () => screen.getByRole('button', { name: /^Permission mode:/ }) as HTMLButtonElement;
const commands = () => within(bar()).getByRole('button', { name: 'Commands' }) as HTMLButtonElement;

/** The Base UI halves load lazily: wait until the real (enabled) triggers are in. */
async function loaded() {
  await waitFor(() => expect(chip().disabled).toBe(false));
  await waitFor(() => expect(commands().disabled).toBe(false));
}

beforeEach(() => {
  viewport(1440);
  resetUnavailable();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the control bar (C8)', () => {
  it('shows the mode chip, Interrupt, Clear draft and Commands while controls are on', async () => {
    renderApp({ path: '/s/a', state: on() });
    await loaded();
    const b = bar();
    expect(within(b).getByRole('button', { name: 'Permission mode: Manual' })).toBeTruthy();
    expect(within(b).getByRole('button', { name: 'Interrupt. Hold for 0.6 seconds' })).toBeTruthy();
    expect(within(b).getByRole('button', { name: "Clear draft in the Mac's terminal" }).textContent).toBe('Clear draft');
    expect(commands()).toBeTruthy();
  });

  it('leaves Clear draft out until the Mac has verified it (spike S1: it could send part of a draft)', async () => {
    renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a', { status: 'working', mode: 'default' })], features: { controls: true } }) });
    await loaded();
    expect(within(bar()).queryByRole('button', { name: /Clear draft/ })).toBeNull();
    expect(within(bar()).getByRole('button', { name: 'Interrupt. Hold for 0.6 seconds' })).toBeTruthy();
  });

  it('is not there while controls are off, or while a card is open', () => {
    const off = renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a')] }) });
    expect(screen.queryByRole('group', { name: 'Controls' })).toBeNull();
    off.unmount();
    renderApp({
      path: '/s/a',
      state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [pending('a')], features: { controls: true } }),
    });
    expect(screen.queryByRole('group', { name: 'Controls' })).toBeNull();
  });

  it('is not there while the terminal dialog dock shows (v0.4.2: every key there is refused while Claude waits)', async () => {
    const getScreen = vi.fn(async () => ({ text: 'Pick a region\n❯ North', lines: 2, at: iso(0), backend: 'terminal-app' }));
    const { store } = renderApp({ path: '/s/a', api: fakeApi({ getScreen }), state: on({ status: 'waiting' }) });
    expect(screen.getByRole('heading', { name: 'Claude is waiting in the terminal' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Controls' })).toBeNull();
    // Claude moves on: the dock goes and the bar comes back.
    act(() => emit(store, [{ seq: 11, ts: iso(1000), type: 'session.updated', sid: 'a', data: { patch: { status: 'working', statusSince: iso(1000) } } }]));
    await loaded();
    expect(screen.queryByRole('heading', { name: 'Claude is waiting in the terminal' })).toBeNull();
  });

  it('says the mode once (rule 19): the chip while it shows, the meta again while a card hides it', async () => {
    const wide = renderApp({ path: '/s/a', state: on({ mode: 'plan' }) });
    await loaded();
    expect(chip().getAttribute('aria-label')).toMatch(/Plan/);
    const props = screen.getByRole('complementary', { name: 'Session properties' });
    expect(within(props).queryByText('Mode')).toBeNull();
    expect(within(props).queryByText('plan mode')).toBeNull();
    wide.unmount();

    viewport(1024);
    const narrow = renderApp({ path: '/s/a', state: on({ mode: 'plan' }) });
    await loaded();
    expect(screen.queryByText(/plan mode/)).toBeNull();
    narrow.unmount();

    renderApp({
      path: '/s/a',
      state: stateWith({ sessions: [session('a', { status: 'waiting', mode: 'plan' })], pending: [pending('a')], features: { controls: true } }),
    });
    expect(screen.queryByRole('group', { name: 'Controls' })).toBeNull();
    expect(screen.getByText(/plan mode/)).toBeTruthy();
  });

  it('sends Interrupt only after a 0.6 s hold, and says it went', async () => {
    const api = fakeApi({ sessionKey: vi.fn(async () => undefined) });
    renderApp({ path: '/s/a', api, state: on() });
    await loaded();
    const hold = within(bar()).getByRole('button', { name: /^Interrupt/ });
    vi.useFakeTimers();
    fireEvent.click(hold);
    fireEvent.pointerDown(hold, { button: 0 });
    act(() => vi.advanceTimersByTime(INTERRUPT_HOLD_MS - 100));
    fireEvent.pointerUp(hold);
    act(() => vi.advanceTimersByTime(1000));
    expect(api.sessionKey).not.toHaveBeenCalled();
    fireEvent.pointerDown(hold, { button: 0 });
    act(() => vi.advanceTimersByTime(INTERRUPT_HOLD_MS));
    vi.useRealTimers();
    expect(api.sessionKey).toHaveBeenCalledWith('a', 'interrupt');
    expect(await screen.findByText('Interrupt sent')).toBeTruthy();
  });

  it('clears the draft in the terminal with one tap', async () => {
    const api = fakeApi({ sessionKey: vi.fn(async () => undefined) });
    renderApp({ path: '/s/a', api, state: on() });
    await loaded();
    fireEvent.click(within(bar()).getByRole('button', { name: "Clear draft in the Mac's terminal" }));
    await waitFor(() => expect(api.sessionKey).toHaveBeenCalledWith('a', 'clearInput'));
    expect(await screen.findByText('Draft cleared in the terminal')).toBeTruthy();
  });

  it('shows a refusal with the daemon reason, in ink, until the next action', async () => {
    const api = fakeApi({
      sessionKey: vi
        .fn()
        .mockRejectedValueOnce(new ApiError('dialog_open', 'a dialog is open in the terminal; answer it there first', 409))
        .mockRejectedValueOnce(new ApiError('rate_limited', 'Ctrl+C went to this session less than 3 seconds ago', 429)),
    });
    renderApp({ path: '/s/a', api, state: on() });
    await loaded();
    fireEvent.click(within(bar()).getByRole('button', { name: "Clear draft in the Mac's terminal" }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Not sent: a dialog is open in the terminal; answer it there first');
    expect(alert.className).not.toMatch(/signal/);
    fireEvent.click(within(bar()).getByRole('button', { name: "Clear draft in the Mac's terminal" }));
    // The 3-second Ctrl+C rule keeps its own sentence (not "wait a minute").
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Not sent: Ctrl+C went to this session less than 3 seconds ago'));
  });

  it('disables every control offline', async () => {
    renderApp({ path: '/s/a', state: on(), status: 'offline' });
    await waitFor(() => expect(within(bar()).getByRole('button', { name: /^Interrupt/ })).toBeTruthy());
    const b = bar();
    for (const btn of within(b).getAllByRole('button')) expect((btn as HTMLButtonElement).disabled, btn.getAttribute('aria-label') ?? btn.textContent ?? '').toBe(true);
  });

  it('sits under the transcript on a phone, above the composer', async () => {
    viewport(390);
    renderApp({ path: '/s/a', state: on({ status: 'idle' }) });
    await loaded();
    const b = bar();
    const form = screen.getByRole('form', { name: 'Send a prompt' });
    expect(b.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(b.className).toContain('border-t');
  });
});

/** Hold the mode sheet's button for `ms` (2 s commits). */
async function holdToSwitch(ms = 2000) {
  const b = within(await screen.findByRole('dialog')).getByRole('button', { name: /^Hold to switch/ });
  vi.useFakeTimers();
  fireEvent.pointerDown(b, { button: 0 });
  act(() => vi.advanceTimersByTime(ms));
  fireEvent.pointerUp(b);
  vi.useRealTimers();
}

describe('the mode chip (C8)', () => {
  it('names the mode the session reports, or says it is not known', async () => {
    const r = renderApp({ path: '/s/a', state: on({ mode: 'acceptEdits' }) });
    await loaded();
    expect(chip().textContent).toBe('Accept edits');
    r.unmount();
    renderApp({ path: '/s/a', state: on({ mode: undefined }) });
    await loaded();
    expect(chip().getAttribute('aria-label')).toBe('Permission mode: Mode not known');
  });

  it('lists the modes in cycle order, the current one checked, and switches on a pick', async () => {
    let finish!: (v: { mode: 'plan'; steps: number }) => void;
    const api = fakeApi({ sessionMode: vi.fn(() => new Promise<{ mode: 'plan'; steps: number }>((r) => (finish = r))) });
    const { store } = renderApp({ path: '/s/a', api, state: on() });
    await loaded();
    fireEvent.click(chip());
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual([
      'ManualAsks before each edit and command',
      'Accept editsEdits files without asking',
      'PlanReads and plans, changes nothing',
      'Bypass permissionsNever asks',
      'AutoClaude decides when to ask',
    ]);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(items[2] as HTMLElement);
    expect(api.sessionMode).toHaveBeenCalledWith('a', 'plan');
    await waitFor(() => expect(chip().textContent).toContain('Switching to Plan'));
    expect(chip().disabled).toBe(true);
    await act(async () => finish({ mode: 'plan', steps: 2 }));
    await waitFor(() => expect(chip().textContent).toBe('Plan'));
    // The daemon's event agrees, and later modes come from the session again.
    emit(store, [{ seq: 11, ts: iso(1000), type: 'session.updated', sid: 'a', data: { patch: { mode: 'plan' } } }]);
    emit(store, [{ seq: 12, ts: iso(2000), type: 'session.updated', sid: 'a', data: { patch: { mode: 'auto' } } }]);
    await waitFor(() => expect(chip().textContent).toBe('Auto'));
  });

  it('greys a mode the session does not have, with the reason, after a 409', async () => {
    const api = fakeApi({ sessionMode: vi.fn(async () => Promise.reject(new ApiError('mode_unavailable', "bypass permissions is not in this session's cycle (it is now manual mode)", 409))) });
    renderApp({ path: '/s/a', api, state: on() });
    await loaded();
    fireEvent.click(chip());
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Bypass permissions/ }));
    await holdToSwitch();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("Could not switch to Bypass permissions: bypass permissions is not in this session's cycle (it is now manual mode)");
    expect(alert.className).not.toMatch(/signal/);
    await waitFor(() => expect(chip().disabled).toBe(false));
    fireEvent.click(chip());
    const bypass = await screen.findByRole('menuitemradio', { name: /^Bypass permissions/ });
    expect(bypass.getAttribute('aria-disabled')).toBe('true');
    expect(bypass.textContent).toContain("Not in this session's cycle");
    fireEvent.click(bypass);
    expect(api.sessionMode).toHaveBeenCalledTimes(1);
  });

  it('Bypass permissions and Auto take the start sheet\'s sentence and a 2-second hold, never one tap', async () => {
    const api = fakeApi({ sessionMode: vi.fn(async () => ({ mode: 'auto' as const, steps: 4 })) });
    renderApp({ path: '/s/a', api, state: on() });
    await loaded();
    for (const name of [/^Bypass permissions/, /^Auto/]) {
      fireEvent.click(chip());
      fireEvent.click(await screen.findByRole('menuitemradio', { name }));
      const sheet = await screen.findByRole('dialog');
      expect(within(sheet).getByText("Claude won't ask before running commands in this session.")).toBeTruthy();
      expect(within(sheet).getByRole('button', { name: 'Hold to switch. Hold for 2 seconds' })).toBeTruthy();
      expect(api.sessionMode).not.toHaveBeenCalled();
      fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    fireEvent.click(chip());
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Auto/ }));
    await holdToSwitch(1900);
    expect(api.sessionMode).not.toHaveBeenCalled();
    await holdToSwitch();
    await waitFor(() => expect(api.sessionMode).toHaveBeenCalledWith('a', 'auto', { confirm: true }));
    expect(api.sessionMode).toHaveBeenCalledTimes(1);
  });

  it('shows other refusals inline and stays usable', async () => {
    const api = fakeApi({ sessionMode: vi.fn(async () => Promise.reject(new ApiError('input_not_empty', "Claude's input box holds a draft", 409))) });
    renderApp({ path: '/s/a', api, state: on() });
    await loaded();
    fireEvent.click(chip());
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Plan/ }));
    expect((await screen.findByRole('alert')).textContent).toBe("Could not switch to Plan: Claude's input box holds a draft");
    await waitFor(() => expect(chip().disabled).toBe(false));
    expect(chip().textContent).toBe('Manual');
  });
});

describe('the commands menu and its sheets (C8)', () => {
  const ok = () => vi.fn(async () => ({ proven: true }));

  async function openItem(name: RegExp) {
    fireEvent.click(commands());
    fireEvent.click(await screen.findByRole('menuitem', { name }));
  }

  it('lists the six commands with their slash names', async () => {
    renderApp({ path: '/s/a', state: on() });
    await loaded();
    fireEvent.click(commands());
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Plan before acting/plan',
      'Change the model/model',
      'Change the effort/effort',
      'Compact the conversation/compact',
      'Rewind the conversation/rewind',
      'Clear the conversation/clear',
    ]);
  });

  it('sends /compact and /plan at once, and says whether Claude confirmed them', async () => {
    const api = fakeApi({ sessionCommand: vi.fn().mockResolvedValueOnce({ proven: true }).mockResolvedValueOnce({ proven: false }) });
    renderApp({ path: '/s/a', api, state: on() });
    await loaded();
    await openItem(/^Compact the conversation/);
    await waitFor(() => expect(api.sessionCommand).toHaveBeenCalledWith('a', { name: 'compact' }, expect.any(String)));
    expect(await screen.findByText('Claude ran /compact')).toBeTruthy();
    await waitFor(() => expect(commands().disabled).toBe(false));
    await openItem(/^Plan before acting/);
    expect(await screen.findByText('Typed /plan; Claude has not confirmed it yet')).toBeTruthy();
    // A fresh Idempotency-Key per tap.
    const keys = api.sessionCommand.mock.calls.map((c: unknown[]) => c[2]);
    expect(new Set(keys).size).toBe(2);
  });

  it('/clear and /rewind go only from their confirm sheet, with confirm: true', async () => {
    const api = fakeApi({ sessionCommand: ok() });
    renderApp({ path: '/s/a', api, state: on() });
    await loaded();
    await openItem(/^Clear the conversation/);
    const sheet = await screen.findByRole('dialog', { name: 'Clear the conversation?' });
    expect(sheet.textContent).toContain('starts again with an empty context');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Clear the conversation?' })).toBeNull());
    expect(api.sessionCommand).not.toHaveBeenCalled();

    await openItem(/^Clear the conversation/);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Clear the conversation?' })).getByRole('button', { name: 'Clear conversation' }));
    await waitFor(() => expect(api.sessionCommand).toHaveBeenCalledWith('a', { name: 'clear', confirm: true }, expect.any(String)));
    expect(await screen.findByText('Claude ran /clear')).toBeTruthy();

    await waitFor(() => expect(commands().disabled).toBe(false));
    await openItem(/^Rewind the conversation/);
    const rewind = await screen.findByRole('dialog', { name: 'Rewind the conversation?' });
    expect(rewind.textContent).toContain('Pick one at the Mac');
    fireEvent.click(within(rewind).getByRole('button', { name: 'Open the rewind list' }));
    await waitFor(() => expect(api.sessionCommand).toHaveBeenLastCalledWith('a', { name: 'rewind', confirm: true }, expect.any(String)));
  });

  it('/model and /effort offer only the allowed words and warn that Claude keeps them as the default', async () => {
    const api = fakeApi({ sessionCommand: ok() });
    renderApp({ path: '/s/a', api, state: on() });
    await loaded();
    await openItem(/^Change the model/);
    const model = await screen.findByRole('dialog', { name: 'Change the model' });
    expect(model.textContent).toContain('Claude also keeps it as the default for new sessions.');
    expect(within(model).getAllByRole('button').map((b) => b.textContent)).toEqual(['Default', 'Opus', 'Sonnet', 'Haiku', 'Fable']);
    fireEvent.click(within(model).getByRole('button', { name: 'Opus' }));
    await waitFor(() => expect(api.sessionCommand).toHaveBeenCalledWith('a', { name: 'model', args: 'opus' }, expect.any(String)));
    expect(await screen.findByText('Claude ran /model opus')).toBeTruthy();

    await waitFor(() => expect(commands().disabled).toBe(false));
    await openItem(/^Change the effort/);
    const effort = await screen.findByRole('dialog', { name: 'Change the effort' });
    expect(effort.textContent).toContain('(Max is for this session only)');
    fireEvent.click(within(effort).getByRole('button', { name: 'Extra high' }));
    await waitFor(() => expect(api.sessionCommand).toHaveBeenLastCalledWith('a', { name: 'effort', args: 'xhigh' }, expect.any(String)));
  });

  it('shows a refused command with the reason', async () => {
    const api = fakeApi({ sessionCommand: vi.fn(async () => Promise.reject(new ApiError('refused', 'a permission card is open for this session; answer it first', 422))) });
    renderApp({ path: '/s/a', api, state: on() });
    await loaded();
    await openItem(/^Compact the conversation/);
    expect((await screen.findByRole('alert')).textContent).toBe('/compact not sent: a permission card is open for this session; answer it first');
  });
});

describe('design rules for session/controls (spec 5.0)', () => {
  const dir = join(__dirname, '..', 'src', 'ui', 'screens', 'session', 'controls');
  const code = readdirSync(dir).map((f) => ({ f, text: readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1') }));

  it('uses no ember: refusals and errors are ink', () => {
    expect(code.filter((c) => /\b(?:text|bg|border|fill|stroke|outline|ring|decoration)-(?:signal|badge|on-signal)|--signal|--badge/.test(c.text)).map((c) => c.f)).toEqual([]);
  });

  it('has no colour literals, arbitrary sizes, em dashes or exclamation marks in strings', () => {
    expect(code.filter((c) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|oklch\(|-\[|—/.test(c.text)).map((c) => c.f)).toEqual([]);
    expect(code.filter((c) => /[a-z]![\s'"`<]/i.test(c.text)).map((c) => c.f)).toEqual([]);
  });
});
