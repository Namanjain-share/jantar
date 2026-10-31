/**
 * v0.4.2: sends with files in the Transcript tab. The daemon types and proves
 * the prompt it composed (the words, a blank line and "Attached files:", or
 * "Please look at these files:" alone, then one line per file), so a proven
 * send is matched to that user turn and shown once, with its receipt. Until
 * then its bubble says how many files went with it ("2 files" under the
 * words, or alone for files with no words). Put back restores the files of
 * the send whose receipt was tapped, not of another with the same text.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendJob, TranscriptItem } from '@jantar/protocol';
import { fakeUploads, pdf, textFile } from './attach-helpers.js';
import { emit, fakeApi, iso, renderApp, sendJob, session, stateWith } from './helpers.js';

const box = () => screen.getByLabelText('Prompt for Claude') as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
const chipNames = () => {
  const list = screen.queryByRole('list', { name: 'Attached files' });
  return list ? Array.from(list.querySelectorAll('li .truncate')).map((el) => el.textContent) : [];
};
/** Every "you" bubble's text, oldest first. */
const bubbles = () => Array.from(document.querySelectorAll('[data-item="user"] > div')).map((el) => el.textContent);

function progress(seq: number, job: SendJob) {
  return { seq, ts: job.updatedAt, type: 'send.progress' as const, sid: job.sid, data: { job } };
}

afterEach(() => vi.useRealTimers());

/** The session screen with a fake upload route, and sends answered job-1, job-2, ... */
function setup(turns: TranscriptItem[] = []) {
  const up = fakeUploads();
  let n = 0;
  const sendPrompt = vi.fn(async (sid: string, _text: string, _key: string) => {
    n += 1;
    return { jobId: `job-${n}`, job: sendJob(`job-${n}`, sid) };
  });
  const getTranscript = vi.fn(async () => ({ items: [...turns].reverse(), nextBefore: null }));
  const api = fakeApi({ sendPrompt, getTranscript, uploadCreate: up.uploadCreate, uploadDelete: up.uploadDelete });
  const r = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })], seq: 10 }) });
  /** Pick `files`, put each on the Mac, then send them with `words`. */
  const send = async (files: File[], words: string) => {
    const first = up.calls.length;
    fireEvent.change(screen.getByLabelText('Add files'), { target: { files } });
    for (let i = 0; i < files.length; i += 1) {
      await waitFor(() => expect(up.uploadCreate.mock.calls.length).toBeGreaterThan(first + i));
      await act(async () => {
        up.finish(first + i, files[i]?.type.startsWith('text/') ? 'text' : 'pdf');
      });
    }
    fireEvent.change(box(), { target: { value: words } });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    const before = sendPrompt.mock.calls.length;
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(before + 1));
    await waitFor(() => expect(chipNames()).toEqual([]));
  };
  return { ...r, api, up, send, sendPrompt, getTranscript };
}

const COMPOSED = 'compare these\n\nAttached files:\n- "budget.pdf": /synthetic/uploads/a/one.pdf\n- "plan.md": /synthetic/uploads/a/two.md';
const FILES_ONLY = 'Please look at these files:\n- "scan.pdf": /synthetic/uploads/a/three.pdf';

describe('sends with files in the transcript (v0.4.2)', () => {
  it('a proven send with files is shown once, as the prompt the daemon composed; so is one of files alone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const turns: TranscriptItem[] = [];
    const { send, store } = setup(turns);
    await send([pdf('budget.pdf'), textFile('plan.md')], 'compare these');
    await send([pdf('scan.pdf')], '');
    // Before the proof: the words with "2 files", and "1 file" alone, never an empty bubble.
    expect(bubbles()).toEqual(['compare these2 files', '1 file']);

    turns.push(
      { id: 'u1', at: iso(130_000), role: 'user', kind: 'text', text: COMPOSED },
      { id: 'r1', at: iso(140_000), role: 'assistant', kind: 'text', text: 'Both read; the plan covers the budget.' },
      { id: 'u2', at: iso(150_000), role: 'user', kind: 'text', text: FILES_ONLY },
    );
    act(() =>
      emit(store, [
        progress(11, sendJob('job-1', 'a', { stage: 'proven', attempts: 1, updatedAt: iso(131_000) })),
        progress(12, sendJob('job-2', 'a', { stage: 'proven', attempts: 1, updatedAt: iso(151_000) })),
      ]),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitFor(() => expect(bubbles()).toEqual([COMPOSED, FILES_ONLY]));
    // Each with its own receipt, in its place: before the reply that follows it, not pinned under it.
    const user = Array.from(document.querySelectorAll('[data-item="user"]'));
    expect(user.map((u) => u.querySelector('[data-stage]')?.getAttribute('data-stage'))).toEqual(['proven', 'proven']);
    const reply = document.querySelector('[data-item="assistant"]');
    expect(user[0]?.compareDocumentPosition(reply as Node) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByText('2 files')).toBeNull();
  });

  it('Put the text back under a send restores that send\'s files, not those of a newer one with the same text', async () => {
    const { send, store } = setup();
    await send([pdf('first.pdf')], '');
    await send([pdf('second.pdf')], '');
    act(() =>
      emit(store, [
        progress(11, sendJob('job-1', 'a', { stage: 'failed', attempts: 12, reason: 'no proof in the transcript after 12 tries', updatedAt: iso(150_000) })),
        progress(12, sendJob('job-2', 'a', { stage: 'failed', attempts: 12, reason: 'no proof in the transcript after 12 tries', updatedAt: iso(151_000) })),
      ]),
    );
    const backs = await screen.findAllByRole('button', { name: 'Put the text back' });
    expect(backs.length).toBe(2);
    fireEvent.click(backs[0] as HTMLElement);
    expect(chipNames()).toEqual(['first.pdf']);
  });
});
