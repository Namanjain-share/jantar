/**
 * The read-only viewer (v0.3 spec 5.2.3, no diffs: U9) against the fake
 * API, kind by kind: code (highlighted, plain, windows, hidden characters,
 * line selection), Markdown, images, SVG as source with a blob preview,
 * PDF through a stand-in pdf.js, notebooks, binary files; the edits tab;
 * and the loading, gone, refused and offline states, including a file read
 * before that is gone or refused now. The named security rules (W3 to W5)
 * are in files.test.tsx.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChange, FileStat } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { setSharedHighlighter } from '../src/lib/highlight/client.js';
import type { Line } from '../src/lib/highlight/types.js';
import { clearFilesCache } from '../src/ui/screens/files/data.js';
import { pickAlive } from '../src/ui/screens/files/PdfView.js';
import { change, layout, objectUrls, pendingForever, renderViewer as viewer, stat, text } from './files-helpers.js';
import { fakeApi, iso } from './helpers.js';

// pdf.js itself needs a real canvas: a stand-in with the same calls.
const pdf = vi.hoisted(() => {
  const rendered: number[] = [];
  const destroyed = { count: 0 };
  const getDocument = vi.fn((_opts: Record<string, unknown>) => ({
    promise: Promise.resolve({
      numPages: 5,
      getPage: async (n: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => {
          rendered.push(n);
          return { promise: Promise.resolve(), cancel: () => undefined };
        },
        cleanup: () => true,
      }),
    }),
    destroy: async () => {
      destroyed.count += 1;
    },
  }));
  return { rendered, destroyed, getDocument };
});
vi.mock('../src/ui/screens/files/pdf.js', () => ({
  PDF_OPTIONS: { useWasm: false, enableXfa: false, disableFontFace: true, disableRange: true, maxImageSize: 16e6 },
  loadPdfjs: async () => ({ getDocument: pdf.getDocument }),
}));

const RLO = String.fromCodePoint(0x202e);

let clipboard: { writeText: ReturnType<typeof vi.fn> };

beforeEach(() => {
  clearFilesCache();
  clipboard = { writeText: vi.fn(async () => undefined) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});
afterEach(() => setSharedHighlighter(null));

describe('code', () => {
  it('shows numbered lines with the name, size and language, highlighted by the worker', async () => {
    setSharedHighlighter({
      highlight: async (t) =>
        t.split('\n').map((l): Line => (l.startsWith('const') ? [['const', 'tk-kw'], [l.slice(5), '']] : [[l, '']])),
      dispose: () => undefined,
    });
    const api = fakeApi({ filesStat: vi.fn(async () => stat({ size: 4200 })), filesText: vi.fn(async () => text('const a = 1;\nlet b = 2;\n')) });
    viewer(api);
    expect(await screen.findByRole('heading', { name: 'a.ts' })).toBeTruthy();
    expect(screen.getByText('src/a.ts · 4.1 KB · TypeScript')).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'a.ts, 2 lines' });
    await waitFor(() => expect(list.querySelector('.tk-kw')?.textContent).toBe('const'));
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('boxes hidden characters and shows the daemon warnings as banners', async () => {
    const api = fakeApi({
      filesStat: vi.fn(async () => stat()),
      filesText: vi.fn(async () => text(`const ok = "a${RLO}b";\n`, { warnings: ['bidi', 'secret-like', 'truncated-line'] })),
    });
    viewer(api);
    expect(await screen.findByText('⟨U+202E⟩')).toBeTruthy();
    expect(screen.getByText(/hidden direction characters/)).toBeTruthy();
    expect(screen.getByText('This file holds keys or tokens. They show as * here and never leave the Mac.')).toBeTruthy();
    expect(screen.getByText('A very long line was cut short.')).toBeTruthy();
  });

  it('wraps a minified file and never asks for highlighting', async () => {
    const highlight = vi.fn(async () => null);
    setSharedHighlighter({ highlight, dispose: () => undefined });
    const api = fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('a();b();\n', { warnings: ['minified'] })) });
    viewer(api, { path: 'app.min.js' });
    expect(await screen.findByText(/looks minified/)).toBeTruthy();
    const code = (await screen.findByRole('listitem')).querySelector('code')!;
    expect(code.className).toContain('whitespace-pre-wrap');
    expect(highlight).not.toHaveBeenCalled();
  });

  it('pages a large file in 512 KB windows', async () => {
    const filesText = vi.fn(async (q: { offset?: number }) =>
      q.offset ? text('third\n', { offset: 524288, next: null, size: 600_000 }) : text('first\nsecond\n', { next: 524288, size: 600_000 }),
    );
    const api = fakeApi({ filesStat: vi.fn(async () => stat({ size: 600_000 })), filesText });
    viewer(api);
    expect(await screen.findByText('512 KB of 586 KB shown')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load the next 512 KB' }));
    expect(await screen.findByRole('button', { name: 'Line 3' })).toBeTruthy();
    expect(filesText).toHaveBeenLastCalledWith({ root: 'r.work', path: 'src/a.ts', offset: 524288 });
    expect(screen.queryByRole('button', { name: /Load the next/ })).toBeNull();
  });

  it('keeps the windows already loaded when the Mac comes back, and starts over when the file changed', async () => {
    const filesText = vi.fn(async (q: { offset?: number }) =>
      q.offset ? text('third\n', { offset: 524288, next: null, size: 600_000 }) : text('first\nsecond\n', { next: 524288, size: 600_000 }),
    );
    const { store } = viewer(fakeApi({ filesStat: vi.fn(async () => stat({ size: 600_000 })), filesText }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load the next 512 KB' }));
    expect(await screen.findByRole('button', { name: 'Line 3' })).toBeTruthy();
    const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));
    act(() => store.getState().setConn({ status: 'offline' }));
    act(() => store.getState().setConn({ status: 'live' }));
    await waitFor(() => expect(filesText).toHaveBeenCalledTimes(3));
    await settle();
    // The same first window (same mtime and size): the third line is still there.
    expect(screen.getByRole('button', { name: 'Line 3' })).toBeTruthy();
    filesText.mockImplementation(async (q: { offset?: number }) =>
      q.offset ? text('third\n', { offset: 524288, next: null, size: 600_100 }) : text('first\nsecond\n', { next: 524288, size: 600_100, mtime: iso(5_000) }),
    );
    act(() => store.getState().setConn({ status: 'offline' }));
    act(() => store.getState().setConn({ status: 'live' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Line 3' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Load the next 512 KB' })).toBeTruthy();
  });

  it('a line number copies path:line, a second one a range, and the menu copies and asks', async () => {
    const onAsk = vi.fn();
    const api = fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('a\nb\nc\nd\n')) });
    viewer(api, { onAsk });
    fireEvent.click(await screen.findByRole('button', { name: 'Line 2' }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith('src/a.ts:2');
    expect(screen.getByRole('button', { name: 'Line 2' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Line 4' }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith('src/a.ts:2-4');
    expect(screen.getByRole('button', { name: 'Line 3' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'More for this file' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy path' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith('src/a.ts'));
    fireEvent.click(screen.getByRole('button', { name: 'More for this file' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ask about this' }));
    expect(onAsk).toHaveBeenCalledWith('@src/a.ts:2-4 ');
  });

  it('under a finger a line number only selects (a scroll can end on one); ··· copies path:line', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('pointer: coarse'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
    const api = fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('a\nb\nc\n')) });
    viewer(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Line 2' }));
    expect(screen.getByRole('button', { name: 'Line 2' }).getAttribute('aria-pressed')).toBe('true');
    expect(clipboard.writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'More for this file' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy path:line' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith('src/a.ts:2'));
  });

  it('offers "Ask about this" only where the caller allows it (a session folder)', async () => {
    const api = fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('a\n')) });
    viewer(api);
    fireEvent.click(await screen.findByRole('button', { name: 'More for this file' }));
    expect(await screen.findByRole('menuitem', { name: 'Copy path' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Ask about this' })).toBeNull();
  });

  it('spells out hidden characters in the name, the meta line and the "Copied" toast', async () => {
    const api = fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('x\n')) });
    const { toasts } = viewer(api, { path: `src/evil${RLO}gnp.ts` });
    const heading = await screen.findByRole('heading', { name: 'evil⟨U+202E⟩gnp.ts' });
    expect(heading.querySelector('.tk-hidden')?.textContent).toBe('⟨U+202E⟩');
    expect(screen.getByText(/^src\/evil/).querySelector('.tk-hidden')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More for this file' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy path' }));
    // The clipboard gets the real path; the toast shows what is in it.
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith(`src/evil${RLO}gnp.ts`));
    await waitFor(() => expect(toasts.getState().toasts.at(-1)?.text).toBe('Copied src/evil⟨U+202E⟩gnp.ts'));
  });

  it('virtualises a long file', async () => {
    layout();
    const body = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
    const api = fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text(body)) });
    viewer(api);
    const list = await screen.findByRole('list', { name: 'a.ts, 3000 lines' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.length).toBeLessThan(100);
    expect(within(list).queryByText('line 3000')).toBeNull();
  });
});

describe('states', () => {
  it('loading, gone, refused, offline and the empty file', async () => {
    const a = viewer(fakeApi({ filesStat: vi.fn(pendingForever) }));
    expect(await screen.findByText('Reading the file…')).toBeTruthy();
    a.unmount();
    clearFilesCache();

    // The daemon's sentence when it sends one (WP-FP's refusals), ours when it does not.
    const b = viewer(fakeApi({ filesStat: vi.fn(async () => Promise.reject(new ApiError('not_found', 'That folder is not shared with this device (or its session has ended).', 404))) }));
    expect(await screen.findByText('That folder is not shared with this device (or its session has ended).')).toBeTruthy();
    b.unmount();
    clearFilesCache();
    const b2 = viewer(fakeApi({ filesStat: vi.fn(async () => Promise.reject(new ApiError('not_found', '', 404))) }));
    expect(await screen.findByText('That file is no longer there.')).toBeTruthy();
    b2.unmount();
    clearFilesCache();

    const c = viewer(fakeApi({ filesStat: vi.fn(async () => Promise.reject(new ApiError('forbidden', 'This file is protected. Keys and secrets never leave the Mac.', 403))) }));
    expect(await screen.findByText('This file is protected. Keys and secrets never leave the Mac.')).toBeTruthy();
    expect(screen.getByLabelText('Protected')).toBeTruthy();
    c.unmount();
    clearFilesCache();

    const filesStat = vi.fn(async (): Promise<FileStat> => Promise.reject(new ApiError('network', 'down', 0)));
    const d = viewer(fakeApi({ filesStat }));
    expect(await screen.findByText("Can't reach the Mac. Files show again when it's back.")).toBeTruthy();
    filesStat.mockImplementation(async () => stat());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(filesStat).toHaveBeenCalledTimes(2));
    d.unmount();
    clearFilesCache();

    viewer(fakeApi({ filesStat: vi.fn(async () => stat({ size: 0 })), filesText: vi.fn(async () => text('')) }));
    expect(await screen.findByText('This file is empty.')).toBeTruthy();
  });

  it('a folder opened as a file moves to the folder view', async () => {
    const { onLocation } = viewer(fakeApi({ filesStat: vi.fn(async () => stat({ type: 'dir', kind: 'binary' })) }), { path: 'src/lib' });
    await waitFor(() => expect(onLocation).toHaveBeenCalledWith({ root: 'r.work', path: 'src/lib/' }, { replace: true }));
    expect(onLocation).toHaveBeenCalledTimes(1);
  });

  it('a binary file says what it is', async () => {
    viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'binary', size: 2_500_000, language: undefined })) }), { path: 'dist/app.zip' });
    expect(await screen.findByText('Binary file · 2.4 MB · zip. Jantar shows text, images and PDFs.')).toBeTruthy();
  });
});

describe('Markdown', () => {
  it('renders by default, shows the source on request, and opens relative links', async () => {
    const api = fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'markdown', language: 'markdown' })), filesText: vi.fn(async () => text('# Title\n\nSee [b](b.md).\n')) });
    const { onLocation } = viewer(api, { path: 'docs/a.md' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Title' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'b' }));
    expect(onLocation).toHaveBeenCalledWith({ root: 'r.work', path: 'docs/b.md' });
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(await screen.findByRole('list', { name: 'a.md, 3 lines' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Title' })).toBeNull();
  });
});

describe('images and SVG', () => {
  it('shows an image from its bytes and revokes the URL when the viewer closes', async () => {
    const urls = objectUrls();
    const filesRaw = vi.fn(async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }));
    const { unmount } = viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'image', language: undefined })), filesRaw }), { path: 'img/logo.png' });
    const img = await screen.findByRole('img', { name: 'logo.png' });
    expect(img.getAttribute('src')).toBe(urls.made[0]);
    expect(filesRaw).toHaveBeenCalledWith({ root: 'r.work', path: 'img/logo.png' }, { signal: expect.any(AbortSignal) });
    expect(urls.revoke).not.toHaveBeenCalled();
    unmount();
    expect(urls.revoke).toHaveBeenCalledWith(urls.made[0]);
  });

  it('an image over the cap is not fetched; a refused one shows the reason', async () => {
    const filesRaw = vi.fn(async () => Promise.reject(new ApiError('unsupported_media_type', 'Jantar shows this file as text, or not at all.', 415)));
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'image', size: 30 * 1024 * 1024 })), filesRaw }), { path: 'big.png' });
    expect(await screen.findByText('Image · 30 MB. Jantar shows images up to 20 MB.')).toBeTruthy();
    expect(filesRaw).not.toHaveBeenCalled();
    a.unmount();
    clearFilesCache();
    viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'image' })), filesRaw }), { path: 'fake.png' });
    expect(await screen.findByText('Jantar shows this file as text, or not at all.')).toBeTruthy();
    // A fact about the file, not an alarm, and trying again cannot change it.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('stops downloading an image when the viewer closes', async () => {
    const signals: AbortSignal[] = [];
    const filesRaw = vi.fn((_q: { root: string; path: string }, o?: { signal?: AbortSignal }) => {
      if (o?.signal) signals.push(o.signal);
      return pendingForever();
    });
    const { unmount } = viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'image', size: 19_000_000 })), filesRaw }), { path: 'photo.png' });
    expect(await screen.findByText('Loading the image…')).toBeTruthy();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    unmount();
    expect(signals[0]!.aborted).toBe(true);
  });

  it('an SVG shows its source first; Preview is a blob image of that text, revoked when it closes', async () => {
    const urls = objectUrls();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n';
    const api = fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'svg', language: 'svg' })), filesText: vi.fn(async () => text(svg)) });
    const { unmount } = viewer(api, { path: 'logo.svg' });
    const list = await screen.findByRole('list', { name: 'logo.svg, 1 lines' });
    expect(list.querySelector('svg,script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const img = await screen.findByRole('img', { name: 'logo.svg' });
    expect(img.getAttribute('src')).toBe(urls.made[0]);
    // Revoked once painted: a long press's "Open in New Tab" finds nothing to load as a document.
    expect(urls.revoke).not.toHaveBeenCalled();
    fireEvent.load(img);
    expect(urls.revoke).toHaveBeenCalledWith(urls.made[0]);
    const blob = urls.create.mock.calls[0]![0];
    expect(blob.type).toBe('image/svg+xml');
    expect(await blob.text()).toBe(svg);
    // Never through /v1/files/raw (it refuses SVG).
    expect(api.filesRaw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(urls.revoke).toHaveBeenCalledWith(urls.made[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('img', { name: 'logo.svg' });
    unmount();
    expect(urls.revoke).toHaveBeenCalledWith(urls.made[1]);
  });
});

/** IntersectionObserver stand-ins (jsdom has none): the test reports entries by page number; null is "left". */
function fakeObservers() {
  const made: FakeObserver[] = [];
  class FakeObserver {
    readonly cb: IntersectionObserverCallback;
    readonly opts: IntersectionObserverInit;
    targets: Element[] = [];
    constructor(cb: IntersectionObserverCallback, opts: IntersectionObserverInit = {}) {
      this.cb = cb;
      this.opts = opts;
      made.push(this);
    }
    observe(el: Element) {
      this.targets.push(el);
    }
    unobserve() {}
    disconnect() {
      this.targets = [];
    }
    takeRecords() {
      return [];
    }
    report(pages: Array<[number, number | null]>) {
      const entries = pages.map(
        ([n, ratio]) =>
          ({
            target: this.targets.find((t) => t.getAttribute('data-page') === String(n))!,
            isIntersecting: ratio !== null,
            intersectionRatio: ratio ?? 0,
          }) as unknown as IntersectionObserverEntry,
      );
      act(() => this.cb(entries, this as unknown as IntersectionObserver));
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  return made;
}

/** The pages whose canvas is alive (drawn), in page order. */
function drawn(): number[] {
  return Array.from(document.querySelectorAll('canvas[data-alive]')).map((c) => Number(c.closest('[data-page]')!.getAttribute('data-page')));
}

describe('PDF', () => {
  beforeEach(() => {
    pdf.rendered.length = 0;
    pdf.destroyed.count = 0;
    pdf.getDocument.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks before loading, then draws at most three pages with the strict options', async () => {
    const filesRaw = vi.fn(async () => new Blob([new TextEncoder().encode('%PDF-1.7')], { type: 'application/pdf' }));
    const { unmount } = viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'pdf', size: 13_000_000 })), filesRaw }), { path: 'spec.pdf' });
    expect(await screen.findByText('PDF · 12.4 MB')).toBeTruthy();
    expect(filesRaw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('PDF · 12.4 MB · 5 pages')).toBeTruthy();
    expect(screen.getAllByRole('img', { name: /^Page \d$/ })).toHaveLength(5);
    const opts = pdf.getDocument.mock.calls[0]![0];
    expect(opts).toMatchObject({ useWasm: false, enableXfa: false, disableFontFace: true });
    expect(opts.data).toBeInstanceOf(Uint8Array);
    await waitFor(() => expect(pdf.rendered).toEqual([1, 2, 3]));
    unmount();
    expect(pdf.destroyed.count).toBe(1);
  });

  it('picks the pages to draw: on screen first (most visible, then highest), then the ones near it', () => {
    const shown = (pairs: Array<[number, number]>) => new Map(pairs);
    expect(pickAlive(shown([[1, 1], [2, 1], [3, 1], [4, 1], [5, 0.5]]), new Set([1, 2, 3, 4, 5, 6]))).toEqual([1, 2, 3]);
    expect(pickAlive(shown([[4, 0.25], [5, 1], [6, 1], [7, 0.5]]), new Set([3, 4, 5, 6, 7, 8]))).toEqual([5, 6, 7]);
    // One tall page on screen: the pages either side are drawn before they scroll in.
    expect(pickAlive(shown([[2, 0.6]]), new Set([1, 2, 3, 4]))).toEqual([1, 2, 3]);
    expect(pickAlive(shown([]), new Set())).toEqual([]);
  });

  it('a slide deck on a phone: five pages on screen at once draw the top three, and scrolling moves them', async () => {
    const io = fakeObservers();
    const filesRaw = vi.fn(async () => new Blob([new TextEncoder().encode('%PDF-1.7')], { type: 'application/pdf' }));
    viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'pdf', size: 2_000_000 })), filesRaw }), { path: 'deck.pdf' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    const meta = await screen.findByText(/5 pages$/);
    // One pair of observers for the whole document, both rooted at the scroller the pages move in.
    await waitFor(() => expect(io).toHaveLength(2));
    const scroller = meta.parentElement!;
    const onScreen = io.find((o) => !o.opts.rootMargin)!;
    const near = io.find((o) => o.opts.rootMargin === '200px 0px')!;
    expect(onScreen.opts.root).toBe(scroller);
    expect(near.opts.root).toBe(scroller);
    expect(onScreen.targets).toHaveLength(5);
    expect(near.targets).toHaveLength(5);
    expect(drawn()).toEqual([]);
    // The browser reports every visible page in one go, in page order.
    onScreen.report([[1, 1], [2, 1], [3, 1], [4, 1], [5, 0.5]]);
    near.report([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]);
    await waitFor(() => expect(drawn()).toEqual([1, 2, 3]));
    await waitFor(() => expect([...pdf.rendered].sort()).toEqual([1, 2, 3]));
    // Scrolled down: pages 1 and 2 leave the screen, 5 comes in whole.
    onScreen.report([[1, null], [2, null], [5, 1]]);
    near.report([[1, null]]);
    await waitFor(() => expect(drawn()).toEqual([3, 4, 5]));
  });

  it('a PDF over the cap cannot be opened; a failed open says why', async () => {
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'pdf', size: 60 * 1024 * 1024 })) }), { path: 'big.pdf' });
    expect(await screen.findByText('Jantar opens PDFs up to 50 MB.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    a.unmount();
    clearFilesCache();
    viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'pdf', size: 100 })), filesRaw: vi.fn(async () => Promise.reject(new ApiError('payload_too_large', '', 413))) }), { path: 'x.pdf' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText('This file is too large to show here.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('notebooks', () => {
  const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a));
  const nb = JSON.stringify({
    nbformat: 4,
    metadata: { language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Report\n', 'Some <b>bold</b> text'] },
      {
        cell_type: 'code',
        execution_count: 3,
        source: 'print("hi")',
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['hi\n'] },
          { output_type: 'display_data', data: { 'image/png': PNG, 'text/plain': ['<Figure>'] } },
          { output_type: 'display_data', data: { 'text/html': ['<script>window.__pwned=1</script>'] } },
          { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[31mValueError\u001b[0m: bad'] },
        ],
      },
      { cell_type: 'code', source: '__proto__ = 1', outputs: [{ output_type: 'execute_result', data: { __proto__: 'x', 'application/vnd.jupyter.widget-view+json': {} } }] },
    ],
  });

  it('shows cells, text and image outputs, labels HTML, and revokes image URLs on close', async () => {
    const urls = objectUrls();
    const api = fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'notebook', language: undefined })), filesText: vi.fn(async () => text(nb)) });
    const { unmount } = viewer(api, { path: 'report.ipynb' });
    const cells = await screen.findByRole('list', { name: 'Cells' });
    expect(within(cells).getByRole('heading', { level: 1, name: 'Report' })).toBeTruthy();
    expect(cells.querySelector('b,script')).toBeNull();
    expect(cells.textContent).toContain('Some <b>bold</b> text');
    expect(within(cells).getByText('In [3]')).toBeTruthy();
    expect(within(cells).getByText('hi')).toBeTruthy();
    expect(within(cells).getAllByText('HTML output not shown')).toHaveLength(2);
    expect(within(cells).getByText('ValueError: bad')).toBeTruthy();
    const img = await within(cells).findByRole('img', { name: 'Cell output' });
    expect(img.getAttribute('src')).toBe(urls.made[0]);
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined();
    unmount();
    expect(urls.revoke).toHaveBeenCalledWith(urls.made[0]);
  });

  it('reads every window before parsing, and shows the source when it is not a notebook', async () => {
    const half = Math.floor(nb.length / 2);
    const filesText = vi.fn(async (q: { offset?: number }) =>
      q.offset ? text(nb.slice(half), { offset: half, next: null, size: nb.length }) : text(nb.slice(0, half), { next: half, size: nb.length }),
    );
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'notebook' })), filesText }), { path: 'r.ipynb' });
    expect(await screen.findByRole('list', { name: 'Cells' })).toBeTruthy();
    expect(filesText).toHaveBeenCalledTimes(2);
    a.unmount();
    clearFilesCache();
    viewer(fakeApi({ filesStat: vi.fn(async () => stat({ kind: 'notebook' })), filesText: vi.fn(async () => text('{not json')) }), { path: 'bad.ipynb' });
    expect(await screen.findByText('This notebook could not be read as a notebook, so its source shows.')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'bad.ipynb, 1 lines' })).toBeTruthy();
  });
});

describe("Claude's edits", () => {
  const c: FileChange = change({ rootId: 'r.work', rel: 'src/a.ts' });

  it('lists each op, newest first, with no content', async () => {
    const sessionChange = vi.fn(async () => ({
      change: c,
      ops: [
        { opId: 'o1', tool: 'Write' as const, at: '2026-01-15T10:01:00.000Z', status: 'ok' as const, added: 10, removed: 0, approx: false, byAgent: false, large: false },
        { opId: 'o2', tool: 'Edit' as const, at: '2026-01-15T10:02:00.000Z', status: 'rejected' as const, added: 6, removed: 2, approx: true, byAgent: true, large: false },
      ],
    }));
    const api = fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('x\n')), sessionChange });
    const { onLocation } = viewer(api, { change: c });
    fireEvent.click(await screen.findByRole('button', { name: "Claude's edits 3" }));
    expect(onLocation).toHaveBeenCalledWith({ root: 'r.work', path: 'src/a.ts', tab: 'edits' }, { replace: true });
  });

  it('the edits tab shows the ops', async () => {
    const sessionChange = vi.fn(async () => ({
      change: c,
      ops: [
        { opId: 'o1', tool: 'Write' as const, at: '2026-01-15T10:01:00.000Z', status: 'ok' as const, added: 10, removed: 0, approx: false, byAgent: false, large: false },
        { opId: 'o2', tool: 'Edit' as const, at: '2026-01-15T10:02:00.000Z', status: 'rejected' as const, added: 6, removed: 2, approx: true, byAgent: true, large: false },
      ],
    }));
    viewer(fakeApi({ filesStat: vi.fn(async () => stat()), sessionChange }), { change: c, tab: 'edits' });
    const list = await screen.findByRole('list', { name: "Claude's edits" });
    const rows = within(list).getAllByRole('listitem').map((r) => r.textContent);
    expect(rows[0]).toMatch(/^Edit · \d\d:\d\d · ~\+6 \u22122 · rejectedagent$/);
    expect(rows[1]).toMatch(/^Write · \d\d:\d\d · \+10 \u22120 · ok$/);
    expect(sessionChange).toHaveBeenCalledWith('a', 'c1');
    expect(screen.getByText(/not their content/)).toBeTruthy();
  });

  it('the edits tab shows loading and failure', async () => {
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => stat()), sessionChange: vi.fn(pendingForever) }), { change: c, tab: 'edits' });
    expect(await screen.findByText("Reading Claude's edits…")).toBeTruthy();
    a.unmount();
    clearFilesCache();
    viewer(fakeApi({ filesStat: vi.fn(async () => stat()), sessionChange: vi.fn(async () => Promise.reject(new ApiError('not_found', 'That session is gone.', 404))) }), {
      change: c,
      tab: 'edits',
    });
    expect(await screen.findByText('That session is gone.')).toBeTruthy();
  });

  it('without a change there is no edits tab, even when the URL asks for it', async () => {
    viewer(fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('x\n')) }), { tab: 'edits' });
    expect(await screen.findByRole('button', { name: 'Line 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Claude's edits/ })).toBeNull();
  });
});

describe('a file read before', () => {
  const gone = () => Promise.reject(new ApiError('not_found', '', 404));

  it('gives way to "no longer there" once the Mac says it is gone', async () => {
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('old plan\n')) }));
    expect(await screen.findByText('old plan')).toBeTruthy();
    a.unmount();
    // Deleted or moved on the Mac (Claude's Bash does both), then opened again.
    viewer(fakeApi({ filesStat: vi.fn(gone), filesText: vi.fn(gone) }));
    expect(await screen.findByText('That file is no longer there.')).toBeTruthy();
    expect(screen.queryByText('old plan')).toBeNull();
  });

  it('gives way to the refusal when the file is protected now, or its session root has ended', async () => {
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('old plan\n')) }));
    expect(await screen.findByText('old plan')).toBeTruthy();
    a.unmount();
    const refused = () => Promise.reject(new ApiError('forbidden', 'This file is protected. Keys and secrets never leave the Mac.', 403));
    viewer(fakeApi({ filesStat: vi.fn(refused), filesText: vi.fn(refused) }));
    expect(await screen.findByText('This file is protected. Keys and secrets never leave the Mac.')).toBeTruthy();
    expect(screen.queryByText('old plan')).toBeNull();
  });

  it('gives way when the text alone is gone (the stat still answers)', async () => {
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('old plan\n')) }));
    expect(await screen.findByText('old plan')).toBeTruthy();
    a.unmount();
    viewer(fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(gone) }));
    expect(await screen.findByText('That file is no longer there.')).toBeTruthy();
    expect(screen.queryByText('old plan')).toBeNull();
  });

  it('stays on screen when the Mac cannot be reached', async () => {
    const a = viewer(fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('kept\n')) }));
    expect(await screen.findByText('kept')).toBeTruthy();
    a.unmount();
    const down = vi.fn(async () => Promise.reject(new ApiError('network', 'down', 0)));
    viewer(fakeApi({ filesStat: down, filesText: down }));
    await waitFor(() => expect(down).toHaveBeenCalledTimes(2));
    await act(async () => new Promise<void>((r) => setTimeout(r, 0)));
    expect(screen.getByText('kept')).toBeTruthy();
  });
});

describe('offline', () => {
  it('a file already read stays on screen while offline', async () => {
    const api = fakeApi({ filesStat: vi.fn(async () => stat()), filesText: vi.fn(async () => text('kept\n')) });
    const { store } = viewer(api);
    expect(await screen.findByText('kept')).toBeTruthy();
    act(() => store.getState().setConn({ status: 'offline' }));
    expect(screen.getByText('kept')).toBeTruthy();
  });
});
