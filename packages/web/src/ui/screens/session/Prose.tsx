/**
 * Claude's text as styled Markdown, with no bubble (direction.md 5.2).
 *
 * lib/markdown.tsx turns untrusted text into plain React elements (p, ul,
 * code, ...) and never parses HTML. This walks that tree once and gives each
 * element its token classes, so the renderer stays untouched and nothing
 * needs a stylesheet. Task-list box markers become glyph squares (outline
 * or filled), and the plan variant draws numbered steps as ruled rows.
 */
import clsx from 'clsx';
import { Children, cloneElement, isValidElement, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { renderMarkdown } from '../../../lib/markdown.js';
import { StatusGlyph } from '../../kit/StatusGlyph.js';

type Variant = 'body' | 'plan';

interface Props {
  className?: string;
  children?: ReactNode;
  start?: number;
}

const BLOCK: Record<string, string> = {
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
};

function classFor(tag: string, existing: string | undefined, inPre: boolean, variant: Variant): string {
  const has = (c: string) => (existing ?? '').split(' ').includes(c);
  if (tag === 'pre') return 'no-scrollbar overflow-x-auto whitespace-pre rounded-btn bg-term px-14 py-10 type-code text-term-ink';
  if (tag === 'code') return inPre ? '' : 'rounded-chip bg-select px-4 font-mono text-mono text-ink';
  if (/^h[3-6]$/.test(tag)) return 'type-row font-medium text-ink';
  if (tag === 'div' && has('md-table')) return 'no-scrollbar overflow-x-auto';
  if (tag === 'span' && has('md-path')) return 'font-mono text-mono text-ink-2';
  if (variant === 'plan' && tag === 'ol') return 'border-t border-line';
  if (variant === 'plan' && tag === 'li') return 'relative border-b border-line py-6 pl-28';
  return BLOCK[tag] ?? '';
}

function walk(node: ReactNode, variant: Variant, inPre = false): ReactNode {
  if (Array.isArray(node)) return node.map((n) => walk(n, variant, inPre));
  if (!isValidElement<Props>(node) || typeof node.type !== 'string') return node;
  const el = node as ReactElement<Props>;
  const tag = node.type;
  const existing = el.props.className;

  // Task list: the empty box markers become glyph squares (outline / filled).
  if (tag === 'li' && existing === 'md-task') {
    const kids = Children.toArray(el.props.children).map((c) => {
      if (isValidElement<Props & { 'aria-label'?: string }>(c) && c.props.className === 'md-box') {
        const done = c.props['aria-label'] === 'done';
        return <StatusGlyph key="box" state={done ? 'working' : 'turn'} label={done ? 'done' : 'not done'} className="-ml-4 self-center" />;
      }
      return walk(c, variant, inPre);
    });
    return cloneElement(el, { className: 'flex list-none items-baseline gap-4 not-first:mt-4' }, ...kids);
  }

  // Plan steps: ruled rows with a mono number, like the terminal's own plan.
  if (variant === 'plan' && tag === 'ol') {
    const start = typeof el.props.start === 'number' ? el.props.start : 1;
    const items = Children.toArray(el.props.children).map((c, i) => {
      if (!isValidElement<Props>(c) || c.type !== 'li') return walk(c, variant);
      const kids = Children.toArray(c.props.children).map((k) => walk(k, variant));
      return cloneElement(
        c,
        { className: classFor('li', c.props.className, false, variant) },
        <span key="n" className="absolute left-0 top-10 type-mono text-ink-3" aria-hidden="true">
          {start + i}
        </span>,
        ...kids,
      );
    });
    return cloneElement(el, { className: classFor('ol', existing, false, variant) }, ...items);
  }

  const children = Children.toArray(el.props.children).map((c) => walk(c, variant, inPre || tag === 'pre'));
  const cls = classFor(tag, existing, inPre, variant);
  return cloneElement(el, { className: cls || undefined }, ...children);
}

/** Styled Markdown. `foldAt`: long text shows its start and a "Show the rest" button. */
export function Prose({
  text,
  variant = 'body',
  foldAt = 4000,
  dim = false,
  className,
}: {
  text: string;
  variant?: Variant;
  foldAt?: number;
  dim?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const MAX = 60_000;
  const long = text.length > foldAt;
  const shown = long && !open ? text.slice(0, foldAt) : text.slice(0, MAX);
  const nodes = useMemo(() => {
    const out = walk(renderMarkdown(shown), variant);
    // A plan's opening line is its headline ("3 to add, 1 to change").
    const first = Array.isArray(out) ? out[0] : null;
    if (variant === 'plan' && Array.isArray(out) && isValidElement<Props>(first) && typeof first.type === 'string' && /^(p|h[3-6])$/.test(first.type)) {
      out[0] = cloneElement(first, { className: 'type-title text-ink' });
    }
    return out;
  }, [shown, variant]);
  return (
    <div
      className={clsx(
        'flex min-w-0 flex-col gap-12 wrap-break-word',
        'type-body',
        dim ? 'text-ink-2' : 'text-ink',
        className,
      )}
    >
      {nodes}
      {long ? (
        <button
          type="button"
          className="self-start rounded-chip type-small text-ink-2 underline decoration-line-strong underline-offset-3 hover:text-ink coarse:min-h-44"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : `Show the rest (${Math.round(text.length / 100) / 10}k characters)`}
        </button>
      ) : null}
      {open && text.length > MAX ? <p className="type-small text-ink-3">Cut at {MAX.toLocaleString()} characters.</p> : null}
    </div>
  );
}
