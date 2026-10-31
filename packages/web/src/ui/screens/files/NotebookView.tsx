/**
 * A Jupyter notebook (v0.3 spec 5.2.3, P1): code cells highlighted, markdown
 * cells through the document renderer, stream and text outputs as text, PNG
 * and JPEG outputs decoded to a Blob and shown through an object URL
 * (revoked on unmount), and a label for HTML, script and widget outputs,
 * which never run. A notebook is one JSON value, so the whole file is read
 * (up to NOTEBOOK_MAX) before it is parsed; past that, the source shows.
 */
import { Fragment, useMemo } from 'react';
import { useHighlight } from '../../../lib/highlight/client.js';
import { languageFor } from '../../../lib/highlight/languages.js';
import { plainLines } from '../../../lib/highlight/tokens.js';
import { base64Blob, useObjectUrl } from './blob.js';
import { CodeView, LineText, Warnings } from './CodeView.js';
import { useOffline } from './data.js';
import { MarkdownDoc } from './MarkdownDoc.js';
import { sizeText, type LineRange } from './model.js';
import { parseNotebook, type NotebookCell, type NotebookOutput } from './notebook.js';
import { LoadError, Loading, StateLine } from './states.js';
import type { FileTextState } from './text.js';

/** Read notebooks up to this size; bigger ones show as source. */
export const NOTEBOOK_MAX = 8 * 1024 * 1024;
/** One decoded output image at most. */
const IMAGE_MAX = 10 * 1024 * 1024;

function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const plain = useMemo(() => plainLines(code), [code]);
  const lit = useHighlight(code, lang);
  const lines = lit && lit.length === plain.length ? lit : plain;
  return (
    <pre className="no-scrollbar overflow-x-auto rounded-btn border border-line bg-surface px-12 py-8 type-code text-ink">
      <code>
        {lines.map((l, i) => (
          <Fragment key={i}>
            {i > 0 ? '\n' : null}
            <LineText line={l} />
          </Fragment>
        ))}
      </code>
    </pre>
  );
}

function OutputImage({ mime, base64 }: { mime: 'image/png' | 'image/jpeg'; base64: string }) {
  const blob = useMemo(() => base64Blob(base64, mime, IMAGE_MAX), [base64, mime]);
  const url = useObjectUrl(blob);
  if (!blob) return <p className="type-mono text-ink-3">Image output not shown</p>;
  return url ? <img src={url} alt="Cell output" className="h-auto max-w-full" /> : null;
}

function Output({ out }: { out: NotebookOutput }) {
  if (out.kind === 'image') return <OutputImage mime={out.mime} base64={out.base64} />;
  if (out.kind === 'hidden') return <p className="type-mono text-ink-3">{out.label}</p>;
  return <pre className="overflow-x-auto whitespace-pre-wrap break-words type-code text-ink-2">{out.text}</pre>;
}

function Cell({ cell, lang, root, path, onOpen }: { cell: NotebookCell; lang: string | null; root: string; path: string; onOpen: (p: string) => void }) {
  if (cell.kind === 'markdown') return <MarkdownDoc text={cell.source} root={root} path={path} onOpen={onOpen} />;
  if (cell.kind === 'raw') return <pre className="overflow-x-auto whitespace-pre-wrap type-code text-ink-2">{cell.source}</pre>;
  return (
    <div className="flex flex-col gap-8">
      <p className="type-mono text-ink-3">In [{cell.count ?? ' '}]</p>
      <CodeBlock code={cell.source} lang={lang} />
      {cell.outputs.map((o, i) => (
        <Output key={i} out={o} />
      ))}
    </div>
  );
}

export function NotebookView({
  t,
  root,
  path,
  name,
  onOpen,
  sel,
  onLine,
}: {
  /** Loaded with { all: true, maxBytes: NOTEBOOK_MAX }. */
  t: FileTextState;
  root: string;
  path: string;
  name: string;
  onOpen: (p: string) => void;
  sel: LineRange | null;
  onLine: (n: number) => void;
}) {
  const offline = useOffline();
  const whole = t.first !== null && t.next === null;
  const nb = useMemo(() => (whole ? parseNotebook(t.text) : null), [whole, t.text]);
  const lang = nb ? languageFor(name, nb.language) : null;

  if (!t.first) {
    if (t.error) return <LoadError error={t.error} offline={offline} onRetry={t.reload} />;
    return <Loading caption="Reading the notebook…" />;
  }
  if (t.moreError) return <LoadError error={t.moreError} offline={offline} onRetry={t.loadMore} />;
  if (!whole && t.loaded < NOTEBOOK_MAX) return <Loading caption={`Reading the notebook · ${sizeText(t.loaded)} of ${sizeText(t.first.size)}`} />;
  if (!nb) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <StateLine>
          {whole ? 'This notebook could not be read as a notebook, so its source shows.' : `This notebook is over ${sizeText(NOTEBOOK_MAX)}, so its source shows.`}
        </StateLine>
        <CodeView t={t} name={name} lang="json" sel={sel} onLine={onLine} />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Warnings warnings={t.warnings} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-16 py-16 md:px-24">
        {nb.cells.length ? (
          <ol aria-label="Cells" className="flex flex-col gap-24">
            {nb.cells.map((c, i) => (
              <li key={i}>
                <Cell cell={c} lang={lang} root={root} path={path} onOpen={onOpen} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="type-small text-ink-2">This notebook has no cells.</p>
        )}
      </div>
    </div>
  );
}
