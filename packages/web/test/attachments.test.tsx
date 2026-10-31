/**
 * The composer's attachments (v0.4.2, spec 6.1, 6.6, 6.8) against the fake
 * API: the + (the file picker itself, or a sheet with "From this session's
 * folder" while Files lists the folder), paste and drop, chips that prepare,
 * upload two at a time with progress and a tick, fail with the daemon's
 * sentence (Retry only after no answer or a 429), and leave with × (aborting
 * the upload, or deleting it from the Mac). U12: thumbnails are blob: URLs,
 * revoked on remove and when the screen closes. The send itself (it waits
 * for the chips and carries them, Put back) is in send.test.tsx; Rewrite's
 * send is in rewrite.test.tsx.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOADS_PER_PROMPT, type UploadKind } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { clearFilesCache } from '../src/ui/screens/files/data.js';
import {
  ABORT_SETTLE_MS,
  attachmentsLine,
  chipsWaiting,
  cutName,
  readyRefs,
  sendFilesWord,
  turnOfSend,
  type Attachment,
  type LocalSend,
} from '../src/ui/screens/session/sends.js';
import { fakeUploads, imageEnv, pdf, photo, textFile } from './attach-helpers.js';
import { layout, listing, root } from './files-helpers.js';
import { fakeApi, renderApp, session, stateWith } from './helpers.js';

const box = () => screen.getByLabelText('Prompt for Claude') as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
const form = () => screen.getByRole('form', { name: 'Send a prompt' });
const chipList = () => screen.getByRole('list', { name: 'Attached files' });
const noChips = () => screen.queryByRole('list', { name: 'Attached files' }) === null;
const chips = () => within(chipList()).getAllByRole('listitem');
const states = () => chips().map((li) => li.getAttribute('data-state'));
const names = () => chips().map((li) => li.querySelector('.truncate')?.textContent);
/** The + as the file picker itself (Files off, or the folder not listed). */
const plusInput = () => screen.getByLabelText('Add files') as HTMLInputElement;
const pick = (files: File[], input: HTMLElement = plusInput()) => fireEvent.change(input, { target: { files } });

let env: ReturnType<typeof imageEnv> | null = null;
beforeEach(() => clearFilesCache());
afterEach(() => {
  env?.restore();
  env = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A promise the test settles. */
function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

function setup(opts: { files?: boolean; status?: 'live' | 'offline'; api?: Partial<Api> } = {}) {
  const up = fakeUploads();
  const api = fakeApi({ uploadCreate: up.uploadCreate, uploadDelete: up.uploadDelete, ...opts.api });
  const r = renderApp({
    path: '/s/a',
    api,
    state: stateWith({ sessions: [session('a', { status: 'idle' })], ...(opts.files ? { features: { files: true } } : {}) }),
    ...(opts.status ? { status: opts.status } : {}),
  });
  return { ...r, api, up };
}

describe('the + and its chips', () => {
  it('uploads picked files two at a time, with progress, then a tick; Send waits for all of them', async () => {
    const { up } = setup();
    expect(plusInput().multiple).toBe(true);
    expect(plusInput().accept).toBe('');
    pick([pdf('a.pdf'), pdf('b.pdf'), textFile('c.md')]);
    expect(names()).toEqual(['a.pdf', 'b.pdf', 'c.md']);
    expect(states()).toEqual(['preparing', 'preparing', 'preparing']);
    // The picker is cleared, so the same file can be picked again.
    expect(plusInput().value).toBe('');

    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    expect(up.calls.map((c) => [c.sid, c.opts.ext])).toEqual([
      ['a', 'pdf'],
      ['a', 'pdf'],
    ]);
    expect(states()).toEqual(['uploading', 'uploading', 'uploading']);
    act(() => up.calls[0]?.opts.onProgress?.(31, 100));
    expect(within(chips()[0] as HTMLElement).getByText('31%')).toBeTruthy();
    // A screen reader hears it as a progress bar.
    expect(within(chips()[0] as HTMLElement).getByRole('progressbar', { name: 'Uploading a.pdf' }).getAttribute('aria-valuenow')).toBe('31');
    expect(sendButton().disabled).toBe(true);

    await act(async () => {
      up.finish(0);
    });
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(3));
    expect(up.calls[2]?.opts.ext).toBe('md');
    expect(states()[0]).toBe('ready');
    expect(within(chips()[0] as HTMLElement).getByLabelText('on the Mac')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);

    await act(async () => {
      up.finish(1);
      up.finish(2, 'text');
    });
    await waitFor(() => expect(states()).toEqual(['ready', 'ready', 'ready']));
    expect(sendButton().disabled).toBe(false);
  });

  it('× aborts an upload in flight and deletes one already on the Mac', async () => {
    const { up, api } = setup();
    pick([pdf('a.pdf'), pdf('b.pdf')]);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    const id = up.finish(1);
    await waitFor(() => expect(states()).toEqual(['uploading', 'ready']));

    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    expect(up.calls[0]?.opts.signal?.aborted).toBe(true);
    expect(names()).toEqual(['b.pdf']);
    expect(api.uploadDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove b.pdf' }));
    expect(api.uploadDelete).toHaveBeenCalledWith('a', id);
    expect(noChips()).toBe(true);
    expect(sendButton().disabled).toBe(true);
  });

  it('an upload that lands after its chip was removed is deleted from the Mac', async () => {
    const { up, api } = setup();
    pick([pdf('late.pdf')]);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
    // The Mac's answer is already on its way (resolved, not yet read) when × is tapped.
    up.calls[0]?.resolve({ upload: { id: '01jfz8x8y3t0v5g9wqk2m4n6zz', kind: 'pdf', bytes: 1 } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove late.pdf' }));
    await waitFor(() => expect(api.uploadDelete).toHaveBeenCalledWith('a', '01jfz8x8y3t0v5g9wqk2m4n6zz'));
    expect(noChips()).toBe(true);
  });

  it('no answer from the Mac offers Retry, which uploads the same file again', async () => {
    const { up } = setup();
    pick([pdf('a.pdf')]);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
    await act(async () => up.fail(0, new ApiError('network', 'network error', 0)));
    await waitFor(() => expect(states()).toEqual(['failed']));
    expect(screen.getByText('a.pdf: Could not reach the Mac. Check the connection and try again.')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Retry a.pdf' }));
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    expect(up.calls[1]?.blob).toBe(up.calls[0]?.blob);
    expect(states()).toEqual(['uploading']);
    await act(async () => {
      up.finish(1);
    });
    await waitFor(() => expect(states()).toEqual(['ready']));
  });

  it("a refusal shows the daemon's sentence with no Retry; a 429 offers Retry", async () => {
    const { up } = setup();
    pick([pdf('a.pdf'), pdf('b.pdf')]);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    await act(async () => {
      up.fail(0, new ApiError('unsupported_media_type', "Claude can't read this kind of file", 415));
      up.fail(1, new ApiError('rate_limited', 'Two uploads at a time from one phone', 429));
    });
    await waitFor(() => expect(states()).toEqual(['failed', 'failed']));
    expect(screen.getByText("a.pdf: Claude can't read this kind of file")).toBeTruthy();
    expect(screen.getByText('b.pdf: Two uploads at a time from one phone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry a.pdf' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry b.pdf' })).toBeTruthy();
  });

  it('a file Claude cannot read fails on the phone, before any upload', async () => {
    const { up } = setup();
    pick([new File(['x'], 'clip.mov', { type: 'video/quicktime' })]);
    await waitFor(() => expect(states()).toEqual(['failed']));
    expect(screen.getByText("clip.mov: Claude can't watch video or listen to audio")).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull();
    expect(up.uploadCreate).not.toHaveBeenCalled();
  });

  it(`takes ${UPLOADS_PER_PROMPT} files at most`, async () => {
    const { up } = setup();
    pick(Array.from({ length: UPLOADS_PER_PROMPT + 1 }, (_, i) => pdf(`f${i}.pdf`)));
    expect(chips().length).toBe(UPLOADS_PER_PROMPT);
    expect(screen.getByText('Up to 10 files per prompt')).toBeTruthy();
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    pick([pdf('more.pdf')]);
    expect(chips().length).toBe(UPLOADS_PER_PROMPT);
  });

  it('after × on an upload in flight, the next waits a moment, so the Mac has freed its slot', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { up } = setup();
    pick([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ABORT_SETTLE_MS - 100);
    });
    expect(up.uploadCreate).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(3));
    expect(names()).toEqual(['b.pdf', 'c.pdf']);
  });

  it("a file the phone can't read fails with the phone's sentence, no Retry", async () => {
    const { up } = setup();
    const broken = pdf('broken.pdf');
    Object.defineProperty(broken, 'size', {
      get() {
        throw new Error('synthetic: unreadable');
      },
    });
    pick([broken]);
    await waitFor(() => expect(states()).toEqual(['failed']));
    expect(screen.getByText("broken.pdf: The phone couldn't read this file")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry broken.pdf' })).toBeNull();
    expect(up.uploadCreate).not.toHaveBeenCalled();
  });

  it('an unpaired device gets the sentence that says so, with no Retry', async () => {
    const { up } = setup();
    pick([pdf('a.pdf')]);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
    await act(async () => up.fail(0, new ApiError('unauthorized', 'unauthorized', 401)));
    await waitFor(() => expect(states()).toEqual(['failed']));
    expect(screen.getByText('a.pdf: This device is not paired (or was revoked).')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry a.pdf' })).toBeNull();
  });

  it('a kind this app does not know still gets a chip, with the plain file glyph', async () => {
    const { up } = setup();
    pick([pdf('odd.pdf')]);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
    await act(async () => {
      up.finish(0, 'archive' as UploadKind);
    });
    await waitFor(() => expect(states()).toEqual(['ready']));
    expect(chips()[0]?.querySelector('svg')).not.toBeNull();
  });

  it('offline: + is off, and a drop only says why', () => {
    const { up } = setup({ status: 'offline' });
    expect(plusInput().disabled).toBe(true);
    expect(plusInput().closest('label')?.getAttribute('title')).toBe("Offline: can't add files right now");
    fireEvent.drop(form(), { dataTransfer: { types: ['Files'], files: [pdf()] } });
    expect(screen.getByText("Offline: can't add files right now")).toBeTruthy();
    expect(noChips()).toBe(true);
    expect(up.uploadCreate).not.toHaveBeenCalled();
  });
});

describe('offline (spec 6.8)', () => {
  it('going offline fails the uploads on their way with Retry; none starts until Retry, which waits for the connection', async () => {
    const { up, store } = setup();
    pick([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    act(() => up.calls[0]?.opts.onProgress?.(40, 100));
    act(() => store.getState().setConn({ status: 'offline' }));
    await waitFor(() => expect(states()).toEqual(['failed', 'failed', 'failed']));
    expect(up.calls[0]?.opts.signal?.aborted).toBe(true);
    expect(up.calls[1]?.opts.signal?.aborted).toBe(true);
    expect(screen.getByText('c.pdf: Could not reach the Mac. Check the connection and try again.')).toBeTruthy();
    // Retry offline only says why.
    fireEvent.click(screen.getByRole('button', { name: 'Retry c.pdf' }));
    expect(screen.getByText("Offline: can't add files right now")).toBeTruthy();
    await new Promise((r) => setTimeout(r, ABORT_SETTLE_MS + 50));
    expect(up.uploadCreate).toHaveBeenCalledTimes(2);

    // Back online: the line goes, and nothing uploads by itself.
    act(() => store.getState().setConn({ status: 'live' }));
    await waitFor(() => expect(screen.queryByText("Offline: can't add files right now")).toBeNull());
    expect(up.uploadCreate).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Retry c.pdf' }));
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(3));
    expect(states()).toEqual(['failed', 'failed', 'uploading']);
  });

  it('a file finished preparing while offline fails with Retry instead of waiting at 0%', async () => {
    const { up, store } = setup();
    pick([pdf('a.pdf')]);
    act(() => store.getState().setConn({ status: 'offline' }));
    await waitFor(() => expect(states()).toEqual(['failed']));
    expect(screen.getByRole('button', { name: 'Retry a.pdf' })).toBeTruthy();
    expect(up.uploadCreate).not.toHaveBeenCalled();
  });

  it("the offline line goes once the connection is back", async () => {
    const { store } = setup({ status: 'offline' });
    fireEvent.drop(form(), { dataTransfer: { types: ['Files'], files: [pdf()] } });
    expect(screen.getByText("Offline: can't add files right now")).toBeTruthy();
    act(() => store.getState().setConn({ status: 'live' }));
    await waitFor(() => expect(screen.queryByText("Offline: can't add files right now")).toBeNull());
    expect(plusInput().disabled).toBe(false);
  });
});

describe('paste and drop', () => {
  it('a pasted file becomes a chip, and the paste does not reach the box', async () => {
    const { up } = setup();
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { files: [textFile('notes.md')], items: [], types: ['Files'] } });
    fireEvent(box(), ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(names()).toEqual(['notes.md']);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
  });

  it('takes the file items when a browser lists the paste only there', async () => {
    const { up } = setup();
    const file = pdf('from-items.pdf');
    fireEvent.paste(box(), { clipboardData: { files: [], items: [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => file }], types: ['Files'] } });
    expect(names()).toEqual(['from-items.pdf']);
    await waitFor(() => expect(up.calls[0]?.blob).toBe(file));
  });

  it('a paste holding text too says it went as a file, and "Paste the text instead" swaps the file for the text', async () => {
    const { up } = setup();
    fireEvent.change(box(), { target: { value: 'totals: ' } });
    box().setSelectionRange(8, 8);
    const cells = 'Q1\t120\nQ2\t140';
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: { files: [photo('image.png', 'image/png')], items: [], types: ['text/plain', 'text/html', 'Files'], getData: (t: string) => (t === 'text/plain' ? cells : '') },
    });
    fireEvent(box(), ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(names()).toEqual(['image 1']);
    expect(screen.getByText('Pasted as a file.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Paste the text instead' }));
    expect(box().value).toBe(`totals: ${cells}`);
    expect(noChips()).toBe(true);
    expect(screen.queryByText('Pasted as a file.')).toBeNull();
    // The upload already on its way was stopped (none is left on the Mac).
    await waitFor(() => expect(up.calls.every((c) => c.opts.signal?.aborted)).toBe(true));
  });

  it('a file copied in the Finder (its text is only its name) adds the file and says nothing more', () => {
    setup();
    fireEvent.paste(box(), { clipboardData: { files: [pdf('report.pdf')], items: [], types: ['text/plain', 'Files'], getData: () => 'report.pdf' } });
    expect(names()).toEqual(['report.pdf']);
    expect(screen.queryByText('Pasted as a file.')).toBeNull();
  });

  it('a text paste goes ahead as before', () => {
    setup();
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { files: [], items: [{ kind: 'string', getAsFile: () => null }], types: ['text/plain'] } });
    fireEvent(box(), ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(noChips()).toBe(true);
  });

  it('dropping files on the composer highlights the box, then adds them', async () => {
    const { up } = setup();
    fireEvent.dragOver(form(), { dataTransfer: { types: ['Files'], files: [] } });
    expect(box().className).toContain('border-ink');
    fireEvent.dragLeave(form(), { relatedTarget: document.body });
    expect(box().className).not.toContain('border-ink');
    expect(box().className).toContain('border-line-strong');

    fireEvent.dragOver(form(), { dataTransfer: { types: ['Files'], files: [] } });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [pdf('dropped.pdf'), textFile('also.md')] } });
    fireEvent(form(), drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(box().className).not.toContain('border-ink');
    expect(names()).toEqual(['dropped.pdf', 'also.md']);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
  });

  it('files dropped outside the composer are taken too, never opened by the browser (which would leave the app)', async () => {
    const { up } = setup();
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: { types: ['Files'], files: [], dropEffect: 'none' } });
    fireEvent(document.body, over);
    expect(over.defaultPrevented).toBe(true);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [pdf('outside.pdf')] } });
    fireEvent(document.body, drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(names()).toEqual(['outside.pdf']);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
    // A drop on the composer is added once, not again by the screen.
    const onForm = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(onForm, 'dataTransfer', { value: { types: ['Files'], files: [pdf('on-form.pdf')] } });
    fireEvent(form(), onForm);
    expect(names()).toEqual(['outside.pdf', 'on-form.pdf']);
  });

  it('a mixed paste that adds no chip (ten already) goes ahead as text: its text half is not lost', () => {
    setup();
    pick(Array.from({ length: UPLOADS_PER_PROMPT }, (_, i) => pdf(`f${i}.pdf`)));
    expect(names()).toHaveLength(UPLOADS_PER_PROMPT);
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: { files: [photo('image.png', 'image/png')], items: [], types: ['text/plain', 'Files'], getData: (t: string) => (t === 'text/plain' ? 'Q1\t120' : '') },
    });
    fireEvent(box(), ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(names()).toHaveLength(UPLOADS_PER_PROMPT);
    expect(screen.queryByText('Pasted as a file.')).toBeNull();
  });

  it('a drag of text (no files) is left to the browser', () => {
    setup();
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: { types: ['text/plain'], files: [] } });
    fireEvent(form(), over);
    expect(over.defaultPrevented).toBe(false);
    expect(box().className).not.toContain('border-ink');
  });
});

describe('photos and their thumbnails (U12)', () => {
  it('a pasted photo becomes "image 1", a JPEG with a blob: thumbnail revoked on ×', async () => {
    env = imageEnv({ width: 4032, height: 3024 });
    const { up } = setup();
    fireEvent.paste(box(), { clipboardData: { files: [photo('image.png', 'image/png'), photo('image.png', 'image/png')], items: [], types: ['Files'] } });
    expect(names()).toEqual(['image 1', 'image 2']);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    expect(up.calls.map((c) => [c.opts.ext, c.blob.type])).toEqual([
      ['jpg', 'image/jpeg'],
      ['jpg', 'image/jpeg'],
    ]);
    const thumbs = Array.from(chipList().querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '');
    expect(thumbs.length).toBe(2);
    for (const src of thumbs) expect(src.startsWith('blob:')).toBe(true);
    expect(document.querySelector('img[src^="data:"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove image 1' }));
    expect(env.revokeObjectURL).toHaveBeenCalledWith(thumbs[0]);
    expect(env.revokeObjectURL).not.toHaveBeenCalledWith(thumbs[1]);
  });

  it('a picked HEIC keeps its name without the extension; leaving the screen revokes the thumbnails and stops the uploads', async () => {
    env = imageEnv({ width: 3024, height: 4032 });
    const { up, unmount } = setup();
    pick([photo('IMG_0412.HEIC')]);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
    expect(names()).toEqual(['IMG_0412']);
    const src = chipList().querySelector('img')?.getAttribute('src') ?? '';
    expect(src.startsWith('blob:')).toBe(true);
    unmount();
    expect(env.revokeObjectURL).toHaveBeenCalledWith(src);
    expect(up.calls[0]?.opts.signal?.aborted).toBe(true);
  });

  it('photos are prepared one at a time (each decodes to tens of MB on the phone)', async () => {
    env = imageEnv({ width: 4032, height: 3024 });
    const turns: ReturnType<typeof deferred<void>>[] = [];
    env.decode.mockImplementation(() => {
      const d = deferred<void>();
      turns.push(d);
      return d.promise;
    });
    const { up } = setup();
    pick([photo('IMG_0001.HEIC'), photo('IMG_0002.HEIC'), photo('IMG_0003.HEIC'), pdf('notes.pdf')]);
    // The PDF does not wait for the photos.
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
    expect(up.calls[0]?.opts.ext).toBe('pdf');
    await waitFor(() => expect(env?.decode).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(env.decode).toHaveBeenCalledTimes(1);
    await act(async () => turns[0]?.resolve());
    await waitFor(() => expect(env?.decode).toHaveBeenCalledTimes(2));
    expect(states()).toEqual(['uploading', 'preparing', 'preparing', 'uploading']);
    // A photo removed while it waits is never decoded.
    fireEvent.click(screen.getByRole('button', { name: 'Remove IMG_0003.HEIC' }));
    await act(async () => turns[1]?.resolve());
    await waitFor(() => expect(states()).toEqual(['uploading', 'uploading', 'uploading']));
    await new Promise((r) => setTimeout(r, 10));
    expect(env.decode).toHaveBeenCalledTimes(2);
  });

  it('a PDF or a text file gets a glyph, never an image', async () => {
    const { up } = setup();
    pick([pdf('budget.pdf'), textFile('plan.md')]);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(2));
    expect(chipList().querySelectorAll('img').length).toBe(0);
  });
});

describe("the + sheet and \"From this session's folder\"", () => {
  const roots = [root('s.a', { kind: 'session', sid: 'a', label: 'a', display: '~/work/a' })];
  const filesList = vi.fn(async (q: { root: string; path?: string }) =>
    q.path === 'src'
      ? listing([{ name: 'app.ts', type: 'file', size: 120 }], { root: 's.a', path: 'src' })
      : listing(
          [
            { name: 'src', type: 'dir' },
            { name: 'README.md', type: 'file', size: 64 },
          ],
          { root: 's.a' },
        ),
  );

  it('puts a file of the folder into the draft by mention, and uploads nothing', async () => {
    layout();
    const { up } = setup({ files: true, api: { filesRoots: vi.fn(async () => ({ roots })), filesList } });
    fireEvent.change(box(), { target: { value: 'look at' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add files' }));
    const menu = await screen.findByRole('dialog', { name: 'Add to the prompt' });
    fireEvent.click(within(menu).getByRole('button', { name: "From this session's folder" }));
    const picker = await screen.findByRole('dialog', { name: "From this session's folder" });
    fireEvent.click(await within(picker).findByRole('button', { name: 'src' }));
    await waitFor(() => expect(filesList).toHaveBeenLastCalledWith({ root: 's.a', path: 'src', hidden: false }));
    fireEvent.click(await within(picker).findByRole('button', { name: /app\.ts/ }));
    await waitFor(() => expect(box().value).toBe('look at @src/app.ts '));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "From this session's folder" })).toBeNull());
    expect(filesList).toHaveBeenCalledWith({ root: 's.a', path: '', hidden: false });
    expect(up.uploadCreate).not.toHaveBeenCalled();
    expect(noChips()).toBe(true);
  });

  it('"Photos, camera or files" in the sheet adds chips and closes it', async () => {
    const { up } = setup({ files: true, api: { filesRoots: vi.fn(async () => ({ roots })), filesList } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add files' }));
    const menu = await screen.findByRole('dialog', { name: 'Add to the prompt' });
    const input = within(menu).getByLabelText('Photos, camera or files') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(input.getAttribute('capture')).toBeNull();
    pick([pdf('from-sheet.pdf')], input);
    expect(names()).toEqual(['from-sheet.pdf']);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add to the prompt' })).toBeNull());
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
  });

  it('with Files on but the folder not listed, + is the picker itself', async () => {
    const filesRoots = vi.fn(async () => ({ roots: [root('r.work', { label: 'work', display: '~/Desktop/work' })] }));
    setup({ files: true, api: { filesRoots, filesList } });
    await waitFor(() => expect(filesRoots).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('button', { name: 'Add files' })).toBeNull();
    expect(plusInput().type).toBe('file');
  });

  it('a pick made while the roots load still arrives after + becomes the sheet button', async () => {
    const answer = deferred<{ roots: typeof roots }>();
    const { up } = setup({ files: true, api: { filesRoots: vi.fn(() => answer.promise), filesList } });
    // The picker opens from the + as it is drawn before the roots answer...
    const early = plusInput();
    await act(async () => answer.resolve({ roots }));
    await screen.findByRole('button', { name: 'Add files' });
    // ...and the pick lands after: the same input, still mounted.
    expect(early.isConnected).toBe(true);
    pick([pdf('early.pdf')], early);
    expect(names()).toEqual(['early.pdf']);
    await waitFor(() => expect(up.uploadCreate).toHaveBeenCalledTimes(1));
  });

  it('offline, the + that opens the sheet is off too', async () => {
    setup({ files: true, status: 'offline', api: { filesRoots: vi.fn(async () => ({ roots })), filesList } });
    const plus = (await screen.findByRole('button', { name: 'Add files' })) as HTMLButtonElement;
    expect(plus.disabled).toBe(true);
    expect(plus.getAttribute('title')).toBe("Offline: can't add files right now");
  });

  it('with Files off, the roots are never asked for', () => {
    const filesRoots = vi.fn(async () => ({ roots }));
    setup({ api: { filesRoots } });
    expect(plusInput().type).toBe('file');
    expect(filesRoots).not.toHaveBeenCalled();
  });
});

describe('the chip helpers', () => {
  const chip = (over: Partial<Attachment>): Attachment => ({ key: 'k', name: 'a.pdf', state: 'ready', progress: 1, upload: { id: '01jfz8x8y3t0v5g9wqk2m4n601', kind: 'pdf', bytes: 1 }, ...over });

  it('readyRefs takes ready chips on the Mac and not held by a send; chipsWaiting says when Send must wait', () => {
    const ready = chip({});
    expect(readyRefs([ready, chip({ state: 'uploading', upload: undefined }), chip({ sending: true })])).toEqual([{ upload: '01jfz8x8y3t0v5g9wqk2m4n601', label: 'a.pdf' }]);
    expect(chipsWaiting([ready])).toBe(false);
    for (const state of ['preparing', 'uploading', 'failed'] as const) expect(chipsWaiting([ready, chip({ state })]), state).toBe(true);
    expect(chipsWaiting([chip({ sending: true })])).toBe(true);
    expect(chipsWaiting([])).toBe(false);
  });

  it("the Rewrite sheet's line", () => {
    expect(attachmentsLine([])).toBeNull();
    expect(attachmentsLine([chip({})])).toBe('1 file goes with it');
    expect(attachmentsLine([chip({}), chip({ sending: true })])).toBe('2 files go with it');
    expect(attachmentsLine([chip({}), chip({ state: 'uploading' })])).toBe('2 files go with it once they are uploaded');
    // The sheet covers the composer: its own Retry and Remove sit under this line.
    expect(attachmentsLine([chip({ state: 'failed' })])).toBe("The file didn't upload. Retry or remove it to send.");
    expect(attachmentsLine([chip({ state: 'failed' }), chip({ state: 'failed' })])).toBe("The files didn't upload. Retry or remove them to send.");
    expect(attachmentsLine([chip({}), chip({ state: 'failed' }), chip({ state: 'uploading' })])).toBe("1 of 3 files didn't upload. Retry or remove it to send.");
  });

  it('cutName keeps whole code points within the length a label may have; sendFilesWord counts a send\'s files', () => {
    const smile = '\u{1F600}';
    expect(cutName('short.pdf', 200)).toBe('short.pdf');
    expect(cutName(`a${smile.repeat(3)}`, 4)).toBe(`a${smile}`);
    expect(cutName(smile.repeat(3), 4)).toBe(smile.repeat(2));
    const local = (n: number): LocalSend => ({ key: 'k', text: '', posting: false, at: 0, attachments: Array.from({ length: n }, (_, i) => ({ upload: `01jfz8x8y3t0v5g9wqk2m4n60${i}`, label: `f${i}` })) });
    expect(sendFilesWord({ local: local(1) })).toBe('1 file');
    expect(sendFilesWord({ local: local(3) })).toBe('3 files');
    expect(sendFilesWord({ local: local(0) })).toBeNull();
    expect(sendFilesWord({})).toBeNull();
  });

  it('turnOfSend: a send with files is the prompt the daemon composed from it', () => {
    const refs = [
      { upload: '01jfz8x8y3t0v5g9wqk2m4n601', label: 'a.pdf' },
      { upload: '01jfz8x8y3t0v5g9wqk2m4n602', label: 'b.md' },
    ];
    const local = (text: string, attachments?: LocalSend['attachments']): LocalSend => ({ key: 'k', text, posting: false, at: 0, ...(attachments ? { attachments } : {}) });
    const composed = 'compare these\n\nAttached files:\n- "a.pdf": /synthetic/state/uploads/s1/one.pdf\n- "b.md": /synthetic/state/uploads/s1/two.md';
    const withFiles = { text: 'compare these', local: local('compare these', refs) };
    expect(turnOfSend(composed, withFiles)).toBe(true);
    expect(turnOfSend(composed.replace(/\n/g, '\r\n'), withFiles)).toBe(true);
    expect(turnOfSend('compare these', withFiles)).toBe(false);
    // One file short is another send.
    expect(turnOfSend(composed.split('\n').slice(0, -1).join('\n'), withFiles)).toBe(false);
    const alone = { text: '', local: local('', refs.slice(0, 1)) };
    expect(turnOfSend('Please look at these files:\n- "a.pdf": /synthetic/state/uploads/s1/one.pdf', alone)).toBe(true);
    expect(turnOfSend('Attached files:\n- "a.pdf": /x', alone)).toBe(false);
    // Without files: the exact text, as before.
    expect(turnOfSend('  ship it ', { text: 'ship it', local: local('ship it') })).toBe(true);
    expect(turnOfSend('ship it now', { text: 'ship it', local: local('ship it') })).toBe(false);
    expect(turnOfSend('', { text: '', local: local('') })).toBe(false);
  });
});
