import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api.js';
import { account, emit, fakeApi, iso, pending, renderApp, session, stateWith } from './helpers.js';

const card = () => screen.getByRole('article');

describe('session screen', () => {
  it('shows folder, session, status, account and the last reply as safe markdown', async () => {
    renderApp({
      path: '/s/web-app',
      state: stateWith({
        sessions: [
          session('web-app', {
            status: 'idle',
            account: 2,
            name: 'fix login',
            lastReply: { text: 'I **fixed** it.\n\n<img src=x onerror="alert(1)">', at: iso(1000) },
          }),
        ],
        accounts: [account(2, { alias: 'side' })],
      }),
    });
    expect(screen.getByRole('heading', { level: 1, name: 'web-app' })).toBeTruthy();
    expect(screen.getByText('fix login')).toBeTruthy();
    // Status is the glyph plus its word (no pills): idle reads "Your turn".
    expect(screen.getByRole('img', { name: 'Your turn' })).toBeTruthy();
    expect(screen.getAllByText('02 side').length).toBeGreaterThan(0);
    const reply = await screen.findByRole('tabpanel', { name: 'Transcript' });
    expect(within(reply).getByText('fixed').tagName).toBe('STRONG');
    expect(reply.querySelector('img')).toBeNull();
    expect(reply.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('says when the session is gone', () => {
    renderApp({ path: '/s/missing', state: stateWith({ sessions: [session('other')] }) });
    expect(screen.getByText('This session is gone')).toBeTruthy();
  });

  it('a sid that names an Object.prototype member is no session (no crash, nothing borrowed)', () => {
    for (const sid of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const { unmount } = renderApp({ path: `/s/${sid}`, state: stateWith({ sessions: [session('other')] }) });
      expect(screen.getByText('This session is gone'), sid).toBeTruthy();
      unmount();
    }
  });

  it('brings the tab to the front on the Mac', async () => {
    const api = fakeApi();
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    fireEvent.click(screen.getByRole('button', { name: /Show on Mac/ }));
    await waitFor(() => expect(api.focus).toHaveBeenCalledWith('a'));
    expect(await screen.findByText('Brought the tab to the front on the Mac')).toBeTruthy();
  });

  it('peeks at the screen, and explains an unreadable terminal', async () => {
    const api = fakeApi({
      getScreen: vi
        .fn()
        .mockResolvedValueOnce({ text: '\u001b[32m> npm test\u001b[0m\n  12 passing', lines: 2, at: iso(0), backend: 'terminal-app' })
        .mockRejectedValueOnce(new ApiError('unavailable', 'terminal unreadable', 503)),
    });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')] }) });
    fireEvent.click(screen.getByRole('tab', { name: 'Screen' }));
    await waitFor(() => expect(screen.getByLabelText('Terminal text').textContent).toBe('> npm test\n  12 passing'));
    expect(api.getScreen).toHaveBeenCalledWith('a', 80);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText(/could not be read right now/)).toBeTruthy();
  });

  it('loads the newest page on open and shows it oldest first', async () => {
    const api = fakeApi({
      getTranscript: vi.fn(async () => ({
        items: [
          { id: 'u2', role: 'assistant' as const, kind: 'text' as const, text: 'Second **reply**' },
          { id: 'u1', role: 'user' as const, kind: 'text' as const, text: 'First question' },
        ],
        nextBefore: null,
      })),
    });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')] }) });
    // The newest page loads with the screen; no accordion to open.
    await waitFor(() => expect(document.querySelectorAll('[data-item]').length).toBe(2));
    const msgs = Array.from(document.querySelectorAll('[data-item]')).map((m) => m.textContent);
    expect(msgs[0]).toContain('First question');
    expect(msgs[1]).toContain('Second reply');
    expect(api.getTranscript).toHaveBeenCalledWith('a', { limit: 50 });
  });

  it('loads earlier messages from the cursor and folds tool calls', async () => {
    const getTranscript = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          { id: 'n3', role: 'assistant' as const, kind: 'text' as const, text: 'All green.' },
          { id: 'n2', role: 'assistant' as const, kind: 'tool_use' as const, tool: 'Bash', text: 'npm test', at: iso(70_000) },
          { id: 'n1', role: 'assistant' as const, kind: 'tool_use' as const, tool: 'Read', text: 'src/a.ts', at: iso(10_000) },
        ],
        nextBefore: '1200',
      })
      .mockResolvedValueOnce({ items: [{ id: 'o1', role: 'user' as const, kind: 'text' as const, text: 'Run the tests' }], nextBefore: null });
    const api = fakeApi({ getTranscript });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    const fold = await screen.findByRole('button', { name: /2 tool calls · Read 1 · Bash 1 · 1m00s/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    expect(within(screen.getByRole('list', { name: 'Tool calls' })).getByText('npm test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier messages' }));
    await waitFor(() => expect(getTranscript).toHaveBeenLastCalledWith('a', { before: '1200', limit: 50 }));
    await waitFor(() => expect(document.querySelector('[data-item]')?.textContent).toContain('Run the tests'));
    expect(screen.queryByRole('button', { name: 'Earlier messages' })).toBeNull();
  });

  it('replaces the composer with the dock while a card is open, and has none once the session ended', () => {
    const { unmount } = renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a')], pending: [pending('a')] }) });
    expect(screen.getByRole('article')).toBeTruthy();
    expect(screen.queryByLabelText('Prompt for Claude')).toBeNull();
    unmount();
    renderApp({ path: '/s/b', state: stateWith({ sessions: [session('b', { status: 'ended' })] }) });
    expect(screen.queryByLabelText('Prompt for Claude')).toBeNull();
    expect(screen.getByText('This session has ended.')).toBeTruthy();
  });

  it('shows what Claude waits for in the terminal when there is no card', async () => {
    const api = fakeApi({ getScreen: vi.fn(async () => ({ text: 'Do you trust this folder?\n> 1. Yes', lines: 2, at: iso(0), backend: 'terminal-app' })) });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })] }) });
    expect(within(card()).getByRole('heading', { name: 'Claude is waiting in the terminal' })).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Last lines of the terminal').textContent).toContain('Do you trust this folder?'));
    // v0.4.2: the session screen's one read, KEYPAD_LINES lines (every line the keypad's check covers).
    expect(api.getScreen).toHaveBeenCalledWith('a', 40);
    expect(screen.queryByLabelText('Prompt for Claude')).toBeNull();
    // No copy that sends the user to the Mac as the only way.
    expect(card().textContent).not.toMatch(/no card to answer|only at the Mac/);
  });

  it('tells you before sending a prompt the daemon would refuse', () => {
    renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    const box = screen.getByLabelText('Prompt for Claude') as HTMLTextAreaElement;
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    fireEvent.change(box, { target: { value: '!rm -rf dist' } });
    expect(send.disabled).toBe(true);
    expect(screen.getByText(/runs as a shell command in Claude's bash mode/)).toBeTruthy();
    fireEvent.change(box, { target: { value: '/clear' } });
    expect(send.disabled).toBe(true);
    expect(screen.getByText(/^\/clear starts a new transcript/)).toBeTruthy();
    fireEvent.change(box, { target: { value: '/compact keep the notes' } });
    expect(send.disabled).toBe(false);
  });

  it('disables the composer offline, with the reason', () => {
    renderApp({ path: '/s/a', status: 'offline', state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    expect((screen.getByLabelText('Prompt for Claude') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getAllByText("Offline: can't send right now").length).toBeGreaterThan(0);
  });

  it('steps through the needs-you queue and offers the next one after answering', async () => {
    const api = fakeApi();
    const first = pending('a', { createdAt: iso(10_000) });
    const second = pending('b', { kind: 'plan', tool: 'ExitPlanMode', input: { plan: 'Do it' }, createdAt: iso(20_000) });
    const { history } = renderApp({
      path: '/s/a',
      api,
      state: stateWith({ sessions: [session('a', { status: 'waiting' }), session('b', { status: 'waiting' }), session('c', { status: 'idle' })], pending: [first, second] }),
    });
    expect(screen.getByLabelText('Session 1 of 2')).toBeTruthy();
    fireEvent.click(within(card()).getByRole('button', { name: /^Yes$/ }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(first.id, { behavior: 'allow' }));
    const receipt = await screen.findByRole('status', { name: 'Answer sent' });
    expect(receipt.textContent).toContain('Allowed once');
    expect(receipt.textContent).toContain('waiting for Claude');
    fireEvent.click(within(receipt).getByRole('button', { name: /Next: b · Plan/ }));
    expect(history.entries.at(-1)).toBe('/s/b');
  });
});

describe('permission card', () => {
  it('allows once and denies', async () => {
    const api = fakeApi();
    const p = pending('a', { tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' } });
    const { unmount } = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    expect(within(card()).getByText('Run this in a?')).toBeTruthy();
    expect(within(card()).getByText('Run the tests')).toBeTruthy();
    expect(within(card()).getByText('npm test').tagName).toBe('PRE');
    fireEvent.click(within(card()).getByRole('button', { name: /^Yes$/ }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow' }));
    // No toast: the dock turns into a receipt.
    expect((await screen.findByRole('status', { name: 'Answer sent' })).textContent).toContain('Allowed once');
    unmount();

    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    const deny = within(card()).getByRole('button', { name: /^No$/ });
    fireEvent.click(deny);
    expect(deny.getAttribute('aria-expanded')).toBe('true');
    expect(api.decide).toHaveBeenCalledTimes(1);
    fireEvent.click(within(card()).getByRole('button', { name: 'Send No' }));
    await waitFor(() => expect(api.decide).toHaveBeenLastCalledWith(p.id, { behavior: 'deny' }));
  });

  it('holds for 2 seconds to always allow a Bash rule, and prints the rule it saves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = fakeApi();
      const p = pending('a', {
        suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }],
      });
      renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
      const btn = within(card()).getByRole('button', { name: /Always allow Bash\(npm test:\*\) for this project \(local\)\. Hold for 2 seconds/ });
      expect(btn.textContent).toContain('Always allow');
      expect(card().textContent).toContain('It saves the rule Bash(npm test:*) for this project (local).');
      // A click, or letting go early, sends nothing.
      fireEvent.click(btn);
      fireEvent.pointerDown(btn, { button: 0 });
      act(() => vi.advanceTimersByTime(1500));
      fireEvent.pointerUp(btn);
      act(() => vi.advanceTimersByTime(1000));
      expect(api.decide).not.toHaveBeenCalled();
      fireEvent.pointerDown(btn, { button: 0 });
      act(() => vi.advanceTimersByTime(2000));
      await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', suggestion: 0, confirm: true }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('always-allows other tools with one tap, and asks again if the daemon wants a confirm', async () => {
    const decide = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('needs_confirm', 'confirm', 409))
      .mockResolvedValue({ pending: pending('a') });
    const api = fakeApi({ decide });
    const p = pending('a', {
      tool: 'Edit',
      input: { file_path: '/synthetic/src/a.ts', old_string: 'a', new_string: 'b' },
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    fireEvent.click(within(card()).getByRole('button', { name: /switch to auto-accept edits/ }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', suggestion: 0 }));
    const confirm = await within(card()).findByRole('button', { name: /Tap again to confirm/ });
    fireEvent.click(confirm);
    await waitFor(() => expect(decide).toHaveBeenLastCalledWith(p.id, { behavior: 'allow', suggestion: 0, confirm: true }));
  });

  it('denies with a note and stops the turn', async () => {
    const api = fakeApi();
    const p = pending('a');
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    fireEvent.click(within(card()).getByRole('button', { name: /^No$/ }));
    fireEvent.change(within(card()).getByLabelText(/Tell Claude what to do instead/), { target: { value: 'Use the staging DB' } });
    fireEvent.click(within(card()).getByRole('button', { name: 'No, and stop Claude' }));
    await waitFor(() =>
      expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'deny', message: 'Use the staging DB', interrupt: true }),
    );
  });

  it('explains a card that was already answered', async () => {
    const api = fakeApi({ decide: vi.fn().mockRejectedValue(new ApiError('conflict', 'closed', 409)) });
    const p = pending('a');
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    fireEvent.click(within(card()).getByRole('button', { name: /^Yes$/ }));
    expect((await within(card()).findByRole('alert')).textContent).toBe('This card was already answered or closed.');
  });

  it('turns a card answered elsewhere into a receipt, then says Claude picked it up', () => {
    const p = pending('a');
    const { store } = renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a')], pending: [p], seq: 10 }) });
    act(() => emit(store, [{ seq: 11, ts: iso(70_000), type: 'pending.resolved', sid: 'a', data: { id: p.id, state: 'decided', decidedBy: 'device:dev-1' } }]));
    const receipt = screen.getByRole('status', { name: 'Answer sent' });
    expect(receipt.textContent).toContain('Answered on another device');
    expect(receipt.textContent).toContain('waiting for Claude');
    expect(screen.queryByRole('button', { name: /^Yes$/ })).toBeNull();
    act(() => emit(store, [{ seq: 12, ts: iso(71_000), type: 'pending.resolved', sid: 'a', data: { id: p.id, state: 'confirmed' } }]));
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.getByRole('status', { name: 'Answer sent' }).textContent).toContain('Claude picked it up');
  });
});

describe('session keys (desktop)', () => {
  beforeEach(() =>
    vi.stubGlobal('matchMedia', (query: string) => {
      const m = /min-width:\s*(\d+)px/.exec(query);
      return { matches: m ? 1440 >= Number(m[1]) : false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined };
    }),
  );
  afterEach(() => vi.unstubAllGlobals());

  it('a allows once, d opens the deny note, and "g a" still only jumps to Accounts', async () => {
    const api = fakeApi();
    const p = pending('a');
    const { history } = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    fireEvent.keyDown(window, { key: 'd' });
    expect(within(card()).getByRole('button', { name: /^No$/ }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'a' });
    expect(history.entries.at(-1)).toBe('/accounts');
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('a allows once when focus is in the session pane', async () => {
    const api = fakeApi();
    const p = pending('a');
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    fireEvent.keyDown(document.body, { key: 'a' });
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow' }));
  });
});

describe('question card', () => {
  const questions = [
    { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }] },
    { question: 'Which features?', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }] },
  ];

  it('answers single and multi choice, keyed by question text', async () => {
    const api = fakeApi();
    const p = pending('a', { kind: 'question', tool: 'AskUserQuestion', input: { questions }, questions });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    const send = within(card()).getByRole('button', { name: /Send answers/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(within(card()).getByLabelText(/Postgres/));
    expect(send.disabled).toBe(true);
    fireEvent.click(within(card()).getByLabelText(/Auth/));
    fireEvent.click(within(card()).getByLabelText(/Billing/));
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() =>
      expect(api.decide).toHaveBeenCalledWith(p.id, {
        behavior: 'allow',
        answers: { 'Which database?': 'Postgres', 'Which features?': ['Auth', 'Billing'] },
      }),
    );
  });

  it('takes a typed Other answer', async () => {
    const api = fakeApi();
    const one = [questions[0]!];
    const p = pending('a', { kind: 'question', tool: 'AskUserQuestion', input: { questions: one }, questions: one });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    fireEvent.click(within(card()).getByLabelText(/SQLite/));
    fireEvent.change(within(card()).getByLabelText('Other answer to: Which database?'), { target: { value: 'DuckDB' } });
    fireEvent.click(within(card()).getByRole('button', { name: /Send answer/ }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', answers: { 'Which database?': 'DuckDB' } }));
  });

  it('reads questions from the tool input when the card has none', () => {
    const p = pending('a', { kind: 'question', tool: 'AskUserQuestion', input: { questions: [questions[0]] } });
    renderApp({ path: '/s/a', state: stateWith({ sessions: [session('a')], pending: [p] }) });
    expect(within(card()).getByText('Which database?')).toBeTruthy();
  });
});

describe('plan card', () => {
  const plan = '# Plan\n1. Add a migration\n2. Update the API';

  it('approves with auto-accept or ask-first', async () => {
    const api = fakeApi();
    const p = pending('a', { kind: 'plan', tool: 'ExitPlanMode', input: { plan } });
    const { unmount } = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    expect(within(card()).getByText('Add a migration').tagName).toBe('LI');
    fireEvent.click(within(card()).getByRole('button', { name: /auto-accept edits/ }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', mode: 'acceptEdits' }));
    expect((await screen.findByRole('status', { name: 'Answer sent' })).textContent).toContain('Approved, auto-accept edits');
    unmount();
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    fireEvent.click(within(card()).getByRole('button', { name: /manually approve edits/ }));
    await waitFor(() => expect(api.decide).toHaveBeenLastCalledWith(p.id, { behavior: 'allow', mode: 'default' }));
  });

  it('sends revise feedback as a deny with a message', async () => {
    const api = fakeApi();
    const p = pending('a', { kind: 'plan', tool: 'ExitPlanMode', input: { plan } });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    fireEvent.click(within(card()).getByRole('button', { name: /Tell Claude what to change/ }));
    const send = within(card()).getByRole('button', { name: /Send feedback/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(card()).getByLabelText(/What should change/), { target: { value: 'Split step 2' } });
    fireEvent.click(send);
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'deny', message: 'Split step 2' }));
  });
});

describe('subagent card', () => {
  it('opens the terminal dialog dock, "A subagent asks", with Show on Mac (v0.4.2)', async () => {
    const api = fakeApi();
    const p = pending('a', { kind: 'subagent-info', tool: 'Bash', agentId: 'agent-1' });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    expect(within(card()).getByRole('heading', { name: 'A subagent asks · Bash' })).toBeTruthy();
    expect(within(card()).getByText('npm test').tagName).toBe('PRE');
    expect(card().textContent).not.toMatch(/only be answered at the Mac/);
    // Its prompt is read from the screen at once (a subagent card reads as often as waiting).
    await waitFor(() => expect(api.getScreen).toHaveBeenCalledWith('a', 40));
    fireEvent.click(within(card()).getByRole('button', { name: /Show on Mac/ }));
    await waitFor(() => expect(api.focus).toHaveBeenCalledWith('a'));
    // The writer refuses a prompt while a subagent waits, so the dock takes the composer's place.
    expect(screen.queryByLabelText('Prompt for Claude')).toBeNull();
  });
});
