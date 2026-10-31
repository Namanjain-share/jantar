// Portions adapted from Shed (c) Sukhad Anand, MIT. See THIRD_PARTY_NOTICES.md
//
// Escape-first Markdown for untrusted transcript text (Claude's replies quote
// arbitrary web pages, files and tool output). Nothing is ever parsed as HTML:
// the text becomes React elements, which React escapes, and only a small,
// known set of formatting is recognised. Only http(s) links become clickable,
// and they open in a new tab with no opener and no referrer.
//
// Changes from upstream: renders React nodes instead of an HTML string,
// merges consecutive quote lines, keeps an ordered list's start number,
// shows task-list boxes, and trims trailing punctuation from bare URLs.
//
// Doc mode (v0.3 Files viewer, `{ doc: true }`): real heading levels (# is
// h1), images, and relative links and images handed to the caller, which
// opens them in the viewer or fetches them from the Mac. Remote images are
// never loaded: they show as their URL. Raw HTML stays text in both modes.
import type { ReactNode } from 'react';

export interface MarkdownOptions {
  /** Files viewer: keep heading levels and render images (the transcript shifts headings down by two). */
  doc?: boolean;
  /** A relative link target ("../README.md", "docs/setup.md#run"): the element that opens it, or null to show it as text. */
  localLink?: (target: string, label: string, key: string) => ReactNode | null;
  /** A relative image target: the element that shows it, or null to show its alt text instead. */
  localImage?: (target: string, alt: string, key: string) => ReactNode | null;
}

const NONE: MarkdownOptions = {};

/** A target with no scheme and no host: a path next to the document. */
export function isLocalTarget(url: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//');
}

/** The URL if it is http(s), else null. */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function link(href: string, label: ReactNode, key: string): ReactNode {
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
      {label}
    </a>
  );
}

interface Hit {
  index: number;
  length: number;
  render: (key: string) => ReactNode[];
}

type Matcher = (s: string, o: MarkdownOptions) => Hit | null;

const matchers: Matcher[] = [
  // ![alt](url), doc mode only (the transcript shows the "!" and the link label)
  (s, o) => {
    if (!o.doc) return null;
    const m = /!\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(s);
    if (!m) return null;
    const [all, alt = '', url = ''] = m;
    return {
      index: m.index,
      length: all.length,
      render: (key) => {
        // Never fetched from elsewhere: the CSP would refuse it, and it would tell a server you read the file.
        if (safeHref(url)) {
          return [
            <span key={key} className="md-image" title={url}>
              {`Remote image: ${url}`}
            </span>,
          ];
        }
        const local = isLocalTarget(url) ? o.localImage?.(url, alt, key) : null;
        return [
          local ?? (
            <span key={key} className="md-path" title={url}>
              {alt || url}
            </span>
          ),
        ];
      },
    };
  },
  // [label](url)
  (s, o) => {
    const m = /\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(s);
    if (!m) return null;
    const [all, label = '', url = ''] = m;
    return {
      index: m.index,
      length: all.length,
      render: (key) => {
        const href = safeHref(url);
        if (href) return [link(href, label, key)];
        const local = o.localLink && isLocalTarget(url) ? o.localLink(url, label, key) : null;
        if (local) return [local];
        // Local paths and other schemes are shown, never linked.
        return [
          <span key={key} className="md-path" title={url}>
            {label}
          </span>,
        ];
      },
    };
  },
  // bare http(s) URL
  (s) => {
    const m = /(^|[\s(])(https?:\/\/[^\s<>)]+)/.exec(s);
    if (!m) return null;
    const [all, pre = '', rawUrl = ''] = m;
    const trail = /[.,;:!?'"]+$/.exec(rawUrl)?.[0] ?? '';
    const url = trail ? rawUrl.slice(0, -trail.length) : rawUrl;
    return {
      index: m.index,
      length: all.length,
      render: (key) => {
        const href = safeHref(url);
        const out: ReactNode[] = [];
        if (pre) out.push(pre);
        out.push(href ? link(href, url, key) : url);
        if (trail) out.push(trail);
        return out;
      },
    };
  },
  // **bold**
  (s, o) => {
    const m = /\*\*([^*\n]+)\*\*/.exec(s);
    if (!m) return null;
    return {
      index: m.index,
      length: m[0].length,
      render: (key) => [<strong key={key}>{rich(m[1] ?? '', key, o)}</strong>],
    };
  },
  // *em*
  (s, o) => {
    const m = /(^|[^\w*])\*([^*\n]+)\*(?!\w)/.exec(s);
    if (!m) return null;
    const pre = m[1] ?? '';
    return {
      index: m.index,
      length: m[0].length,
      render: (key) => [pre, <em key={key}>{rich(m[2] ?? '', key, o)}</em>],
    };
  },
  // _em_
  (s, o) => {
    const m = /(^|[^\w])_([^_\n]+)_(?!\w)/.exec(s);
    if (!m) return null;
    const pre = m[1] ?? '';
    return {
      index: m.index,
      length: m[0].length,
      render: (key) => [pre, <em key={key}>{rich(m[2] ?? '', key, o)}</em>],
    };
  },
];

/** Links, bold and emphasis (no code spans: those are split out first). */
function rich(text: string, keyPrefix: string, o: MarkdownOptions = NONE): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    let best: Hit | null = null;
    for (const match of matchers) {
      const hit = match(rest, o);
      if (hit && (best === null || hit.index < best.index)) best = hit;
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.index > 0) out.push(rest.slice(0, best.index));
    out.push(...best.render(`${keyPrefix}.${n++}`));
    rest = rest.slice(best.index + best.length);
  }
  return out;
}

/** Inline Markdown: `code`, links, **bold**, *em*, _em_ (and images in doc mode). */
export function inline(text: string, keyPrefix = 'i', o: MarkdownOptions = NONE): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(...rich(text.slice(last, m.index), `${keyPrefix}.${n++}`, o));
    out.push(<code key={`${keyPrefix}.c${n++}`}>{m[1]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...rich(text.slice(last), `${keyPrefix}.${n++}`, o));
  return out;
}

function withBreaks(lines: string[], key: string, o: MarkdownOptions): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${key}.br${i}`} />);
    out.push(...inline(line, `${key}.${i}`, o));
  });
  return out;
}

function listItem(text: string, key: string, o: MarkdownOptions): ReactNode {
  const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
  if (task) {
    const done = task[1] !== ' ';
    return (
      <li key={key} className="md-task">
        {/* An empty box marker: the session screen draws it as a glyph square (screens/session/Prose.tsx). */}
        <span className="md-box" role="img" aria-label={done ? 'done' : 'not done'} />{' '}
        {inline(task[2] ?? '', key, o)}
      </li>
    );
  }
  return <li key={key}>{inline(text, key, o)}</li>;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}/;

/** Block Markdown: fences, tables, headings, rules, quotes, lists, paragraphs. */
export function renderMarkdown(text: string, o: MarkdownOptions = NONE): ReactNode[] {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: { type: 'ul' | 'ol'; start: number; items: string[] } | null = null;
  let k = 0;
  const key = () => `b${k++}`;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const kk = key();
    blocks.push(<p key={kk}>{withBreaks(paragraph, kk, o)}</p>);
    paragraph = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const kk = key();
    blocks.push(<blockquote key={kk}>{withBreaks(quote, kk, o)}</blockquote>);
    quote = [];
  };
  const flushList = () => {
    if (!list) return;
    const kk = key();
    const items = list.items.map((item, i) => listItem(item, `${kk}.${i}`, o));
    blocks.push(
      list.type === 'ul' ? (
        <ul key={kk}>{items}</ul>
      ) : (
        <ol key={kk} start={list.start !== 1 ? list.start : undefined}>
          {items}
        </ol>
      ),
    );
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    const fence = /^\s*```\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i] ?? '')) code.push(lines[i] ?? '');
      const kk = key();
      blocks.push(
        <pre key={kk} className="md-code" data-lang={fence[1] || undefined}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      flush();
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(line);
      i += 1;
      const body: string[][] = [];
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1] ?? '')) body.push(cells(lines[++i] ?? ''));
      const kk = key();
      blocks.push(
        <div key={kk} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, `${kk}.h${j}`, o)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, `${kk}.${ri}.${j}`, o)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      // The transcript nests under the screen's own headings; a document keeps its levels.
      const depth = heading[1]?.length ?? 1;
      const level = o.doc ? depth : Math.min(depth + 2, 6);
      const kk = key();
      const content = inline(heading[2] ?? '', kk, o);
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Tag key={kk} className="md-h">
          {content}
        </Tag>,
      );
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push(<hr key={key()} />);
      continue;
    }

    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushParagraph();
      flushList();
      quote.push(q[1] ?? '');
      continue;
    }
    flushQuote();

    const bullet = /^\s*[-*+•]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, start: numbered ? Number(numbered[1]) || 1 : 1, items: [] };
      list.items.push((bullet ? bullet[1] : numbered?.[2]) ?? '');
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      const items: string[] = list.items;
      items[items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
