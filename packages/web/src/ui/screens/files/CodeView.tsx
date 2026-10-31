/**
 * A text file as code (v0.3 spec 5.2.3, File tab): numbered lines in
 * type-code, virtualised, highlighted off the main thread within the limits
 * (lib/highlight), plain otherwise. Minified files are wrapped and plain.
 * Tapping a line number selects it and copies "rel:12"; a second number
 * extends it to a range ("rel:12-20"), which "Ask about this" uses.
 *
 * File text reaches the DOM only as text nodes inside spans (spec 6, W3):
 * no HTML is built from it anywhere. Hidden characters show as ⟨U+202E⟩.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { memo, useMemo, useRef, type ReactNode } from 'react';
import { FILES_TEXT_WINDOW, type FileTextWarning } from '@jantar/protocol';
import { useHighlight } from '../../../lib/highlight/client.js';
import { languageFor, type LanguageId } from '../../../lib/highlight/languages.js';
import { hiddenName, plainLines, splitHidden } from '../../../lib/highlight/tokens.js';
import type { Line } from '../../../lib/highlight/types.js';
import { Button } from '../../kit/Button.js';
import { sizeText, type LineRange } from './model.js';
import { Banner, LoadError, Loading, StateLine, fileErrorText } from './states.js';
import type { FileTextState } from './text.js';
import { useOffline } from './data.js';
import { observeRect } from './VirtualList.js';

/** One run of file text: text nodes, with hidden characters boxed. */
export function TextRun({ text, cls }: { text: string; cls?: string }): ReactNode {
  const parts = splitHidden(text);
  if (parts.length === 1 && !parts[0]![1]) return cls ? <span className={cls}>{text}</span> : text;
  return (
    <span className={cls || undefined}>
      {parts.map(([t, hidden], i) =>
        hidden ? (
          <span key={i} className="tk-hidden" title="Hidden character">
            {hiddenName(t)}
          </span>
        ) : (
          t
        ),
      )}
    </span>
  );
}

/** A line's segments as spans. */
export function LineText({ line }: { line: Line }) {
  return (
    <>
      {line.map(([t, cls], i) => (
        <TextRun key={i} text={t} cls={cls} />
      ))}
    </>
  );
}

const WARNING_TEXT: Readonly<Record<FileTextWarning, string>> = {
  bidi: 'This file holds hidden direction characters. Each one shows as a boxed ⟨U+…⟩.',
  'secret-like': 'This file holds keys or tokens. They show as * here and never leave the Mac.',
  minified: 'This file looks minified, so it shows wrapped and without highlighting.',
  'truncated-line': 'A very long line was cut short.',
};

/** One-line banners for the daemon's warnings, in a fixed order. */
export function Warnings({ warnings }: { warnings: ReadonlySet<FileTextWarning> }) {
  const order: FileTextWarning[] = ['bidi', 'secret-like', 'truncated-line', 'minified'];
  return (
    <>
      {order
        .filter((w) => warnings.has(w))
        .map((w) => (
          <Banner key={w}>{WARNING_TEXT[w]}</Banner>
        ))}
    </>
  );
}

/** "Load the next 512 KB" and how much is here, under a partly loaded file. */
export function MoreText({ t }: { t: FileTextState }) {
  if (t.next === null || !t.first) return null;
  return (
    <div className="px-16 py-12">
      <p className="type-mono text-ink-3">
        {sizeText(t.loaded)} of {sizeText(t.first.size)} shown
      </p>
      <Button size="sm" className="mt-8" onClick={t.loadMore} disabled={t.loadingMore}>
        Load the next {sizeText(FILES_TEXT_WINDOW)}
      </Button>
      {t.moreError ? (
        <p role="alert" className="mt-8 type-small text-ink-2">
          {fileErrorText(t.moreError)}
        </p>
      ) : null}
    </div>
  );
}

const Row = memo(function Row({
  n,
  line,
  digits,
  wrap,
  selected,
  onLine,
}: {
  n: number;
  line: Line;
  digits: number;
  wrap: boolean;
  selected: boolean;
  onLine: (n: number) => void;
}) {
  return (
    <div className={clsx('flex', wrap ? 'w-full' : 'w-max min-w-full', selected && 'bg-select')}>
      <button
        type="button"
        aria-label={`Line ${n}`}
        aria-pressed={selected}
        onClick={() => onLine(n)}
        className={clsx(
          // At least 44 px wide under a finger; a line's height stays the code's own.
          'sticky left-0 flex-none select-none pl-8 pr-12 text-right type-code text-ink-3 transition-colors duration-120 hover:text-ink coarse:min-w-44',
          selected ? 'bg-select text-ink' : 'bg-bg',
        )}
        // Width in ch of the widest number, so the code column never jumps (CSSOM style, CSP-safe).
        style={{ width: `calc(${digits}ch + 20px)` }}
      >
        {n}
      </button>
      <code className={clsx('min-w-0 pr-16 type-code text-ink', wrap ? 'flex-1 whitespace-pre-wrap break-all' : 'whitespace-pre')}>
        <LineText line={line} />
      </code>
    </div>
  );
});

export interface CodeViewProps {
  /** The file's text, loaded by the viewer (useFileText). */
  t: FileTextState;
  /** File name and the daemon's language hint pick the grammar. */
  name: string;
  hint?: string;
  /** Force a grammar (an SVG's source is markup); null for plain. */
  lang?: LanguageId | null;
  sel: LineRange | null;
  onLine: (n: number) => void;
}

export function CodeView({ t, name, hint, lang: forced, sel, onLine }: CodeViewProps) {
  const offline = useOffline();
  const scroller = useRef<HTMLDivElement>(null);
  const wrap = t.warnings.has('minified');
  const lang = wrap ? null : forced !== undefined ? forced : languageFor(name, hint ?? t.first?.language);
  // A final newline ends the last line; it does not start another.
  const body = t.text.endsWith('\n') ? t.text.slice(0, -1) : t.text;
  const plain = useMemo(() => plainLines(body), [body]);
  const lit = useHighlight(body, lang);
  const lines = lit && lit.length === plain.length ? lit : plain;
  const digits = String(lines.length).length;

  const v = useVirtualizer({
    count: t.first && body ? lines.length : 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 20,
    overscan: 20,
    useFlushSync: false,
    observeElementRect: observeRect,
  });

  if (!t.first) {
    if (t.error) return <LoadError error={t.error} offline={offline} onRetry={t.reload} />;
    return <Loading caption="Reading the file…" />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Warnings warnings={t.warnings} />
      <div ref={scroller} data-scroller="" className="min-h-0 flex-1 overflow-auto overscroll-contain bg-bg py-8">
        {body ? (
          <div role="list" aria-label={`${name}, ${lines.length} lines`} className="relative" style={{ height: v.getTotalSize() }}>
            {v.getVirtualItems().map((row) => (
              <div
                key={row.key}
                role="listitem"
                data-index={row.index}
                ref={v.measureElement}
                className={clsx('absolute left-0 top-0', wrap ? 'w-full' : 'w-max min-w-full')}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <Row
                  n={row.index + 1}
                  line={lines[row.index] ?? []}
                  digits={digits}
                  wrap={wrap}
                  selected={sel !== null && row.index + 1 >= sel.from && row.index + 1 <= sel.to}
                  onLine={onLine}
                />
              </div>
            ))}
          </div>
        ) : (
          <StateLine>This file is empty.</StateLine>
        )}
        <MoreText t={t} />
      </div>
    </div>
  );
}
