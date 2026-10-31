/**
 * lib/markdown.tsx in doc mode (the Files viewer's Markdown, v0.3 spec
 * 5.2.3) and MarkdownDoc around it: real heading levels, relative links
 * that open the viewer, relative images from the Mac (served images only,
 * never through a dot folder), remote images as their URL, raw HTML as text
 * (W3), and the transcript mode unchanged.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { isLocalTarget, renderMarkdown } from '../src/lib/markdown.js';
import { MarkdownDoc } from '../src/ui/screens/files/MarkdownDoc.js';
import { fetchableImage, resolveRel } from '../src/ui/screens/files/model.js';
import { fakeApi } from './helpers.js';
import { renderWith } from './files-helpers.js';

function doc(text: string, opts: Parameters<typeof renderMarkdown>[1] = { doc: true }) {
  const { container } = render(<div>{renderMarkdown(text, opts)}</div>);
  return container.firstElementChild as HTMLElement;
}

describe('markdown doc mode', () => {
  it('keeps heading levels in a document and nests them in the transcript', () => {
    const text = '# One\n## Two\n###### Six';
    expect(Array.from(doc(text).querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => h.tagName)).toEqual(['H1', 'H2', 'H6']);
    expect(Array.from(doc(text, {}).querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => h.tagName)).toEqual(['H3', 'H4', 'H6']);
  });

  it('hands relative links and images to the caller; remote images stay text', () => {
    const localLink = vi.fn((target: string, label: string, key: string) => (
      <button key={key} type="button" data-target={target}>
        {label}
      </button>
    ));
    const localImage = vi.fn((target: string, alt: string, key: string) => <img key={key} alt={alt} data-target={target} />);
    const el = doc('[setup](docs/setup.md#run) [site](https://example.test) ![logo](img/logo.png) ![far](https://example.test/x.png) [bad](javascript:alert(1))', {
      doc: true,
      localLink,
      localImage,
    });
    expect(localLink).toHaveBeenCalledWith('docs/setup.md#run', 'setup', expect.any(String));
    expect(el.querySelector('button')?.getAttribute('data-target')).toBe('docs/setup.md#run');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('https://example.test/');
    expect(localImage).toHaveBeenCalledWith('img/logo.png', 'logo', expect.any(String));
    expect(el.querySelectorAll('img')).toHaveLength(1);
    // A remote image is never fetched: it shows as its URL.
    expect(el.querySelector('.md-image')?.textContent).toBe('Remote image: https://example.test/x.png');
    expect(el.textContent).toContain('bad');
    expect(el.querySelectorAll('a')).toHaveLength(1);
  });

  it('leaves the transcript as it was: no images, local paths shown not linked', () => {
    const el = doc('![logo](img/logo.png) [file](src/app.ts)', {});
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('!logo file');
    expect(isLocalTarget('src/app.ts')).toBe(true);
    expect(isLocalTarget('mailto:x@y.test')).toBe(false);
    expect(isLocalTarget('//cdn.example.test/x')).toBe(false);
  });

  it('W3: raw HTML in a document stays text', () => {
    const el = doc('<b>x</b> <script>window.__pwned=1</script> <img src=x onerror="alert(1)">\n\n<iframe src="https://example.test"></iframe>');
    expect(el.querySelector('b,script,img,iframe')).toBeNull();
    expect(el.textContent).toContain('<b>x</b>');
    expect(el.textContent).toContain('<iframe src="https://example.test"></iframe>');
  });

  it('resolves relative targets inside the root and refuses ones that leave it', () => {
    expect(resolveRel('docs/a.md', 'b.md')).toBe('docs/b.md');
    expect(resolveRel('docs/a.md', '../README.md#top')).toBe('README.md');
    expect(resolveRel('docs/a.md', './img/My%20Logo.png?raw=1')).toBe('docs/img/My Logo.png');
    expect(resolveRel('docs/a.md', '/src/x.ts')).toBe('src/x.ts');
    expect(resolveRel('docs/a.md', 'sub/')).toBe('docs/sub/');
    expect(resolveRel('docs/a.md', '../../etc/passwd')).toBeNull();
    expect(resolveRel('a.md', '#section')).toBeNull();
  });
});

describe('MarkdownDoc', () => {
  it('opens relative links in the viewer and loads relative images from the Mac', () => {
    const onOpen = vi.fn();
    const api = fakeApi();
    renderWith(<MarkdownDoc text={'# Guide\n\nSee [the API](../api/README.md) and ![diagram](img/flow.png).'} root="r.work" path="docs/guide.md" onOpen={onOpen} />, { api });
    expect(screen.getByRole('heading', { level: 1, name: 'Guide' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'the API' }));
    expect(onOpen).toHaveBeenCalledWith('api/README.md');
    // Nothing is asked for until the tap: the alt text shows, and how many images there are.
    expect(screen.queryByRole('img')).toBeNull();
    expect(api.filesRawUrl).not.toHaveBeenCalled();
    expect(screen.getByText('Image: diagram')).toBeTruthy();
    expect(screen.getByText('This document shows an image from the Mac.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
    const img = screen.getByRole('img', { name: 'diagram' });
    expect(screen.queryByRole('button', { name: 'Show images' })).toBeNull();
    expect(api.filesRawUrl).toHaveBeenCalledWith({ root: 'r.work', path: 'docs/img/flow.png' });
    expect(img.getAttribute('src')).toBe('http://127.0.0.1:7420/v1/files/raw?root=r.work&path=docs%2Fimg%2Fflow.png');
  });

  it('never makes the phone ask for a path on its own: only served images, never through a dot folder', () => {
    // Each refused path would be an audit row, and five would push "A device tried to open protected files".
    const api = fakeApi();
    const { container } = renderWith(
      <MarkdownDoc text={'![env](.env) ![key](.ssh/a.png) ![](x.pem) ![git](../.git/config) ![svg](logo.svg) ![ok](img/a.png)'} root="r.work" path="docs/guide.md" onOpen={vi.fn()} />,
      { api },
    );
    expect(container.querySelectorAll('img')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(api.filesRawUrl).toHaveBeenCalledTimes(1);
    expect(api.filesRawUrl).toHaveBeenCalledWith({ root: 'r.work', path: 'docs/img/a.png' });
    // The others show as their alt text, or their path when there is none.
    const shown = Array.from(container.querySelectorAll('span[title]')).map((s) => [s.textContent, s.getAttribute('title')]);
    expect(shown).toEqual([
      ['env', '.env'],
      ['key', '.ssh/a.png'],
      ['x.pem', 'x.pem'],
      ['git', '../.git/config'],
      ['svg', 'logo.svg'],
    ]);
  });

  it('knows which images /v1/files/raw serves', () => {
    expect(['img/a.png', 'a.JPG', 'b.jpeg', 'c.gif', 'd.webp', 'e.avif', 'f.heic'].map(fetchableImage)).toEqual(Array(7).fill(true));
    expect(['.env', '.ssh/a.png', 'a/.git/x.png', 'x.pem', 'logo.svg', 'img/', '', 'constructor', '__proto__'].map(fetchableImage)).toEqual(Array(9).fill(false));
  });

  it('shows a link that leaves the root as text', () => {
    const onOpen = vi.fn();
    renderWith(<MarkdownDoc text="[out](../../x.md)" root="r.work" path="a.md" onOpen={onOpen} />);
    expect(screen.queryByRole('button', { name: 'out' })).toBeNull();
    expect(screen.getByText('out')).toBeTruthy();
  });
});
