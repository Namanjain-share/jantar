import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, safeHref } from '../src/lib/markdown.js';

function md(text: string) {
  const { container } = render(<div>{renderMarkdown(text)}</div>);
  return container.firstElementChild as HTMLElement;
}

describe('markdown (escape-first)', () => {
  it('never turns text into HTML', () => {
    const el = md('<img src=x onerror="alert(1)"> <script>alert(2)</script> <b>bold?</b> &amp;');
    expect(el.querySelector('img,script,b')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror="alert(1)"> <script>alert(2)</script> <b>bold?</b> &amp;');
  });

  it('links only http(s) URLs, with no opener and no referrer', () => {
    const el = md('[docs](https://example.test/a?b=1) [bad](javascript:alert(1)) [file](src/app.ts) [d](data:text/html,x)');
    const links = el.querySelectorAll('a');
    expect(links.length).toBe(1);
    const a = links[0]!;
    expect(a.getAttribute('href')).toBe('https://example.test/a?b=1');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(a.getAttribute('rel')).toContain('noreferrer');
    const paths = el.querySelectorAll('.md-path');
    expect(Array.from(paths).map((p) => [p.textContent, p.getAttribute('title')])).toEqual([
      ['bad', 'javascript:alert(1'],
      ['file', 'src/app.ts'],
      ['d', 'data:text/html,x'],
    ]);
  });

  it('links bare URLs without trailing punctuation', () => {
    const el = md('See https://example.test/page. Or (https://example.test/x)!');
    const hrefs = Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.test/page', 'https://example.test/x']);
    expect(el.textContent).toBe('See https://example.test/page. Or (https://example.test/x)!');
  });

  it('renders inline code, bold and emphasis', () => {
    const el = md('Run `rm -rf <dir>` then **really _sure_** and *maybe*; snake_case_name and 2*3*4 stay.');
    expect(el.querySelector('code')?.textContent).toBe('rm -rf <dir>');
    expect(el.querySelector('strong')?.textContent).toBe('really sure');
    expect(el.querySelector('strong em')?.textContent).toBe('sure');
    expect(Array.from(el.querySelectorAll('em')).map((e) => e.textContent)).toEqual(['sure', 'maybe']);
    expect(el.textContent).toContain('2*3*4');
    expect(el.textContent).toContain('snake_case_name');
  });

  it('renders fences, headings, rules, quotes and tables', () => {
    const el = md(
      [
        '# Title',
        '```ts',
        'const a = "<b>";',
        '```',
        '---',
        '> line one',
        '> line two',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | `x` |',
      ].join('\n'),
    );
    expect(el.querySelector('h3')?.textContent).toBe('Title');
    const pre = el.querySelector('pre.md-code');
    expect(pre?.getAttribute('data-lang')).toBe('ts');
    expect(pre?.textContent).toBe('const a = "<b>";');
    expect(el.querySelector('hr')).toBeTruthy();
    expect(el.querySelectorAll('blockquote').length).toBe(1);
    expect(el.querySelector('blockquote')?.querySelectorAll('br').length).toBe(1);
    expect(Array.from(el.querySelectorAll('th')).map((t) => t.textContent)).toEqual(['a', 'b']);
    expect(el.querySelector('td code')?.textContent).toBe('x');
  });

  it('renders lists, ordered start numbers, continuations and task boxes', () => {
    const el = md(['3. three', '4. four', '   continued', '', '- [x] done', '- [ ] todo', '* plain'].join('\n'));
    const ol = el.querySelector('ol');
    expect(ol?.getAttribute('start')).toBe('3');
    expect(Array.from(ol!.querySelectorAll('li')).map((l) => l.textContent)).toEqual(['three', 'four continued']);
    const ul = el.querySelector('ul');
    expect(Array.from(ul!.querySelectorAll('li')).map((l) => l.textContent?.trim())).toEqual(['done', 'todo', 'plain']);
    expect(Array.from(ul!.querySelectorAll('.md-box')).map((b) => b.getAttribute('aria-label'))).toEqual(['done', 'not done']);
  });

  it('keeps line breaks inside a paragraph', () => {
    const el = md('one\ntwo\n\nthree');
    expect(el.querySelectorAll('p').length).toBe(2);
    expect(el.querySelector('p')?.querySelectorAll('br').length).toBe(1);
  });

  it('accepts only http and https in safeHref', () => {
    expect(safeHref('https://a.test/x')).toBe('https://a.test/x');
    expect(safeHref('http://a.test')).toBe('http://a.test/');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeHref('vbscript:x')).toBeNull();
    expect(safeHref('/relative')).toBeNull();
  });

  it('is the only way text is rendered: no raw HTML anywhere in the app source', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|js)$/.test(name)) files.push(p);
      }
    };
    walk(join(__dirname, '..', 'src'));
    walk(join(__dirname, '..', 'sw'));
    const offenders = files.filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
