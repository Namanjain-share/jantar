/**
 * v0.4.2 hook cards (spec 4.1, screenshots 43 and mac-1): Claude's own rows
 * and wording on the plan, permission and question cards, and the exact
 * bodies they send. A plan card shows only the modes it offers
 * (`planModes`); the permission card folds every session-scoped suggestion
 * into Claude's one "for this session" row.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLARIFY_MESSAGE, DIALOG_HOLD_COPY } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { sessionRow, sessionRowLabel } from '../src/lib/describe.js';
import { fakeApi, pending, renderApp, session, stateWith } from './helpers.js';

const card = () => screen.getByRole('article');
/** The card's answer buttons, by name (the sheet's own fold control left out). */
const buttons = () =>
  within(card())
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '')
    .filter((name) => name !== 'Fold the panel');

const DIRS = { type: 'addDirectories', directories: ['/synthetic/home/.claude/plans', '/synthetic/home/work/demo/plans'], destination: 'session' };
const ACCEPT_EDITS = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
const READS = { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//synthetic/home/notes/**' }], behavior: 'allow', destination: 'session' };
const PROJECT_RULE = { type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: 'docs/**' }], behavior: 'allow', destination: 'localSettings' };
const WRITE_INPUT = { file_path: '/synthetic/home/work/demo/notes.md', content: 'hello' };

/** Hold a HoldButton for its 2 seconds. */
function hold(btn: HTMLElement) {
  fireEvent.pointerDown(btn, { button: 0 });
  act(() => vi.advanceTimersByTime(2000));
}

afterEach(() => vi.useRealTimers());

describe('plan card rows come from planModes', () => {
  const plan = '# Plan\n1. Add a migration';

  it("a session that ran in auto mode: Claude's three rows, auto held and confirmed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi();
    const p = pending('a', { kind: 'plan', tool: 'ExitPlanMode', input: { plan }, planModes: ['auto', 'default'] });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    expect(buttons()).toEqual(['Yes, and use auto mode. Hold for 2 seconds', 'Yes, manually approve edits', 'Tell Claude what to change…']);
    expect(within(card()).queryByRole('button', { name: /auto-accept edits/ })).toBeNull();
    expect(card().textContent).toContain(DIALOG_HOLD_COPY.mode);

    // A tap, or letting go early, sends nothing.
    const auto = within(card()).getByRole('button', { name: /use auto mode/ });
    fireEvent.click(auto);
    fireEvent.pointerDown(auto, { button: 0 });
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.pointerUp(auto);
    expect(api.decide).not.toHaveBeenCalled();
    hold(auto);
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', mode: 'auto', confirm: true }));
    expect((await screen.findByRole('status', { name: 'Answer sent' })).textContent).toContain('Approved, auto mode');
  });

  it('manually approve edits sends default, with no confirm', async () => {
    const api = fakeApi();
    const p = pending('a', { kind: 'plan', tool: 'ExitPlanMode', input: { plan }, planModes: ['auto', 'default'] });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    fireEvent.click(within(card()).getByRole('button', { name: 'Yes, manually approve edits' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', mode: 'default' }));
  });

  it('otherwise (or on a card that names no modes) it offers auto-accept edits, never auto', async () => {
    for (const planModes of [['acceptEdits', 'default'] as const, undefined]) {
      const api = fakeApi();
      const p = pending('a', { kind: 'plan', tool: 'ExitPlanMode', input: { plan }, ...(planModes ? { planModes: [...planModes] } : {}) });
      const { unmount } = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
      expect(buttons()).toEqual(['Yes, auto-accept edits', 'Yes, manually approve edits', 'Tell Claude what to change…']);
      expect(card().textContent).not.toContain(DIALOG_HOLD_COPY.mode);
      fireEvent.click(within(card()).getByRole('button', { name: 'Yes, auto-accept edits' }));
      await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', mode: 'acceptEdits' }));
      unmount();
    }
  });

  it('a request with no plan text sends the user to the Mac (not the Transcript, which has no plan) before approving', async () => {
    const api = fakeApi();
    const p = pending('a', { kind: 'plan', tool: 'ExitPlanMode', input: {}, planModes: ['acceptEdits', 'default'] });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    expect(card().textContent).toContain("this request doesn't carry the plan. Read it at the Mac before you approve.");
    expect(card().textContent).not.toContain('Transcript');
    expect(within(card()).queryByLabelText('Plan text')).toBeNull();
    // The rows are still Claude's; the line says where to look first, and its button brings the tab forward.
    expect(buttons()).toContain('Yes, manually approve edits');
    fireEvent.click(within(card()).getByRole('button', { name: 'Show on Mac' }));
    await waitFor(() => expect(api.focus).toHaveBeenCalledWith('a'));
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('Tell Claude what to change needs the note, then sends it', async () => {
    const api = fakeApi();
    const p = pending('a', { kind: 'plan', tool: 'ExitPlanMode', input: { plan }, planModes: ['auto', 'default'] });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    const tell = within(card()).getByRole('button', { name: 'Tell Claude what to change…' });
    fireEvent.click(tell);
    expect(tell.getAttribute('aria-expanded')).toBe('true');
    const send = within(card()).getByRole('button', { name: 'Send feedback' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(card()).getByLabelText(/What should change/), { target: { value: 'Split step 2' } });
    fireEvent.click(send);
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'deny', message: 'Split step 2' }));
  });
});

describe('the session row (mac-1, option 2)', () => {
  it('builds the label from every session-scoped suggestion, in Claude words', () => {
    expect(sessionRowLabel([DIRS, ACCEPT_EDITS])).toBe(
      'Yes, and allow access to /synthetic/home/.claude/plans, /synthetic/home/work/demo/plans; switch to auto-accept edits for this session',
    );
    expect(sessionRowLabel([READS])).toBe('Yes, and allow reading from /synthetic/home/notes for this session');
    expect(sessionRowLabel([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }])).toBe(
      'Yes, and switch to bypass permissions for this session',
    );
    expect(sessionRowLabel([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }])).toBe(
      'Yes, and allow Bash(npm test:*) for this session',
    );
    expect(sessionRow([PROJECT_RULE], 'Write')).toBeNull();
    expect(sessionRow([PROJECT_RULE, DIRS, READS], 'Write')).toMatchObject({ indices: [1, 2], dangerous: false });
    expect(sessionRow([DIRS], 'Bash')?.dangerous).toBe(true);
    expect(sessionRow([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }], 'Edit')?.dangerous).toBe(true);
    // Auto mode is held as bypass is (CONFIRM_MODES, the daemon's suggestionNeedsConfirm).
    expect(sessionRow([DIRS, { type: 'setMode', mode: 'auto', destination: 'session' }], 'Edit')).toMatchObject({
      dangerous: true,
      label: 'Yes, and allow access to /synthetic/home/.claude/plans, /synthetic/home/work/demo/plans; switch to auto mode for this session',
    });
    expect(sessionRow([ACCEPT_EDITS], 'Edit')?.dangerous).toBe(false);
    // More than a decision can name: no combined row (each keeps its own).
    expect(sessionRow(Array.from({ length: 9 }, () => DIRS), 'Write')).toBeNull();
  });

  it('shows Yes, the one session row, the project rule, No and No-and-stop, in that order, and sends every session index', async () => {
    const api = fakeApi();
    const p = pending('a', { tool: 'Write', input: WRITE_INPUT, suggestions: [DIRS, PROJECT_RULE, ACCEPT_EDITS] });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    const label = 'Yes, and allow access to /synthetic/home/.claude/plans, /synthetic/home/work/demo/plans; switch to auto-accept edits for this session';
    expect(buttons()).toEqual(['Yes', label, 'Always allow Edit(docs/**) for this project (local)', 'No', 'No, and stop Claude']);
    fireEvent.click(within(card()).getByRole('button', { name: label }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', suggestions: [0, 2] }));
    expect((await screen.findByRole('status', { name: 'Answer sent' })).textContent).toContain('Allowed for this session');
  });

  it('a single session suggestion goes as `suggestion`, the same answer', async () => {
    const api = fakeApi();
    const p = pending('a', { tool: 'Read', input: { file_path: '/synthetic/home/notes/a.md' }, suggestions: [READS] });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    fireEvent.click(within(card()).getByRole('button', { name: 'Yes, and allow reading from /synthetic/home/notes for this session' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', suggestion: 0 }));
  });

  it('holds when one of them needs the second tap, and says so in full', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi();
    const p = pending('a', { tool: 'Bash', input: { command: 'cat /synthetic/home/.claude/plans/a.md' }, suggestions: [DIRS, ACCEPT_EDITS] });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    const row = within(card()).getByRole('button', { name: /for this session\. Hold for 2 seconds$/ });
    expect(card().textContent).toContain('It lasts until this session ends.');
    fireEvent.click(row);
    expect(api.decide).not.toHaveBeenCalled();
    hold(row);
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', suggestions: [0, 1], confirm: true }));
  });

  it('asks for a second tap when the daemon wants a confirm', async () => {
    const decide = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('needs_confirm', 'confirm', 409))
      .mockResolvedValue({ pending: pending('a') });
    const api = fakeApi({ decide });
    const p = pending('a', { tool: 'Write', input: WRITE_INPUT, suggestions: [DIRS, ACCEPT_EDITS] });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    fireEvent.click(within(card()).getByRole('button', { name: /for this session$/ }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', suggestions: [0, 1] }));
    fireEvent.click(await within(card()).findByRole('button', { name: /Tap again to confirm/ }));
    await waitFor(() => expect(decide).toHaveBeenLastCalledWith(p.id, { behavior: 'allow', suggestions: [0, 1], confirm: true }));
  });
});

describe('Yes and No on a permission card', () => {
  it('Yes allows once; No takes an optional note; No, and stop Claude ends the turn', async () => {
    const api = fakeApi();
    const p = pending('a', { tool: 'Write', input: WRITE_INPUT });
    const { unmount } = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    expect(buttons()).toEqual(['Yes', 'No', 'No, and stop Claude']);
    fireEvent.click(within(card()).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow' }));
    expect((await screen.findByRole('status', { name: 'Answer sent' })).textContent).toContain('Allowed once');
    unmount();

    const again = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    const no = within(card()).getByRole('button', { name: 'No' });
    fireEvent.click(no);
    expect(no.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(within(card()).getByLabelText('Tell Claude what to do instead (optional)'), { target: { value: 'Use the staging copy' } });
    fireEvent.click(within(card()).getByRole('button', { name: 'Send No' }));
    await waitFor(() => expect(api.decide).toHaveBeenLastCalledWith(p.id, { behavior: 'deny', message: 'Use the staging copy' }));
    again.unmount();

    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    fireEvent.click(within(card()).getByRole('button', { name: 'No, and stop Claude' }));
    await waitFor(() => expect(api.decide).toHaveBeenLastCalledWith(p.id, { behavior: 'deny', interrupt: true }));
  });
});

describe('question card', () => {
  const questions = [
    { question: 'Which level?', header: 'Level', options: [{ label: 'Junior', description: 'Needs the most direction' }, { label: 'Senior' }] },
  ];

  it('offers Type something… and sends the typed answer', async () => {
    const api = fakeApi();
    const p = pending('a', { kind: 'question', tool: 'AskUserQuestion', input: { questions }, questions });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: [p] }) });
    expect(within(card()).getByText('Type something…')).toBeTruthy();
    expect(within(card()).queryByText('Other')).toBeNull();
    fireEvent.change(within(card()).getByPlaceholderText('Your own answer'), { target: { value: 'Mid level' } });
    fireEvent.click(within(card()).getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'allow', answers: { 'Which level?': 'Mid level' } }));
  });

  it("Chat about this declines with Claude's own sentence; Decline still declines plainly", async () => {
    const api = fakeApi();
    const p = pending('a', { kind: 'question', tool: 'AskUserQuestion', input: { questions }, questions });
    const { unmount } = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    fireEvent.click(within(card()).getByRole('button', { name: 'Chat about this' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'deny', message: CLARIFY_MESSAGE }));
    unmount();
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    fireEvent.click(within(card()).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(api.decide).toHaveBeenLastCalledWith(p.id, { behavior: 'deny' }));
  });

  it('a question it cannot show says to answer at the Mac, not "in the terminal", and can still be declined', async () => {
    const api = fakeApi();
    const p = pending('a', { kind: 'question', tool: 'AskUserQuestion', input: { questions: 'not a list' } });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a')], pending: [p] }) });
    expect(card().textContent).toContain('Answer it at the Mac, or decline it here.');
    expect(card().textContent).not.toContain('in the terminal');
    expect(buttons()).toEqual(['Decline']);
    fireEvent.click(within(card()).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(p.id, { behavior: 'deny' }));
  });

  it('its Decline is off while offline', () => {
    const p = pending('a', { kind: 'question', tool: 'AskUserQuestion', input: { questions: 'not a list' } });
    renderApp({ path: '/s/a', status: 'offline', state: stateWith({ sessions: [session('a')], pending: [p] }) });
    expect((within(card()).getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
