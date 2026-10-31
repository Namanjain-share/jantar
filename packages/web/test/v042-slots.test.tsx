/**
 * Wave 0's v0.4.2 slots: the dock where v0.4.1's WaitingCard was
 * (session/TermDialog.tsx) fed by the session screen's one terminal read
 * (session/screen.ts), and the composer with its attachment slots
 * (session/attach/). With the stubs the phone behaves as v0.4.1 did; these
 * tests look only at what stays true once lanes L2 and L5 fill the slots.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, iso, renderApp, session, stateWith } from './helpers.js';

const TERMINAL = 'Pick a region\n❯ North\n  South\nEnter to confirm · Esc to cancel';
const read = () => vi.fn(async (_sid: string, _lines?: number) => ({ text: TERMINAL, lines: 4, at: iso(0), backend: 'terminal-app' }));

describe('the dock for a dialog with no card', () => {
  it('shows while Claude waits in the terminal, reads the screen, keeps Show on Mac, and hides the composer', async () => {
    const getScreen = read();
    const api = fakeApi({ getScreen });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })] }) });
    expect(screen.getByRole('heading', { name: 'Claude is waiting in the terminal' })).toBeTruthy();
    await waitFor(() => expect(getScreen).toHaveBeenCalled());
    expect(getScreen.mock.calls.every(([sid]) => sid === 'a')).toBe(true);
    await waitFor(() => expect(document.body.textContent).toContain('Pick a region'));
    expect(screen.queryByLabelText('Prompt for Claude')).toBeNull();
    const show = screen.getAllByRole('button', { name: 'Show on Mac' });
    fireEvent.click(show[show.length - 1] as HTMLElement);
    await waitFor(() => expect(api.focus).toHaveBeenCalledWith('a'));
  });

  it('a hook card still takes the dock first', () => {
    const api = fakeApi({ getScreen: read() });
    const card = {
      id: '01JTESTPENDINGSLOT0001abcdefghijklmnop',
      sid: 'a',
      kind: 'permission' as const,
      tool: 'Bash',
      input: { command: 'npm test' },
      suggestions: [],
      correlationKey: 'a|Bash|{}',
      createdAt: iso(60_000),
      settleUntil: iso(63_000),
      state: 'open' as const,
    };
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [card] }) });
    expect(screen.queryByRole('heading', { name: 'Claude is waiting in the terminal' })).toBeNull();
  });

  it('reads nothing for an idle session while the Screen tab is closed', async () => {
    const api = fakeApi({ getScreen: read() });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    expect(screen.getByLabelText('Prompt for Claude')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(api.getScreen).not.toHaveBeenCalled();
  });
});

describe('the composer with its attachment slots', () => {
  it('sends typed text as before', async () => {
    const api = fakeApi();
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    const form = screen.getByRole('form', { name: 'Send a prompt' });
    fireEvent.change(within(form).getByLabelText('Prompt for Claude'), { target: { value: 'Run the tests again' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    const [sid, text, key] = api.sendPrompt.mock.calls[0] ?? [];
    expect([sid, text]).toEqual(['a', 'Run the tests again']);
    expect(typeof key).toBe('string');
    expect(api.uploadCreate).not.toHaveBeenCalled();
  });

  it('a blank box with no files sends nothing', () => {
    const api = fakeApi();
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });
});
