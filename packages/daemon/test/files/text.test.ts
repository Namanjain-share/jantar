/**
 * Text windows (v0.3 spec 4.4.4) and file kinds: the content rule (F7),
 * the size and line limits (F12), the binary rules, encodings and BOMs,
 * windows cut at a newline and a UTF-8 boundary, the warnings, and kind and
 * language lookups through Maps (a file named `constructor` is just a file).
 */
import { truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStatSchema, FileTextSchema, type FileText } from '@jantar/protocol';
import type { FileRefusal } from '../../src/contracts.js';
import { kindOf } from '../../src/files/kinds.js';
import { isRefusal } from '../../src/files/policy.js';
import { buildFilesService } from '../../src/files/service.js';
import { KEY_MARGIN, TEXT_MAX_FILE, controlHeavy, sniffHead } from '../../src/files/text.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { AWS_LIKE, KEY_BEGIN, KEY_END, PHONE, SECRET_MARKER, fpEnv, type FpEnv } from './fp-helpers.js';

let env: FpEnv;
let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
  env?.cleanup();
});

const WINDOW = 512 * 1024;

async function text(path: string, offset = 0, max = WINDOW): Promise<FileText | FileRefusal> {
  return env.files.text({ root: 'r.proj', path, offset, max }, PHONE);
}

async function ok(path: string, offset = 0, max = WINDOW): Promise<FileText> {
  const r = await text(path, offset, max);
  if (isRefusal(r)) throw new Error(`refused: ${r.refused} (${r.message})`);
  return FileTextSchema.parse(r);
}

async function refused(path: string, offset = 0, max = WINDOW): Promise<string> {
  const r = await text(path, offset, max);
  if (!isRefusal(r)) throw new Error('expected a refusal');
  return r.refused;
}

/** Every window from the start, joined: the whole file must come back exactly once. */
async function readAllWindows(path: string, max: number): Promise<{ text: string; windows: FileText[] }> {
  const windows: FileText[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const w = await ok(path, offset, max);
    windows.push(w);
    if (w.next !== null) expect(w.next).toBeGreaterThan(offset);
    offset = w.next;
  }
  return { text: windows.map((w) => w.text).join(''), windows };
}

describe('F7: the content rule', () => {
  it('a notes.txt holding a private key block is refused', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'notes.txt'), `my notes\n${KEY_BEGIN}\n${SECRET_MARKER}\n${KEY_END}\n`);
    expect(await refused('notes.txt')).toBe('protected');
  });

  it('a window inside a key block, away from both marker lines, is refused too', async () => {
    env = fpEnv();
    const before = 'x'.repeat(99) + '\n';
    const body = Array.from({ length: 50 }, () => `${'A'.repeat(63)}\n`).join('');
    const content = before.repeat(3000) + `${KEY_BEGIN}\n${body}${KEY_END}\n` + before.repeat(3000);
    env.write(join(env.proj, 'big.txt'), content);
    const inKey = content.indexOf(KEY_BEGIN) + KEY_BEGIN.length + 1 + 640;
    expect(await refused('big.txt', inKey, 64)).toBe('protected');
    // Far enough from the key (more than the margin), the file reads fine.
    const far = await ok('big.txt', 0, 4096);
    expect(far.text).not.toContain('PRIVATE');
    expect(content.indexOf(KEY_BEGIN)).toBeGreaterThan(4096 + KEY_MARGIN);
  });

  // Token bodies, built by concatenation so the repo's secret scan never matches this file.
  const BODY = 'Synthetic' + 'SecretDoNotServe' + '0123456789ab';
  const TOKENS = ['sk-' + 'ant-api03-' + BODY, 'gh' + 'p_' + BODY, 'github' + '_pat_' + BODY, 'xo' + 'xb-' + BODY, AWS_LIKE];
  const AWS_BODY = AWS_LIKE.slice(4);

  it('secret tokens are masked after their prefix, one * per character, with a secret-like warning', async () => {
    env = fpEnv();
    const content = TOKENS.map((t, i) => `export const k${i} = '${t}';\n`).join('');
    env.write(join(env.proj, 'config.ts'), content);
    const w = await ok('config.ts');
    expect(w.warnings).toEqual(['secret-like']);
    expect(w.text).not.toContain(BODY);
    expect(w.text).not.toContain(AWS_BODY);
    // Same length, so offsets, lines and the next cursor are unchanged.
    expect(w.text.length).toBe(content.length);
    expect(w.text.split('\n')).toHaveLength(content.split('\n').length);
    expect(w.text).toContain(`'sk-${'ant-'}${'*'.repeat(TOKENS[0]!.length - 7)}'`);
    expect(w.text).toContain(`'AKIA${'*'.repeat(16)}'`);
  });

  it('a window that starts inside a token is masked too, and so is every window of a long one', async () => {
    env = fpEnv();
    const content = `${'x'.repeat(40)}\nkey = ${TOKENS[0]}\nend\n`;
    env.write(join(env.proj, 'notes.txt'), content);
    const mid = await ok('notes.txt', content.indexOf(BODY), 4096);
    expect(mid.text).not.toContain(BODY.slice(4));
    expect(mid.warnings).toContain('secret-like');
    const { text: all } = await readAllWindows('notes.txt', 16);
    expect(all).toHaveLength(content.length);
    expect(all).not.toContain(BODY.slice(0, 8));
    expect(all).not.toContain(BODY.slice(-8));
  });

  it('a UTF-16 file has its tokens masked as well', async () => {
    env = fpEnv();
    const content = `token: ${TOKENS[1]}\n`;
    env.write(join(env.proj, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
    const w = await ok('u16.txt');
    expect(w.text).toBe(`token: gh${'p_'}${'*'.repeat(TOKENS[1]!.length - 4)}\n`);
    expect(w.warnings).toEqual(['secret-like']);
  });

  it('the token body never reaches the phone over the route', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'config.ts'), `export const key = '${TOKENS[0]}';\n`);
    api = await makeApi({
      ctx: { userHome: env.home, home: join(env.home, '.jantar'), settings: env.ctx.settings.get() },
      deps: (ctx, fakes) => ({ files: buildFilesService(ctx, { sessions: fakes.sessions, notifiers: fakes.notifiers }) }),
    });
    const { cookie } = await pairCookie(api);
    const r = await api.tcp.inject({ method: 'GET', url: '/v1/files/text?root=r.proj&path=config.ts', headers: h(cookie) });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(BODY);
    expect(FileTextSchema.parse(r.json()).warnings).toEqual(['secret-like']);
  });
});

describe('windows', () => {
  it('a small file comes back whole, with its size, mtime, language and eol', async () => {
    env = fpEnv();
    const w = await ok('src/app.ts');
    expect(w).toMatchObject({ text: 'export const answer = 42;\n', offset: 0, next: null, size: 26, bom: false, eol: 'lf', language: 'typescript', warnings: [] });
    expect(Date.parse(w.mtime)).toBeGreaterThan(0);
  });

  it('cuts after the last newline; walking the windows gives back the file exactly', async () => {
    env = fpEnv();
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'.'.repeat(i % 70)}\n`).join('');
    env.write(join(env.proj, 'lines.txt'), lines);
    const { text: all, windows } = await readAllWindows('lines.txt', 4096);
    expect(all).toBe(lines);
    for (const w of windows.slice(0, -1)) {
      expect(w.text.endsWith('\n')).toBe(true);
      expect(Buffer.byteLength(w.text)).toBeLessThanOrEqual(4096);
      expect(w.warnings).not.toContain('truncated-line');
    }
  });

  it('a line longer than the window is cut at a character boundary and flagged', async () => {
    env = fpEnv();
    const line = '\u00e9\u20ac\ud83d\ude00a'.repeat(400);
    env.write(join(env.proj, 'wide.txt'), `${line}\nend\n`);
    const { text: all, windows } = await readAllWindows('wide.txt', 7);
    expect(all).toBe(`${line}\nend\n`);
    expect(windows[0]?.warnings).toContain('truncated-line');
    for (const w of windows) expect(w.text).not.toContain('\ufffd');
  });

  it('an offset inside a character skips to the next whole one', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'u.txt'), '\u20ac\u20ac\n');
    const w = await ok('u.txt', 1);
    expect(w.offset).toBe(3);
    expect(w.text).toBe('\u20ac\n');
  });

  it('an offset at or past the end gives an empty last window', async () => {
    env = fpEnv();
    expect(await ok('src/app.ts', 26)).toMatchObject({ text: '', next: null });
    expect(await ok('src/app.ts', 10_000)).toMatchObject({ text: '', next: null, size: 26 });
  });

  it('F12: a 10 MB single line is cut and flagged', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'bundle.min.js'), 'a'.repeat(10 * 1024 * 1024));
    const w = await ok('bundle.min.js');
    expect(w.text.length).toBe(WINDOW);
    expect(w.next).toBe(WINDOW);
    expect(w.warnings).toEqual(expect.arrayContaining(['truncated-line', 'minified']));
    expect(w.language).toBe('javascript');
  });

  it('F12: a 10 GB sparse file gives metadata only', async () => {
    env = fpEnv();
    const p = join(env.proj, 'huge.log');
    writeFileSync(p, '');
    truncateSync(p, 10 * 1024 ** 3);
    const st = await env.files.stat({ root: 'r.proj', path: 'huge.log' }, PHONE);
    if (isRefusal(st)) throw new Error(st.refused);
    expect(FileStatSchema.parse(st)).toMatchObject({ type: 'file', size: 10 * 1024 ** 3 });
    expect(await refused('huge.log')).toBe('too_large');
    expect(10 * 1024 ** 3).toBeGreaterThan(TEXT_MAX_FILE);
    const png = join(env.proj, 'huge.png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    truncateSync(png, 10 * 1024 ** 3);
    const raw = await env.files.raw({ root: 'r.proj', path: 'huge.png' }, PHONE);
    expect(isRefusal(raw) && raw.refused).toBe('too_large');
  });
});

describe('binary or text', () => {
  it('a NUL in the first 8 KiB, invalid UTF-8, UTF-16 without a BOM, or more than 5% control characters is binary', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'nul.txt'), Buffer.concat([Buffer.from('hello'), Buffer.from([0]), Buffer.from('world')]));
    env.write(join(env.proj, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    env.write(join(env.proj, 'utf16.txt'), Buffer.from('hello world\n', 'utf16le'));
    env.write(join(env.proj, 'ctl.txt'), `${'\u0001'.repeat(10)}${'a'.repeat(100)}`);
    env.write(join(env.proj, 'some-ctl.txt'), `${'\u001b'.repeat(4)}${'a'.repeat(96)}`);
    for (const f of ['nul.txt', 'latin1.txt', 'utf16.txt', 'ctl.txt']) expect(await refused(f), f).toBe('unsupported_type');
    expect((await ok('some-ctl.txt')).text).toHaveLength(100);
    expect(controlHeavy('\t\r\n\f'.repeat(10))).toBe(false);
  });

  it('a NUL after the first 8 KiB does not make a text file binary', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'late.txt'), Buffer.concat([Buffer.from(`${'a'.repeat(99)}\n`.repeat(100)), Buffer.from([0]), Buffer.from('\n')]));
    expect((await ok('late.txt')).size).toBe(10_002);
  });

  it('invalid UTF-8 in a later window refuses that window as binary', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'mixed.txt'), Buffer.concat([Buffer.from(`${'a'.repeat(99)}\n`.repeat(200)), Buffer.from([0xff, 0xfe, 0x0a])]));
    expect((await ok('mixed.txt', 0, 4000)).text.length).toBeGreaterThan(0);
    expect(await refused('mixed.txt', 19_000, 4000)).toBe('unsupported_type');
  });

  it('a character cut at 8 KiB is not mistaken for invalid UTF-8', () => {
    const head = Buffer.concat([Buffer.from('a'.repeat(8191)), Buffer.from('\u20ac').subarray(0, 1)]);
    expect(sniffHead(head).binary).toBe(false);
  });
});

describe('encodings, BOMs and line ends', () => {
  it('a UTF-8 BOM is reported and not returned', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi\n')]));
    const w = await ok('bom.txt');
    expect(w).toMatchObject({ text: 'hi\n', bom: true, offset: 3, size: 6 });
    expect(w.warnings).not.toContain('bidi');
  });

  it('UTF-16 with a BOM (either byte order) is text', async () => {
    env = fpEnv();
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('caf\u00e9\r\nok\r\n', 'utf16le')]);
    const be = Buffer.from(le);
    be.swap16();
    env.write(join(env.proj, 'le.txt'), le);
    env.write(join(env.proj, 'be.txt'), be);
    expect(await ok('le.txt')).toMatchObject({ text: 'caf\u00e9\r\nok\r\n', bom: true, eol: 'crlf' });
    expect(await ok('be.txt')).toMatchObject({ text: 'caf\u00e9\r\nok\r\n', bom: true, eol: 'crlf' });
    const lines = Array.from({ length: 300 }, (_, i) => `row ${i}\n`).join('');
    env.write(join(env.proj, 'long16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines, 'utf16le')]));
    expect((await readAllWindows('long16.txt', 1000)).text).toBe(lines);
  });

  it('a UTF-16 offset inside a surrogate pair skips to the next whole character', async () => {
    env = fpEnv();
    // BOM, two emoji (a high and a low surrogate each), a newline: the low halves sit at bytes 4 and 8.
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('😀😁\n', 'utf16le')]);
    const be = Buffer.from(le);
    be.swap16();
    env.write(join(env.proj, 'emoji-le.txt'), le);
    env.write(join(env.proj, 'emoji-be.txt'), be);
    for (const name of ['emoji-le.txt', 'emoji-be.txt']) {
      expect(await ok(name, 2), name).toMatchObject({ text: '😀😁\n', offset: 2, next: null });
      for (const offset of [4, 5]) {
        expect(await ok(name, offset), `${name} at ${offset}`).toMatchObject({ text: '😁\n', offset: 6, next: null });
      }
      // A window too small for the pair after the skipped half still moves forward by that pair.
      expect(await ok(name, 4, 2), `${name} small`).toMatchObject({ text: '😁', offset: 6, next: 10 });
    }
  });

  it('CRLF, LF and mixed line ends', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'crlf.txt'), 'a\r\nb\r\n');
    env.write(join(env.proj, 'mixed.txt'), 'a\r\nb\nc\n');
    expect((await ok('crlf.txt')).eol).toBe('crlf');
    expect((await ok('mixed.txt')).eol).toBe('mixed');
    expect((await ok('README.md')).eol).toBe('lf');
  });
});

describe('warnings', () => {
  it('bidi controls, zero-width marks and a non-leading U+FEFF', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'trojan.ts'), 'const a = "\u202e";\n');
    env.write(join(env.proj, 'zw.ts'), 'const a\u200b = 1;\n');
    env.write(join(env.proj, 'feff.ts'), 'a\ufeffb\n');
    for (const f of ['trojan.ts', 'zw.ts', 'feff.ts']) expect((await ok(f)).warnings, f).toEqual(['bidi']);
  });

  it('minified: an average line over 500 characters', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'min.css'), `${'a{b:c}'.repeat(100)}\n`);
    env.write(join(env.proj, 'short.css'), 'a{b:c}\n'.repeat(100));
    expect((await ok('min.css')).warnings).toEqual(['minified']);
    expect((await ok('short.css')).warnings).toEqual([]);
  });
});

describe('kinds and languages (Maps, never object keys)', () => {
  it('names that are Object.prototype keys resolve to nothing special and never throw', async () => {
    env = fpEnv();
    for (const name of ['constructor', '__proto__', 'toString', 'x.constructor', 'y.__proto__', 'z.hasOwnProperty']) {
      expect(kindOf(name), name).toBeNull();
      env.write(join(env.proj, name), 'plain\n');
      const st = await env.files.stat({ root: 'r.proj', path: name }, PHONE);
      if (isRefusal(st)) throw new Error(st.refused);
      expect(st, name).toEqual({ type: 'file', size: 6, mtime: expect.any(String), kind: 'text' });
      const w = await ok(name);
      expect(w.language, name).toBeUndefined();
    }
    env.write(join(env.proj, '__proto__.md'), '# hi\n');
    expect(await env.files.stat({ root: 'r.proj', path: '__proto__.md' }, PHONE)).toMatchObject({ kind: 'markdown', language: 'markdown' });
  });

  it('stat gives the viewer kind: from the name for images, PDF and known binaries, sniffed for the rest', async () => {
    env = fpEnv();
    const files: Record<string, string | Buffer> = {
      'a.md': '# x\n',
      'b.svg': '<svg/>\n',
      'c.ipynb': '{}\n',
      'd.png': 'not really a png',
      'e.pdf': '%PDF-1.7\n',
      'f.zip': 'PK',
      'g.weird': 'hello\n',
      'h.weird': Buffer.from([1, 0, 2]),
      'i.ts': Buffer.from([0, 0, 0]),
      Makefile: 'all:\n',
      'j.txt': '',
    };
    for (const [n, c] of Object.entries(files)) env.write(join(env.proj, 'kinds', n), c);
    const kind = async (n: string) => {
      const st = await env.files.stat({ root: 'r.proj', path: `kinds/${n}` }, PHONE);
      if (isRefusal(st)) throw new Error(st.refused);
      return [st.kind, st.language];
    };
    expect(await kind('a.md')).toEqual(['markdown', 'markdown']);
    expect(await kind('b.svg')).toEqual(['svg', 'markup']);
    expect(await kind('c.ipynb')).toEqual(['notebook', 'json']);
    expect(await kind('d.png')).toEqual(['image', undefined]);
    expect(await kind('e.pdf')).toEqual(['pdf', undefined]);
    expect(await kind('f.zip')).toEqual(['binary', undefined]);
    expect(await kind('g.weird')).toEqual(['text', undefined]);
    expect(await kind('h.weird')).toEqual(['binary', undefined]);
    expect(await kind('i.ts')).toEqual(['binary', undefined]);
    expect(await kind('Makefile')).toEqual(['text', 'makefile']);
    expect(await kind('j.txt')).toEqual(['text', undefined]);
    const dir = await env.files.stat({ root: 'r.proj', path: 'kinds' }, PHONE);
    expect(dir).toMatchObject({ type: 'dir', size: 0 });
  });
});

describe('GET /v1/files/text and /v1/files/stat', () => {
  it('JSON windows with no-store; refusals map to 403, 413, 415 and 400', async () => {
    env = fpEnv();
    env.write(join(env.proj, 'notes.txt'), `${KEY_BEGIN}\n${SECRET_MARKER}\n`);
    env.write(join(env.proj, 'bin.dat'), Buffer.from([0, 1, 2]));
    const big = join(env.proj, 'big.log');
    writeFileSync(big, '');
    truncateSync(big, TEXT_MAX_FILE + 1);
    api = await makeApi({
      ctx: { userHome: env.home, home: join(env.home, '.jantar'), settings: env.ctx.settings.get() },
      deps: (ctx, fakes) => ({ files: buildFilesService(ctx, { sessions: fakes.sessions, notifiers: fakes.notifiers }) }),
    });
    const { cookie } = await pairCookie(api);
    const get = (url: string) => api!.tcp.inject({ method: 'GET', url, headers: h(cookie) });
    const w = await get('/v1/files/text?root=r.proj&path=src%2Fapp.ts');
    expect(w.statusCode).toBe(200);
    expect(w.headers['cache-control']).toBe('no-store');
    expect(w.headers['content-type']).toMatch(/^application\/json/);
    expect(FileTextSchema.parse(w.json()).text).toBe('export const answer = 42;\n');
    const st = await get('/v1/files/stat?root=r.proj&path=src%2Fapp.ts');
    expect(FileStatSchema.parse(st.json())).toMatchObject({ kind: 'text', language: 'typescript' });
    const code = async (url: string) => {
      const r = await get(url);
      expect(r.body).not.toContain(SECRET_MARKER);
      return [r.statusCode, r.json().error?.code];
    };
    expect(await code('/v1/files/text?root=r.proj&path=notes.txt')).toEqual([403, 'forbidden']);
    expect(await code('/v1/files/text?root=r.proj&path=.env')).toEqual([403, 'forbidden']);
    expect(await code('/v1/files/text?root=r.proj&path=big.log')).toEqual([413, 'payload_too_large']);
    expect(await code('/v1/files/text?root=r.proj&path=bin.dat')).toEqual([415, 'unsupported_media_type']);
    // F1 over HTTP: %2e%2e is decoded once by the query parser, then refused.
    expect(await code('/v1/files/text?root=r.proj&path=%2e%2e%2f%2e%2e%2f.ssh%2fid_rsa')).toEqual([400, 'invalid_request']);
    expect(await code('/v1/files/text?root=r.proj&path=%2Fetc%2Fpasswd')).toEqual([400, 'invalid_request']);
    expect(await code('/v1/files/text?root=r.proj&path=a%00b')).toEqual([400, 'invalid_request']);
    expect(await code('/v1/files/text?root=r.proj&path=src%5Capp.ts')).toEqual([400, 'invalid_request']);
    expect(await code('/v1/files/text?root=r.proj&path=src%2Fapp.ts&max=524289')).toEqual([400, 'invalid_request']);
    expect(await code('/v1/files/stat?root=r.proj&path=gone.ts')).toEqual([404, 'not_found']);
  });
});
