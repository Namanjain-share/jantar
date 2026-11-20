/**
 * 0.14.1 Share and Download in the viewer, for a PDF or an image only: the
 * bytes the viewer already fetched are handed over in the tap itself (the
 * share sheet needs that tap); bytes fetched after the tap wait for a
 * second one ("Ready to share"); a browser that can't share the file gets
 * the download; closing the sheet is silent and any other failure is a
 * plain toast; over the raw caps both are off, with the reason on screen.
 * A save that had to wait for the bytes waits for a second tap too ("Ready
 * to save"), and a file Claude wrote again is fetched anew, never handed
 * over as it was.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILES_RAW_IMAGE_MAX, FILES_RAW_PDF_MAX, type FileChange } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { clearFilesCache } from '../src/ui/screens/files/data.js';
import { handOverFile, handOverRefusal, sharesFile } from '../src/ui/screens/files/HandOver.js';
import { Viewer } from '../src/ui/screens/files/Viewer.js';
import { change, objectUrls, pendingForever, renderViewer as viewer, renderWith, stat, text } from './files-helpers.js';
import { fakeApi, iso } from './helpers.js';

// pdf.js needs a real canvas: a stand-in with the same calls (as files-viewer.test.tsx).
vi.mock('../src/ui/screens/files/pdf.js', () => ({
  PDF_OPTIONS: { useWasm: false, enableXfa: false, disableFontFace: true, disableRange: true, maxImageSize: 16e6 },
  loadPdfjs: async () => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
          render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
          cleanup: () => true,
        }),
      }),
      destroy: async () => undefined,
    }),
  }),
}));

const PNG = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
const PDF = () => new Blob([new TextEncoder().encode('%PDF-1.7 synthetic')], { type: 'application/pdf' });

/** The browser's share sheet, as the test wants it. */
function shareSheet(opts: { can?: boolean; fails?: Error } = {}) {
  const shared: File[] = [];
  const canShare = vi.fn((data: ShareData) => (opts.can ?? true) && (data.files?.length ?? 0) > 0);
  const share = vi.fn(async (data: ShareData) => {
    if (opts.fails) throw opts.fails;
    shared.push(...(data.files ?? []));
  });
  Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true, writable: true });
  Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
  return { shared, share, canShare };
}

/** Downloads: the <a download> clicks, with the name and the object URL each one had. */
function downloads() {
  const clicks: Array<{ name: string; href: string }> = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ name: this.download, href: this.getAttribute('href') ?? '' });
  });
  return clicks;
}

function named(name: string, err = 'x'): Error {
  const e = new Error(err);
  e.name = name;
  return e;
}

beforeEach(() => clearFilesCache());
afterEach(() => {
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { canShare?: unknown }).canShare;
  vi.useRealTimers();
});

const imageStat = (size = 4) => stat({ kind: 'image', language: undefined, size });
const pdfStat = (size = 13_000_000) => stat({ kind: 'pdf', language: undefined, size });

describe('the pieces', () => {
  it('a File named and typed as on the Mac; the caps and their reason', () => {
    const f = handOverFile(PDF(), 'spec.pdf', 'pdf');
    expect([f.name, f.type, f.size]).toEqual(['spec.pdf', 'application/pdf', PDF().size]);
    expect(handOverFile(new Blob(['x']), 'photo.JPG', 'image').type).toBe('image/jpeg');
    expect(handOverRefusal('image', FILES_RAW_IMAGE_MAX)).toBeNull();
    expect(handOverRefusal('image', FILES_RAW_IMAGE_MAX + 1)).toBe('Too large to share or download from here: images up to 20 MB.');
    expect(handOverRefusal('pdf', FILES_RAW_PDF_MAX + 1)).toBe('Too large to share or download from here: PDFs up to 50 MB.');
    expect(sharesFile(f, { download: () => undefined })).toBe(false);
    expect(sharesFile(f, { download: () => undefined, share: async () => undefined, canShare: () => true })).toBe(true);
    expect(sharesFile(f, { download: () => undefined, share: async () => undefined, canShare: () => { throw new TypeError('no'); } })).toBe(false);
  });
});

describe('Share', () => {
  it('an image already on screen: one tap opens the share sheet with its bytes, no second fetch', async () => {
    objectUrls();
    const sheet = shareSheet();
    const filesRaw = vi.fn(async () => PNG());
    viewer(fakeApi({ filesStat: vi.fn(async () => imageStat()), filesRaw }), { path: 'img/logo.png' });
    await screen.findByRole('img', { name: 'logo.png' });
    const share = screen.getByRole('button', { name: 'Share' });
    fireEvent.click(share);
    // In the tap itself: the share sheet needs it.
    expect(sheet.share).toHaveBeenCalledTimes(1);
    expect(sheet.shared.map((f) => [f.name, f.type, f.size])).toEqual([['logo.png', 'image/png', 4]]);
    expect(filesRaw).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Ready to share' })).toBeNull();
  });

  it('a PDF not opened yet: the tap fetches it, then "Ready to share" asks for the tap that shares', async () => {
    const sheet = shareSheet();
    let arrive: (b: Blob) => void = () => undefined;
    const filesRaw = vi.fn(() => new Promise<Blob>((r) => (arrive = r)));
    viewer(fakeApi({ filesStat: vi.fn(async () => pdfStat()), filesRaw }), { path: 'docs/spec.pdf' });
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    expect(filesRaw).toHaveBeenCalledWith({ root: 'r.work', path: 'docs/spec.pdf' }, { signal: expect.any(AbortSignal) });
    expect(await screen.findByText(/Getting spec\.pdf from the Mac/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share' }).hasAttribute('disabled')).toBe(true);
    await act(async () => arrive(PDF()));
    // The first tap was spent waiting: nothing opened yet.
    expect(sheet.share).not.toHaveBeenCalled();
    const ready = await screen.findByRole('region', { name: 'Ready to share' });
    expect(within(ready).getByRole('status').textContent).toBe('Ready to share spec.pdf');
    const now = within(ready).getByRole('button', { name: 'Share now' });
    expect(document.activeElement).toBe(now);
    fireEvent.click(now);
    expect(sheet.share).toHaveBeenCalledTimes(1);
    expect(sheet.shared.map((f) => [f.name, f.type])).toEqual([['spec.pdf', 'application/pdf']]);
    expect(screen.queryByRole('region', { name: 'Ready to share' })).toBeNull();
    // The bytes stay for this viewer: the header's Share shares at once now.
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(sheet.share).toHaveBeenCalledTimes(2);
    expect(filesRaw).toHaveBeenCalledTimes(1);
  });

  it('"Not now" puts the ready bar away; the next Share still shares at once', async () => {
    const sheet = shareSheet();
    viewer(fakeApi({ filesStat: vi.fn(async () => pdfStat()), filesRaw: vi.fn(async () => PDF()) }), { path: 'spec.pdf' });
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('region', { name: 'Ready to share' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(sheet.share).toHaveBeenCalledTimes(1);
  });

  it('a PDF opened in the viewer: Share uses the bytes it opened with, if they are this version\'s', async () => {
    const sheet = shareSheet();
    const filesRaw = vi.fn(async () => PDF());
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => pdfStat(PDF().size)), filesRaw }), { path: 'spec.pdf' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await screen.findByText(/1 page$/);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(sheet.share).toHaveBeenCalledTimes(1);
    expect(filesRaw).toHaveBeenCalledTimes(1);
    a.unmount();

    // Bytes of another size than the file's are another version's: Share asks the Mac for this one.
    clearFilesCache();
    const again = vi.fn(async () => PDF());
    viewer(fakeApi({ filesStat: vi.fn(async () => pdfStat(PDF().size + 10)), filesRaw: again }), { path: 'spec.pdf' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await screen.findByText(/1 page$/);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('region', { name: 'Ready to share' })).toBeTruthy();
    expect(again).toHaveBeenCalledTimes(2);
    expect(sheet.share).toHaveBeenCalledTimes(1);
  });

  it('a browser that cannot share the fetched file saves it instead, from a second tap ("Ready to save")', async () => {
    const urls = objectUrls();
    const clicks = downloads();
    const sheet = shareSheet({ can: false });
    viewer(fakeApi({ filesStat: vi.fn(async () => pdfStat()), filesRaw: vi.fn(async () => PDF()) }), { path: 'docs/spec.pdf' });
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    const ready = await screen.findByRole('region', { name: 'Ready to save' });
    // Nothing saved after the wait: an iPhone allows it only from a tap.
    expect(clicks).toEqual([]);
    expect(within(ready).getByRole('status').textContent).toBe('Ready to save spec.pdf');
    fireEvent.click(within(ready).getByRole('button', { name: 'Save now' }));
    expect(clicks).toEqual([{ name: 'spec.pdf', href: urls.made[0] }]);
    expect(sheet.share).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Ready to save' })).toBeNull();
    // Revoked a moment after the click.
    await waitFor(() => expect(urls.revoke).toHaveBeenCalledWith(urls.made[0]), { timeout: 2_000 });
  });

  it('after Claude writes the file again, Share fetches the new bytes instead of handing over the old ones', async () => {
    objectUrls();
    const sheet = shareSheet();
    const v1 = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    const v2 = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0])], { type: 'image/png' });
    // The stat read again after the write: a new time and size.
    const filesStat = vi.fn(async () => (filesStat.mock.calls.length > 1 ? { ...imageStat(6), mtime: iso(60_000) } : imageStat(4)));
    const filesRaw = vi.fn(async () => (filesRaw.mock.calls.length > 1 ? v2 : v1));
    let wrote: (c: FileChange) => void = () => undefined;
    function Written() {
      const [c, setC] = useState(change({ rootId: 'r.work', rel: 'img/logo.png', lastAt: iso(0) }));
      wrote = setC;
      return <Viewer root="r.work" path="img/logo.png" tab="file" phone change={c} onLocation={() => undefined} />;
    }
    renderWith(<Written />, { api: fakeApi({ filesStat, filesRaw }) });
    await screen.findByRole('img', { name: 'logo.png' });
    // The bytes on screen are this version's: one tap shares them.
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(sheet.shared.map((f) => f.size)).toEqual([4]);
    act(() => wrote(change({ rootId: 'r.work', rel: 'img/logo.png', lastAt: iso(60_000) })));
    await waitFor(() => expect(filesStat).toHaveBeenCalledTimes(2));
    await screen.findByText(/6 B/);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Share now' }));
    expect(filesRaw).toHaveBeenCalledTimes(2);
    expect(sheet.shared.map((f) => f.size)).toEqual([4, 6]);
  });

  it('no Web Share at all: Share downloads too', async () => {
    objectUrls();
    const clicks = downloads();
    viewer(fakeApi({ filesStat: vi.fn(async () => imageStat()), filesRaw: vi.fn(async () => PNG()) }), { path: 'logo.png' });
    await screen.findByRole('img', { name: 'logo.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(clicks.map((c) => c.name)).toEqual(['logo.png']);
  });

  it('closing the share sheet says nothing; any other failure is one plain toast', async () => {
    objectUrls();
    shareSheet({ fails: named('AbortError', 'Share canceled') });
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => imageStat()), filesRaw: vi.fn(async () => PNG()) }), { path: 'logo.png' });
    await screen.findByRole('img', { name: 'logo.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await act(async () => new Promise<void>((r) => setTimeout(r, 0)));
    expect(a.toasts.getState().toasts).toEqual([]);
    a.unmount();

    clearFilesCache();
    shareSheet({ fails: named('NotAllowedError', 'The request is not allowed by the user agent') });
    const b = viewer(fakeApi({ filesStat: vi.fn(async () => imageStat()), filesRaw: vi.fn(async () => PNG()) }), { path: 'logo.png' });
    await screen.findByRole('img', { name: 'logo.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(b.toasts.getState().toasts.map((t) => [t.text, t.tone])).toEqual([["Couldn't share this file. Try again, or use Download.", 'error']]));
  });

  it('bytes that cannot be fetched: the reason as a toast, and Share is back', async () => {
    shareSheet();
    const filesRaw = vi.fn(async () => Promise.reject(new ApiError('not_found', 'That file is no longer there.', 404)));
    const { toasts } = viewer(fakeApi({ filesStat: vi.fn(async () => pdfStat()), filesRaw }), { path: 'spec.pdf' });
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    await waitFor(() => expect(toasts.getState().toasts.at(-1)?.text).toBe('That file is no longer there.'));
    expect(screen.getByRole('button', { name: 'Share' }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('region', { name: 'Ready to share' })).toBeNull();
  });

  it('leaving the viewer stops a fetch for Share', async () => {
    shareSheet();
    const signals: AbortSignal[] = [];
    const filesRaw = vi.fn((_q: unknown, o?: { signal?: AbortSignal }) => {
      if (o?.signal) signals.push(o.signal);
      return pendingForever();
    });
    const { unmount } = viewer(fakeApi({ filesStat: vi.fn(async () => pdfStat()), filesRaw }), { path: 'spec.pdf' });
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    expect(signals).toHaveLength(1);
    unmount();
    expect(signals[0]!.aborted).toBe(true);
  });
});

describe('Download (in ···)', () => {
  it('saves the bytes on screen through <a download>; with none yet, fetches them and saves from the second tap', async () => {
    const urls = objectUrls();
    const clicks = downloads();
    shareSheet();
    const filesRaw = vi.fn(async () => PNG());
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => imageStat()), filesRaw }), { path: 'img/logo.png' });
    await screen.findByRole('img', { name: 'logo.png' });
    fireEvent.click(screen.getByRole('button', { name: 'More for this file' }));
    expect(await screen.findByRole('menuitem', { name: 'Share' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download' }));
    expect(clicks).toEqual([{ name: 'logo.png', href: urls.made[1] }]);
    expect(filesRaw).toHaveBeenCalledTimes(1);
    a.unmount();

    clearFilesCache();
    const pdfRaw = vi.fn(async () => PDF());
    viewer(fakeApi({ filesStat: vi.fn(async () => pdfStat()), filesRaw: pdfRaw }), { path: 'spec.pdf' });
    fireEvent.click(await screen.findByRole('button', { name: 'More for this file' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download' }));
    const ready = await screen.findByRole('region', { name: 'Ready to save' });
    expect(clicks.map((c) => c.name)).toEqual(['logo.png']);
    fireEvent.click(within(ready).getByRole('button', { name: 'Save now' }));
    expect(clicks.map((c) => c.name)).toEqual(['logo.png', 'spec.pdf']);
    expect(pdfRaw).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Ready to share' })).toBeNull();
  });
});

describe('when there is none', () => {
  it('over the caps: Share and Download are off, and the viewer says why', async () => {
    shareSheet();
    const filesRaw = vi.fn(async () => PNG());
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => imageStat(FILES_RAW_IMAGE_MAX + 1)), filesRaw }), { path: 'huge.png' });
    const share = await screen.findByRole('button', { name: 'Share' });
    expect(share.hasAttribute('disabled')).toBe(true);
    const reason = screen.getByText('Too large to share or download from here: images up to 20 MB.');
    expect(share.getAttribute('aria-describedby')).toBe(reason.id);
    fireEvent.click(screen.getByRole('button', { name: 'More for this file' }));
    for (const item of ['Share', 'Download']) expect((await screen.findByRole('menuitem', { name: item })).getAttribute('aria-disabled'), item).toBe('true');
    fireEvent.click(share);
    expect(filesRaw).not.toHaveBeenCalled();
    a.unmount();

    viewer(fakeApi({ filesStat: vi.fn(async () => pdfStat(FILES_RAW_PDF_MAX + 1)), filesRaw }), { path: 'huge.pdf' });
    expect(await screen.findByText('Too large to share or download from here: PDFs up to 50 MB.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share' }).hasAttribute('disabled')).toBe(true);
  });

  it('other kinds (code, Markdown, SVG, binary) have neither', async () => {
    shareSheet();
    for (const [path, kind] of [['src/a.ts', 'text'], ['README.md', 'markdown'], ['logo.svg', 'svg'], ['app.zip', 'binary']] as const) {
      clearFilesCache();
      const v = viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind })), filesText: vi.fn(async () => text('x\n')) }), { path });
      fireEvent.click(await screen.findByRole('button', { name: 'More for this file' }));
      expect(await screen.findByRole('menuitem', { name: 'Copy path' })).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: 'Share' }), path).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Download' }), path).toBeNull();
      expect(screen.queryByRole('button', { name: 'Share' }), path).toBeNull();
      v.unmount();
    }
  });
});
