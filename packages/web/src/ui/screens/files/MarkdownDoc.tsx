/**
 * A Markdown file as a document (v0.3 spec 5.2.3): lib/markdown.tsx in doc
 * mode, so headings keep their levels, relative links open in the viewer,
 * relative images load from the Mac (GET /v1/files/raw, same origin) when
 * they name an image the daemon serves outside any dot folder, and only
 * after one "Show images" tap per document, and remote images show as their
 * URL. Until that tap, and for every other image, the alt text shows: the
 * document never makes the phone ask for a path on its own (a cloned
 * README naming `id_rsa-arch.png` five times would otherwise raise the
 * Mac's probe alarm on every device, and 300 images would spend the files
 * budget). Raw HTML stays text: the renderer never parses it. "Source"
 * shows the same text in the code view.
 *
 * Like session/Prose.tsx, this walks the rendered tree once and gives each
 * element its token classes; the renderer itself stays style-free.
 */
import clsx from 'clsx';
import { Children, cloneElement, isValidElement, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { renderMarkdown } from '../../../lib/markdown.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { fetchableImage, resolveRel } from './model.js';

interface Props {
  className?: string;
  children?: ReactNode;
}

const BLOCK: Record<string, string> = {
  h1: 'type-title text-ink',
  h2: 'type-title text-ink',
  h3: 'type-row font-medium text-ink',
  h4: 'type-row font-medium text-ink',
  h5: 'type-row font-medium text-ink-2',
  h6: 'type-row font-medium text-ink-2',
  p: '',
  ul: 'list-disc pl-20 marker:text-ink-3',
  ol: 'list-decimal pl-24 marker:text-ink-3 marker:font-mono',
  li: 'pl-2 not-first:mt-4',
  blockquote: 'pl-16 text-ink-2',
  hr: 'border-line',
  strong: 'font-medium text-ink',
  em: 'italic',
  a: 'text-ink underline decoration-line-strong underline-offset-3 transition-colors duration-120 hover:decoration-ink',
  table: 'w-full border-collapse type-small',
  th: 'border-b border-line py-6 pr-12 text-left align-bottom font-medium text-ink',
  td: 'border-b border-line py-6 pr-12 align-top',
  img: 'max-w-full h-auto rounded-btn',
};

function classFor(tag: string, existing: string | undefined, inPre: boolean): string {
  const has = (c: string) => (existing ?? '').split(' ').includes(c);
  if (tag === 'pre') return 'no-scrollbar overflow-x-auto whitespace-pre rounded-btn bg-term px-14 py-10 type-code text-term-ink';
  if (tag === 'code') return inPre ? '' : 'rounded-chip bg-select px-4 font-mono text-mono text-ink';
  if (tag === 'div' && has('md-table')) return 'no-scrollbar overflow-x-auto';
  if (tag === 'span' && (has('md-path') || has('md-image'))) return 'font-mono text-mono text-ink-2 wrap-anywhere';
  if (tag === 'button' && has('md-link')) return 'text-left text-ink underline decoration-line-strong underline-offset-3 transition-colors duration-120 hover:decoration-ink';
  return BLOCK[tag] ?? '';
}

function walk(node: ReactNode, inPre = false): ReactNode {
  if (Array.isArray(node)) return node.map((n) => walk(n, inPre));
  if (!isValidElement<Props>(node) || typeof node.type !== 'string') return node;
  const el = node as ReactElement<Props>;
  const tag = node.type;
  const children = Children.toArray(el.props.children).map((c) => walk(c, inPre || tag === 'pre'));
  const cls = classFor(tag, el.props.className, inPre);
  return cloneElement(el, { className: cls || undefined }, ...children);
}

export interface MarkdownDocProps {
  /** The document's text. */
  text: string;
  root: string;
  /** The document's own path (relative links and images resolve from its folder). */
  path: string;
  /** Open another path under the same root in the viewer. */
  onOpen: (path: string) => void;
  className?: string;
}

/** Rendered Markdown, document style. */
export function MarkdownDoc({ text, root, path, onOpen, className }: MarkdownDocProps) {
  const { api } = useDeps();
  const [showImages, setShowImages] = useState(false);
  const { nodes, images } = useMemo(() => {
    let images = 0;
    const nodes = walk(
      renderMarkdown(text, {
          doc: true,
          localLink: (target, label, key) => {
            const to = resolveRel(path, target);
            if (!to) return null;
            return (
              <button key={key} type="button" className="md-link" title={to} onClick={() => onOpen(to)}>
                {label}
              </button>
            );
          },
          localImage: (target, alt, key) => {
            const to = resolveRel(path, target);
            // `![](.env)`, `![](.ssh/id_rsa)`, `![](x.pem)`: shown as text, never asked for.
            if (!to || !fetchableImage(to)) return null;
            images += 1;
            if (!showImages) {
              return (
                <span key={key} className="md-image" title={to}>
                  {`Image: ${alt || to}`}
                </span>
              );
            }
            // Same origin with the device cookie; the daemon serves raster images only.
            return <img key={key} src={api.filesRawUrl({ root, path: to })} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
          },
        }),
      );
    return { nodes, images };
  }, [text, root, path, onOpen, api, showImages]);
  return (
    <div className={clsx('flex min-w-0 flex-col gap-12 wrap-break-word type-body text-ink', className)}>
      {images > 0 && !showImages ? (
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4 border-b border-line pb-8">
          <span className="type-small text-ink-2">{images === 1 ? 'This document shows an image from the Mac.' : `This document shows ${images} images from the Mac.`}</span>
          <Button variant="text" size="sm" onClick={() => setShowImages(true)}>
            Show images
          </Button>
        </div>
      ) : null}
      {nodes}
    </div>
  );
}
