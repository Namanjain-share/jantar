/**
 * v0.8 (Intel reads links): the fake claude's read modes, run as a process
 * the way the daemon runs it (`claude -p --input-format stream-json
 * --output-format stream-json --verbose --system-prompt-file
 * <dir>/read-v1.md`, one user message with text and image blocks on stdin),
 * and the fake yt-dlp (single-file formats only, forbidden options
 * refused). Every value synthetic.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST_MARKER, TINY_JPEG_DATA_URL, makeFakeHome, setFakeClaude, writeFakeYtDlp, type FakeClaudeMode, type FakeHome } from '../src/index.js';
import { sh } from './run.js';

let home: FakeHome;
let ARGS: string[] = [];
beforeAll(async () => {
  home = await makeFakeHome({ sessions: [] });
  const promptFile = join(home.root, 'intel', 'read-v1.md');
  await mkdir(dirname(promptFile), { recursive: true });
  await writeFile(promptFile, 'You summarise one saved post.\n');
  ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--fallback-model', 'haiku', '--tools', '', '--system-prompt-file', promptFile];
});
afterAll(async () => {
  await home.cleanup();
});
beforeEach(async () => {
  await home.clearCalls();
  await setFakeClaude(home, {});
});

const CAPTION = `Three ways to cook dal at home tonight ${POST_MARKER} with turmeric`;

/** The daemon's one stdin line: tagged text, a label, a picture. */
function stdinLine(images = 1): string {
  const content: unknown[] = [{ type: 'text', text: `<item>\nplatform: instagram\ntype: reel\n</item>\n<caption>\n${CAPTION.replace(/<\/caption/g, '<\\/caption')}\n</caption>` }];
  for (let i = 0; i < images; i++) content.push({ type: 'text', text: `Frame ${i + 1} of ${images}` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: TINY_JPEG_DATA_URL.split(',')[1] } });
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })}\n`;
}

async function read(mode?: FakeClaudeMode, args = ARGS, images = 2) {
  if (mode) await setFakeClaude(home, { mode });
  const r = await sh(home, home.bins.claude, args, stdinLine(images));
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { ...r, lines, init: lines[0], result: lines.find((l) => l.type === 'result') as { result: string; is_error: boolean } | undefined };
}

describe('the read modes', () => {
  it('read-ok: the init line without tools, then the answer with the caption, counting the pictures', async () => {
    const r = await read();
    expect(r.code).toBe(0);
    expect(r.init).toMatchObject({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
    const answer = JSON.parse(r.result?.result ?? '{}');
    expect(answer).toMatchObject({ title: 'Three ways to cook dal at home tonight', tags: ['saved', 'synthetic'] });
    expect(answer.summary).toContain('Shown 2 pictures.');
    expect(answer.summary).toContain(POST_MARKER);
  });

  it('read-fence, read-bad-json (the caption on stderr), read-no-title, read-hostile', async () => {
    expect((await read('read-fence')).result?.result).toMatch(/^```json\n\{/);
    const bad = await read('read-bad-json');
    expect(() => JSON.parse(bad.result?.result ?? '')).toThrow();
    expect(bad.stderr).toContain(POST_MARKER);
    expect(JSON.parse((await read('read-no-title')).result?.result ?? '{}')).not.toHaveProperty('title');
    const hostile = JSON.parse((await read('read-hostile')).result?.result ?? '{}');
    expect(hostile.title).toContain('https://evil.example');
    expect(hostile.points).toHaveLength(9);
    expect(hostile).toHaveProperty('extra');
  });

  it('read-refuse-input refuses --input-format with claude\'s words; without it answers read-ok', async () => {
    const refused = await read('read-refuse-input');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe("error: unknown option '--input-format'\n");
    const text = ARGS.filter((a, i) => a !== '--input-format' && ARGS[i - 1] !== '--input-format').map((a) => (a === 'stream-json' ? 'json' : a));
    const plain = await sh(home, home.bins.claude, text, '<caption>\nA plain text retry\n</caption>');
    expect(plain.code).toBe(0);
  });

  it('read-init-tools: the init line lists tools and an MCP server', async () => {
    const r = await read('read-init-tools');
    expect(r.init).toMatchObject({ tools: ['Bash', 'Read', 'WebFetch'], mcp_servers: [{ name: 'synthetic', status: 'connected' }] });
  });
});

describe('the fake yt-dlp', () => {
  const ytArgs = (dir: string, mode: string[]) => ['--ignore-config', '--no-plugin-dirs', '--no-cookies', '--no-cookies-from-browser', '--no-cache-dir', '--use-extractors', 'Instagram', '--no-playlist', '-P', dir, '-o', 'media.%(ext)s', '--print', 'after_move:filepath', ...mode, '--', 'https://www.instagram.com/reel/AbC123xyz/'];

  it('a single-file video: an ftyp file in the job dir, its path printed; metadata; captions', async () => {
    const bin = await writeFakeYtDlp(home.root, join(home.home, '.local', 'bin'));
    const job = join(home.root, 'job');
    await mkdir(job, { recursive: true });
    const video = await sh(home, bin, ytArgs(job, ['-f', 'b[ext=mp4][vcodec^=avc1][acodec!=none][protocol^=http]/b[ext=mp4][acodec!=none][protocol^=http]']));
    expect(video.stdout.trim()).toBe(join(job, 'media.mp4'));
    expect((await readFile(join(job, 'media.mp4'))).subarray(4, 8).toString('latin1')).toBe('ftyp');
    const meta = JSON.parse((await sh(home, bin, ytArgs(job, ['--skip-download', '-J']))).stdout);
    expect(meta).toMatchObject({ title: 'A synthetic video', duration: 42, language: 'en' });
    await sh(home, bin, ytArgs(job, ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-format', 'json3', '--sub-langs', 'en-orig,en']));
    expect(JSON.parse(await readFile(join(job, 'media.en.json3'), 'utf8')).events).toHaveLength(2);
    expect((await sh(home, bin, ['--version'])).stdout).toBe('2026.10.01\n');
  });

  it('refuses a merge, cookies, exec, the generic extractor', async () => {
    const bin = await writeFakeYtDlp(home.root, join(home.home, '.local', 'bin'));
    for (const args of [['--use-extractors', 'Instagram', '-f', 'bv+ba', '--', 'x'], ['--use-extractors', 'Instagram', '--cookies-from-browser', 'chrome', '--', 'x'], ['--use-extractors', 'Instagram', '--exec', 'echo', '--', 'x'], ['--use-extractors', 'generic', '--', 'x'], ['--', 'x']]) {
      const r = await sh(home, bin, args);
      expect(r.code, args.join(' ')).toBe(2);
    }
  });
});
