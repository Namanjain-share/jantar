/**
 * Fixtures and render helpers shared by the Files tests (files*.test.tsx):
 * synthetic changes, roots, stats, text windows and listings, a desktop
 * viewport, a jsdom "layout" for TanStack Virtual, and a renderer for one
 * component inside the app's providers. Every path here is made up.
 */
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { FileChange, FileEntry, FileListing, FileRoot, FileStat, FileText, Features, State } from '@jantar/protocol';
import type { Api } from '../src/lib/api.js';
import { createRouter, memoryHistory, type FilesLocation } from '../src/lib/router.js';
import { createAppStore } from '../src/store.js';
import { AppProvider, createToastStore } from '../src/ui/context.js';
import { Viewer, type ViewerProps } from '../src/ui/screens/files/Viewer.js';
import { NOW, fakeApi, iso, stateWith } from './helpers.js';

export function change(over: Partial<FileChange> = {}): FileChange {
  return {
    changeId: 'c1',
    sid: 'a',
    path: '/synthetic/home/work/a/src/auth/session.ts',
    rootId: 's.a',
    rel: 'src/auth/session.ts',
    viewable: 'yes',
    firstAt: iso(0),
    lastAt: iso(120_000),
    ops: 3,
    tools: ['Edit'],
    created: false,
    added: 42,
    removed: 7,
    last: { status: 'ok', tool: 'Edit', at: iso(120_000) },
    ...over,
  };
}

export function root(id: string, over: Partial<FileRoot> = {}): FileRoot {
  return { id, kind: 'configured', label: id.slice(2), display: `~/${id.slice(2)}`, home: false, ...over };
}

export function stat(over: Partial<FileStat> = {}): FileStat {
  return { type: 'file', size: 4200, mtime: iso(0), kind: 'text', language: 'typescript', ...over };
}

export function text(body: string, over: Partial<FileText> = {}): FileText {
  return { text: body, offset: 0, next: null, size: body.length, bom: false, eol: 'lf', mtime: iso(0), warnings: [], ...over };
}

export function listing(entries: FileEntry[], over: Partial<FileListing> = {}): FileListing {
  return { root: 'r.work', path: '', entries, next: null, hiddenProtected: 0, truncated: false, ...over };
}

export const FILES_ON: Partial<Features> = { files: true };

/** Pretend the window is `width` px wide (jsdom has no matchMedia). */
export function viewport(width: number) {
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

/** Give jsdom a layout: scrollers 600 px tall, rows 20 px (TanStack Virtual reads offsetHeight). */
export function layout() {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-scroller') ? 600 : 20;
  });
}

/** A promise that never settles: the loading state. */
export const pendingForever = () => new Promise<never>(() => undefined);

/** Render one component inside the app's providers (no shell). */
export function renderWith(ui: ReactElement, opts: { state?: State; api?: Api; status?: 'live' | 'offline' } = {}) {
  const store = createAppStore(opts.state ?? stateWith({ features: FILES_ON }));
  store.getState().setConn({ status: opts.status ?? 'live', lastOkAt: NOW });
  const router = createRouter(memoryHistory('/'));
  const api = opts.api ?? fakeApi();
  const toasts = createToastStore();
  const utils = render(<AppProvider deps={{ store, api, router, toasts, now: () => NOW }}>{ui}</AppProvider>);
  return { ...utils, store, router, api, toasts };
}

/** The viewer on its own, for a file under r.work (src/a.ts unless `props` says otherwise). */
export function renderViewer(api: Api, props: Partial<ViewerProps> = {}) {
  const onLocation = vi.fn((_next: FilesLocation, _opts?: { replace?: boolean }) => undefined);
  const utils = renderWith(<Viewer root="r.work" path="src/a.ts" tab="file" phone onLocation={onLocation} {...props} />, { api, state: stateWith({ features: { files: true } }) });
  return { ...utils, onLocation };
}

/** Object URLs in jsdom: count what is made and revoked. */
export function objectUrls() {
  let n = 0;
  const made: string[] = [];
  const create = vi.fn((_b: Blob) => {
    const u = `blob:http://127.0.0.1:7420/${++n}`;
    made.push(u);
    return u;
  });
  const revoke = vi.fn((_u: string) => undefined);
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
  return { create, revoke, made };
}
