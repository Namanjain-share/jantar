import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SendJob } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { fakeUploads, pdf, textFile } from './attach-helpers.js';
import { emit, fakeApi, iso, renderApp, sendJob, session, stateWith } from './helpers.js';

const box = () => screen.getByLabelText('Prompt for Claude') as HTMLTextAreaElement;
/** The receipt under the newest send carries its raw stage. */
const stageOf = () => document.querySelector('[data-stage]')?.getAttribute('data-stage');

function progress(seq: number, job: SendJob) {
  return { seq, ts: job.updatedAt, type: 'send.progress' as const, sid: job.sid, data: { job } };
}

describe('composer and send receipts', () => {
  it('sends with an idempotency key and follows every stage to proven', async () => {
    const api = fakeApi();
    const { store } = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })], seq: 10 }) });
    fireEvent.change(box(), { target: { value: 'Run the tests again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    const [sid, text, key] = api.sendPrompt.mock.calls[0]!;
    expect(sid).toBe('a');
    expect(text).toBe('Run the tests again');
    expect(typeof key).toBe('string');
    expect(String(key).length).toBeGreaterThanOrEqual(16);
    expect(box().value).toBe('');
    await waitFor(() => expect(stageOf()).toBe('queued'));
    expect(screen.getByText('Run the tests again')).toBeTruthy();

    expect(screen.getByText('sending…')).toBeTruthy();
    const stages: SendJob['stage'][] = ['checking', 'typed', 'enter', 'proven'];
    const words = ['sending…', 'typed', 'typed · waiting for proof', null];
    stages.forEach((stage, i) => {
      act(() => emit(store, [progress(11 + i, sendJob('job-1', 'a', { stage, attempts: stage === 'enter' ? 1 : 0, updatedAt: iso(130_000 + i) }))]));
      expect(stageOf()).toBe(stage);
      const word = words[i];
      if (word) expect(screen.getByText(word)).toBeTruthy();
    });
    // "sending…", then "typed", then "delivered 10:02" with the proof check.
    expect(screen.getByText(/^delivered /)).toBeTruthy();
    expect(screen.getByLabelText('proven by the transcript')).toBeTruthy();
  });

  it('is loud when a prompt was not sent, and can put the text back', async () => {
    const api = fakeApi();
    const { store } = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })], seq: 10 }) });
    fireEvent.change(box(), { target: { value: 'Deploy to staging' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(stageOf()).toBe('queued'));
    act(() =>
      emit(store, [progress(11, sendJob('job-1', 'a', { stage: 'failed', attempts: 12, reason: 'no proof in the transcript after 12 tries', updatedAt: iso(150_000) }))]),
    );
    expect(screen.getByRole('alert').textContent).toBe('Not delivered: no proof in the transcript after 12 tries');
    expect(stageOf()).toBe('failed');
    fireEvent.click(screen.getByRole('button', { name: 'Put the text back' }));
    expect(box().value).toBe('Deploy to staging');
  });

  it('warns about a merged prompt', async () => {
    const api = fakeApi();
    const { store } = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })], seq: 10 }) });
    fireEvent.change(box(), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(stageOf()).toBe('queued'));
    act(() => emit(store, [progress(11, sendJob('job-1', 'a', { stage: 'proven-merged' }))]));
    expect(screen.getByText(/merged with text that was already in the input box/)).toBeTruthy();
  });

  it('retries a network failure with the same idempotency key', async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'Failed to fetch', 0))
      .mockResolvedValueOnce({ jobId: 'job-9', job: sendJob('job-9', 'a') });
    const api = fakeApi({ sendPrompt });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    fireEvent.change(box(), { target: { value: 'try once' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not delivered: Could not reach the Mac/);
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    expect(sendPrompt.mock.calls[1]![2]).toBe(sendPrompt.mock.calls[0]![2]);
    await waitFor(() => expect(stageOf()).toBe('queued'));
  });

  it('shows a refusal reason and offers to edit and resend', async () => {
    const api = fakeApi({ sendPrompt: vi.fn().mockRejectedValue(new ApiError('refused', 'A ccw move is in progress for this session', 422)) });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    fireEvent.change(box(), { target: { value: 'continue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/A ccw move is in progress/);
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }));
    expect(box().value).toBe('continue');
  });

  it('shows sends from other clients for this session', () => {
    renderApp({
      path: '/s/a',
      state: stateWith({
        sessions: [session('a', { status: 'idle' })],
        sends: [sendJob('cli-job', 'a', { stage: 'typed', textLength: 42, actor: 'cli' }), sendJob('other', 'b', { stage: 'typed' })],
      }),
    });
    expect(screen.getByText('Prompt (42 characters)')).toBeTruthy();
    expect(screen.getByText(/^from the Mac/)).toBeTruthy();
    expect(document.querySelectorAll('[data-stage]').length).toBe(1);
  });

  it('sends with Cmd+Enter and ignores blank text', async () => {
    const api = fakeApi();
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    fireEvent.change(box(), { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box(), { target: { value: 'ship it' } });
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledWith('a', 'ship it', expect.any(String)));
  });
});

describe('sending with attachments (v0.4.2)', () => {
  const chipNames = () => {
    const list = screen.queryByRole('list', { name: 'Attached files' });
    return list ? within(list).getAllByRole('listitem').map((li) => li.querySelector('.truncate')?.textContent) : [];
  };
  const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;

  /** The composer with `files` picked and each one on the Mac; returns their upload ids. */
  async function withFiles(files: File[], over: Parameters<typeof fakeApi>[0] = {}) {
    const up = fakeUploads();
    const api = fakeApi({ uploadCreate: up.uploadCreate, uploadDelete: up.uploadDelete, ...over });
    const r = renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })], seq: 10 }) });
    fireEvent.change(screen.getByLabelText('Add files'), { target: { files } });
    const ids: string[] = [];
    for (let i = 0; i < files.length; i += 1) {
      await waitFor(() => expect(up.uploadCreate.mock.calls.length).toBeGreaterThan(i));
      await act(async () => {
        ids.push(up.finish(i, files[i]?.type.startsWith('text/') ? 'text' : 'pdf'));
      });
    }
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    return { ...r, api, up, ids };
  }

  it('Send waits until every file is on the Mac', async () => {
    const up = fakeUploads();
    const api = fakeApi({ uploadCreate: up.uploadCreate, uploadDelete: up.uploadDelete });
    renderApp({ path: '/s/a', api, state: stateWith({ sessions: [session('a', { status: 'idle' })] }) });
    fireEvent.change(box(), { target: { value: 'look at this' } });
    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: [pdf()] } });
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    fireEvent.click(sendButton());
    expect(api.sendPrompt).not.toHaveBeenCalled();
    await act(async () => {
      up.finish(0);
    });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });

  it('carries the files with the words, in the order picked; the chips leave once the Mac takes the send', async () => {
    const { api, ids } = await withFiles([pdf('budget.pdf'), textFile('plan.md')]);
    fireEvent.change(box(), { target: { value: '  compare these  ' } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sendPrompt.mock.calls[0]).toEqual([
      'a',
      'compare these',
      expect.any(String),
      {
        attachments: [
          { upload: ids[0], label: 'budget.pdf' },
          { upload: ids[1], label: 'plan.md' },
        ],
      },
    ]);
    expect(box().value).toBe('');
    await waitFor(() => expect(chipNames()).toEqual([]));
    // They stay on the Mac (Claude reads them there); only × deletes one.
    expect(api.uploadDelete).not.toHaveBeenCalled();
  });

  it('sends files with no words at all', async () => {
    const { api, ids } = await withFiles([pdf('scan.pdf')]);
    expect(box().value).toBe('');
    fireEvent.click(sendButton());
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    expect(api.sendPrompt.mock.calls[0]).toEqual(['a', '', expect.any(String), { attachments: [{ upload: ids[0], label: 'scan.pdf' }] }]);
  });

  it('a chip can not be removed while its send is on the way', async () => {
    let answer: (v: { jobId: string; job: SendJob }) => void = () => undefined;
    const sendPrompt = vi.fn(() => new Promise<{ jobId: string; job: SendJob }>((res) => (answer = res)));
    const { api } = await withFiles([pdf('held.pdf')], { sendPrompt });
    fireEvent.change(box(), { target: { value: 'hold on' } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    const remove = screen.getByRole('button', { name: 'Remove held.pdf' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    // Nothing goes twice: Send is off until the Mac answers.
    expect(sendButton().disabled).toBe(true);
    await act(async () => answer({ jobId: 'job-1', job: sendJob('job-1', 'a') }));
    await waitFor(() => expect(chipNames()).toEqual([]));
    expect(api.uploadDelete).not.toHaveBeenCalled();
  });

  it('Put the text back brings the files back as chips, and sending again carries them', async () => {
    const { api, ids, store } = await withFiles([pdf('report.pdf')]);
    fireEvent.change(box(), { target: { value: 'Summarise the report' } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(stageOf()).toBe('queued'));
    await waitFor(() => expect(chipNames()).toEqual([]));
    act(() => emit(store, [progress(11, sendJob('job-1', 'a', { stage: 'failed', attempts: 12, reason: 'no proof in the transcript after 12 tries', updatedAt: iso(150_000) }))]));
    fireEvent.click(screen.getByRole('button', { name: 'Put the text back' }));
    expect(box().value).toBe('Summarise the report');
    expect(chipNames()).toEqual(['report.pdf']);
    expect(screen.getByLabelText('on the Mac')).toBeTruthy();
    fireEvent.click(sendButton());
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(2));
    expect((api.sendPrompt.mock.calls[1] as unknown[] | undefined)?.[3]).toEqual({ attachments: [{ upload: ids[0], label: 'report.pdf' }] });
  });

  it('a refused send keeps its files in the composer, and Edit and resend does not add them twice', async () => {
    const gone = 'An attached file is no longer on the Mac; remove it and add it again';
    const sendPrompt = vi.fn().mockRejectedValue(new ApiError('not_found', gone, 404));
    const { api, ids } = await withFiles([pdf('a.pdf')], { sendPrompt });
    fireEvent.change(box(), { target: { value: 'read this' } });
    fireEvent.click(sendButton());
    expect((await screen.findByRole('alert')).textContent).toContain(gone);
    expect(chipNames()).toEqual(['a.pdf']);
    expect((screen.getByRole('button', { name: 'Remove a.pdf' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }));
    expect(box().value).toBe('read this');
    expect(chipNames()).toEqual(['a.pdf']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    expect(api.uploadDelete).toHaveBeenCalledWith('a', ids[0]);
  });

  it('files with a slash command say why before anything is sent', async () => {
    const { api } = await withFiles([pdf('a.pdf')]);
    fireEvent.change(box(), { target: { value: '/compact keep the notes' } });
    expect(screen.getByText("Attachments can't go with a slash command")).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    expect(api.sendPrompt).not.toHaveBeenCalled();
    // A slash inside the words is not a command.
    fireEvent.change(box(), { target: { value: 'compare /tmp-like paths' } });
    expect(screen.queryByText("Attachments can't go with a slash command")).toBeNull();
    expect(sendButton().disabled).toBe(false);
    // Without files the command goes as before.
    fireEvent.change(box(), { target: { value: '/compact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    expect(sendButton().disabled).toBe(false);
  });

  it('after no answer the files leave with the words, so no tap sends them twice; Retry sends them with the same key', async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'Failed to fetch', 0))
      .mockResolvedValueOnce({ jobId: 'job-9', job: sendJob('job-9', 'a') });
    const { ids } = await withFiles([pdf('a.pdf')], { sendPrompt });
    fireEvent.change(box(), { target: { value: 'once more' } });
    fireEvent.click(sendButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not delivered: Could not reach the Mac/);
    // The Mac may have typed it: nothing is left in the composer for a second send without the words.
    expect(chipNames()).toEqual([]);
    expect(box().value).toBe('');
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Retry$/ }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    expect(sendPrompt.mock.calls[1]).toEqual(sendPrompt.mock.calls[0]);
    expect(sendPrompt.mock.calls[1]?.[3]).toEqual({ attachments: [{ upload: ids[0], label: 'a.pdf' }] });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(chipNames()).toEqual([]);
  });

  it('after no answer, Edit and resend brings the words and the files back, and sends them with a new key', async () => {
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('network', 'Failed to fetch', 0))
      .mockResolvedValueOnce({ jobId: 'job-9', job: sendJob('job-9', 'a') });
    const { ids } = await withFiles([pdf('a.pdf'), textFile('b.md')], { sendPrompt });
    fireEvent.change(box(), { target: { value: 'look again' } });
    fireEvent.click(sendButton());
    await screen.findByRole('alert');
    expect(chipNames()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }));
    expect(box().value).toBe('look again');
    expect(chipNames()).toEqual(['a.pdf', 'b.md']);
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    expect(sendPrompt.mock.calls[1]?.[2]).not.toBe(sendPrompt.mock.calls[0]?.[2]);
    expect(sendPrompt.mock.calls[1]?.[3]).toEqual({
      attachments: [
        { upload: ids[0], label: 'a.pdf' },
        { upload: ids[1], label: 'b.md' },
      ],
    });
  });

  it('Put back brings back only as many files as there is room for, and says so', async () => {
    const { store } = await withFiles([pdf('report.pdf')]);
    fireEvent.change(box(), { target: { value: 'Summarise the report' } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(stageOf()).toBe('queued'));
    await waitFor(() => expect(chipNames()).toEqual([]));
    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: Array.from({ length: 10 }, (_, i) => pdf(`n${i}.pdf`)) } });
    act(() => emit(store, [progress(11, sendJob('job-1', 'a', { stage: 'failed', attempts: 12, reason: 'no proof in the transcript after 12 tries', updatedAt: iso(150_000) }))]));
    fireEvent.click(screen.getByRole('button', { name: 'Put the text back' }));
    expect(box().value).toBe('Summarise the report');
    expect(chipNames().length).toBe(10);
    expect(chipNames()).not.toContain('report.pdf');
    expect(screen.getByText('Up to 10 files per prompt')).toBeTruthy();
  });

  it('a long name is cut to the 200 a label may hold, never through an emoji', async () => {
    const { api } = await withFiles([pdf(`a${'\u{1F600}'.repeat(150)}.pdf`)]);
    fireEvent.click(sendButton());
    await waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    const label = ((api.sendPrompt.mock.calls[0] as unknown[] | undefined)?.[3] as { attachments: { label: string }[] } | undefined)?.attachments[0]?.label ?? '';
    // 199 units: one more emoji would make 201.
    expect(label).toBe(`a${'\u{1F600}'.repeat(99)}`);
    expect(label.length).toBeLessThanOrEqual(200);
  });
});
