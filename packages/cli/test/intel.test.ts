/**
 * jantar intel on a synthetic HOME, against an in-memory daemon whose
 * settings routes apply patches as the real one does. LI1 (CLI part):
 * `source add` refuses a relative path, a directory, a file that is not
 * .jsonl, one over 50 MB and any path the Files denylist protects, given or
 * real, and writes nothing then; it prints the id the phone will see.
 * `add` sends a capture with the folder it runs in; `list` and `sources`
 * read the daemon, `sources` printing paths from the local config only.
 */
import { mkdir, readFile, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeHome, writeIntelJsonl, type FakeHome } from '@jantar/fixtures';
import { INTEL_SOURCE_MAX_BYTES, type IntelListResponse, type IntelSource } from '@jantar/protocol';
import intel from '../src/commands/intel.js';
import { EXIT } from '../src/command.js';
import { contextFor, fail, fakeCtl, fakeSettings, ok, type CtlCall } from './helpers.js';

let home: FakeHome;
let bot: string;

beforeEach(async () => {
  home = await makeFakeHome({ sessions: [] });
  bot = join(home.home, 'bot');
  await mkdir(bot, { recursive: true });
});

afterEach(async () => {
  await home.cleanup();
});

function daemon(start: Record<string, unknown> = {}, routes: Parameters<typeof fakeCtl>[0] = {}) {
  const s = fakeSettings(start);
  return { s, ctl: fakeCtl({ ...s.routes, ...routes }) };
}

async function run(args: string[], ctl: ReturnType<typeof fakeCtl>) {
  const c = contextFor(home, { ctl });
  const code = await intel.run(args, c.ctx);
  return { code, out: c.io.stdout, err: c.io.stderr };
}

describe('on and off', () => {
  it('patch intel.enabled through the daemon and say what changed', async () => {
    const { s, ctl } = daemon();
    const on = await run(['on'], ctl);
    expect(on.code).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ intel: { enabled: true } }]);
    expect(on.out).toContain('The Intel shelf is on.');
    expect(on.out).toContain('Add a JSONL file: jantar intel source add <file.jsonl>');
    const off = await run(['off'], ctl);
    expect(off.code).toBe(EXIT.ok);
    expect(s.settings.intel.enabled).toBe(false);
    expect(off.out).toContain('The Intel shelf is off.');
    for (const bad of [[], ['maybe'], ['on', 'now'], ['off', '--url', 'https://example.com'], ['source'], ['source', 'frob', 'x'], ['list', 'extra']]) {
      expect((await run(bad, ctl)).code, bad.join(' ')).toBe(EXIT.usage);
    }
    expect(s.patches).toHaveLength(2);
  });

  it('writes config.json when the daemon is not running', async () => {
    const { ctx, io } = contextFor(home);
    expect(await intel.run(['on'], ctx)).toBe(EXIT.ok);
    const config = JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8'));
    // v0.8: reading links stays off, with its speech language.
    expect(config.intel).toEqual({ enabled: true, sources: [], read: false, speechLocale: 'en-IN' });
    expect(io.stdout).toContain('Saved to config.json');
  });
});

describe('LI1: source add refuses what the daemon would refuse', () => {
  it('a relative path, a directory, a non-.jsonl file, one over 50 MB, and protected paths given or real: nothing is written', async () => {
    const { s, ctl } = daemon();
    await mkdir(join(bot, 'folder.jsonl'));
    await writeFile(join(bot, 'notes.txt'), 'x\n');
    await symlink(join(bot, 'notes.txt'), join(bot, 'looks-right.jsonl'));
    await writeFile(join(bot, 'big.jsonl'), '');
    await truncate(join(bot, 'big.jsonl'), INTEL_SOURCE_MAX_BYTES + 1);
    await mkdir(join(home.home, '.ssh'), { recursive: true });
    await writeFile(join(home.home, '.ssh', 'intel.jsonl'), '{"title":"x"}\n');
    await symlink(join(home.home, '.ssh', 'intel.jsonl'), join(bot, 'innocent.jsonl'));
    await writeFile(join(bot, '.env.jsonl'), '{"title":"x"}\n');

    const relative = await run(['source', 'add', 'bot/intel.jsonl'], ctl);
    expect(relative.code).toBe(EXIT.usage);
    expect(relative.err).toContain('is relative');
    const cases: [string, string][] = [
      [join(bot, 'folder.jsonl'), 'Not a .jsonl file'],
      [join(bot, 'notes.txt'), 'Not a .jsonl file'],
      [join(bot, 'looks-right.jsonl'), 'Not a .jsonl file'],
      [join(bot, 'big.jsonl'), 'Larger than 50 MB'],
      [join(home.home, '.ssh', 'intel.jsonl'), 'Protected by the secrets list'],
      ['~/.ssh/intel.jsonl', 'Protected by the secrets list'],
      [join(bot, 'innocent.jsonl'), 'Protected by the secrets list'],
      [join(bot, '.env.jsonl'), 'Protected by the secrets list'],
      [join(home.jantarHome, 'intel', 'captures.jsonl'), 'Protected by the secrets list'],
      [join(bot, 'missing.jsonl'), "Can't be read"],
    ];
    for (const [path, sentence] of cases) {
      const r = await run(['source', 'add', path], ctl);
      expect(r.code, path).toBe(EXIT.failed);
      expect(r.err, path).toContain(`not added: ${sentence}`);
    }
    expect(s.patches).toEqual([]);
  });

  it('adds a good file and prints the id the phone sees; a clash is numbered; a repeat adds nothing', async () => {
    const { s, ctl } = daemon();
    const a = join(bot, 'intel.jsonl');
    const b = join(home.home, 'other', 'Intel.jsonl');
    await writeIntelJsonl(a, { count: 2 });
    await writeIntelJsonl(b, { count: 2 });
    const first = await run(['source', 'add', a], ctl);
    expect(first.code).toBe(EXIT.ok);
    expect(first.out).toContain('Added source intel · ~/bot/intel.jsonl');
    expect(first.out).toContain('The shelf is off. Turn it on: jantar intel on');
    const second = await run(['source', 'add', '~/other/Intel.jsonl'], ctl);
    expect(second.out).toContain('Added source intel-2 · ~/other/Intel.jsonl');
    expect(s.settings.intel.sources).toEqual([a, b]);
    const again = await run(['source', 'add', a], ctl);
    expect(again.code).toBe(EXIT.ok);
    expect(again.out).toContain('is already a source (intel)');
    // Through a symlink to the same file: still the same source.
    await symlink(a, join(home.home, 'alias.jsonl'));
    expect((await run(['source', 'add', join(home.home, 'alias.jsonl')], ctl)).out).toContain('is already a source (intel)');
    expect(s.patches).toHaveLength(2);
  });

  it('keeps at most 10 sources', async () => {
    const paths = Array.from({ length: 10 }, (_, i) => join(bot, `s${i}.jsonl`));
    for (const p of paths) await writeFile(p, '{"title":"x"}\n');
    const { s, ctl } = daemon({ intel: { sources: paths } });
    await writeFile(join(bot, 'one-more.jsonl'), '{"title":"x"}\n');
    const r = await run(['source', 'add', join(bot, 'one-more.jsonl')], ctl);
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toContain('there are already 10 sources');
    expect(s.patches).toEqual([]);
  });

  it('source rm takes the id or the path; an unknown one changes nothing', async () => {
    const a = join(bot, 'intel.jsonl');
    const b = join(home.home, 'other', 'intel.jsonl');
    const { s, ctl } = daemon({ intel: { sources: [a, b] } });
    const gone = await run(['source', 'rm', 'intel-2'], ctl);
    expect(gone.code).toBe(EXIT.ok);
    expect(gone.out).toContain('Removed source intel-2 (~/other/intel.jsonl)');
    expect(s.settings.intel.sources).toEqual([a]);
    expect((await run(['source', 'rm', '~/bot/intel.jsonl'], ctl)).code).toBe(EXIT.ok);
    expect(s.settings.intel.sources).toEqual([]);
    const unknown = await run(['source', 'rm', 'nope'], ctl);
    expect(unknown.code).toBe(EXIT.failed);
    expect(unknown.err).toContain('there is no source nope');
  });
});

describe('sources', () => {
  it('prints ids, counts and errors from the daemon and paths from the local config', async () => {
    const a = join(bot, 'intel.jsonl');
    const b = join(bot, 'notes.txt');
    const live: IntelSource[] = [
      { id: 'captures', label: 'captures', items: 2, skipped: 0, updatedAt: null },
      { id: 'intel', label: 'intel', items: 612, skipped: 3, updatedAt: null },
      { id: 'notes-txt', label: 'notes-txt', items: 0, skipped: 0, error: 'Not a .jsonl file', updatedAt: null },
    ];
    const { ctl } = daemon({ intel: { enabled: true, sources: [a, b] } }, { 'GET /v1/intel/sources': ok({ sources: live }) });
    const r = await run(['sources'], ctl);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('Intel shelf: on');
    expect(r.out).toMatch(/captures\s+2 items/);
    expect(r.out).toMatch(/intel\s+612 items, 3 skipped\s+~\/bot\/intel\.jsonl/);
    expect(r.out).toMatch(/notes-txt\s+Not a \.jsonl file\s+~\/bot\/notes\.txt/);
  });

  it('with the shelf off it still says which files would be refused', async () => {
    const a = join(bot, 'intel.jsonl');
    await writeIntelJsonl(a, { count: 1 });
    const { ctl } = daemon(
      { intel: { sources: [a, join(home.home, '.ssh', 'x.jsonl')] } },
      { 'GET /v1/intel/sources': fail('forbidden', 'The Intel shelf is off. Turn it on at your Mac: jantar intel on', 403) },
    );
    const r = await run(['sources'], ctl);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('Intel shelf: off');
    expect(r.out).toMatch(/intel\s+not read yet\s+~\/bot\/intel\.jsonl/);
    expect(r.out).toMatch(/x\s+Protected by the secrets list\s+~\/\.ssh\/x\.jsonl/);
    expect(r.out).toContain('No counts: the shelf is off.');
    expect(r.out).toContain('Turn it on: jantar intel on');
  });
});

describe('add and list', () => {
  it('add sends one capture with its folder and an Idempotency-Key, and says when it was a duplicate', async () => {
    const calls: CtlCall[] = [];
    let duplicate = false;
    const { ctl } = daemon({}, {
      'POST /v1/intel/captures': (call) => {
        calls.push(call);
        const r = ok({ id: 'captures:01JSYNTHCAPTURE00000000000', duplicate });
        duplicate = true;
        return r;
      },
    });
    const r = await run(['add', 'Example', 'capture', '--url', 'https://example.com/new', '--type', 'tool', '--tag', 'example', '--tag', ' hooks ', '--note', 'A synthetic note'], ctl);
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.out).toBe('Added to the shelf: captures:01JSYNTHCAPTURE00000000000\n');
    expect(calls[0]?.body).toEqual({
      title: 'Example capture',
      url: 'https://example.com/new',
      type: 'tool',
      tags: ['example', 'hooks'],
      note: 'A synthetic note',
      cwd: process.cwd(),
    });
    expect(calls[0]?.opts.idempotencyKey).toMatch(/^id-/);
    const again = await run(['add', 'Example'], ctl);
    expect(again.out).toContain('Already on the shelf (captures:01JSYNTHCAPTURE00000000000): nothing added.');
    expect(calls[1]?.body).toEqual({ title: 'Example', cwd: process.cwd() });
  });

  it('refuses a bad capture before calling the daemon; a down daemon exits 3; a shelf that is off says how to turn it on', async () => {
    const { ctl } = daemon();
    for (const [args, why] of [
      [['add'], 'add needs a title'],
      [['add', 'T', '--url', 'javascript:alert(1)'], '--url must be a whole http or https link'],
      [['add', 'T', '--type', 't'.repeat(41)], '--type must be at most 40'],
      [['add', 'T', '--q', 'x'], '--q is not for "intel add"'],
      [['list', '--note', 'x'], '--note is not for "intel list"'],
      [['list', '--limit', '0'], '--limit must be 1 to 100'],
      [['list', '--tag', 'a', '--tag', 'b'], 'list takes one --tag'],
    ] as [string[], string][]) {
      const r = await run(args, ctl);
      expect(r.code, args.join(' ')).toBe(EXIT.usage);
      expect(r.err, args.join(' ')).toContain(why);
    }
    expect(ctl.calls.filter((c) => c.path.startsWith('/v1/intel'))).toEqual([]);
    const down = contextFor(home);
    expect(await intel.run(['add', 'Example'], down.ctx)).toBe(EXIT.daemonDown);
    const off = fakeCtl({ 'POST /v1/intel/captures': fail('forbidden', 'The Intel shelf is off. Turn it on at your Mac: jantar intel on', 403) });
    const r = await run(['add', 'Example'], off);
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toContain('jantar intel on');
  });

  it('list asks with the filters and prints date, type, title and link', async () => {
    const page: IntelListResponse = {
      items: [
        { id: 'intel:ex-2', source: 'intel', at: '2026-10-29T08:02:00.000Z', title: 'Example tool 2', url: 'https://example.com/2', type: 'tool', tags: ['example'] },
        { id: 'captures:01J', source: 'captures', at: null, title: 'No time\u001b[31m', tags: [] },
      ],
      next: 'x',
      total: 7,
      types: [],
      tags: [],
    };
    const { ctl } = daemon({}, { 'GET /v1/intel': ok(page) });
    const r = await run(['list', '--q', 'hooks and more', '--type', 'tool', '--tag', 'example', '--limit', '2'], ctl);
    expect(r.code).toBe(EXIT.ok);
    const call = ctl.calls.find((c) => c.path.startsWith('/v1/intel'));
    expect(call?.path).toBe('/v1/intel?q=hooks+and+more&type=tool&tag=example&limit=2');
    const lines = r.out.split('\n');
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}  tool  Example tool 2$/);
    expect(lines[1]).toBe(`${' '.repeat(18)}https://example.com/2`);
    // No time, no type; the escape sequence in the title never reaches the terminal.
    expect(lines[2]).toBe(`${'-'.padEnd(10)}  ${'-'.padEnd(4)}  No time`);
    expect(lines.slice(3)).toEqual(['2 of 7 items; more with --limit 100', '']);
    // Already at the most one list holds: the hint is to narrow it, never the same --limit.
    const full = daemon({}, { 'GET /v1/intel': ok({ ...page, total: 612 }) });
    expect((await run(['list', '--limit', '100'], full.ctl)).out.split('\n').at(-2)).toBe('2 of 612 items; narrow it with --q, --type or --tag');
    const empty = daemon({}, { 'GET /v1/intel': ok({ ...page, items: [], total: 0 }) });
    expect((await run(['list'], empty.ctl)).out).toBe('Nothing on the shelf yet.\n');
    expect((await run(['list', '--q', 'x'], empty.ctl)).out).toBe('Nothing on the shelf matches.\n');
  });
});
