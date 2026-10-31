// @vitest-environment node
/**
 * The highlighter (v0.3 spec 5.2.4): language lookups through Maps (W4),
 * Prism's tokens flattened to text-and-class segments (never HTML), the
 * limits, hidden characters, the page-side client (one file at a time,
 * each with its own 1 s watchdog, a fresh worker's start allowed for),
 * the worker's message contract, and the static rules: a Vite-bundled
 * worker (never blob: or data:) and code.css with token variables only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHighlighter, type WorkerLike } from '../src/lib/highlight/client.js';
import { LANGUAGES, extOf, languageFor, languageLabel } from '../src/lib/highlight/languages.js';
import { grammarFor, highlightLines } from '../src/lib/highlight/prism.js';
import { classOf, hiddenName, plainLines, showHidden, splitHidden, toLines } from '../src/lib/highlight/tokens.js';
import { HIGHLIGHT_MAX_CHARS, HIGHLIGHT_MAX_LINE, HIGHLIGHT_MAX_LINES, withinLimits, type HighlightReply, type HighlightRequest, type Line } from '../src/lib/highlight/types.js';

const src = join(__dirname, '..', 'src');
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);

afterEach(() => {
  vi.useRealTimers();
});

describe('languages (W4: Map lookups only)', () => {
  it('picks the grammar from the hint, then the whole name, then the extension', () => {
    expect(languageFor('src/auth/session.ts')).toBe('typescript');
    expect(languageFor('App.TSX')).toBe('tsx');
    expect(languageFor('Dockerfile')).toBe('docker');
    expect(languageFor('notes', 'Python')).toBe('python');
    expect(languageFor('x.txt', 'typescriptreact')).toBe('tsx');
    expect(languageFor('README')).toBeNull();
    expect(extOf('.gitignore')).toBe('');
    expect(extOf('a/b.tar.GZ')).toBe('gz');
  });

  it('names like "constructor" and "__proto__" resolve through the table or to nothing', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(languageFor(name)).toBeNull();
      expect(languageFor(`x.${name}`)).toBeNull();
      expect(languageFor('x', name)).toBeNull();
      expect(grammarFor(name)).toBeNull();
    }
    expect(languageFor('__proto__.md')).toBe('markdown');
    expect(languageFor('constructor.ts', '__proto__')).toBe('typescript');
    expect(languageLabel('constructor', null)).toBeNull();
  });

  it('labels a language, markup by what the file is', () => {
    expect(languageLabel('a.ts', 'typescript')).toBe('TypeScript');
    expect(languageLabel('logo.svg', 'markup')).toBe('SVG');
    expect(languageLabel('index.html', 'markup')).toBe('HTML');
    expect(languageLabel('Info.plist', 'markup')).toBe('XML');
  });

  it('every language the table can name has a grammar in the worker', () => {
    for (const lang of LANGUAGES) expect(grammarFor(lang), lang).not.toBeNull();
  });

  it("every language id the daemon sends (files/kinds.ts) is one the viewer knows", () => {
    const kinds = readFileSync(join(__dirname, '..', '..', 'daemon', 'src', 'files', 'kinds.ts'), 'utf8');
    const ids = new Set([...kinds.matchAll(/text\('([^']+)'\)|language: '([^']+)'/g)].map((m) => m[1] ?? m[2]));
    expect(ids.size).toBeGreaterThan(10);
    for (const id of ids) expect(languageFor('x', id), id).not.toBeNull();
  });
});

describe('tokens', () => {
  it('flattens Prism tokens into lines of (text, class), children inheriting their parent class', () => {
    const lines = toLines([
      { type: 'keyword', content: 'const' },
      ' a = ',
      { type: 'string', content: ['"x', { type: 'punctuation', content: ';' }, '\ny"'] },
      { type: 'unknown', content: 'z', alias: ['comment'] },
    ]);
    expect(lines).toEqual([
      [
        ['const', 'tk-kw'],
        [' a = ', ''],
        ['"x', 'tk-str'],
        [';', 'tk-punct'],
      ],
      [
        ['y"', 'tk-str'],
        ['z', 'tk-com'],
      ],
    ]);
    expect(classOf('class-name')).toBe('tk-type');
    expect(classOf('nope', 'function')).toBe('tk-fn');
    expect(classOf('nope')).toBeNull();
  });

  it('highlights real code with Prism (TypeScript, JSX inside TSX, Python)', () => {
    const ts = highlightLines('const a: Foo = fn("x", 1); // hi\n', 'typescript')!;
    const cls = (l: Line, t: string) => l.find(([x]) => x === t)?.[1];
    expect(cls(ts[0]!, 'const')).toBe('tk-kw');
    expect(cls(ts[0]!, 'fn')).toBe('tk-fn');
    expect(cls(ts[0]!, '"x"')).toBe('tk-str');
    expect(cls(ts[0]!, '1')).toBe('tk-num');
    expect(cls(ts[0]!, '// hi')).toBe('tk-com');
    expect(ts).toHaveLength(2);
    const tsx = highlightLines('<div className="a">{b}</div>', 'tsx')!;
    expect(tsx[0]!.some(([, c]) => c === 'tk-attr')).toBe(true);
    // The text survives exactly: segments only slice it.
    expect(tsx[0]!.map(([t]) => t).join('')).toBe('<div className="a">{b}</div>');
    const py = highlightLines('def f():\n    return 2\n', 'python')!;
    expect(cls(py[0]!, 'def')).toBe('tk-kw');
  });

  it('highlights PHP: a pure PHP file, and PHP blocks inside HTML (markup-templating)', () => {
    const cls = (l: Line, t: string) => l.find(([x]) => x === t)?.[1];
    const pure = highlightLines('<?php\nfunction foo($a) { return "x" . $a; } // hi\n', 'php')!;
    expect(cls(pure[0]!, '<?php')).toBe('tk-kw');
    expect(cls(pure[1]!, 'function')).toBe('tk-kw');
    expect(cls(pure[1]!, 'foo')).toBe('tk-fn');
    expect(cls(pure[1]!, '$a')).toBe('tk-attr');
    expect(cls(pure[1]!, '"x"')).toBe('tk-str');
    expect(cls(pure[1]!, '// hi')).toBe('tk-com');
    const page = '<div class="a"><?= $title ?></div>\n<?php if ($ok): ?><p>yes</p><?php endif; ?>\n';
    const mixed = highlightLines(page, 'php')!;
    // The HTML reads as HTML (not as PHP operators) and each block as PHP.
    expect(cls(mixed[0]!, 'div')).toBe('tk-tag');
    expect(cls(mixed[0]!, 'class')).toBe('tk-attr');
    expect(cls(mixed[0]!, '$title')).toBe('tk-attr');
    expect(cls(mixed[0]!, '<?=')).toBe('tk-kw');
    expect(cls(mixed[1]!, 'if')).toBe('tk-kw');
    expect(cls(mixed[1]!, 'endif')).toBe('tk-kw');
    expect(cls(mixed[1]!, 'p')).toBe('tk-tag');
    // No placeholder leaks, and the text survives exactly.
    expect(mixed.map((l) => l.map(([t]) => t).join('')).join('\n')).toBe(page);
    expect(JSON.stringify(mixed)).not.toContain('___PHP');
    expect(languageFor('views/page.phtml')).toBe('php');
    expect(languageLabel('views/page.phtml', 'php')).toBe('PHP');
  });

  it('keeps a file that spells out a placeholder as it is', () => {
    const page = '<p>___PHP0___</p><?php echo 1; ?>';
    const lines = highlightLines(page, 'php')!;
    expect(lines.map((l) => l.map(([t]) => t).join('')).join('\n')).toBe(page);
  });

  it('declines unknown grammars and text over the limits', () => {
    expect(highlightLines('x', 'brainfuck')).toBeNull();
    expect(highlightLines('a'.repeat(HIGHLIGHT_MAX_LINE + 1), 'typescript')).toBeNull();
    expect(withinLimits('a\n'.repeat(HIGHLIGHT_MAX_LINES - 1))).toBe(true);
    expect(withinLimits('a\n'.repeat(HIGHLIGHT_MAX_LINES))).toBe(false);
    expect(withinLimits('a'.repeat(HIGHLIGHT_MAX_LINE))).toBe(true);
    expect(withinLimits(`${'a'.repeat(HIGHLIGHT_MAX_LINE + 1)}\nb`)).toBe(false);
    expect(withinLimits('ab\n'.repeat(Math.ceil(HIGHLIGHT_MAX_CHARS / 3) + 1).slice(0, HIGHLIGHT_MAX_CHARS + 1))).toBe(false);
  });

  it('plain lines have the same shape; hidden characters are named', () => {
    expect(plainLines('a\n\nb')).toEqual([[['a', '']], [], [['b', '']]]);
    expect(hiddenName(RLO)).toBe('⟨U+202E⟩');
    expect(hiddenName('\u0007')).toBe('⟨U+0007⟩');
    expect(splitHidden(`ab${RLO}c${ZWSP}`)).toEqual([
      ['ab', false],
      [RLO, true],
      ['c', false],
      [ZWSP, true],
    ]);
    expect(splitHidden('tab\tkept')).toEqual([['tab\tkept', false]]);
    expect(showHidden(`evil${RLO}gnp.ts`)).toBe('evil⟨U+202E⟩gnp.ts');
    expect(showHidden('plain.ts')).toBe('plain.ts');
  });
});

/** A fake worker the test answers by hand. */
function fakeWorker() {
  const sent: HighlightRequest[] = [];
  const w: WorkerLike & { sent: HighlightRequest[]; terminated: boolean; reply(r: HighlightReply): void } = {
    sent,
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage: (m) => sent.push(m),
    terminate() {
      this.terminated = true;
    },
    reply(r) {
      this.onmessage?.({ data: r } as MessageEvent<HighlightReply>);
    },
  };
  return w;
}

describe('the highlight client', () => {
  it('sends text to the worker and resolves its lines', async () => {
    const w = fakeWorker();
    const h = createHighlighter({ start: () => w });
    const p = h.highlight('const a', 'typescript');
    expect(w.sent).toEqual([{ id: 1, text: 'const a', lang: 'typescript' }]);
    w.reply({ id: 1, lines: [[['const', 'tk-kw']]] });
    expect(await p).toEqual([[['const', 'tk-kw']]]);
  });

  it('terminates a worker that takes longer than the watchdog, falls back to plain, and starts afresh', async () => {
    vi.useFakeTimers();
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const h = createHighlighter({
      start: () => {
        const w = fakeWorker();
        workers.push(w);
        return w;
      },
      watchdogMs: 1_000,
      startMs: 0,
    });
    const p = h.highlight('x', 'typescript');
    vi.advanceTimersByTime(999);
    expect(workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await p).toBeNull();
    expect(workers[0]!.terminated).toBe(true);
    // A late reply from the dead worker changes nothing; the next file gets a new worker.
    workers[0]!.reply({ id: 1, lines: [] });
    const q = h.highlight('y', 'typescript');
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ id: 2, lines: [[['y', '']]] });
    expect(await q).toEqual([[['y', '']]]);
  });

  it("sends one file at a time, each timed from when the worker takes it (a notebook's cells)", async () => {
    vi.useFakeTimers();
    const w = fakeWorker();
    const h = createHighlighter({ start: () => w, watchdogMs: 1_000, startMs: 0 });
    const cells = [h.highlight('a', 'python'), h.highlight('b', 'python'), h.highlight('c', 'python')];
    expect(w.sent.map((m) => m.text)).toEqual(['a']);
    vi.advanceTimersByTime(900);
    w.reply({ id: 1, lines: [[['a', '']]] });
    expect(w.sent.map((m) => m.text)).toEqual(['a', 'b']);
    // b's second starts now, not when it was asked for: 1.8 s in, nothing has been cut off.
    vi.advanceTimersByTime(900);
    expect(w.terminated).toBe(false);
    w.reply({ id: 2, lines: [[['b', '']]] });
    w.reply({ id: 3, lines: [[['c', '']]] });
    expect(await Promise.all(cells)).toEqual([[[['a', '']]], [[['b', '']]], [[['c', '']]]]);
  });

  it('a file that runs out of time shows plain on its own; the files after it go to a fresh worker', async () => {
    vi.useFakeTimers();
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const h = createHighlighter({
      start: () => {
        const w = fakeWorker();
        workers.push(w);
        return w;
      },
      watchdogMs: 1_000,
      startMs: 0,
    });
    const slow = h.highlight('slow', 'python');
    const next = h.highlight('next', 'python');
    vi.advanceTimersByTime(1_000);
    expect(await slow).toBeNull();
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.sent.map((m) => m.text)).toEqual(['next']);
    workers[1]!.reply({ id: 2, lines: [[['next', '']]] });
    expect(await next).toEqual([[['next', '']]]);
  });

  it("gives a fresh worker's first file the time to load the grammars too", async () => {
    vi.useFakeTimers();
    const w = fakeWorker();
    const h = createHighlighter({ start: () => w, watchdogMs: 1_000, startMs: 2_000 });
    const first = h.highlight('x', 'typescript');
    vi.advanceTimersByTime(2_999);
    expect(w.terminated).toBe(false);
    w.reply({ id: 1, lines: [[['x', '']]] });
    expect(await first).toEqual([[['x', '']]]);
    // Warm now: the next file gets the plain second.
    const second = h.highlight('y', 'typescript');
    vi.advanceTimersByTime(1_000);
    expect(await second).toBeNull();
    expect(w.terminated).toBe(true);
  });

  it('drops a file nobody waits for any more before it reaches the worker', async () => {
    const w = fakeWorker();
    const h = createHighlighter({ start: () => w });
    const first = h.highlight('a', 'python');
    const left = new AbortController();
    const second = h.highlight('b', 'python', left.signal);
    left.abort();
    expect(await second).toBeNull();
    w.reply({ id: 1, lines: [] });
    await first;
    expect(w.sent.map((m) => m.text)).toEqual(['a']);
  });

  it('answers null without a worker, over the limits, and after a worker error', async () => {
    expect(await createHighlighter({ start: () => null }).highlight('x', 'typescript')).toBeNull();
    const w = fakeWorker();
    const h = createHighlighter({ start: () => w });
    expect(await h.highlight('a'.repeat(HIGHLIGHT_MAX_CHARS + 1), 'typescript')).toBeNull();
    expect(w.sent).toHaveLength(0);
    const p = h.highlight('x', 'typescript');
    w.onerror?.(new Event('error'));
    expect(await p).toBeNull();
    expect(w.terminated).toBe(true);
  });
});

describe('the highlight worker', () => {
  it('answers { id, lines } for each message, and null lines for what it will not highlight', async () => {
    const posted: HighlightReply[] = [];
    const scope = { onmessage: null as ((e: MessageEvent<HighlightRequest>) => void) | null, postMessage: (r: HighlightReply) => posted.push(r) };
    vi.stubGlobal('self', scope);
    try {
      await import('../src/workers/highlight.worker.js');
      scope.onmessage?.({ data: { id: 7, text: 'let x = 1', lang: 'javascript' } } as MessageEvent<HighlightRequest>);
      scope.onmessage?.({ data: { id: 8, text: 'x', lang: '__proto__' } } as MessageEvent<HighlightRequest>);
      scope.onmessage?.({ data: { nope: true } } as unknown as MessageEvent<HighlightRequest>);
      expect(posted).toHaveLength(2);
      expect(posted[0]!.id).toBe(7);
      expect(posted[0]!.lines?.[0]?.[0]).toEqual(['let', 'tk-kw']);
      expect(posted[1]).toEqual({ id: 8, lines: null });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('static rules', () => {
  it('starts the worker from a bundled file, never blob: or data:', () => {
    const client = readFileSync(join(src, 'lib/highlight/client.ts'), 'utf8');
    expect(client).toContain("new Worker(new URL('../../workers/highlight.worker.ts', import.meta.url), { type: 'module' })");
    expect(client).not.toMatch(/new Worker\(\s*['"`](blob|data):/);
    expect(client).not.toMatch(/createObjectURL/);
  });

  it('styles every token class in code.css from token variables only', () => {
    const css = readFileSync(join(src, 'styles/code.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|font-size\s*:/);
    for (const c of ['tk-kw', 'tk-type', 'tk-fn', 'tk-str', 'tk-num', 'tk-tag', 'tk-attr', 'tk-com', 'tk-punct', 'tk-hidden']) expect(css).toContain(`.${c}`);
    for (const m of css.matchAll(/color:\s*([^;]+);/g)) expect(m[1]).toMatch(/^var\(--(ink|ink-2|ink-3)\)$/);
  });

  it('pdf.js loads lazily with the strict options and a ?url worker', () => {
    const pdf = readFileSync(join(src, 'ui/screens/files/pdf.ts'), 'utf8');
    expect(pdf).toContain("import('pdfjs-dist')");
    expect(pdf).toContain("import('pdfjs-dist/build/pdf.worker.min.mjs?url')");
    expect(pdf).toMatch(/useWasm: false/);
    expect(pdf).toMatch(/enableXfa: false/);
    expect(pdf).toMatch(/disableFontFace: true/);
    // Nothing else in the app imports pdf.js statically.
    const view = readFileSync(join(src, 'ui/screens/files/PdfView.tsx'), 'utf8');
    expect(view).not.toMatch(/^import [^t].*from 'pdfjs-dist'/m);
  });
});
