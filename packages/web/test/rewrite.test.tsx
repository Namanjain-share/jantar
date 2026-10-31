/**
 * The Rewrite button and review sheet (decisions U5, U6; spec 5.1 adapted to
 * text) against the fake API: every state renders (writing, review, failed,
 * the request errors, offline, too long), every action calls what it says,
 * and nothing is ever sent without a tap.
 *
 * Security rules this package owns (spec 6, adapted to text):
 *   R7  a written prompt that starts with "!" is refused by the sheet until edited
 *   W6  nothing auto-sends: ready, hidden, unmounted or interrupted by a card
 *   plus: the prompt text only ever comes from rewriteGet (events carry none),
 *   and no text is kept in localStorage.
 *
 * Timing (the sent receipt's SENT_MS, the STALL_MS check, GET_TIMEOUT_MS) runs
 * on fake timers that still advance on their own, so waitFor keeps polling.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NO_FEATURES,
  PROTOCOL_VERSION,
  type DaemonEvent,
  type RewriteDetail,
  type RewriteJob,
  type WsServerMessage,
} from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import type { AppStore } from '../src/store.js';
import { GET_TIMEOUT_MS, SENT_MS, STALL_MS } from '../src/ui/rewrite/useRewrite.js';
import { originTag } from '../src/ui/screens/session/SendReceipt.js';
import { fakeUploads, pdf } from './attach-helpers.js';
import { emit, fakeApi, iso, pending, renderApp, sendJob, session, stateWith } from './helpers.js';

const SID = 'a';
const SAID = 'haan so the send timeout in send dot ts, make it ten minutes and fix the tests';
const PROMPT = 'In `send.ts`, raise the proof timeout from 5 minutes to 10 minutes, and update the tests to match.';
const NO_FLAGS = { expanded: false, newTokens: 0, leading: null, preface: false };

function rjob(id: string, over: Partial<RewriteJob> = {}): RewriteJob {
  return {
    id,
    sid: SID,
    deviceId: 'dev-1',
    state: 'queued',
    model: 'opus',
    input: { hash: 'synthetic-input-hash', length: SAID.length },
    createdAt: iso(120_000),
    updatedAt: iso(120_000),
    ...over,
  };
}

const ready = (id: string, over: Partial<RewriteJob> = {}) =>
  rjob(id, {
    state: 'ready',
    account: 7,
    ms: 2400,
    prompt: { hash: 'synthetic-prompt-hash', length: PROMPT.length, flags: NO_FLAGS },
    updatedAt: iso(125_000),
    ...over,
  });

/** GET /v1/rewrite/:jobId as WP-R answers it: what the user said stays until the job is sent or cancelled. */
const detail = (job: RewriteJob, prompt?: string, newTokens?: string[]): RewriteDetail => ({
  state: job.state,
  ...(job.state !== 'sent' && job.state !== 'cancelled' ? { input: SAID } : {}),
  ...(prompt !== undefined ? { prompt } : {}),
  ...(newTokens ? { newTokens } : {}),
  job,
});

/** Apply a rewrite.progress event as the WebSocket would (next seq). */
function push(store: AppStore, job: RewriteJob) {
  const seq = store.getState().state.seq + 1;
  const ev = { seq, ts: job.updatedAt, type: 'rewrite.progress', sid: job.sid, data: { job } } as DaemonEvent;
  act(() => emit(store, [ev]));
}

/** A fresh state snapshot (a daemon restart: its jobs lived in memory, so `rewrites` is empty). */
function snapshot(store: AppStore) {
  const fresh = stateWith({ sessions: [session(SID, { status: 'idle' })], features: { rewrite: true } });
  const seq = store.getState().state.seq + 1;
  act(() => store.getState().applyMessage({ kind: 'snapshot', seq, state: fresh } as unknown as WsServerMessage));
}

function hello(store: AppStore, epoch: string) {
  const msg = { kind: 'hello', protocol: PROTOCOL_VERSION, daemonVersion: '0.0.0-test', webHash: null, epoch, seq: store.getState().state.seq };
  act(() => store.getState().applyMessage(msg as WsServerMessage));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake API whose Rewrite calls work: job rw-1, rw-2 ... and the prompt above. */
function rewriteApi(over: Parameters<typeof fakeApi>[0] = {}) {
  let n = 0;
  return fakeApi({
    rewriteStart: vi.fn(async () => {
      n += 1;
      const id = `rw-${n}`;
      return { jobId: id, job: rjob(id) };
    }),
    rewriteGet: vi.fn(async (jobId: string) => detail(ready(jobId), PROMPT)),
    rewriteCancel: vi.fn(async (jobId: string) => ({ job: rjob(jobId, { state: 'cancelled' }) })),
    ...over,
  });
}

function render(api = rewriteApi(), opts: { status?: 'live' | 'offline' } = {}) {
  return renderApp({
    path: `/s/${SID}`,
    api,
    state: stateWith({ sessions: [session(SID, { status: 'idle' })], features: { rewrite: true } }),
    ...(opts.status ? { status: opts.status } : {}),
  });
}

const box = () => screen.getByLabelText('Prompt for Claude') as HTMLTextAreaElement;
const rewriteButton = () => screen.getByRole('button', { name: 'Rewrite as a prompt' }) as HTMLButtonElement;
const sheet = () => screen.getByRole('dialog', { name: `Rewrite for ${SID}` });
const promptBox = () => within(sheet()).getByLabelText('Prompt') as HTMLTextAreaElement;
const action = (name: string | RegExp) => within(sheet()).getByRole('button', { name }) as HTMLButtonElement;
const phaseNow = () => sheet().querySelector('[data-phase]')?.getAttribute('data-phase');
/** The sheet's one sentence for a failure (ink, a status) or an error (ember, an alert). */
const sentence = (text: string | RegExp) => within(sheet()).findByText(text, { selector: 'p' });

/** Fake timers that still advance on their own, so waitFor keeps polling. */
const fakeClock = () => vi.useFakeTimers({ shouldAdvanceTime: true });

/**
 * An accepted send: the sheet shows its receipt and says Sent, then closes SENT_MS later (needs fakeClock).
 * The close timer is set by an effect after the 'sent' render; on a loaded machine the manual advance can
 * run before that effect has, so the last wait outlasts SENT_MS and lets the self-advancing clock fire it.
 */
async function sentThenClosed() {
  await waitFor(() => expect(phaseNow()).toBe('sent'));
  expect(within(sheet()).getAllByRole('status').some((s) => s.textContent === 'Sent')).toBe(true);
  act(() => vi.advanceTimersByTime(SENT_MS));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 3 * SENT_MS });
}

async function openSheet(text = SAID) {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.click(rewriteButton());
  return screen.findByRole('dialog', { name: `Rewrite for ${SID}` });
}

/** Open the sheet and bring rw-1 to ready, with the prompt in the box. */
async function reviewReady(api = rewriteApi(), opts: { job?: Partial<RewriteJob> } = {}) {
  const r = render(api);
  await openSheet();
  await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(1));
  push(r.store, ready('rw-1', opts.job));
  await waitFor(() => expect(promptBox()).toBeTruthy());
  return r;
}

/**
 * The pane after answering a card: the answer receipt with the composer under
 * it. Sending clears the receipt; Session.tsx keeps the composer at the same
 * place in the tree, so the Rewrite sheet stays open through the send.
 */
function renderAfterAnswer(api = rewriteApi()) {
  const card = pending(SID, { kind: 'permission', state: 'decided' });
  const r = renderApp({
    path: `/s/${SID}`,
    api,
    state: stateWith({ sessions: [session(SID, { status: 'idle' })], pending: [card], features: { rewrite: true } }),
  });
  act(() => emit(r.store, [{ seq: r.store.getState().state.seq + 1, ts: iso(130_000), type: 'pending.resolved', sid: SID, data: { id: card.id, state: 'closed' } } as DaemonEvent]));
  return r;
}

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the Rewrite button', () => {
  it('sits between the box and Send, and needs text and a connection', () => {
    const { store } = render();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(box().compareDocumentPosition(rewriteButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rewriteButton().compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rewriteButton().textContent).toBe('Rewrite');
    expect(rewriteButton().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: '   ' } });
    expect(rewriteButton().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: SAID } });
    expect(rewriteButton().disabled).toBe(false);
    act(() => store.getState().setConn({ status: 'offline' }));
    expect(rewriteButton().disabled).toBe(true);
  });

  it('is not in the composer while Rewrite is off on the Mac', () => {
    renderApp({ path: `/s/${SID}`, state: stateWith({ sessions: [session(SID, { status: 'idle' })] }) });
    expect(screen.queryByRole('button', { name: 'Rewrite as a prompt' })).toBeNull();
  });
});

describe('the review sheet', () => {
  it('opens at once with what the user said, trimmed, and starts one run with the default model', async () => {
    const api = rewriteApi();
    render(api);
    const dialog = await openSheet(`  ${SAID}\n `);
    expect(within(dialog).getByText('You said')).toBeTruthy();
    expect(within(dialog).getByText(SAID)).toBeTruthy();
    expect(within(dialog).getByText('Writing the prompt…')).toBeTruthy();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(1));
    expect(api.rewriteStart).toHaveBeenCalledWith(SID, SAID, { idempotencyKey: expect.any(String) });
    // Nothing to send yet, and only "what I said" can go.
    expect(within(dialog).queryByRole('button', { name: 'Send' })).toBeNull();
    expect(action('Send what I said').disabled).toBe(false);
    expect(within(dialog).queryByRole('button', { name: 'Rewrite again' })).toBeNull();
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it('follows the job, and takes the prompt only from rewriteGet (events carry no text)', async () => {
    const get = deferred<RewriteDetail>();
    const api = rewriteApi({ rewriteGet: vi.fn(() => get.promise) });
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, rjob('rw-1', { state: 'writing', updatedAt: iso(121_000) }));
    expect(within(sheet()).getByText('Writing the prompt…')).toBeTruthy();
    expect(sheet().querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('writing');

    push(store, ready('rw-1'));
    await waitFor(() => expect(api.rewriteGet).toHaveBeenCalledWith('rw-1'));
    // Ready, but the text is not here until the GET answers.
    expect(sheet().textContent).not.toContain(PROMPT);
    expect(within(sheet()).getByText('Writing the prompt…')).toBeTruthy();

    get.resolve(detail(ready('rw-1'), PROMPT));
    await waitFor(() => expect(promptBox().value).toBe(PROMPT));
    expect(within(sheet()).getByText('opus · 07 · 2.4 s')).toBeTruthy();
    expect(within(sheet()).getAllByRole('status').some((s) => s.textContent === 'Prompt ready')).toBe(true);
    expect(action('Send').disabled).toBe(false);
    for (const name of ['Send what I said', 'Rewrite again', 'Rewrite with Sonnet', 'Discard']) expect(action(name)).toBeTruthy();
    // A later event for the same job does not fetch again.
    push(store, ready('rw-1', { updatedAt: iso(126_000) }));
    expect(api.rewriteGet).toHaveBeenCalledTimes(1);
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it('says what the guards found, in ink, with the names the user never said', async () => {
    const api = rewriteApi({ rewriteGet: vi.fn(async (id: string) => detail(ready(id), PROMPT, ['src/new-file.ts', '--force'])) });
    await reviewReady(api, { job: { prompt: { hash: 'h', length: 400, flags: { expanded: true, newTokens: 2, leading: 'slash', preface: true } } } });
    const text = sheet().textContent ?? '';
    expect(text).toContain('Longer than what you said · check it');
    expect(text).toContain("Mentions 2 names you didn't say · check them");
    expect(text).toContain('Starts with / so Claude reads it as a command · check it');
    expect(within(sheet()).getByText('Longer than what you said · check it').className).toContain('text-ink-2');
    const names = within(sheet()).getByRole('list', { name: 'Not in what you said' });
    expect(within(names).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['src/new-file.ts', '--force']);
    // Ink only: no ember for a flag.
    expect(sheet().querySelector('.text-signal-text')).toBeNull();
  });

  it('shows no flag lines for a clean prompt', async () => {
    await reviewReady();
    expect(sheet().textContent).not.toMatch(/check (it|them)/);
    expect(within(sheet()).queryByRole('list', { name: 'Not in what you said' })).toBeNull();
  });

  it('R7: refuses a written prompt that starts with "!" (bash mode) until it is edited', async () => {
    const api = rewriteApi({ rewriteGet: vi.fn(async (id: string) => detail(ready(id), '! rm -rf build')) });
    await reviewReady(api, { job: { prompt: { hash: 'h', length: 14, flags: { ...NO_FLAGS, leading: 'bang' } } } });
    expect(promptBox().value).toBe('! rm -rf build');
    expect(action('Send').disabled).toBe(true);
    expect(within(sheet()).getByText(/starts with ! runs as a shell command/)).toBeTruthy();
    fireEvent.click(action('Send'));
    fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true });
    expect(api.sendPrompt).not.toHaveBeenCalled();

    fireEvent.change(promptBox(), { target: { value: 'Delete the build folder' } });
    expect(action('Send edited').disabled).toBe(false);
    expect(within(sheet()).queryByText(/starts with ! runs as a shell command/)).toBeNull();
  });

  it('caps the prompt at 16,000 characters, like the composer', async () => {
    const long = 'x'.repeat(16_001);
    const api = rewriteApi({ rewriteGet: vi.fn(async (id: string) => detail(ready(id), long)) });
    await reviewReady(api);
    expect(promptBox().maxLength).toBe(16_000);
    expect(action('Send').disabled).toBe(true);
    expect(within(sheet()).getByText('The Mac takes 16,000 characters at most. Shorten it to send.')).toBeTruthy();
  });

  it('a failed run shows its one sentence in ink, and "Send what I said" is the primary, one tap away', async () => {
    fakeClock();
    const api = rewriteApi();
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    const reason = 'No account has room for the prompt writer. Send what you said, or edit it.';
    push(store, rjob('rw-1', { state: 'failed', failure: 'no_account', reason, updatedAt: iso(122_000) }));
    // A fallback with text to review is ink, not ember (spec 5.0 rule 3, 5.1), and polite.
    const line = await sentence(reason);
    expect(line.getAttribute('role')).toBe('status');
    expect(line.className).toContain('text-ink-2');
    expect(sheet().querySelector('.text-signal-text')).toBeNull();
    expect(promptBox().value).toBe(SAID);
    // "Send what I said" is never hidden (U5): with what the user said in the box it is the primary, not a second button.
    expect(within(sheet()).getAllByRole('button', { name: 'Send what I said' })).toHaveLength(1);
    expect(within(sheet()).queryByRole('button', { name: 'Send' })).toBeNull();
    expect(api.rewriteGet).not.toHaveBeenCalled();
    fireEvent.click(action('Send what I said'));
    // Plainly: a failed job has no prompt to compare, so the id could only get a 404.
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sendPrompt.mock.calls[0]).toEqual([SID, SAID, expect.any(String)]);
    // The Mac still holds what the user said for that job: cancelling drops it as the send goes.
    expect(api.rewriteCancel).toHaveBeenCalledWith('rw-1');
    await sentThenClosed();
  });

  it('an edit after a failure says "Send edited", and "Send what I said" comes back beside it', async () => {
    const api = rewriteApi();
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, rjob('rw-1', { state: 'failed', failure: 'timeout', updatedAt: iso(122_000) }));
    await sentence('The prompt writer timed out. Here is what you said.');
    fireEvent.change(promptBox(), { target: { value: `${SAID}, and the docs` } });
    expect(action('Send edited').disabled).toBe(false);
    expect(action('Send what I said').disabled).toBe(false);
    fireEvent.click(action('Send what I said'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledWith(SID, SAID, expect.any(String)));
  });

  it('falls back to a fixed sentence per failure when the job has no reason, and a stopped job says so', async () => {
    const api = rewriteApi();
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, rjob('rw-1', { state: 'failed', failure: 'timeout', updatedAt: iso(122_000) }));
    expect((await sentence('The prompt writer timed out. Here is what you said.')).className).toContain('text-ink-2');
    // Rewrite again is offered after a failure.
    fireEvent.click(action('Rewrite again'));
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(2));
    push(store, rjob('rw-2', { state: 'cancelled', updatedAt: iso(123_000) }));
    expect((await sentence('This rewrite was stopped. Here is what you said.')).className).toContain('text-ink-2');
  });

  it('explains a Mac without Rewrite (501), with no Try again', async () => {
    const api = fakeApi();
    render(api);
    await openSheet();
    const alert = await within(sheet()).findByRole('alert');
    expect(alert.textContent).toBe("Jantar on this Mac can't rewrite prompts yet.");
    // A request error with nothing to review is the one ember line.
    expect(alert.className).toContain('text-signal-text');
    expect(within(sheet()).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(action('Send what I said').disabled).toBe(false);
  });

  it('shows a refusal (403) as the Mac words it, with no Try again', async () => {
    const api = rewriteApi({
      rewriteStart: vi.fn(async () => {
        throw new ApiError('forbidden', 'Rewrite is off. Turn it on at your Mac: jantar settings rewrite.enabled true', 403);
      }),
    });
    render(api);
    await openSheet();
    expect((await within(sheet()).findByRole('alert')).textContent).toMatch(/^Rewrite is off\. Turn it on at your Mac/);
    expect(within(sheet()).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('retries a start that never reached the Mac with the same idempotency key', async () => {
    const rewriteStart = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'Failed to fetch', 0))
      .mockResolvedValueOnce({ jobId: 'rw-1', job: rjob('rw-1') });
    const api = rewriteApi({ rewriteStart });
    render(api);
    await openSheet();
    expect((await within(sheet()).findByRole('alert')).textContent).toMatch(/Could not reach the Mac/);
    fireEvent.click(action('Try again'));
    await waitFor(() => expect(rewriteStart).toHaveBeenCalledTimes(2));
    expect(rewriteStart.mock.calls[1]![2].idempotencyKey).toBe(rewriteStart.mock.calls[0]![2].idempotencyKey);
    expect(await within(sheet()).findByText('Writing the prompt…')).toBeTruthy();
  });

  it('starts afresh (a new key) after a rate limit', async () => {
    const rewriteStart = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('rate_limited', 'too many rewrites', 429))
      .mockResolvedValueOnce({ jobId: 'rw-1', job: rjob('rw-1') });
    render(rewriteApi({ rewriteStart }));
    await openSheet();
    expect((await within(sheet()).findByRole('alert')).textContent).toBe('Too many tries. Wait a minute and try again.');
    fireEvent.click(action('Try again'));
    await waitFor(() => expect(rewriteStart).toHaveBeenCalledTimes(2));
    expect(rewriteStart.mock.calls[1]![2].idempotencyKey).not.toBe(rewriteStart.mock.calls[0]![2].idempotencyKey);
  });

  it('can fetch the prompt again after a network failure', async () => {
    const rewriteGet = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'Failed to fetch', 0))
      .mockResolvedValueOnce(detail(ready('rw-1'), PROMPT));
    const api = rewriteApi({ rewriteGet });
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, ready('rw-1'));
    expect((await within(sheet()).findByRole('alert')).textContent).toMatch(/^Couldn't fetch the prompt: Could not reach the Mac/);
    fireEvent.click(action('Try again'));
    await waitFor(() => expect(promptBox().value).toBe(PROMPT));
    expect(rewriteGet).toHaveBeenCalledTimes(2);
  });

  it('a job the Mac no longer has at fetch time leaves what the user said, sent plainly', async () => {
    const api = rewriteApi({
      rewriteGet: vi.fn(async () => {
        throw new ApiError('not_found', 'no such rewrite job', 404);
      }),
    });
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, ready('rw-1'));
    expect((await sentence('The Mac no longer has this rewrite. Here is what you said.')).className).toContain('text-ink-2');
    expect(promptBox().value).toBe(SAID);
    fireEvent.click(action('Send what I said'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledWith(SID, SAID, expect.any(String)));
    expect(api.sendPrompt.mock.calls[0]).toHaveLength(3);
  });

  it('never sends text over 8,000 characters to the prompt writer', async () => {
    const api = rewriteApi();
    render(api);
    const long = `${'word '.repeat(1_700)}end`;
    await openSheet(long);
    await sentence(`That's too long to rewrite: ${long.length.toLocaleString('en-US')} characters, and the limit is 8,000. Send it as it is, or split it.`);
    expect(api.rewriteStart).not.toHaveBeenCalled();
    expect(within(sheet()).queryByRole('button', { name: 'Rewrite again' })).toBeNull();
    fireEvent.click(action('Send what I said'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledWith(SID, long, expect.any(String)));
  });

  it('Discard cancels the job, closes, and leaves the draft as it was', async () => {
    const api = rewriteApi();
    await reviewReady(api);
    fireEvent.click(action('Discard'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.rewriteCancel).toHaveBeenCalledWith('rw-1');
    expect(box().value).toBe(SAID);
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it('Discard while the POST is still out cancels the job once the Mac answers', async () => {
    const start = deferred<{ jobId: string; job: RewriteJob }>();
    const api = rewriteApi({ rewriteStart: vi.fn(() => start.promise) });
    render(api);
    await openSheet();
    fireEvent.click(action('Discard'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    start.resolve({ jobId: 'rw-9', job: rjob('rw-9') });
    await waitFor(() => expect(api.rewriteCancel).toHaveBeenCalledWith('rw-9'));
  });

  it('Escape only hides the sheet: Rewrite brings the same review back, and a new draft drops it', async () => {
    const api = rewriteApi();
    await reviewReady(api);
    fireEvent.change(promptBox(), { target: { value: `${PROMPT} Keep it short.` } });
    fireEvent.keyDown(promptBox(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.rewriteCancel).not.toHaveBeenCalled();

    fireEvent.click(rewriteButton());
    await screen.findByRole('dialog', { name: `Rewrite for ${SID}` });
    expect(promptBox().value).toBe(`${PROMPT} Keep it short.`);
    expect(api.rewriteStart).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(promptBox(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.change(box(), { target: { value: `${SAID} and the docs` } });
    await waitFor(() => expect(api.rewriteCancel).toHaveBeenCalledWith('rw-1'));
    fireEvent.click(rewriteButton());
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(2));
    expect(api.rewriteStart.mock.calls[1]![1]).toBe(`${SAID} and the docs`);
  });

  it('Rewrite starts afresh when the held review can never send: a final refusal', async () => {
    const rewriteStart = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('not_implemented', 'not built', 501))
      .mockResolvedValueOnce({ jobId: 'rw-1', job: rjob('rw-1') });
    render(rewriteApi({ rewriteStart }));
    await openSheet();
    await within(sheet()).findByRole('alert');
    fireEvent.keyDown(sheet(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The Mac gained Rewrite since: the same draft gets a new run, not the old error.
    fireEvent.click(rewriteButton());
    await waitFor(() => expect(rewriteStart).toHaveBeenCalledTimes(2));
    expect(await within(sheet()).findByText('Writing the prompt…')).toBeTruthy();
    expect(within(sheet()).queryByRole('alert')).toBeNull();
  });

  it('Rewrite starts afresh when the held job was stopped, and brings back one that can still retry', async () => {
    const rewriteStart = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'Failed to fetch', 0))
      .mockResolvedValueOnce({ jobId: 'rw-1', job: rjob('rw-1') })
      .mockResolvedValueOnce({ jobId: 'rw-2', job: rjob('rw-2') });
    const api = rewriteApi({ rewriteStart });
    const { store } = render(api);
    await openSheet();
    await within(sheet()).findByRole('alert');
    fireEvent.keyDown(sheet(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // A network failure can still be tried again: the same review comes back.
    fireEvent.click(rewriteButton());
    expect(await within(sheet()).findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(rewriteStart).toHaveBeenCalledTimes(1);
    fireEvent.click(action('Try again'));
    await waitFor(() => expect(rewriteStart).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(sheet(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Stopped on the Mac while hidden: nothing left to send with it, so a new run.
    push(store, rjob('rw-1', { state: 'cancelled', updatedAt: iso(123_000) }));
    fireEvent.click(rewriteButton());
    await waitFor(() => expect(rewriteStart).toHaveBeenCalledTimes(3));
    expect(rewriteStart.mock.calls[2]![1]).toBe(SAID);
  });

  it('Rewrite again and Rewrite with Sonnet start new runs on the same text and stop the old one', async () => {
    const api = rewriteApi();
    const { store } = await reviewReady(api);
    fireEvent.click(action('Rewrite again'));
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(2));
    expect(api.rewriteStart.mock.calls[1]).toEqual([SID, SAID, { idempotencyKey: expect.any(String) }]);
    expect(api.rewriteCancel).toHaveBeenCalledWith('rw-1');
    expect(within(sheet()).getByText('Writing the prompt…')).toBeTruthy();

    push(store, ready('rw-2', { model: 'opus' }));
    await waitFor(() => expect(promptBox().value).toBe(PROMPT));
    fireEvent.click(action('Rewrite with Sonnet'));
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(3));
    expect(api.rewriteStart.mock.calls[2]).toEqual([SID, SAID, { model: 'sonnet', idempotencyKey: expect.any(String) }]);
    expect(api.rewriteCancel).toHaveBeenCalledWith('rw-2');
    push(store, ready('rw-3', { model: 'sonnet', account: 4, ms: 1830 }));
    expect(await within(sheet()).findByText('sonnet · 04 · 1.8 s')).toBeTruthy();
  });

  it('a rewrite over edits in the box asks once before it replaces them', async () => {
    const api = rewriteApi();
    await reviewReady(api);
    fireEvent.change(promptBox(), { target: { value: `${PROMPT} Also lint.` } });
    fireEvent.click(action('Rewrite again'));
    expect(api.rewriteStart).toHaveBeenCalledTimes(1);
    expect(within(sheet()).getByText('A new rewrite replaces your edits in the box. Tap again to go ahead.')).toBeTruthy();
    // Edited again: the warning was about other text, so it asks again.
    fireEvent.change(promptBox(), { target: { value: `${PROMPT} Also lint, then test.` } });
    expect(action('Rewrite again').textContent).toBe('Rewrite again');
    fireEvent.click(action('Rewrite with Sonnet'));
    expect(api.rewriteStart).toHaveBeenCalledTimes(1);
    fireEvent.click(action('Replace my edits with Sonnet'));
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(2));
    expect(api.rewriteStart.mock.calls[1]).toEqual([SID, SAID, { model: 'sonnet', idempotencyKey: expect.any(String) }]);
  });

  it('the guard flags and the new names are read with the Prompt box', async () => {
    await reviewReady(rewriteApi(), { job: { prompt: { hash: 'h', length: 10, flags: { ...NO_FLAGS, newTokens: 1 } } } as never });
    const ids = (promptBox().getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.map((id) => document.getElementById(id)?.textContent).join(' ')).toContain("Mentions a name you didn't say");
  });

  it('turns the send actions off while offline, and says why', async () => {
    const { store } = await reviewReady();
    act(() => store.getState().setConn({ status: 'offline' }));
    expect(action('Send').disabled).toBe(true);
    expect(action('Send what I said').disabled).toBe(true);
    expect(action('Rewrite again').disabled).toBe(true);
    expect(within(sheet()).getByText("Offline: can't send right now")).toBeTruthy();
    // Discard still works.
    expect(action('Discard').disabled).toBe(false);
  });

  it('says once where the text goes', async () => {
    const api = rewriteApi();
    await reviewReady(api);
    const intro = /go to Claude on one of your accounts, which writes the prompt/;
    // What the Mac forgets is its own copy of the two texts; the session's messages are its transcript anyway.
    expect(within(sheet()).getByText(intro).textContent).toContain('The Mac forgets what you typed and the written prompt once you send or discard, or 30 minutes after.');
    fireEvent.click(action('Discard'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(rewriteButton());
    await screen.findByRole('dialog', { name: `Rewrite for ${SID}` });
    expect(within(sheet()).queryByText(intro)).toBeNull();
  });

  it('folds a long "You said" to three lines with Show all', async () => {
    render();
    const long = `${SAID}. ${SAID}. ${SAID}.`;
    await openSheet(long);
    const toggle = action('Show all');
    expect(within(sheet()).getByText(long).className).toContain('line-clamp-3');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(sheet()).getByText(long).className).not.toContain('line-clamp-3');
  });

  it('says "Writing the prompt" in one live region: the spinner is only the picture', async () => {
    render();
    await openSheet();
    // The kit Spinner shows after 150 ms.
    await waitFor(() => expect(sheet().querySelector('.spinner')).not.toBeNull());
    const statuses = within(sheet()).getAllByRole('status');
    expect(statuses.filter((s) => s.textContent === 'Writing the prompt' || s.getAttribute('aria-label') === 'Writing the prompt')).toHaveLength(1);
  });

  it('lists each name the user never said once, however often the Mac reports it', async () => {
    const api = rewriteApi({ rewriteGet: vi.fn(async (id: string) => detail(ready(id), PROMPT, ['--force', 'src/a.ts', '--force'])) });
    await reviewReady(api, { job: { prompt: { hash: 'h', length: 200, flags: { ...NO_FLAGS, newTokens: 2 } } } });
    const names = within(sheet()).getByRole('list', { name: 'Not in what you said' });
    expect(within(names).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['--force', 'src/a.ts']);
  });

  it('on a phone, stacks the actions in one column below 360 px', async () => {
    await reviewReady();
    const send = action('Send');
    expect(send.className).toContain('col-span-2');
    expect(send.className).toContain('max-[360px]:col-span-1');
    expect(send.parentElement?.className).toContain('grid-cols-2');
    expect(send.parentElement?.className).toContain('max-[360px]:grid-cols-1');
  });

  it('stops waiting for the prompt after GET_TIMEOUT_MS, with Try again', async () => {
    fakeClock();
    const rewriteGet = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(detail(ready('rw-1'), PROMPT));
    const api = rewriteApi({ rewriteGet });
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, ready('rw-1'));
    await waitFor(() => expect(rewriteGet).toHaveBeenCalledTimes(1));
    act(() => vi.advanceTimersByTime(GET_TIMEOUT_MS));
    expect((await within(sheet()).findByRole('alert')).textContent).toMatch(/^Couldn't fetch the prompt: Could not reach the Mac/);
    fireEvent.click(action('Try again'));
    await waitFor(() => expect(promptBox().value).toBe(PROMPT));
  });

  it('on a desk: Cmd+Enter sends, Shift+Cmd+Enter sends what you said, with the keys shown', async () => {
    viewport(1440);
    const api = rewriteApi();
    await reviewReady(api);
    expect(within(sheet()).getByText('send what I said')).toBeTruthy();
    fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true, shiftKey: true });
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledWith(SID, SAID, expect.any(String), { rewriteJobId: 'rw-1' }));
  });

  it('on a desk: Cmd+Enter sends the prompt', async () => {
    viewport(1440);
    const api = rewriteApi();
    await reviewReady(api);
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledWith(SID, PROMPT, expect.any(String), { rewriteJobId: 'rw-1' }));
  });
});

describe('sending from the sheet', () => {
  it('Send types the written prompt with its job id, shows the receipt, closes, and clears the draft', async () => {
    fakeClock();
    const api = rewriteApi();
    await reviewReady(api);
    fireEvent.click(action('Send'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    // Only the job id goes along: the phone never claims an origin, the daemon works it out from the hash (R10).
    expect(api.sendPrompt.mock.calls[0]).toEqual([SID, PROMPT, expect.any(String), { rewriteJobId: 'rw-1' }]);
    // Sent (spec 5.1): the transcript's receipt row, no actions, for SENT_MS.
    await waitFor(() => expect(phaseNow()).toBe('sent'));
    expect(within(sheet()).getByText('sending…')).toBeTruthy();
    expect(within(sheet()).queryByRole('button')).toBeNull();
    expect(promptBox().disabled).toBe(true);
    act(() => vi.advanceTimersByTime(SENT_MS - 50));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await sentThenClosed();
    expect(box().value).toBe('');
    // The transcript shows it like any other send.
    expect(await screen.findByText(PROMPT)).toBeTruthy();
    // markSent drops the texts on the Mac: nothing to cancel.
    expect(api.rewriteCancel).not.toHaveBeenCalled();
  });

  it('an edit says "Send edited" and sends the edit, still with the job id', async () => {
    const api = rewriteApi();
    await reviewReady(api);
    fireEvent.change(promptBox(), { target: { value: `${PROMPT} Run the tests after.` } });
    fireEvent.click(action('Send edited'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledWith(SID, `${PROMPT} Run the tests after.`, expect.any(String), { rewriteJobId: 'rw-1' }));
  });

  it('an edit back to the written prompt says "Send" again', async () => {
    await reviewReady();
    fireEvent.change(promptBox(), { target: { value: `${PROMPT}!!` } });
    expect(action('Send edited')).toBeTruthy();
    fireEvent.change(promptBox(), { target: { value: PROMPT } });
    expect(action('Send')).toBeTruthy();
  });

  it('Send what I said sends the input with the job id once the job is ready', async () => {
    fakeClock();
    const api = rewriteApi();
    await reviewReady(api);
    fireEvent.click(action('Send what I said'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledWith(SID, SAID, expect.any(String), { rewriteJobId: 'rw-1' }));
    // The box shows what went, not the written prompt.
    expect(promptBox().value).toBe(SAID);
    await sentThenClosed();
    expect(box().value).toBe('');
  });

  it('Send what I said while the prompt is being written stops the run and sends plainly', async () => {
    fakeClock();
    const api = rewriteApi();
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, rjob('rw-1', { state: 'writing', updatedAt: iso(121_000) }));
    fireEvent.click(action('Send what I said'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sendPrompt.mock.calls[0]).toEqual([SID, SAID, expect.any(String)]);
    expect(api.rewriteCancel).toHaveBeenCalledWith('rw-1');
    await sentThenClosed();
  });

  it('shows Sending… and holds every action while the send is out', async () => {
    const send = deferred<{ jobId: string; job: never }>();
    const api = rewriteApi({ sendPrompt: vi.fn(() => send.promise) });
    await reviewReady(api);
    fireEvent.click(action('Send'));
    expect(await within(sheet()).findByRole('button', { name: 'Sending…' })).toBeTruthy();
    expect(action('Sending…').disabled).toBe(true);
    expect(action('Send what I said').disabled).toBe(true);
    expect(action('Rewrite again').disabled).toBe(true);
    expect(action('Discard').disabled).toBe(true);
    expect(promptBox().disabled).toBe(true);
  });

  it('a 404 for a job the Mac dropped keeps the text, and offers to send it again without the id', async () => {
    fakeClock();
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('not_found', 'no such rewrite job for this session (it may have expired)', 404))
      .mockResolvedValueOnce({ jobId: 'job-2', job: { id: 'job-2', sid: SID, textHash: 'x', textLength: 1, stage: 'queued', attempts: 0, createdAt: iso(0), updatedAt: iso(0) } });
    const rewriteGet = vi
      .fn()
      .mockResolvedValueOnce(detail(ready('rw-1'), PROMPT))
      .mockRejectedValueOnce(new ApiError('not_found', 'no such rewrite job', 404));
    const api = rewriteApi({ sendPrompt, rewriteGet });
    await reviewReady(api);
    fireEvent.change(promptBox(), { target: { value: `${PROMPT} Thanks.` } });
    fireEvent.click(action('Send edited'));
    const alert = await within(sheet()).findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toBe('Nothing was typed: the Mac no longer has this rewrite (it keeps one for 30 minutes). Send it again to type it as it is.');
    // Nothing went: that is the ember "Not delivered" family.
    expect(alert.className).toContain('text-signal-text');
    // The sheet kept the text it tried to send, and checked the job once.
    expect(promptBox().value).toBe(`${PROMPT} Thanks.`);
    expect(rewriteGet).toHaveBeenCalledTimes(2);
    expect(rewriteGet).toHaveBeenLastCalledWith('rw-1');
    // What the user said is back in the composer, as before the send.
    expect(box().value).toBe(SAID);

    fireEvent.click(action('Send again'));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    expect(sendPrompt.mock.calls[1]).toEqual([SID, `${PROMPT} Thanks.`, expect.any(String)]);
    expect(sendPrompt.mock.calls[1]![2]).not.toBe(sendPrompt.mock.calls[0]![2]);
    await sentThenClosed();
    expect(box().value).toBe('');
  });

  it('offers the same plain resend for an unedited prompt', async () => {
    const sendPrompt = vi.fn().mockRejectedValueOnce(new ApiError('not_found', 'no such rewrite job for this session (it may have expired)', 404));
    const rewriteGet = vi
      .fn()
      .mockResolvedValueOnce(detail(ready('rw-1'), PROMPT))
      .mockRejectedValueOnce(new ApiError('not_found', 'no such rewrite job', 404));
    await reviewReady(rewriteApi({ sendPrompt, rewriteGet }));
    fireEvent.click(action('Send'));
    await within(sheet()).findByRole('alert');
    expect(promptBox().value).toBe(PROMPT);
    expect(action('Send again').disabled).toBe(false);
  });

  it('treats a job the Mac keeps without its texts (stopped or sent) as gone, and offers the plain resend', async () => {
    const sendPrompt = vi.fn().mockRejectedValueOnce(new ApiError('not_found', 'no such rewrite job for this session (it may have expired)', 404));
    const rewriteGet = vi
      .fn()
      .mockResolvedValueOnce(detail(ready('rw-1'), PROMPT))
      // Cancelled from elsewhere: the job stays until its expiry, with no texts, and originFor refuses it.
      .mockResolvedValueOnce(detail(rjob('rw-1', { state: 'cancelled', updatedAt: iso(140_000) })));
    await reviewReady(rewriteApi({ sendPrompt, rewriteGet }));
    fireEvent.click(action('Send'));
    expect((await within(sheet()).findByRole('alert')).textContent).toMatch(/^Nothing was typed/);
    expect(action('Send again').disabled).toBe(false);
  });

  it('stops checking a send refused with 404 after GET_TIMEOUT_MS, so the sheet is never stuck on Sending…', async () => {
    fakeClock();
    const sendPrompt = vi.fn().mockRejectedValueOnce(new ApiError('not_found', 'no such session', 404));
    const rewriteGet = vi
      .fn()
      .mockResolvedValueOnce(detail(ready('rw-1'), PROMPT))
      .mockImplementationOnce(() => new Promise(() => undefined));
    await reviewReady(rewriteApi({ sendPrompt, rewriteGet }));
    fireEvent.click(action('Send'));
    await waitFor(() => expect(rewriteGet).toHaveBeenCalledTimes(2));
    expect(action('Sending…')).toBeTruthy();
    act(() => vi.advanceTimersByTime(GET_TIMEOUT_MS));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findByRole('alert')).textContent).toMatch(/no such session/);
  });

  it('a 404 while the job is still there (the session went) closes the sheet, and the transcript says why', async () => {
    const sendPrompt = vi.fn().mockRejectedValue(new ApiError('not_found', 'no such session', 404));
    const api = rewriteApi({ sendPrompt });
    await reviewReady(api);
    fireEvent.click(action('Send'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // One GET for the prompt, one to check: the job was ready with its texts, so it was not an expiry.
    expect(api.rewriteGet).toHaveBeenCalledTimes(2);
    expect((await screen.findByRole('alert')).textContent).toMatch(/no such session/);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('a send refused for another reason closes the sheet at once, and the transcript says why', async () => {
    const api = rewriteApi({ sendPrompt: vi.fn().mockRejectedValue(new ApiError('refused', 'A ccw move is in progress for this session', 422)) });
    await reviewReady(api);
    fireEvent.click(action('Send'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Only a 404 can mean the job expired: nothing else is asked about (one GET, for the prompt).
    expect(api.rewriteGet).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole('alert')).textContent).toMatch(/A ccw move is in progress/);
    expect(screen.getByRole('button', { name: 'Edit and resend' })).toBeTruthy();
    expect(api.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('a 409 (an earlier send of the job is still being typed) closes the sheet and leaves no "Not delivered"', async () => {
    const sendPrompt = vi.fn().mockRejectedValue(new ApiError('conflict', 'This prompt is already being sent.', 409));
    const api = rewriteApi({ sendPrompt });
    await reviewReady(api);
    fireEvent.click(action('Send'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Not an expiry: nothing is asked about (one GET, for the prompt), and nothing goes back in the composer.
    expect(api.rewriteGet).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByText(/^Not delivered/)).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryAllByText(PROMPT, { selector: '[data-item="user"] > div' })).toHaveLength(0);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('Send again takes the refused send\'s place in the transcript: the text shows once, with no "Not delivered"', async () => {
    fakeClock();
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('not_found', 'no such rewrite job for this session (it may have expired)', 404))
      .mockResolvedValueOnce({ jobId: 'job-2', job: sendJob('job-2', SID) });
    const rewriteGet = vi
      .fn()
      .mockResolvedValueOnce(detail(ready('rw-1'), PROMPT))
      .mockRejectedValueOnce(new ApiError('not_found', 'no such rewrite job', 404));
    await reviewReady(rewriteApi({ sendPrompt, rewriteGet }));
    fireEvent.click(action('Send'));
    await within(sheet()).findByRole('alert');
    // Behind the sheet, the transcript says the first send never arrived.
    const notDelivered = () => screen.queryAllByText(/^Not delivered/);
    const bubbles = () => screen.queryAllByText(PROMPT, { selector: '[data-item="user"] > div' });
    expect(notDelivered()).toHaveLength(1);
    expect(bubbles()).toHaveLength(1);

    fireEvent.click(action('Send again'));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    await sentThenClosed();
    expect(notDelivered()).toHaveLength(0);
    expect(bubbles()).toHaveLength(1);
    expect(screen.getByText('sending…')).toBeTruthy();
  });

  it('Discard after an expiry leaves the refused send in the transcript, with Edit and resend', async () => {
    const sendPrompt = vi.fn().mockRejectedValueOnce(new ApiError('not_found', 'no such rewrite job for this session (it may have expired)', 404));
    const rewriteGet = vi
      .fn()
      .mockResolvedValueOnce(detail(ready('rw-1'), PROMPT))
      .mockRejectedValueOnce(new ApiError('not_found', 'no such rewrite job', 404));
    await reviewReady(rewriteApi({ sendPrompt, rewriteGet }));
    fireEvent.click(action('Send'));
    await within(sheet()).findByRole('alert');
    fireEvent.click(action('Discard'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByText(/^Not delivered/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Edit and resend' })).toBeTruthy();
  });

  it('a network failure closes the sheet and leaves Retry (same key, same job id) in the transcript', async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'Failed to fetch', 0))
      .mockResolvedValueOnce({ jobId: 'job-3', job: { id: 'job-3', sid: SID, textHash: 'x', textLength: 1, stage: 'queued', attempts: 0, createdAt: iso(0), updatedAt: iso(0) } });
    const api = rewriteApi({ sendPrompt });
    await reviewReady(api);
    fireEvent.click(action('Send'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.rewriteGet).toHaveBeenCalledTimes(1);
    fireEvent.click(await screen.findByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    expect(sendPrompt.mock.calls[1]).toEqual(sendPrompt.mock.calls[0]);
  });
});

describe('the transcript bubble of a rewritten prompt (spec 5.1)', () => {
  it('names the origin the daemon found, and none for typed text or what the user said', () => {
    expect(originTag('rewrite')).toBe('rewrite');
    expect(originTag('rewrite-edited')).toBe('rewrite · edited');
    expect(originTag('rewrite-raw')).toBeNull();
    expect(originTag('typed')).toBeNull();
    expect(originTag(undefined)).toBeNull();
  });

  it('carries a mono "rewrite" tag beside its receipt, in flight and once delivered', async () => {
    fakeClock();
    const job = sendJob('job-r', SID, { origin: 'rewrite', textLength: PROMPT.length });
    const api = rewriteApi({ sendPrompt: vi.fn(async () => ({ jobId: 'job-r', job })) });
    const { store } = await reviewReady(api);
    fireEvent.click(action('Send'));
    await sentThenClosed();
    const receipt = () => document.querySelector('[data-item="user"] [data-stage]') as HTMLElement;
    expect(receipt().textContent).toBe('sending…rewrite');
    expect(within(receipt()).getByText('rewrite').className).toContain('font-mono');
    act(() => emit(store, [{ seq: store.getState().state.seq + 1, ts: iso(131_000), type: 'send.progress', sid: SID, data: { job: { ...job, stage: 'proven', updatedAt: iso(131_000), proof: { kind: 'user', at: iso(131_000) } } } } as DaemonEvent]));
    await waitFor(() => expect(receipt().getAttribute('data-stage')).toBe('proven'));
    expect(within(receipt()).getByText('rewrite')).toBeTruthy();
    expect(within(receipt()).getByLabelText('proven by the transcript')).toBeTruthy();
  });

  it('says "rewrite · edited" for an edited prompt, and nothing for "Send what I said"', async () => {
    fakeClock();
    const edited = sendJob('job-e', SID, { origin: 'rewrite-edited' });
    const api = rewriteApi({ sendPrompt: vi.fn(async () => ({ jobId: 'job-e', job: edited })) });
    await reviewReady(api);
    fireEvent.change(promptBox(), { target: { value: `${PROMPT} Thanks.` } });
    fireEvent.click(action('Send edited'));
    await sentThenClosed();
    expect(screen.getByText('rewrite · edited')).toBeTruthy();
  });

  it('shows no tag for what the user said, sent from the sheet', async () => {
    fakeClock();
    const raw = sendJob('job-s', SID, { origin: 'rewrite-raw' });
    const api = rewriteApi({ sendPrompt: vi.fn(async () => ({ jobId: 'job-s', job: raw })) });
    await reviewReady(api);
    fireEvent.click(action('Send what I said'));
    await sentThenClosed();
    const receipt = document.querySelector('[data-item="user"] [data-stage]') as HTMLElement;
    expect(receipt.textContent).toBe('sending…');
    expect(screen.queryByText(/^rewrite/)).toBeNull();
  });
});

describe('after a card answer (the composer remounts mid-send)', () => {
  it('Send clears the draft at once, so what the user said cannot be sent a second time', async () => {
    fakeClock();
    const api = rewriteApi();
    const { store } = renderAfterAnswer(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(1));
    push(store, ready('rw-1'));
    await waitFor(() => expect(promptBox().value).toBe(PROMPT));
    fireEvent.click(action('Send'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sendPrompt.mock.calls[0]).toEqual([SID, PROMPT, expect.any(String), { rewriteJobId: 'rw-1' }]);
    // The send clears the answer receipt, and the sheet stays through it: Sent, then it closes.
    await sentThenClosed();
    await waitFor(() => expect(box().value).toBe(''));
    // The composer's own Send has nothing to type.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.keyDown(box(), { key: 'Enter' });
    await new Promise((res) => setTimeout(res, 20));
    expect(api.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('a send without the job id cancels the job as it goes', async () => {
    const api = rewriteApi();
    const { store } = renderAfterAnswer(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(1));
    push(store, rjob('rw-1', { state: 'failed', failure: 'timeout', updatedAt: iso(122_000) }));
    await sentence('The prompt writer timed out. Here is what you said.');
    fireEvent.click(action('Send what I said'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sendPrompt.mock.calls[0]).toEqual([SID, SAID, expect.any(String)]);
    expect(api.rewriteCancel).toHaveBeenCalledWith('rw-1');
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('a card that takes the pane during a plain send still gets the draft cleared and the job cancelled', async () => {
    const send = deferred<{ jobId: string; job: never }>();
    const api = rewriteApi({ sendPrompt: vi.fn(() => send.promise) });
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, rjob('rw-1', { state: 'writing', updatedAt: iso(121_000) }));
    fireEvent.click(action('Send what I said'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    const card = pending(SID, { kind: 'permission' });
    act(() => emit(store, [{ seq: store.getState().state.seq + 1, ts: iso(130_000), type: 'pending.opened', sid: SID, data: { pending: card } } as DaemonEvent]));
    await waitFor(() => expect(screen.queryByLabelText('Prompt for Claude')).toBeNull());
    expect(api.rewriteCancel).toHaveBeenCalledWith('rw-1');
    act(() => emit(store, [{ seq: store.getState().state.seq + 1, ts: iso(131_000), type: 'pending.resolved', sid: SID, data: { id: card.id, state: 'closed' } } as DaemonEvent]));
    await waitFor(() => expect(box().value).toBe(''));
    expect(api.sendPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('a job that stops moving', () => {
  it('a fresh snapshot without the job (the daemon restarted) asks the Mac once: a 404 leaves what the user said', async () => {
    const api = rewriteApi({
      rewriteGet: vi.fn(async () => {
        throw new ApiError('not_found', 'no such rewrite job', 404);
      }),
    });
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, rjob('rw-1', { state: 'writing', updatedAt: iso(121_000) }));
    expect(phaseNow()).toBe('writing');
    snapshot(store);
    await waitFor(() => expect(api.rewriteGet).toHaveBeenCalledWith('rw-1'));
    expect(api.rewriteGet).toHaveBeenCalledTimes(1);
    await sentence('The Mac no longer has this rewrite. Here is what you said.');
    expect(promptBox().value).toBe(SAID);
    expect(action('Send what I said').disabled).toBe(false);
  });

  it('a fresh snapshot without a job that already ended keeps the sheet where it was', async () => {
    const api = rewriteApi();
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, rjob('rw-1', { state: 'failed', failure: 'timeout', updatedAt: iso(122_000) }));
    await sentence('The prompt writer timed out. Here is what you said.');
    snapshot(store);
    await new Promise((res) => setTimeout(res, 20));
    expect(phaseNow()).toBe('failed');
    expect(within(sheet()).getByText('The prompt writer timed out. Here is what you said.')).toBeTruthy();
    expect(api.rewriteGet).not.toHaveBeenCalled();
  });

  it('a new daemon epoch asks the Mac about a job still writing', async () => {
    const api = rewriteApi({
      rewriteGet: vi.fn(async () => {
        throw new ApiError('not_found', 'no such rewrite job', 404);
      }),
    });
    const { store } = render(api);
    hello(store, 'epoch-1');
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    expect(phaseNow()).toBe('writing');
    hello(store, 'epoch-1');
    expect(api.rewriteGet).not.toHaveBeenCalled();
    hello(store, 'epoch-2');
    await waitFor(() => expect(api.rewriteGet).toHaveBeenCalledWith('rw-1'));
    await sentence('The Mac no longer has this rewrite. Here is what you said.');
  });

  it('no news for STALL_MS: one GET, whose answer the sheet takes (the prompt too)', async () => {
    fakeClock();
    const api = rewriteApi();
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, rjob('rw-1', { state: 'writing', updatedAt: iso(121_000) }));
    act(() => vi.advanceTimersByTime(STALL_MS - 1_000));
    expect(api.rewriteGet).not.toHaveBeenCalled();
    // An event resets the wait.
    push(store, rjob('rw-1', { state: 'writing', updatedAt: iso(122_000) }));
    act(() => vi.advanceTimersByTime(STALL_MS - 1_000));
    expect(api.rewriteGet).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    await waitFor(() => expect(promptBox().value).toBe(PROMPT));
    // The one GET brought the text: no second fetch.
    expect(api.rewriteGet).toHaveBeenCalledTimes(1);
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });
});

describe('never on its own (W6)', () => {
  it('a ready prompt stays unsent while the app is hidden, the sheet is closed, and the screen goes away', async () => {
    const api = rewriteApi();
    const { store, unmount } = await reviewReady(api);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    push(store, ready('rw-1', { updatedAt: iso(200_000) }));
    fireEvent.keyDown(promptBox(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    unmount();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(api.sendPrompt).not.toHaveBeenCalled();
    // Leaving drops the job, so its texts go at once.
    expect(api.rewriteCancel).toHaveBeenCalledWith('rw-1');
  });

  it('a card that opens mid-review takes the pane: the prompt moves to the draft and nothing is sent', async () => {
    const api = rewriteApi();
    const { store } = await reviewReady(api);
    fireEvent.change(promptBox(), { target: { value: `${PROMPT} Edited.` } });
    const card = pending(SID, { kind: 'permission' });
    act(() => emit(store, [{ seq: store.getState().state.seq + 1, ts: iso(130_000), type: 'pending.opened', sid: SID, data: { pending: card } } as DaemonEvent]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByLabelText('Prompt for Claude')).toBeNull();
    expect(api.sendPrompt).not.toHaveBeenCalled();
    expect(api.rewriteCancel).toHaveBeenCalledWith('rw-1');

    act(() => emit(store, [{ seq: store.getState().state.seq + 1, ts: iso(131_000), type: 'pending.resolved', sid: SID, data: { id: card.id, state: 'closed' } } as DaemonEvent]));
    await waitFor(() => expect(box().value).toBe(`${PROMPT} Edited.`));
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it('Rewrite switched off at the Mac mid-review removes the button and stops the run, sending nothing', async () => {
    const api = rewriteApi();
    const { store } = render(api);
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalled());
    push(store, rjob('rw-1', { state: 'writing', updatedAt: iso(121_000) }));
    const off = { protocol: PROTOCOL_VERSION, daemonVersion: '0.0.0-test', webHash: null, features: { ...NO_FEATURES } };
    act(() => emit(store, [{ seq: store.getState().state.seq + 1, ts: iso(130_000), type: 'daemon.version', data: off } as DaemonEvent]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Rewrite as a prompt' })).toBeNull();
    expect(api.rewriteCancel).toHaveBeenCalledWith('rw-1');
    // What the user said is still in the box, unsent.
    expect(box().value).toBe(SAID);
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it('keeps no text in localStorage', async () => {
    fakeClock();
    const api = rewriteApi();
    await reviewReady(api);
    fireEvent.click(action('Send'));
    await sentThenClosed();
    const stored = Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k) ?? ''}`).join('\n');
    expect(stored).not.toContain('send dot ts');
    expect(stored).not.toContain('proof timeout');
  });
});

describe('with files in the composer (v0.4.2, spec 6.7)', () => {
  /** The composer with `names` picked (as PDFs); `finish` puts each on the Mac. */
  function withPicked(names: string[]) {
    const up = fakeUploads();
    const api = rewriteApi({ uploadCreate: up.uploadCreate, uploadDelete: up.uploadDelete });
    const r = render(api);
    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: names.map((n) => pdf(n)) } });
    return { ...r, api, up };
  }

  it("the sheet says the files go with it, and its Send carries them with the job's id", async () => {
    fakeClock();
    const { api, up, store } = withPicked(['notes.pdf', 'chart.pdf']);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    const ids: string[] = [];
    await act(async () => {
      ids.push(up.finish(0), up.finish(1));
    });
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(1));
    // The prompt writer gets the words only.
    expect(api.rewriteStart).toHaveBeenCalledWith(SID, SAID, expect.anything());
    push(store, ready('rw-1'));
    await waitFor(() => expect(promptBox().value).toBe(PROMPT));
    expect(within(sheet()).getByText('2 files go with it')).toBeTruthy();
    fireEvent.click(action('Send'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sendPrompt.mock.calls[0]).toEqual([
      SID,
      PROMPT,
      expect.any(String),
      {
        rewriteJobId: 'rw-1',
        attachments: [
          { upload: ids[0], label: 'notes.pdf' },
          { upload: ids[1], label: 'chart.pdf' },
        ],
      },
    ]);
    await sentThenClosed();
    expect(screen.queryByRole('list', { name: 'Attached files' })).toBeNull();
  });

  it('"Send what I said" carries them too', async () => {
    const { api, up, store } = withPicked(['notes.pdf']);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
    let id = '';
    await act(async () => {
      id = up.finish(0);
    });
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(1));
    push(store, ready('rw-1'));
    await waitFor(() => expect(promptBox().value).toBe(PROMPT));
    expect(within(sheet()).getByText('1 file goes with it')).toBeTruthy();
    fireEvent.click(action('Send what I said'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    expect((api.sendPrompt.mock.calls[0] as unknown[] | undefined)?.[3]).toEqual({ rewriteJobId: 'rw-1', attachments: [{ upload: id, label: 'notes.pdf' }] });
  });

  it('while a file is still uploading the sheet says so, and its Send waits for it', async () => {
    const { api, up, store } = withPicked(['notes.pdf']);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(1));
    push(store, ready('rw-1'));
    await waitFor(() => expect(promptBox().value).toBe(PROMPT));
    expect(within(sheet()).getByText('1 file goes with it once it is uploaded')).toBeTruthy();
    expect(action('Send').disabled).toBe(true);
    expect(action('Send what I said').disabled).toBe(true);
    fireEvent.click(action('Send'));
    await new Promise((res) => setTimeout(res, 20));
    expect(api.sendPrompt).not.toHaveBeenCalled();
    await act(async () => {
      up.finish(0);
    });
    await waitFor(() => expect(within(sheet()).getByText('1 file goes with it')).toBeTruthy());
    fireEvent.click(action('Send'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    expect((api.sendPrompt.mock.calls[0] as unknown[] | undefined)?.[3]).toMatchObject({ rewriteJobId: 'rw-1' });
  });

  it('a file that did not upload holds the send until it is removed or uploaded', async () => {
    const { api, up, store } = withPicked(['notes.pdf']);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
    await act(async () => up.fail(0, new ApiError('network', 'network error', 0)));
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(1));
    push(store, ready('rw-1'));
    await waitFor(() => expect(promptBox().value).toBe(PROMPT));
    expect(within(sheet()).getByText("The file didn't upload. Retry or remove it to send.")).toBeTruthy();
    expect(action('Send').disabled).toBe(true);
    fireEvent.click(action('Send'));
    await new Promise((res) => setTimeout(res, 20));
    expect(api.sendPrompt).not.toHaveBeenCalled();
    // The composer is under the sheet, so the sheet offers Retry itself.
    expect(within(sheet()).getByText('notes.pdf: Could not reach the Mac. Check the connection and try again.')).toBeTruthy();
    fireEvent.click(action('Retry notes.pdf'));
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    let id = '';
    await act(async () => {
      id = up.finish(1);
    });
    await waitFor(() => expect(within(sheet()).getByText('1 file goes with it')).toBeTruthy());
    expect(within(sheet()).queryByRole('button', { name: 'Retry notes.pdf' })).toBeNull();
    fireEvent.click(action('Send'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    expect((api.sendPrompt.mock.calls[0] as unknown[] | undefined)?.[3]).toEqual({ rewriteJobId: 'rw-1', attachments: [{ upload: id, label: 'notes.pdf' }] });
  });

  it("Remove in the sheet takes a file that won't upload off the send", async () => {
    const { api, up, store } = withPicked(['notes.pdf', 'clip.pdf']);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    let id = '';
    await act(async () => {
      id = up.finish(0);
      up.fail(1, new ApiError('payload_too_large', 'This file is larger than 20 MB', 413));
    });
    await openSheet();
    await waitFor(() => expect(api.rewriteStart).toHaveBeenCalledTimes(1));
    push(store, ready('rw-1'));
    await waitFor(() => expect(promptBox().value).toBe(PROMPT));
    expect(within(sheet()).getByText("1 of 2 files didn't upload. Retry or remove it to send.")).toBeTruthy();
    expect(within(sheet()).getByText('clip.pdf: This file is larger than 20 MB')).toBeTruthy();
    // A refusal is not retried.
    expect(within(sheet()).queryByRole('button', { name: 'Retry clip.pdf' })).toBeNull();
    fireEvent.click(action('Remove clip.pdf'));
    await waitFor(() => expect(within(sheet()).getByText('1 file goes with it')).toBeTruthy());
    fireEvent.click(action('Send'));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    expect((api.sendPrompt.mock.calls[0] as unknown[] | undefined)?.[3]).toEqual({ rewriteJobId: 'rw-1', attachments: [{ upload: id, label: 'notes.pdf' }] });
  });

  it('no files, no line', async () => {
    await reviewReady();
    expect(within(sheet()).queryByText(/go(es)? with it/)).toBeNull();
  });
});
