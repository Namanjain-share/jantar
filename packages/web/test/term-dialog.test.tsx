/**
 * The terminal dialog dock (v0.4.2, spec 0 and 2; session/TermDialog.tsx
 * and session/answer.ts) against the shared dialog models in
 * term-dialog-fixtures.json (gates off, and `.open` with their gates on):
 * every model renders in Claude's order and wording, every row role sends
 * the right body, and every outcome lands back on the live dialog.
 *
 * Fake timers that move with real time: the dock drops a tap that lands
 * within TAP_GUARD_MS of its row appearing or changing (or of a tap dropped
 * before it), so `settle()` lets that pass.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIALOG_COUNTDOWN_LATE,
  DIALOG_COUNTDOWN_MIN_S,
  DIALOG_GATES,
  DIALOG_HOLD_COPY,
  DIALOG_NOTES,
  countdownSeconds,
  type Features,
  type PendingRequest,
  type ScreenResponse,
  type TerminalDialog,
} from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { setAppChimes, type Chimes } from '../src/lib/sounds.js';
import { writeLocal } from '../src/lib/storage.js';
import { LOCAL_DEVICE_KEY } from '../src/ui/screens/devices/local.js';
import {
  CANT_TELL,
  CHANGED,
  CONTROLS_OFF,
  COUNTDOWN_LATE,
  COUNTDOWN_MIN_S,
  NO_CHANGE,
  NO_CONTROL_SCOPE,
  NOTE_IN_BOX,
  TAP_DROPPED,
  TAP_GUARD_MS,
  countdownSecondsOf,
} from '../src/ui/screens/session/answer.js';
import { UNREADABLE } from '../src/ui/screens/session/screen.js';
import { BLOCKED, PLAN_PARTIAL, TEXT_SHORT, TONE_AT_S, blocksLine, leftWords } from '../src/ui/screens/session/TermDialog.js';
import fixtures from './term-dialog-fixtures.json';
import { emit, fakeApi, iso, pending, renderApp, session, stateWith } from './helpers.js';

type Fixture = { dialog: TerminalDialog | null; note: string | null };
const FIX = fixtures as unknown as Record<string, Fixture>;
const KEY = 'a'.repeat(64);

function fixture(name: string): Fixture {
  const f = FIX[name];
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
}
function dialogOf(name: string): TerminalDialog {
  const d = fixture(name).dialog;
  if (!d) throw new Error(`${name} has no dialog`);
  return d;
}
/** A screen read that parsed `name` (the text is a stand-in: the dock shows the model). */
function readOf(name: string): ScreenResponse {
  const f = fixture(name);
  return {
    text: 'synthetic terminal text',
    lines: 40,
    at: iso(0),
    backend: 'terminal-app',
    screenKey: KEY,
    ...(f.dialog ? { dialog: f.dialog } : {}),
    ...(f.note ? { dialogNote: f.note } : {}),
  };
}
/** A screen read that parsed `d`, a fixture's model changed by the test. */
function readWith(d: TerminalDialog): ScreenResponse {
  return { text: 'synthetic terminal text', lines: 40, at: iso(0), backend: 'terminal-app', screenKey: KEY, dialog: d };
}
/** PLAN_80COL with a plan of 8 lines: its body starts folded (a permission's always shows open). Row 1 is a plain pick. */
function tallPlan(): TerminalDialog {
  return { ...dialogOf('PLAN_80COL'), body: Array.from({ length: 8 }, (_, i) => `Step ${i + 1} of the plan.`), fingerprint: '9'.repeat(64) };
}

const card = () => screen.getByRole('article');
const choices = () => within(card()).getByRole('group', { name: 'Choices' });
const rowsOf = () => Array.from(choices().children) as HTMLElement[];
const buttonOf = (row: HTMLElement) => (row.tagName === 'BUTTON' ? row : (row.querySelector('button') as HTMLElement)) as HTMLButtonElement;
/** What the phone shows for a label: Claude's keyboard hints dropped. */
const shown = (label: string) => label.replace(/ \((?:shift\+tab|esc)\)/g, '');

/** Let `ms` of fake time pass. */
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
/** Let TAP_GUARD_MS pass, so the rows on screen take taps. */
const settle = () => pass(TAP_GUARD_MS);
/** The poll reads again at once when the page shows (session/screen.ts). */
const readAgain = () => act(() => void document.dispatchEvent(new Event('visibilitychange')));
/** Let the taps so far land: whatever they send is in the mock by then. */
const landed = () => act(async () => undefined);

async function openDock(
  name: string,
  opts: { api?: Partial<Api>; features?: Partial<Features>; pending?: PendingRequest[]; status?: 'offline'; settled?: boolean } = {},
) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const getScreen = vi.fn(async (_sid: string, _lines?: number) => readOf(name));
  const api = fakeApi({ getScreen, ...opts.api });
  const utils = renderApp({
    path: '/s/a',
    api,
    status: opts.status ?? 'live',
    state: stateWith({ sessions: [session('a', { status: 'waiting' })], pending: opts.pending ?? [], features: { controls: true, ...opts.features } }),
  });
  if (fixture(name).dialog) {
    // The dock is its own chunk: the first render may be its stand-in, a frame the dock then replaces.
    await screen.findByRole('group', { name: 'Choices' });
    if (opts.settled !== false) await settle();
  }
  return { ...utils, api };
}

afterEach(() => vi.useRealTimers());

const withDialog = Object.keys(FIX).filter((k) => FIX[k]?.dialog);
const noteOnly = Object.keys(FIX).filter((k) => !FIX[k]?.dialog);

describe('each dialog model renders as Claude draws it (gated and .open)', () => {
  it.each(withDialog)('%s', async (name) => {
    const d = dialogOf(name);
    await openDock(name);
    const head = d.title || { permission: 'permission', plan: 'plan', question: 'question', multi: 'question', review: 'your answers' }[d.kind];
    expect(within(card()).getByRole('heading', { name: `Claude asks · ${head}` })).toBeTruthy();
    expect(within(card()).getByText(d.question)).toBeTruthy();
    const rows = rowsOf();
    expect(rows).toHaveLength(d.options.length);
    // Claude's countdown under the margin on the phone's count (a 0:05 read is 4 s left): every row is off.
    const left = d.blocksIn ? (countdownSeconds(d.blocksIn) ?? Number.POSITIVE_INFINITY) - 1 : Number.POSITIVE_INFINITY;
    d.options.forEach((o, i) => {
      const row = rows[i] as HTMLElement;
      const button = buttonOf(row);
      const label = shown(o.label);
      const what = `${name} option ${i}`;
      if (o.role === 'locked') {
        expect(button.disabled, what).toBe(true);
        expect(row.textContent, what).toContain(label);
        // The note shows once under a run of rows that share it; each row names it.
        const next = d.options[i + 1];
        const last = !(next?.role === 'locked' && next.note === o.note);
        expect(row.textContent.includes(o.note ?? ''), what).toBe(last);
        expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent, what).toBe(o.note);
        return;
      }
      expect(button.disabled, what).toBe(left < DIALOG_COUNTDOWN_MIN_S);
      if (o.role === 'text') {
        expect(button.textContent, what).toBe(`${label.replace(/\.$/, '')}…${o.detail ?? ''}`);
        expect(button.getAttribute('aria-expanded'), what).toBe('false');
      } else if (o.role === 'chat') {
        expect(button.textContent, what).toBe(label);
      } else if (o.role === 'toggle') {
        expect(button.getAttribute('aria-pressed'), what).toBe(String(Boolean(o.checked)));
        expect(button.textContent, what).toBe(`${label}${o.detail ?? ''}`);
      } else if (d.kind === 'review' && /^Cancel/.test(label)) {
        expect(button.textContent, what).toBe('Cancel, decline all');
      } else if (o.hold) {
        expect(button.getAttribute('aria-label'), what).toBe(`${label}. Hold for 2 seconds`);
        expect(row.textContent, what).toContain(DIALOG_HOLD_COPY[o.hold]);
      } else if ((d.kind === 'permission' || d.kind === 'plan') && /^No\b.*\btell Claude\b/.test(label)) {
        // It opens the note box itself.
        expect(button.textContent, what).toBe(`${label}…${o.detail ?? ''}`);
        expect(button.getAttribute('aria-expanded'), what).toBe('false');
      } else {
        expect(button.textContent, what).toBe(`${label}${o.detail ?? ''}`);
      }
    });
    // Claude's keyboard hints are not buttons on a phone.
    expect(card().textContent).not.toMatch(/\(shift\+tab\)|\(esc\)/);
    // A dock with buttons has no keys, and keeps Show on Mac.
    expect(within(card()).queryByRole('region', { name: 'Keys' })).toBeNull();
    expect(within(card()).queryByRole('button', { name: /Enter/ })).toBeNull();
    expect(within(card()).getByRole('button', { name: 'Show on Mac' })).toBeTruthy();
    if (d.tabs?.length) expect(within(card()).getByRole('list', { name: 'Questions' }).children).toHaveLength(d.tabs.length);
    if (d.kind === 'multi') expect(within(card()).queryByText('Tick from top to bottom.') !== null).toBe(!DIALOG_GATES.up);
  });

  it.each(noteOnly)('%s: no buttons; why, the screen and the keys', async (name) => {
    const note = fixture(name).note as string;
    await openDock(name);
    expect(await within(card()).findByText(note)).toBeTruthy();
    expect(within(card()).getByRole('heading', { name: 'Claude is waiting in the terminal' })).toBeTruthy();
    expect(within(card()).queryByRole('group', { name: 'Choices' })).toBeNull();
    expect(within(card()).getByLabelText('Last lines of the terminal').textContent).toBe('synthetic terminal text');
    expect(within(card()).getByRole('region', { name: 'Keys' })).toBeTruthy();
  });

  it('a plan starts folded and says when the Mac shows only part of it; a permission shows open whatever its length; the review lists its answers', async () => {
    const plan = await openDock('PLAN_FULLSCREEN');
    const read = within(card()).getByRole('button', { name: /Read the plan/ });
    expect(read.getAttribute('aria-expanded')).toBe('false');
    // The plan box scrolls on the Mac (its ↓): said even while folded, and never "the Transcript has it".
    expect(within(card()).getByText(PLAN_PARTIAL)).toBeTruthy();
    expect(card().textContent).not.toContain('Transcript');
    fireEvent.click(read);
    expect(within(card()).getByLabelText('The plan').textContent).toContain('Plan: Notes page for the demo app');
    plan.unmount();

    // A plan the box shows whole: no such line.
    const short = await openDock('PLAN_80COL');
    expect(within(card()).queryByText(PLAN_PARTIAL)).toBeNull();
    short.unmount();

    const bash = await openDock('PERM_BASH_PREFIX');
    expect(within(card()).getByLabelText('What the dialog shows').textContent).toContain('date > a.txt');
    bash.unmount();

    // 40 lines, the command's start first and the daemon's line for what is left out: open, nothing folded.
    const long = await openDock('PERM_BASH_LONG');
    expect(within(card()).getByRole('button', { name: /What the Mac shows/ }).getAttribute('aria-expanded')).toBe('true');
    const shownBody = within(card()).getByLabelText('What the dialog shows').textContent ?? '';
    expect(shownBody).toContain("rm -rf ./build-cache && cat > notes.txt <<'EOF'");
    expect(shownBody).toContain('… 5 more lines on the Mac …');
    long.unmount();

    await openDock('Q_REVIEW');
    expect(within(card()).getByLabelText('Your answers').textContent).toContain('→ purple');
  });

  it('a run of locked rows with one note shows it once (PLAN_FULLSCREEN: two rows, one note)', async () => {
    await openDock('PLAN_FULLSCREEN');
    const note = DIALOG_NOTES.tall;
    expect(card().textContent?.split(note).length).toBe(2);
    const [manual, feedback] = [buttonOf(rowsOf()[1] as HTMLElement), buttonOf(rowsOf()[2] as HTMLElement)];
    expect(manual.getAttribute('aria-describedby')).toBe(feedback.getAttribute('aria-describedby'));
  });
});

describe('each tap sends the right body', () => {
  it('a pick row: its index and the fingerprint the dock showed, with a new Idempotency-Key per tap', async () => {
    const d = dialogOf('PLAN_80COL');
    const sessionDialog = vi.fn(async () => ({ outcome: 'unchanged' as const, dialog: d }));
    const { api } = await openDock('PLAN_80COL', { api: { sessionDialog } });
    fireEvent.click(buttonOf(rowsOf()[1] as HTMLElement));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledTimes(1));
    expect(api.sessionDialog).toHaveBeenCalledWith('a', { fingerprint: d.fingerprint, option: 1 }, expect.any(String));
    await waitFor(() => expect(buttonOf(rowsOf()[1] as HTMLElement).disabled).toBe(false));
    fireEvent.click(buttonOf(rowsOf()[1] as HTMLElement));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledTimes(2));
    const keys = (sessionDialog.mock.calls as unknown as [string, unknown, string][]).map((c) => c[2]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('a hold row sends confirm: true only after a 2-second hold; a click or an early release sends nothing', async () => {
    const d = dialogOf('PLAN_80COL');
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    await openDock('PLAN_80COL', { api: { sessionDialog } });
    const hold = within(card()).getByRole('button', { name: 'Yes, and use auto mode. Hold for 2 seconds' });
    expect(card().textContent).toContain(`Hold for 2 seconds. ${DIALOG_HOLD_COPY.mode}`);
    fireEvent.click(hold);
    fireEvent.pointerDown(hold, { button: 0 });
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.pointerUp(hold);
    act(() => vi.advanceTimersByTime(1000));
    expect(sessionDialog).not.toHaveBeenCalled();
    fireEvent.pointerDown(hold, { button: 0 });
    act(() => vi.advanceTimersByTime(2000));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: d.fingerprint, option: 0, confirm: true }, expect.any(String)));
  });

  it('a text row opens a box: 2 to 700 characters on one line, no leading / ! # @ and no @ mention; trimmed', async () => {
    const d = dialogOf('PLAN_80COL');
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    await openDock('PLAN_80COL', { api: { sessionDialog } });
    const row = buttonOf(rowsOf()[2] as HTMLElement);
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const box = within(card()).getByLabelText('What should change') as HTMLTextAreaElement;
    const send = () => within(card()).getByRole('button', { name: 'Send to Claude' }) as HTMLButtonElement;
    // The box has focus as it opens (the phone's keyboard comes up with the tap).
    expect(document.activeElement).toBe(box);
    expect(row.getAttribute('aria-controls')).toBe(box.parentElement?.id);
    expect(box.getAttribute('enterkeyhint')).toBe('send');
    for (const bad of ['x', '/plan it', '#tag it', 'ask @someone', 'two\nlines', 'y'.repeat(701)]) {
      fireEvent.change(box, { target: { value: bad } });
      expect(send().disabled, JSON.stringify(bad)).toBe(true);
    }
    expect(card().textContent).toContain('At most 700 characters here.');
    fireEvent.change(box, { target: { value: 'two\nlines' } });
    expect(card().textContent).toContain('Keep it on one line: the Mac takes this answer as one line of text.');
    fireEvent.change(box, { target: { value: '/plan it' } });
    expect(card().textContent).toMatch(/Leave out a leading \/, !, # or @/);
    // One character: Send stays off, and says why.
    fireEvent.change(box, { target: { value: '3' } });
    expect(send().disabled).toBe(true);
    expect(card().textContent).toContain(TEXT_SHORT);
    fireEvent.change(box, { target: { value: '  use b.txt instead  ' } });
    expect(within(card()).getByText('17 / 700')).toBeTruthy();
    fireEvent.click(send());
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: d.fingerprint, option: 2, text: 'use b.txt instead' }, expect.any(String)));
  });

  it('Enter in an answer box sends it (one line)', async () => {
    const d = dialogOf('Q_SINGLE');
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    await openDock('Q_SINGLE', { api: { sessionDialog } });
    fireEvent.click(within(card()).getByRole('button', { name: 'Type something…' }));
    const box = within(card()).getByLabelText('Your answer');
    fireEvent.change(box, { target: { value: 'teal' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: d.fingerprint, option: 3, text: 'teal' }, expect.any(String)));
  });

  it('Chat about this, a multi-select toggle and its Submit row each send their own index', async () => {
    const q = dialogOf('Q_SINGLE');
    const multi = dialogOf('Q_MULTI');
    const sessionDialog = vi.fn(async (_sid: string, body: { fingerprint: string }) => ({
      outcome: 'unchanged' as const,
      dialog: body.fingerprint === q.fingerprint ? q : multi,
    }));
    const first = await openDock('Q_SINGLE', { api: { sessionDialog } });
    fireEvent.click(within(card()).getByRole('button', { name: 'Chat about this' }));
    await waitFor(() => expect(sessionDialog).toHaveBeenLastCalledWith('a', { fingerprint: q.fingerprint, option: 4 }, expect.any(String)));
    first.unmount();

    await openDock('Q_MULTI', { api: { sessionDialog } });
    const banana = within(card()).getByRole('button', { name: /^Banana/ });
    expect(banana.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(banana);
    await waitFor(() => expect(sessionDialog).toHaveBeenLastCalledWith('a', { fingerprint: multi.fingerprint, option: 1 }, expect.any(String)));
    await waitFor(() => expect((within(card()).getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(card()).getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(sessionDialog).toHaveBeenLastCalledWith('a', { fingerprint: multi.fingerprint, option: 4 }, expect.any(String)));
    // "Type something" in a multi-select stays at the Mac.
    const typed = rowsOf()[3] as HTMLElement;
    expect(buttonOf(typed).disabled).toBe(true);
    expect(typed.textContent).toContain('Type extra answers at the Mac.');
  });

  it("the review: Submit answers is the primary row; Cancel declines all only on a second tap", async () => {
    const d = dialogOf('Q_REVIEW');
    const sessionDialog = vi.fn(async () => ({ outcome: 'unchanged' as const, dialog: d }));
    await openDock('Q_REVIEW', { api: { sessionDialog } });
    expect(buttonOf(rowsOf()[0] as HTMLElement).className).toContain('bg-ink');
    const cancel = within(card()).getByRole('button', { name: 'Cancel, decline all' });
    fireEvent.click(cancel);
    expect(sessionDialog).not.toHaveBeenCalled();
    fireEvent.click(within(card()).getByRole('button', { name: 'Tap again to decline all' }));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: d.fingerprint, option: 1 }, expect.any(String)));
  });

  it('a network error keeps the key for a tap on the same row; the next tap after an answer gets a new one', async () => {
    const d = dialogOf('PERM_CREATE_2');
    const sessionDialog = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'offline', 0))
      .mockResolvedValue({ outcome: 'unchanged', dialog: d });
    await openDock('PERM_CREATE_2', { api: { sessionDialog } });
    const yes = () => buttonOf(rowsOf()[0] as HTMLElement);
    fireEvent.click(yes());
    expect(await within(card()).findByRole('alert')).toBeTruthy();
    fireEvent.click(yes());
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledTimes(2));
    await within(card()).findByText(NO_CHANGE);
    fireEvent.click(yes());
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledTimes(3));
    const keys = sessionDialog.mock.calls.map((c) => c[2] as string);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('every row is off while a tap is in flight', async () => {
    let finish: (v: { outcome: 'unchanged'; dialog: TerminalDialog }) => void = () => undefined;
    const d = dialogOf('PERM_BASH_PREFIX');
    const sessionDialog = vi.fn(() => new Promise<{ outcome: 'unchanged'; dialog: TerminalDialog }>((r) => (finish = r)));
    await openDock('PERM_BASH_PREFIX', { api: { sessionDialog } });
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    await waitFor(() => expect(rowsOf().every((r) => buttonOf(r).disabled)).toBe(true));
    expect((within(card()).getByRole('button', { name: 'Show on Mac' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(buttonOf(rowsOf()[3] as HTMLElement));
    expect(sessionDialog).toHaveBeenCalledTimes(1);
    await act(async () => finish({ outcome: 'unchanged', dialog: d }));
    await waitFor(() => expect(buttonOf(rowsOf()[3] as HTMLElement).disabled).toBe(false));
  });
});

describe('outcomes always land on the live dialog', () => {
  it('done with a next dialog shows it at once', async () => {
    const next = dialogOf('Q_REVIEW');
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: next }));
    await openDock('Q_TABS', { api: { sessionDialog } });
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    expect(await within(card()).findByRole('heading', { name: 'Claude asks · Review your answers' })).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'Submit answers' })).toBeTruthy();
  });

  it('done with the dialog closed says "Answered · <row>" until the next read', async () => {
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('PLAN_80COL')).mockResolvedValue({ text: '> ', lines: 1, at: iso(1000), backend: 'terminal-app', screenKey: KEY });
    const { store } = await openDock('PLAN_80COL', { api: { sessionDialog, getScreen } });
    fireEvent.click(within(card()).getByRole('button', { name: 'Yes, manually approve edits' }));
    expect((await within(card()).findByRole('status')).textContent).toBe('Answered · Yes, manually approve edits');
    expect(within(card()).queryByRole('group', { name: 'Choices' })).toBeNull();
    // The session moves on: the next read and the status say what the screen shows now.
    act(() => emit(store, [{ seq: 11, ts: iso(2000), type: 'session.updated', sid: 'a', data: { patch: { status: 'working', statusSince: iso(2000) } } }]));
    await waitFor(() => expect(screen.queryByText(/^Answered ·/)).toBeNull());
    expect(screen.getByLabelText('Prompt for Claude')).toBeTruthy();
  });

  it('a typed answer reads back as what was typed', async () => {
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    await openDock('Q_SINGLE', { api: { sessionDialog } });
    fireEvent.click(within(card()).getByRole('button', { name: 'Type something…' }));
    fireEvent.change(within(card()).getByLabelText('Your answer'), { target: { value: 'teal' } });
    fireEvent.click(within(card()).getByRole('button', { name: 'Send answer' }));
    expect((await within(card()).findByRole('status')).textContent).toBe('Answered · teal');
  });

  it('unchanged: the live dialog again, rows on, with "Jantar saw no change", and no Try again', async () => {
    const d = dialogOf('PERM_CREATE_2');
    const sessionDialog = vi.fn(async () => ({ outcome: 'unchanged' as const, dialog: d }));
    await openDock('PERM_CREATE_2', { api: { sessionDialog } });
    fireEvent.click(buttonOf(rowsOf()[1] as HTMLElement));
    expect(await within(card()).findByText(NO_CHANGE)).toBeTruthy();
    expect(rowsOf().every((r) => !buttonOf(r).disabled)).toBe(true);
    expect(within(card()).queryByRole('button', { name: /Try again/ })).toBeNull();
  });

  it('409: reads the screen again and shows the fresh dialog with "The dialog on the Mac changed"', async () => {
    const sessionDialog = vi.fn().mockRejectedValue(new ApiError('conflict', 'The dialog on the Mac changed. Look at it again.', 409));
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('PERM_BASH_PREFIX')).mockResolvedValue(readOf('PERM_BASH_TWIN'));
    await openDock('PERM_BASH_PREFIX', { api: { sessionDialog, getScreen } });
    expect(within(card()).getByText('Do you want to proceed?')).toBeTruthy();
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    expect(await within(card()).findByText(CHANGED)).toBeTruthy();
    expect(getScreen).toHaveBeenCalledTimes(2);
    expect(within(card()).getByLabelText('What the dialog shows').textContent).toContain('date > b.txt');
  });

  it('a read already out when an answer reports the next screen is dropped (it may show the dialog from before)', async () => {
    const next = dialogOf('Q_REVIEW');
    let land: (r: ScreenResponse) => void = () => undefined;
    const getScreen = vi
      .fn()
      .mockResolvedValueOnce(readOf('Q_TABS'))
      .mockImplementationOnce(() => new Promise<ScreenResponse>((r) => (land = r)))
      .mockResolvedValue(readOf('Q_REVIEW'));
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: next }));
    await openDock('Q_TABS', { api: { sessionDialog, getScreen } });
    // A poll goes out, and the answer comes back before it does.
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(getScreen).toHaveBeenCalledTimes(2));
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    expect(await within(card()).findByRole('heading', { name: 'Claude asks · Review your answers' })).toBeTruthy();
    await act(async () => land(readOf('Q_TABS')));
    expect(within(card()).getByRole('heading', { name: 'Claude asks · Review your answers' })).toBeTruthy();
    expect(within(card()).queryByRole('list', { name: 'Questions' })?.textContent ?? '').not.toContain('☐ Colour');
  });

  it("a refusal shows the daemon's sentence under the dialog it was about", async () => {
    const sessionDialog = vi.fn().mockRejectedValue(new ApiError('invalid_request', 'This row needs text (2 to 700 characters)', 400));
    await openDock('PERM_CREATE_2', { api: { sessionDialog } });
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    expect((await within(card()).findByRole('alert')).textContent).toBe('This row needs text (2 to 700 characters)');
  });

  it('409 with no dialog on the fresh read: the line shows over the screen and the keys', async () => {
    const sessionDialog = vi.fn().mockRejectedValue(new ApiError('conflict', 'The dialog on the Mac changed. Look at it again.', 409));
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('PERM_CREATE_2')).mockResolvedValue(readOf('Q_SCROLLED'));
    await openDock('PERM_CREATE_2', { api: { sessionDialog, getScreen } });
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    expect(await within(card()).findByText(CHANGED)).toBeTruthy();
    expect(within(card()).getByRole('heading', { name: 'Claude is waiting in the terminal' })).toBeTruthy();
    expect(within(card()).queryByRole('group', { name: 'Choices' })).toBeNull();
    expect(within(card()).getByRole('region', { name: 'Keys' })).toBeTruthy();
  });

  it('a screen read that fails says so under the dialog, which stays', async () => {
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('PERM_CREATE_2')).mockRejectedValue(new ApiError('unavailable', 'no terminal', 503));
    await openDock('PERM_CREATE_2', { api: { getScreen } });
    readAgain();
    expect(await within(card()).findByText(UNREADABLE)).toBeTruthy();
    expect(rowsOf()).toHaveLength(dialogOf('PERM_CREATE_2').options.length);
  });
});

describe('a dialog that changes under the same rows', () => {
  it('the next queued prompt (same question and rows, another command) starts afresh, body open, and says so', async () => {
    const twin = dialogOf('PERM_BASH_TWIN');
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('PERM_BASH_PREFIX')).mockResolvedValue(readOf('PERM_BASH_TWIN'));
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    await openDock('PERM_BASH_PREFIX', { api: { getScreen, sessionDialog } });
    expect(within(card()).queryByText(CHANGED)).toBeNull();
    readAgain();
    expect(await within(card()).findByText(CHANGED)).toBeTruthy();
    expect(within(card()).getByLabelText('What the dialog shows').textContent).toContain('date > b.txt');
    // A tap that lands as the twin appears was aimed at the prompt before it: dropped.
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    await act(async () => undefined);
    expect(sessionDialog).not.toHaveBeenCalled();
    await settle();
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: twin.fingerprint, option: 0 }, expect.any(String)));
  });

  it('a folded body that changes opens, so it never hides what a tap now answers', async () => {
    const first = tallPlan();
    const next: TerminalDialog = { ...first, body: [...first.body.slice(0, -1), 'Step 8 of another plan.'], fingerprint: '8'.repeat(64) };
    const getScreen = vi.fn().mockResolvedValueOnce(readWith(first)).mockResolvedValue(readWith(next));
    await openDock('PLAN_80COL', { api: { getScreen } });
    expect(within(card()).getByRole('button', { name: /Read the plan/ }).getAttribute('aria-expanded')).toBe('false');
    readAgain();
    expect(await within(card()).findByText(CHANGED)).toBeTruthy();
    expect(within(card()).getByRole('button', { name: /Read the plan/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('done with the twin as the next dialog shows it with the line', async () => {
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: dialogOf('PERM_BASH_TWIN') }));
    await openDock('PERM_BASH_PREFIX', { api: { sessionDialog } });
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    expect(await within(card()).findByText(CHANGED)).toBeTruthy();
    expect(within(card()).getByLabelText('What the dialog shows').textContent).toContain('date > b.txt');
  });

  it('done with a next dialog drawn just like the one answered: shown as new, body open, with the line; a tap at once is dropped', async () => {
    const first = tallPlan();
    const next: TerminalDialog = { ...first, fingerprint: 'e'.repeat(64) };
    const sessionDialog = vi.fn().mockResolvedValueOnce({ outcome: 'done', dialog: next }).mockResolvedValue({ outcome: 'unchanged', dialog: next });
    await openDock('PLAN_80COL', { api: { sessionDialog, getScreen: vi.fn(async () => readWith(first)) } });
    const body = () => within(card()).getByRole('button', { name: /Read the plan/ });
    const row = () => buttonOf(rowsOf()[1] as HTMLElement);
    expect(body().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row());
    // Not "the tap didn't take": the Mac took it and shows another dialog that looks the same.
    expect(await within(card()).findByText(CHANGED)).toBeTruthy();
    expect(within(card()).queryByText(NO_CHANGE)).toBeNull();
    expect(body().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(row());
    await act(async () => undefined);
    expect(sessionDialog).toHaveBeenCalledTimes(1);
    await settle();
    fireEvent.click(row());
    await waitFor(() => expect(sessionDialog).toHaveBeenLastCalledWith('a', { fingerprint: next.fingerprint, option: 1 }, expect.any(String)));
  });

  it('unchanged with another fingerprint under the same drawing: shown as new, with the changed line, never "no change"', async () => {
    const first = tallPlan();
    const twin: TerminalDialog = { ...first, fingerprint: 'd'.repeat(64) };
    const sessionDialog = vi.fn().mockResolvedValue({ outcome: 'unchanged', dialog: twin });
    await openDock('PLAN_80COL', { api: { sessionDialog, getScreen: vi.fn(async () => readWith(first)) } });
    const body = () => within(card()).getByRole('button', { name: /Read the plan/ });
    const row = () => buttonOf(rowsOf()[1] as HTMLElement);
    fireEvent.click(row());
    expect(await within(card()).findByText(CHANGED)).toBeTruthy();
    expect(within(card()).queryByText(NO_CHANGE)).toBeNull();
    expect(body().getAttribute('aria-expanded')).toBe('true');
    // A tap at once is dropped; after a look it carries the twin's fingerprint.
    fireEvent.click(row());
    await act(async () => undefined);
    expect(sessionDialog).toHaveBeenCalledTimes(1);
    await settle();
    fireEvent.click(row());
    await waitFor(() => expect(sessionDialog).toHaveBeenLastCalledWith('a', { fingerprint: twin.fingerprint, option: 1 }, expect.any(String)));
  });

  it('unchanged with no dialog back (the Mac shows one whose top is off screen): says Jantar can\'t tell, never "try again"', async () => {
    const sessionDialog = vi.fn(async () => ({ outcome: 'unchanged' as const, dialog: null }));
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('PERM_BASH_PREFIX')).mockResolvedValue(readOf('PERM_BASH_TALL'));
    await openDock('PERM_BASH_PREFIX', { api: { sessionDialog, getScreen } });
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    expect(await within(card()).findByText(CANT_TELL)).toBeTruthy();
    expect(within(card()).queryByText(NO_CHANGE)).toBeNull();
    expect(within(card()).queryByRole('group', { name: 'Choices' })).toBeNull();
  });

  it('a toggle that took (and the pointer that moved with it) is the same dialog: no line', async () => {
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: dialogOf('Q_MULTI_TICKED') }));
    await openDock('Q_MULTI', { api: { sessionDialog } });
    fireEvent.click(within(card()).getByRole('button', { name: /^Cherry/ }));
    await waitFor(() => expect(within(card()).getByRole('button', { name: /^Cherry/ }).getAttribute('aria-pressed')).toBe('true'));
    expect(within(card()).queryByText(CHANGED)).toBeNull();
  });

  it('a box ticked at the Mac: a tap on it at once sends nothing (it would untick it), and after a look it goes with the ticked dialog', async () => {
    const ticked = dialogOf('Q_MULTI_TICKED');
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('Q_MULTI')).mockResolvedValue(readOf('Q_MULTI_TICKED'));
    const sessionDialog = vi.fn(async () => ({ outcome: 'unchanged' as const, dialog: ticked }));
    await openDock('Q_MULTI', { api: { getScreen, sessionDialog } });
    const cherry = () => within(card()).getByRole('button', { name: /^Cherry/ });
    readAgain();
    await waitFor(() => expect(cherry().getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(cherry());
    await landed();
    expect(sessionDialog).not.toHaveBeenCalled();
    expect(within(card()).getByRole('status').textContent).toBe(TAP_DROPPED);
    // Ticks are not another dialog: no "changed" line.
    expect(within(card()).queryByText(CHANGED)).toBeNull();
    await settle();
    fireEvent.click(cherry());
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: ticked.fingerprint, option: 2 }, expect.any(String)));
  });

  it('the next question drawn alike (only the tab bar differs) starts afresh, says so, and a tap at once is dropped', async () => {
    const first = dialogOf('Q_TABS');
    const next: TerminalDialog = { ...first, tabs: (first.tabs ?? []).map((t) => ({ ...t, answered: true })), fingerprint: 'f'.repeat(64) };
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('Q_TABS')).mockResolvedValue(readWith(next));
    const sessionDialog = vi.fn(async () => ({ outcome: 'unchanged' as const, dialog: next }));
    await openDock('Q_TABS', { api: { getScreen, sessionDialog } });
    readAgain();
    expect(await within(card()).findByText(CHANGED)).toBeTruthy();
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    await landed();
    expect(sessionDialog).not.toHaveBeenCalled();
    await settle();
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: next.fingerprint, option: 0 }, expect.any(String)));
  });

  it('a new fingerprint under the very same drawing (a change the phone does not show) starts afresh, body open, and says so', async () => {
    const first = tallPlan();
    const next: TerminalDialog = { ...first, fingerprint: 'e'.repeat(64) };
    const getScreen = vi.fn().mockResolvedValueOnce(readWith(first)).mockResolvedValue(readWith(next));
    const sessionDialog = vi.fn(async () => ({ outcome: 'unchanged' as const, dialog: next }));
    await openDock('PLAN_80COL', { api: { getScreen, sessionDialog } });
    const body = () => within(card()).getByRole('button', { name: /Read the plan/ });
    expect(body().getAttribute('aria-expanded')).toBe('false');
    readAgain();
    expect(await within(card()).findByText(CHANGED)).toBeTruthy();
    expect(body().getAttribute('aria-expanded')).toBe('true');
    const row = () => buttonOf(rowsOf()[1] as HTMLElement);
    fireEvent.click(row());
    await landed();
    expect(sessionDialog).not.toHaveBeenCalled();
    await settle();
    fireEvent.click(row());
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: next.fingerprint, option: 1 }, expect.any(String)));
  });

  it('the pointer moved at the Mac: the same view, no line, and a tap at once is dropped', async () => {
    const first = dialogOf('PERM_CREATE_2');
    const moved: TerminalDialog = { ...first, current: 1, fingerprint: 'c'.repeat(64) };
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('PERM_CREATE_2')).mockResolvedValue(readWith(moved));
    const sessionDialog = vi.fn(async () => ({ outcome: 'unchanged' as const, dialog: moved }));
    await openDock('PERM_CREATE_2', { api: { getScreen, sessionDialog } });
    readAgain();
    await waitFor(() => expect(getScreen).toHaveBeenCalledTimes(2));
    await landed();
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    await landed();
    expect(sessionDialog).not.toHaveBeenCalled();
    expect(within(card()).queryByText(CHANGED)).toBeNull();
    await settle();
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: moved.fingerprint, option: 0 }, expect.any(String)));
  });
});

describe('a tap that lands as its row appears is dropped (useTapGuard)', () => {
  it(`as the dialog shows: nothing is sent until it has been on screen for ${TAP_GUARD_MS} ms, and a dropped tap says so`, async () => {
    const d = dialogOf('PERM_CREATE_2');
    const sessionDialog = vi.fn(async () => ({ outcome: 'unchanged' as const, dialog: d }));
    await openDock('PERM_CREATE_2', { api: { sessionDialog }, settled: false });
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    await landed();
    expect(sessionDialog).not.toHaveBeenCalled();
    expect(within(card()).getByRole('status').textContent).toBe(TAP_DROPPED);
    await settle();
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: d.fingerprint, option: 0 }, expect.any(String)));
  });

  it('each dropped tap starts the window again: a double tap straddling its end sends nothing', async () => {
    const d = dialogOf('PERM_CREATE_2');
    const sessionDialog = vi.fn(async () => ({ outcome: 'unchanged' as const, dialog: d }));
    await openDock('PERM_CREATE_2', { api: { sessionDialog }, settled: false });
    await pass(TAP_GUARD_MS - 200);
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    // The second half lands after the first window has ended, but inside the one the drop started.
    await pass(TAP_GUARD_MS - 200);
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    await landed();
    expect(sessionDialog).not.toHaveBeenCalled();
    await settle();
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledTimes(1));
    expect(within(card()).queryByText(TAP_DROPPED)).toBeNull();
  });

  it('as the next question an answer brought shows: the same spot sends nothing at once', async () => {
    const next = dialogOf('Q_REVIEW');
    const sessionDialog = vi.fn().mockResolvedValueOnce({ outcome: 'done', dialog: next }).mockResolvedValue({ outcome: 'unchanged', dialog: next });
    await openDock('Q_TABS', { api: { sessionDialog } });
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    fireEvent.click(await within(card()).findByRole('button', { name: 'Submit answers' }));
    await act(async () => undefined);
    expect(sessionDialog).toHaveBeenCalledTimes(1);
    await settle();
    fireEvent.click(within(card()).getByRole('button', { name: 'Submit answers' }));
    await waitFor(() => expect(sessionDialog).toHaveBeenLastCalledWith('a', { fingerprint: next.fingerprint, option: 0 }, expect.any(String)));
  });
});

describe('No, and tell Claude what to do instead (spec 2.7)', () => {
  it('a No row that says "tell Claude" opens the note box itself (no second link); "Just No" sends the plain No', async () => {
    const d = dialogOf('PERM_FETCH');
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    await openDock('PERM_FETCH', { api: { sessionDialog } });
    const no = rowsOf()[2] as HTMLElement;
    const row = buttonOf(no);
    expect(row.textContent).toBe('No, and tell Claude what to do differently…');
    expect(within(no).queryByRole('button', { name: 'No, and tell Claude what to do instead…' })).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(within(no).getByLabelText('What Claude should do instead'));
    expect(sessionDialog).not.toHaveBeenCalled();
    fireEvent.click(within(no).getByRole('button', { name: 'Just No' }));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: d.fingerprint, option: 2 }, expect.any(String)));
  });

  it('answers No with no text, then the note waits in the composer for one tap on Send', async () => {
    const d = dialogOf('PERM_FETCH');
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    const { store } = await openDock('PERM_FETCH', { api: { sessionDialog } });
    const no = rowsOf()[2] as HTMLElement;
    fireEvent.click(buttonOf(no));
    const put = within(no).getByRole('button', { name: 'No, and put my note in the box' }) as HTMLButtonElement;
    const box = within(no).getByLabelText('What Claude should do instead');
    fireEvent.change(box, { target: { value: '!rm -rf build' } });
    expect(put.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Use the cached copy instead' } });
    fireEvent.click(put);
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: d.fingerprint, option: 2 }, expect.any(String)));
    expect(await screen.findByText(NOTE_IN_BOX)).toBeTruthy();
    // Claude stops the turn after No; the composer comes back with the note, not sent.
    act(() => emit(store, [{ seq: 11, ts: iso(2000), type: 'session.updated', sid: 'a', data: { patch: { status: 'idle', statusSince: iso(2000) } } }]));
    const prompt = (await screen.findByLabelText('Prompt for Claude')) as HTMLTextAreaElement;
    expect(prompt.value).toBe('Use the cached copy instead');
    expect(store.getState().state.sends).toEqual({});
  });

  it('on unchanged the note stays in its box', async () => {
    const d = dialogOf('PERM_CREATE_2');
    const sessionDialog = vi.fn(async () => ({ outcome: 'unchanged' as const, dialog: d }));
    await openDock('PERM_CREATE_2', { api: { sessionDialog } });
    const no = rowsOf()[1] as HTMLElement;
    fireEvent.click(within(no).getByRole('button', { name: 'No, and tell Claude what to do instead…' }));
    fireEvent.change(within(no).getByLabelText('What Claude should do instead'), { target: { value: 'Try the other file' } });
    fireEvent.click(within(no).getByRole('button', { name: 'No, and put my note in the box' }));
    expect(await within(card()).findByText(NO_CHANGE)).toBeTruthy();
    expect((within(rowsOf()[1] as HTMLElement).getByLabelText('What Claude should do instead') as HTMLTextAreaElement).value).toBe('Try the other file');
    expect(screen.queryByText(NOTE_IN_BOX)).toBeNull();
  });

  it('a note may be up to 16,000 characters (the composer\'s limit)', async () => {
    await openDock('PERM_CREATE_2');
    const no = rowsOf()[1] as HTMLElement;
    fireEvent.click(within(no).getByRole('button', { name: 'No, and tell Claude what to do instead…' }));
    const box = within(no).getByLabelText('What Claude should do instead');
    const put = () => within(no).getByRole('button', { name: 'No, and put my note in the box' }) as HTMLButtonElement;
    fireEvent.change(box, { target: { value: 'n'.repeat(16_001) } });
    expect(put().disabled).toBe(true);
    expect(no.textContent).toContain('At most 16,000 characters.');
    fireEvent.change(box, { target: { value: 'n'.repeat(16_000) } });
    expect(put().disabled).toBe(false);
  });

  it('is offered under a No row only (not under Yes, and not under a hold row)', async () => {
    await openDock('PERM_READ_OUTSIDE');
    expect(within(card()).queryByRole('button', { name: /No, and tell Claude what to do instead/ })).toBeNull();
  });
});

describe('who and when the dock can answer', () => {
  it('Controls off: every row shown, greyed, with the command that turns them on', async () => {
    await openDock('PERM_CREATE_2', { features: { controls: false } });
    expect(rowsOf().every((r) => buttonOf(r).disabled)).toBe(true);
    expect(within(card()).getByText(CONTROLS_OFF)).toBeTruthy();
    expect((within(card()).getByRole('button', { name: 'Show on Mac' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a device paired without the control scope: greyed, with why', async () => {
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-2', name: 'Tablet', scopes: ['read'] });
    await openDock('PERM_CREATE_2');
    expect(rowsOf().every((r) => buttonOf(r).disabled)).toBe(true);
    expect(within(card()).getByText(NO_CONTROL_SCOPE)).toBeTruthy();
  });

  it('offline: greyed, with the offline line', async () => {
    await openDock('PERM_CREATE_2', { status: 'offline' });
    expect(rowsOf().every((r) => buttonOf(r).disabled)).toBe(true);
    expect(within(card()).getByText("Offline: can't send right now")).toBeTruthy();
  });

  it('a subagent prompt Jantar can\'t read shows the card\'s tool and command over the screen and the keys', async () => {
    const sub = pending('a', { kind: 'subagent-info', tool: 'Bash', agentId: 'agent-1', input: { command: 'make test-unit', description: 'Run the unit tests' } });
    await openDock('Q_SCROLLED', { pending: [sub] });
    expect(await within(card()).findByRole('heading', { name: 'A subagent asks · Bash' })).toBeTruthy();
    expect(within(card()).getByText('A subagent is waiting in the terminal (Bash).')).toBeTruthy();
    expect(within(card()).getByText('make test-unit')).toBeTruthy();
    expect(within(card()).getByLabelText('Last lines of the terminal').textContent).toBe('synthetic terminal text');
    expect(within(card()).getByRole('region', { name: 'Keys' })).toBeTruthy();
  });

  it("a subagent card open while another dialog shows (Claude's own, or another tool's): titled Claude's", async () => {
    const sub = pending('a', { kind: 'subagent-info', tool: 'Bash', agentId: 'agent-1' });
    const first = await openDock('Q_SINGLE', { pending: [sub] });
    expect(within(card()).getByRole('heading', { name: 'Claude asks · Colour' })).toBeTruthy();
    first.unmount();
    await openDock('PERM_CREATE_2', { pending: [sub] });
    expect(within(card()).getByRole('heading', { name: 'Claude asks · Create file' })).toBeTruthy();
  });

  it('a subagent prompt is titled "A subagent asks" and is answered the same way', async () => {
    const d = dialogOf('PERM_BASH_PREFIX');
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    const sub = pending('a', { kind: 'subagent-info', tool: 'Bash', agentId: 'agent-1' });
    await openDock('PERM_BASH_PREFIX', { api: { sessionDialog }, pending: [sub] });
    expect(within(card()).getByRole('heading', { name: 'A subagent asks · Bash' })).toBeTruthy();
    fireEvent.click(buttonOf(rowsOf()[3] as HTMLElement));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: d.fingerprint, option: 3 }, expect.any(String)));
  });
});

describe('the dock while it reads, on the prompt box, and for focus', () => {
  it('reading: the dock says so (the chunk\'s frame, then its own) with no rows and no keys, then the dialog shows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let land: (r: ScreenResponse) => void = () => undefined;
    const getScreen = vi.fn(() => new Promise<ScreenResponse>((r) => (land = r)));
    renderApp({
      path: '/s/a',
      api: fakeApi({ getScreen }),
      state: stateWith({ sessions: [session('a', { status: 'waiting' })], features: { controls: true } }),
    });
    expect(await screen.findByRole('status', { name: 'Reading the screen' })).toBeTruthy();
    expect(within(card()).getByRole('heading', { name: 'Claude is waiting in the terminal' })).toBeTruthy();
    expect(within(card()).queryByRole('group', { name: 'Choices' })).toBeNull();
    expect(within(card()).queryByRole('region', { name: 'Keys' })).toBeNull();
    await waitFor(() => expect(getScreen).toHaveBeenCalled());
    await act(async () => land(readOf('PERM_CREATE_2')));
    expect(await within(card()).findByRole('group', { name: 'Choices' })).toBeTruthy();
  });

  it("Claude's prompt box and no dialog: says Claude is ready for a prompt, and offers no keys", async () => {
    const read: ScreenResponse = { text: 'synthetic terminal text', lines: 40, at: iso(0), backend: 'terminal-app', screenKey: KEY, dialogNote: DIALOG_NOTES.promptBox };
    await openDock('Q_SCROLLED', { api: { getScreen: vi.fn(async () => read) } });
    expect(await within(card()).findByText(DIALOG_NOTES.promptBox)).toBeTruthy();
    expect(within(card()).queryByRole('region', { name: 'Keys' })).toBeNull();
    expect(within(card()).getByRole('button', { name: 'Show on Mac' })).toBeTruthy();
  });

  it("the terminal's full-width rules are cut to fit the phone's box", async () => {
    const rule = '─'.repeat(80);
    const read: ScreenResponse = { text: `● Done.\n${rule}\n Pick one`, lines: 3, at: iso(0), backend: 'terminal-app', screenKey: KEY, dialogNote: DIALOG_NOTES.unsure };
    await openDock('Q_SCROLLED', { api: { getScreen: vi.fn(async () => read) } });
    const box = await within(card()).findByLabelText('Last lines of the terminal');
    expect(box.textContent).toBe(`● Done.\n${'─'.repeat(40)}\n Pick one`);
  });

  it('after a tap that brings the next question, focus is on its question (not lost to the page)', async () => {
    const next = dialogOf('Q_REVIEW');
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: next }));
    await openDock('Q_TABS', { api: { sessionDialog } });
    fireEvent.click(buttonOf(rowsOf()[0] as HTMLElement));
    const question = await within(card()).findByText(next.question);
    await waitFor(() => expect(document.activeElement).toBe(question));
  });

  it("a hold row's description is read with it (its aria-label replaces the row's text)", async () => {
    const d = dialogOf('Q_SINGLE');
    const held: TerminalDialog = { ...d, options: d.options.map((o, i) => (i === 0 ? { ...o, label: 'Always red', hold: 'rule' as const } : o)), fingerprint: '7'.repeat(64) };
    await openDock('Q_SINGLE', { api: { getScreen: vi.fn(async () => readWith(held)) } });
    const row = within(card()).getByRole('button', { name: 'Always red. Hold for 2 seconds' });
    const described = (row.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '');
    expect(described[0]).toBe('Choose red');
    expect(described[1]).toContain(DIALOG_HOLD_COPY.rule);
  });
});

describe("v0.5.2: an ask Claude blocks by itself (a workflow agent's Bash prompt)", () => {
  /** The line under the question at `left` (the read's time less a second for its way here). */
  const blocksAt = (left: string) => `Claude blocks this at the Mac in ${left} if nobody answers`;
  const rows = () => rowsOf().map((r) => buttonOf(r));

  it('counts down from the read, a second off for its way here; a tick refreshes it without starting afresh, and a tap right after it goes', async () => {
    const d = dialogOf('PERM_WORKFLOW_133');
    // The daemon gives every second of the countdown the same fingerprint: the countdown is in none.
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('PERM_WORKFLOW_133')).mockResolvedValue(readWith({ ...d, blocksIn: '1:30' }));
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    await openDock('PERM_WORKFLOW_133', { api: { getScreen, sessionDialog } });
    // 1:33 read, TAP_GUARD_MS since: 1 min 32 s.
    expect(within(card()).getByText(blocksAt('1 min 32 s'))).toBeTruthy();
    await pass(1_000);
    expect(within(card()).getByText(blocksAt('1 min 31 s'))).toBeTruthy();
    // What the Mac shows, the command and its warning, but not the countdown's own line.
    const body = within(card()).getByLabelText('What the dialog shows').textContent ?? '';
    expect(body).toContain('rm -rf $T/out/*');
    expect(body).not.toContain('automatically block');
    // The next read (1:30) starts the count again from itself.
    readAgain();
    expect(await within(card()).findByText(blocksAt('1 min 29 s'))).toBeTruthy();
    expect(within(card()).queryByText(CHANGED)).toBeNull();
    // Not a live region; the Choices name it, so a screen reader moving to Yes or No hears it.
    const line = within(card()).getByText(blocksAt('1 min 29 s'));
    expect(line.closest('[aria-live]')).toBeNull();
    expect(choices().getAttribute('aria-describedby')).toBe(line.id);
    // No settle: a tick is not a change under the finger, so the tap goes, with the one fingerprint.
    fireEvent.click(buttonOf(rowsOf()[1] as HTMLElement));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: d.fingerprint, option: 1 }, expect.any(String)));
    expect(within(card()).queryByText(TAP_DROPPED)).toBeNull();
    // The dialog went with the answer: so did the line.
    expect(await within(card()).findByText('Answered · No')).toBeTruthy();
    expect(within(card()).queryByText(/Claude blocks this|Claude has blocked this/u)).toBeNull();
  });

  it('keeps counting while reads fail (10 s on: 1 min 22 s), and says Claude has blocked it once the time is up', async () => {
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('PERM_WORKFLOW_133')).mockRejectedValue(new ApiError('network', 'offline', 0));
    await openDock('PERM_WORKFLOW_133', { api: { getScreen }, settled: false });
    await pass(10_000);
    expect(getScreen.mock.calls.length).toBeGreaterThan(1);
    expect(within(card()).getByText(blocksAt('1 min 22 s'))).toBeTruthy();
    expect(within(card()).queryByText(blocksAt('1 min 32 s'))).toBeNull();
    // 88 s in all: 4 s left, under the margin: the rows are off and the line says to answer at the Mac.
    await pass(78_000);
    expect(within(card()).getByText(DIALOG_COUNTDOWN_LATE)).toBeTruthy();
    expect(rows().every((b) => b.disabled)).toBe(true);
    await pass(12_000);
    expect(within(card()).getByText(BLOCKED)).toBeTruthy();
    expect(within(card()).queryByText(/Claude blocks this at the Mac in \d/u)).toBeNull();
    expect(rows().every((b) => b.disabled)).toBe(true);
  });

  it('back from 3 minutes in the background, never the old time, before or after the read lands', async () => {
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    let land: (r: ScreenResponse) => void = () => undefined;
    const getScreen = vi
      .fn()
      .mockResolvedValueOnce(readOf('PERM_WORKFLOW_133'))
      .mockImplementation(() => new Promise<ScreenResponse>((r) => (land = r)));
    await openDock('PERM_WORKFLOW_133', { api: { getScreen } });
    expect(within(card()).getByText(blocksAt('1 min 32 s'))).toBeTruthy();
    hidden = true;
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await pass(180_000);
    // The poll stays paused while hidden.
    expect(getScreen).toHaveBeenCalledTimes(1);
    hidden = false;
    readAgain();
    expect(within(card()).getByText(BLOCKED)).toBeTruthy();
    expect(within(card()).queryByText(/1 min|1:33/u)).toBeNull();
    // The read lands: Claude blocked it, no dialog.
    await act(async () => land({ ...readOf('PERM_WORKFLOW_133'), dialog: undefined }));
    expect(within(card()).queryByText(/Claude blocks this|Claude has blocked this/u)).toBeNull();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('a read under the margin locks the rows and says to answer at the Mac', async () => {
    const d = dialogOf('PERM_WORKFLOW_133');
    await openDock('PERM_WORKFLOW_133', { api: { getScreen: vi.fn(async () => readWith({ ...d, blocksIn: '0:05' })) } });
    // 0:05 read: 4 s left on the phone's count.
    expect(within(card()).getByText(DIALOG_COUNTDOWN_LATE)).toBeTruthy();
    expect(rows().every((b) => b.disabled)).toBe(true);
  });

  it("a 409 because the Mac's countdown had too little left says so, not that the dialog changed", async () => {
    const d = dialogOf('PERM_WORKFLOW_133');
    // The phone's count is the daemon's guide, not its guard: a tap that gets there late is a 409 that says why.
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('PERM_WORKFLOW_133')).mockResolvedValue(readWith({ ...d, blocksIn: '0:04' }));
    const sessionDialog = vi.fn(async () => {
      throw new ApiError('conflict', DIALOG_COUNTDOWN_LATE, 409);
    });
    await openDock('PERM_WORKFLOW_133', { api: { getScreen, sessionDialog } });
    fireEvent.click(buttonOf(rowsOf()[1] as HTMLElement));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalled());
    expect((await within(card()).findByRole('status')).textContent).toBe(DIALOG_COUNTDOWN_LATE);
    expect(within(card()).queryByText(CHANGED)).toBeNull();
  });

  it('a countdown that goes up under the same fingerprint is another ask: starts afresh, body open, says so, and drops a tap right after', async () => {
    const d = dialogOf('PERM_WORKFLOW_133');
    const getScreen = vi.fn().mockResolvedValueOnce(readWith({ ...d, blocksIn: '0:40' })).mockResolvedValue(readWith({ ...d, blocksIn: '1:59' }));
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    await openDock('PERM_WORKFLOW_133', { api: { getScreen, sessionDialog } });
    expect(within(card()).queryByText(CHANGED)).toBeNull();
    readAgain();
    expect(await within(card()).findByText(CHANGED)).toBeTruthy();
    expect(within(card()).getByText(blocksAt('1 min 58 s'))).toBeTruthy();
    expect(within(card()).getByLabelText('What the dialog shows')).toBeTruthy();
    // The tap guard starts again: a tap at once is dropped (the CHANGED line stays), one after it goes.
    fireEvent.click(buttonOf(rowsOf()[1] as HTMLElement));
    await landed();
    expect(sessionDialog).not.toHaveBeenCalled();
    expect(within(card()).getByText(CHANGED)).toBeTruthy();
    await settle();
    fireEvent.click(buttonOf(rowsOf()[1] as HTMLElement));
    await waitFor(() => expect(sessionDialog).toHaveBeenCalledWith('a', { fingerprint: d.fingerprint, option: 1 }, expect.any(String)));
  });

  it('the queued twin (another command, its own countdown) starts afresh, body open, and says so', async () => {
    const getScreen = vi.fn().mockResolvedValueOnce(readOf('PERM_WORKFLOW_TWIN_A')).mockResolvedValue(readOf('PERM_WORKFLOW_TWIN_B'));
    await openDock('PERM_WORKFLOW_TWIN_A', { api: { getScreen } });
    expect(within(card()).queryByText(CHANGED)).toBeNull();
    readAgain();
    expect(await within(card()).findByText(CHANGED)).toBeTruthy();
    expect(within(card()).getByLabelText('What the dialog shows').textContent).toContain('gamma DEMO-103/demo-search');
    expect(within(card()).getByText(blocksAt('1 min 57 s'))).toBeTruthy();
  });

  it('"about N minutes" shows as drawn, not counted down; the folded sheet starts its peek with the time left', async () => {
    const d = dialogOf('PERM_WORKFLOW_133');
    await openDock('PERM_WORKFLOW_133', { api: { getScreen: vi.fn(async () => readWith({ ...d, blocksIn: 'about 2 minutes' })) } });
    expect(within(card()).getByText(blocksAt('about 2 minutes'))).toBeTruthy();
    await pass(1_000);
    expect(within(card()).getByText(blocksAt('about 2 minutes'))).toBeTruthy();
    fireEvent.click(within(card()).getByRole('button', { name: 'Fold the panel' }));
    expect(within(card()).getByText('about 2 minutes left · Do you want to proceed?')).toBeTruthy();
  });

  it('a dialog without a countdown says nothing of one', async () => {
    await openDock('PERM_BASH_PREFIX');
    expect(within(card()).queryByText(/Claude blocks this|Claude has blocked this/u)).toBeNull();
    expect(choices().getAttribute('aria-describedby')).toBeNull();
  });

  it("the dock's copies of the margin, the late sentence and the seconds are the protocol's own", () => {
    expect(COUNTDOWN_MIN_S).toBe(DIALOG_COUNTDOWN_MIN_S);
    expect(COUNTDOWN_LATE).toBe(DIALOG_COUNTDOWN_LATE);
    for (const time of ['1:33', '0:05', '0:00', '12:00', 'about 2 minutes', 'about 1 minute', 'about 40 seconds', 'about 1 second', '45', 'soon', 'About 1 Minute']) {
      expect(countdownSecondsOf(time), time).toBe(countdownSeconds(time));
    }
  });

  it('blocksLine and leftWords: minutes and seconds in words, never a clock time', () => {
    expect(blocksLine(leftWords(93))).toBe('Claude blocks this at the Mac in 1 min 33 s if nobody answers');
    expect(leftWords(120)).toBe('2 min');
    expect(leftWords(59)).toBe('59 s');
    expect(leftWords(0)).toBe('0 s');
    expect(blocksLine('about 2 minutes')).toBe('Claude blocks this at the Mac in about 2 minutes if nobody answers');
  });
});

describe("v0.5.3: the Answer soon tone as Claude's countdown crosses 60, 30 and 10 s left", () => {
  /** Fake chimes that record each tone and phrase (lib/sounds.ts). */
  function recorder() {
    const r = {
      tones: [] as string[],
      said: [] as string[],
      unlock: () => Promise.resolve(),
      wake: () => undefined,
      play: (tone: string) => (r.tones.push(tone), true),
      speak: (group: string) => void r.said.push(group),
    };
    setAppChimes(r as unknown as Chimes);
    return r;
  }
  const sounds = (over: { on?: boolean; speak?: boolean; urgent?: string } = {}) =>
    writeLocal('alert-sounds', { v: 1, on: over.on ?? true, speak: over.speak ?? false, tones: { urgent: over.urgent ?? 'alarm', needs: 'ding', done: 'success', care: 'bell', problem: 'low' } });
  /** The first read, then reads that fail: the phone keeps counting from the first. */
  const onlyFirst = (blocksIn: string) =>
    vi.fn().mockResolvedValueOnce(readWith({ ...dialogOf('PERM_WORKFLOW_133'), blocksIn })).mockRejectedValue(new ApiError('network', 'offline', 0));

  afterEach(() => setAppChimes(null));
  const blocksAt = (left: string) => `Claude blocks this at the Mac in ${left} if nobody answers`;

  it('plays the urgent tone once at each mark, none at 0', async () => {
    expect(TONE_AT_S).toEqual([60, 30, 10]);
    const r = recorder();
    sounds();
    // 1:33 read: 92 s left on the phone's count.
    await openDock('PERM_WORKFLOW_133', { api: { getScreen: onlyFirst('1:33') } });
    await pass(29_000);
    expect(r.tones).toEqual([]);
    await pass(5_000);
    expect(r.tones).toEqual(['alarm']);
    await pass(25_000);
    expect(r.tones).toEqual(['alarm']);
    await pass(5_000);
    expect(r.tones).toEqual(['alarm', 'alarm']);
    await pass(15_000);
    expect(r.tones).toEqual(['alarm', 'alarm']);
    await pass(5_000);
    expect(r.tones).toEqual(['alarm', 'alarm', 'alarm']);
    await pass(15_000);
    expect(within(card()).getByText(BLOCKED)).toBeTruthy();
    expect(r.tones).toEqual(['alarm', 'alarm', 'alarm']);
    expect(r.said).toEqual([]);
  });

  it('a read every 3 s that starts the count again never plays a mark twice', async () => {
    const r = recorder();
    sounds({ urgent: 'bell' });
    const d = dialogOf('PERM_WORKFLOW_133');
    const t0 = Date.now();
    // The Mac's countdown as the reads find it: 1:33 at the first, a second less each second.
    const getScreen = vi.fn(async () => {
      const left = Math.max(0, 93 - Math.floor((Date.now() - t0) / 1000));
      return readWith({ ...d, blocksIn: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
    });
    await openDock('PERM_WORKFLOW_133', { api: { getScreen } });
    for (let i = 0; i < 90; i++) await pass(1_000);
    expect(getScreen.mock.calls.length).toBeGreaterThan(20);
    expect(r.tones).toEqual(['bell', 'bell', 'bell']);
  });

  it('a dock that opens with 45 s left plays at 30 and 10 only', async () => {
    const r = recorder();
    sounds();
    await openDock('PERM_WORKFLOW_133', { api: { getScreen: onlyFirst('0:45') } });
    await pass(20_000);
    expect(r.tones).toEqual(['alarm']);
    await pass(20_000);
    expect(r.tones).toEqual(['alarm', 'alarm']);
  });

  it('back from the background past two marks at once (60 and 30): one tone, then 10 as usual', async () => {
    const r = recorder();
    sounds();
    await openDock('PERM_WORKFLOW_133', { api: { getScreen: onlyFirst('1:33') } });
    expect(within(card()).getByText(blocksAt('1 min 32 s'))).toBeTruthy();
    // The phone slept 70 s: no tick ran, the wall clock moved on; the page shows again.
    vi.setSystemTime(Date.now() + 70_000);
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(within(card()).getByText(blocksAt('22 s'))).toBeTruthy();
    expect(r.tones).toEqual(['alarm']);
    await pass(5_000);
    expect(r.tones).toEqual(['alarm']);
    await pass(10_000);
    expect(r.tones).toEqual(['alarm', 'alarm']);
  });

  it('stops once the ask is answered', async () => {
    const r = recorder();
    sounds();
    const sessionDialog = vi.fn(async () => ({ outcome: 'done' as const, dialog: null }));
    await openDock('PERM_WORKFLOW_133', { api: { getScreen: onlyFirst('1:33'), sessionDialog } });
    await pass(34_000);
    expect(r.tones).toEqual(['alarm']);
    fireEvent.click(buttonOf(rowsOf()[1] as HTMLElement));
    expect(await within(card()).findByText('Answered · No')).toBeTruthy();
    await pass(60_000);
    expect(r.tones).toEqual(['alarm']);
  });

  it("follows this device's Sounds: off plays nothing", async () => {
    const off = recorder();
    sounds({ on: false });
    await openDock('PERM_WORKFLOW_133', { api: { getScreen: onlyFirst('0:35') } });
    await pass(10_000);
    expect(within(card()).getByText(blocksAt('24 s'))).toBeTruthy();
    expect(off.tones).toEqual([]);
    expect(off.said).toEqual([]);
  });

  it('with Speak on, says "Answer soon" with the tone', async () => {
    const speaking = recorder();
    sounds({ speak: true });
    await openDock('PERM_WORKFLOW_133', { api: { getScreen: onlyFirst('0:35') } });
    await pass(10_000);
    expect(speaking.tones).toEqual(['alarm']);
    expect(speaking.said).toEqual(['urgent']);
  });

  it('an "about 1 minute" countdown (not counted down) plays nothing', async () => {
    const about = recorder();
    sounds();
    const d = dialogOf('PERM_WORKFLOW_133');
    await openDock('PERM_WORKFLOW_133', { api: { getScreen: vi.fn(async () => readWith({ ...d, blocksIn: 'about 1 minute' })) } });
    await pass(70_000);
    expect(about.tones).toEqual([]);
  });
});
