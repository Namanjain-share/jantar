/**
 * The read-only file viewer (v0.3 spec 5.2.3, no diffs: U9). A pushed
 * screen on the phone (a long file needs native scroll, which fights a
 * sheet's swipe), the detail pane on a desktop.
 *
 *   header 52   ‹ (phone)  name                                  ···
 *   meta        src/auth/session.ts · 4.1 KB · TypeScript         mono --ink-3
 *   tabs        File | Claude's edits 3      only when a session changed it
 *   banners     hidden characters, secret-like, cut lines, minified
 *   body        by kind: code, Markdown, image, SVG, PDF, notebook, binary
 *
 * ··· holds Copy path, Copy path:line (with lines selected) and, in a
 * session's folder, Ask about this, which puts "@src/x.ts:12-20 " in that
 * session's composer and never sends.
 *
 * When Claude writes the open file again (the list's change for it moves
 * on), the stat and the text are read again, so the File tab stays current.
 */
import { Menu } from '@base-ui/react/menu';
import { CaretLeftIcon, DotsThreeIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileChange, FileStat } from '@jantar/protocol';
import { clock } from '../../../lib/format.js';
import { languageFor, languageLabel, extOf } from '../../../lib/highlight/languages.js';
import { showHidden } from '../../../lib/highlight/tokens.js';
import type { FilesLocation } from '../../../lib/router.js';
import { useDeps, useNow, useToast } from '../../context.js';
import { IconButton } from '../../kit/IconButton.js';
import { Segmented } from '../accounts/Segmented.js';
import { CodeView, MoreText, TextRun, Warnings } from './CodeView.js';
import { EditsList } from './EditsList.js';
import { useLoad, useOffline } from './data.js';
import { ImageView } from './ImageView.js';
import { MarkdownDoc } from './MarkdownDoc.js';
import { baseName, dirLocation, mention, nextSelection, pathLine, sizeText, type LineRange } from './model.js';
import { NOTEBOOK_MAX, NotebookView } from './NotebookView.js';
import { PdfView } from './PdfView.js';
import { LoadError, Loading, StateLine } from './states.js';
import { SvgView } from './SvgView.js';
import { useFileText } from './text.js';

const ITEM =
  'flex h-32 cursor-pointer select-none items-center px-12 type-small text-ink outline-none transition-colors duration-120 ease-hover ' +
  'data-highlighted:bg-select coarse:h-44';

const TEXT_KINDS = new Set<FileStat['kind']>(['text', 'markdown', 'svg', 'notebook']);

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface ViewerProps {
  root: string;
  /** The file, relative to the root (no trailing slash). */
  path: string;
  tab: 'file' | 'edits';
  phone: boolean;
  /** The newest change a session made to this file: adds the "Claude's edits" tab. */
  change?: FileChange;
  /** Phone: the ‹ back to the list. */
  onBack?: () => void;
  onLocation: (next: FilesLocation, opts?: { replace?: boolean }) => void;
  /** Only in a session's own folder: hand "@path:lines " to that session's composer. */
  onAsk?: (text: string) => void;
}

export function Viewer({ root, path, tab: asked, phone, change, onBack, onLocation, onAsk }: ViewerProps) {
  const { api } = useDeps();
  const toast = useToast();
  const now = useNow(60_000);
  const offline = useOffline();
  const name = baseName(path);
  const stat = useLoad(`stat:${root}\u0000${path}`, () => api.filesStat({ root, path }));
  const kind = stat.data?.type === 'file' ? stat.data.kind : null;
  const t = useFileText(root, path, { enabled: kind !== null && TEXT_KINDS.has(kind), all: kind === 'notebook', maxBytes: NOTEBOOK_MAX });
  const [sel, setSel] = useState<LineRange | null>(null);
  const [mdMode, setMdMode] = useState<'rendered' | 'source'>('rendered');
  const [svgMode, setSvgMode] = useState<'source' | 'preview'>('source');
  const tab = asked === 'edits' && change ? 'edits' : 'file';

  // The parent's callback changes on every render of the session screen; links and
  // the folder redirect go through the latest one without re-rendering the document.
  const onLocationRef = useRef(onLocation);
  useEffect(() => {
    onLocationRef.current = onLocation;
  });

  // Claude wrote this file again while it is open (its change moved on in the list): show it
  // as it is now. The list arriving for the first time is no write.
  const lastAt = change?.lastAt;
  const seenAt = useRef(lastAt);
  const { reload: reloadStat } = stat;
  const { reload: reloadText } = t;
  useEffect(() => {
    const before = seenAt.current;
    seenAt.current = lastAt;
    if (before === undefined || lastAt === undefined || before === lastAt) return;
    reloadStat();
    reloadText();
  }, [lastAt, reloadStat, reloadText]);

  // A folder reached by a link or an old URL: show it as a folder instead (once).
  const isDir = stat.data?.type === 'dir';
  const moved = useRef(false);
  useEffect(() => {
    if (!isDir || moved.current) return;
    moved.current = true;
    onLocationRef.current(dirLocation(root, path), { replace: true });
  }, [isDir, root, path]);

  // The clipboard gets the path as it is; the toast spells out any hidden character in it.
  const copyOut = (text: string) => void copy(text).then((ok) => toast(ok ? `Copied ${showHidden(text)}` : 'This browser did not allow copying.', ok ? 'ok' : 'error'));
  // A line number: select it (or extend, or clear) and copy "path:line". Under a finger a line is
  // one code line tall, so a tap only selects (a scroll can land on one): ··· has "Copy path:line".
  const onLine = (n: number) => {
    const next = nextSelection(sel, n);
    setSel(next);
    if (next && !coarsePointer()) copyOut(pathLine(path, next));
  };
  const openRel = useCallback((to: string) => onLocationRef.current(to.endsWith('/') ? dirLocation(root, to) : { root, path: to }), [root]);

  const s = stat.data;
  const lang = s && s.type === 'file' ? languageFor(name, s.language ?? t.first?.language) : null;
  const meta = s
    ? [
        path,
        sizeText(s.size),
        languageLabel(name, lang),
        t.first?.eol === 'crlf' ? 'CRLF' : t.first?.eol === 'mixed' ? 'mixed line ends' : null,
        change ? `edited ${clock(change.lastAt, now)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : path;

  let body;
  if (!s) {
    body = stat.error ? <LoadError error={stat.error} offline={offline} onRetry={stat.reload} /> : <Loading caption="Reading the file…" />;
  } else if (s.type === 'dir') {
    body = null;
  } else if (tab === 'edits' && change) {
    body = <EditsList change={change} />;
  } else if (s.kind === 'image') {
    body = <ImageView root={root} path={path} name={name} size={s.size} />;
  } else if (s.kind === 'pdf') {
    body = <PdfView root={root} path={path} size={s.size} />;
  } else if (s.kind === 'svg') {
    body = <SvgView t={t} name={name} mode={svgMode} onMode={setSvgMode} sel={sel} onLine={onLine} />;
  } else if (s.kind === 'notebook') {
    body = <NotebookView t={t} root={root} path={path} name={name} onOpen={openRel} sel={sel} onLine={onLine} />;
  } else if (s.kind === 'markdown') {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-none px-16 py-8">
          <Segmented
            label="Show the Markdown as"
            value={mdMode}
            onChange={setMdMode}
            segments={[
              { key: 'source', label: 'Source' },
              { key: 'rendered', label: 'Rendered' },
            ]}
          />
        </div>
        {mdMode === 'source' || !t.first ? (
          <CodeView t={t} name={name} hint="markdown" sel={sel} onLine={onLine} />
        ) : (
          <>
            <Warnings warnings={t.warnings} />
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <MarkdownDoc text={t.text} root={root} path={path} onOpen={openRel} className="px-16 py-16 md:px-24" />
              <MoreText t={t} />
            </div>
          </>
        )}
      </div>
    );
  } else if (s.kind === 'text') {
    body = <CodeView t={t} name={name} hint={s.language} sel={sel} onLine={onLine} />;
  } else {
    const ext = extOf(name);
    body = (
      <StateLine>
        Binary file · {sizeText(s.size)}
        {ext ? ` · ${ext}` : ''}. Jantar shows text, images and PDFs.
      </StateLine>
    );
  }

  const tabs = change ? (
    <div className="flex-none px-16 pb-8 md:px-24">
      <Segmented
        label="File views"
        value={tab}
        onChange={(next) => onLocation({ root, path, tab: next === 'edits' ? 'edits' : undefined }, { replace: true })}
        segments={[
          { key: 'file', label: 'File' },
          {
            key: 'edits',
            name: `Claude's edits ${change.ops}`,
            label: (
              <>
                Claude's edits<span className="type-mono text-ink-3">{change.ops}</span>
              </>
            ),
          },
        ]}
      />
    </div>
  ) : null;

  return (
    <section aria-label={showHidden(name)} className="flex min-h-0 flex-1 flex-col bg-bg">
      <header className={clsx('flex h-52 flex-none items-center gap-4', phone ? 'pl-4 pr-8' : 'px-24')}>
        {onBack ? (
          <IconButton aria-label="Back to the list" onClick={onBack} className={phone ? 'size-44' : '-ml-8'}>
            <CaretLeftIcon size={20} />
          </IconButton>
        ) : null}
        <h2 className={clsx('min-w-0 flex-1 truncate type-title text-ink', phone && !onBack && 'pl-12')}>
          <TextRun text={name} />
        </h2>
        <Menu.Root>
          <Menu.Trigger render={<IconButton aria-label="More for this file" className={phone ? 'size-44' : undefined} />}>
            <DotsThreeIcon size={20} weight="bold" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={12} className="z-30">
              <Menu.Popup className="min-w-176 rounded-btn bg-raised py-4 text-ink shadow-float outline-none animate-pop">
                <Menu.Item className={ITEM} onClick={() => copyOut(path)}>
                  Copy path
                </Menu.Item>
                {sel ? (
                  <Menu.Item className={ITEM} onClick={() => copyOut(pathLine(path, sel))}>
                    Copy path:line
                  </Menu.Item>
                ) : null}
                {onAsk ? (
                  <Menu.Item className={ITEM} onClick={() => onAsk(mention(path, sel))}>
                    Ask about this
                  </Menu.Item>
                ) : null}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </header>
      <p className={clsx('flex-none truncate pb-8 type-mono text-ink-3', phone ? 'px-16' : 'px-24')}>
        <TextRun text={meta} />
      </p>
      {tabs}
      <div className="flex min-h-0 flex-1 flex-col border-t border-line">{body}</div>
    </section>
  );
}

/** A touch screen's pointer (where a tap on a line number may be the end of a scroll). */
function coarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}
