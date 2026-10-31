/**
 * A folder's past conversations for Resume (v0.4 spec 4.10) and security
 * rule LL3: history opens only regular `<uuid>.jsonl` files in
 * `projects/<encoded folder>/` (never a symlink, a FIFO or another name),
 * at most LAUNCH_HISTORY_LIMIT of them, reads at most 64 KiB of each, and
 * masks e-mail addresses and tokens in the first line. The transcripts are
 * written by the fixtures' writePastSessions on a synthetic home.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAST_SECRET_EMAIL, PAST_SECRET_TOKEN, PAST_SESSIONS, makeFakeHome, writePastSessions, type FakeHome } from '@jantar/fixtures';
import { LAUNCH_HISTORY_LIMIT, LaunchHistoryResponseSchema, type AccountsMode } from '@jantar/protocol';
import type { FileRefusalCode } from '../../src/contracts.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { HISTORY_READ_BYTES, firstLineOf, launchHistory, pastFile, pastFiles, pastSessions, type HistoryDeps } from '../../src/launcher/history.js';
import { fsx } from '../../src/sources/lib/fsx.js';
import * as fsxModule from '../../src/sources/lib/fsx.js';
import { accountForProfileDir } from '../../src/sources/lib/cswap-files.js';
import { encodeProjectDir } from '../../src/sources/transcripts/reader.js';
import { FakePolicy, device, session } from './helpers.js';

let home: FakeHome;
let folder: string;

beforeEach(async () => {
  home = await makeFakeHome({ sessions: [] });
  folder = join(home.home, 'Desktop', 'work', 'foo');
  await mkdir(folder, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await home.cleanup();
});

/** The history's deps on the fake home: profiles map to accounts by their "<n>-" prefix, as cswap names them. */
function deps(mode: AccountsMode = 'cswap'): HistoryDeps & { ctx: TestContext } {
  const ctx = createTestContext({ userHome: home.home, accountsMode: mode });
  return { ctx, sessions: { accountForConfigDir: (dir) => accountForProfileDir(basename(dir), null) } };
}

const [NEWEST, ON_TWO, SECRET] = PAST_SESSIONS.map((s) => s.id) as [string, string, string];
const sharedDir = () => join(home.paths.claudeProjects, encodeProjectDir(folder));
const profileDir = (account: number) => join(home.configDirFor(account), 'projects', encodeProjectDir(folder));

describe('a folder\'s past conversations', () => {
  it('lists the shared dir and profiles\' own dirs, newest first, with the account a profile pins and a masked first line', async () => {
    await writePastSessions(home, folder, PAST_SESSIONS);
    const d = deps();
    const list = await pastSessions(d, folder);
    expect(LaunchHistoryResponseSchema.parse({ sessions: list }).sessions).toEqual(list);
    expect(list).toEqual([
      { id: NEWEST, account: null, lastAt: '2026-01-15T09:30:00.000Z', first: 'fix the push example in the service worker', live: false },
      { id: ON_TWO, account: 2, lastAt: '2026-01-14T18:00:00.000Z', first: 'write tests for the folder browser', live: false },
      { id: SECRET, account: null, lastAt: '2026-01-13T08:15:00.000Z', first: expect.any(String), live: false },
    ]);
    // The command wrapper line (<command-name>/clear) is skipped; only the prompt's first line is kept.
    const secret = list[2]?.first ?? '';
    expect(secret).not.toContain(PAST_SECRET_EMAIL);
    expect(secret).not.toContain(PAST_SECRET_TOKEN);
    expect(secret).toMatch(/^mail o\*+@e\*+\.org the key \[token\] please$/);
    expect(JSON.stringify(list)).not.toContain('keep it short');
  });

  it('marks a conversation that is running now as live; an ended one is not', async () => {
    await writePastSessions(home, folder, PAST_SESSIONS);
    const d = deps();
    d.ctx.store.emit({ type: 'session.added', sid: NEWEST, data: { session: session({ sid: NEWEST, cwd: folder }) } });
    d.ctx.store.emit({ type: 'session.added', sid: SECRET, data: { session: session({ sid: SECRET, cwd: folder, status: 'ended' }) } });
    const list = await pastSessions(d, folder);
    expect(list.map((s) => [s.id, s.live])).toEqual([
      [NEWEST, true],
      [ON_TWO, false],
      [SECRET, false],
    ]);
  });

  it('single mode lists the shared dir only: claude on ~/.claude cannot resume a profile\'s conversation', async () => {
    await writePastSessions(home, folder, PAST_SESSIONS);
    const list = await pastSessions(deps('single'), folder);
    expect(list.map((s) => s.id)).toEqual([NEWEST, SECRET]);
    expect(list.every((s) => s.account === null)).toBe(true);
  });

  it('a profile that shares history (projects is a symlink to the shared dir) is listed once, as shared', async () => {
    await writePastSessions(home, folder, [PAST_SESSIONS[0]!]);
    await symlink(home.paths.claudeProjects, join(home.configDirFor(4), 'projects'));
    expect((await pastSessions(deps(), folder)).map((s) => [s.id, s.account])).toEqual([[NEWEST, null]]);
  });

  it('a profile whose account is unknown is left out (its conversations could not be pinned)', async () => {
    await writePastSessions(home, folder, PAST_SESSIONS);
    const d = deps();
    d.sessions = { accountForConfigDir: () => null };
    expect((await pastSessions(d, folder)).map((s) => s.id)).toEqual([NEWEST, SECRET]);
  });

  it('the same id in two dirs is listed once, at its newest', async () => {
    const id = NEWEST;
    await writePastSessions(home, folder, [{ id, first: 'shared copy', at: '2026-01-10T10:00:00.000Z' }]);
    await writePastSessions(home, folder, [{ id, first: 'profile copy', at: '2026-01-12T10:00:00.000Z', account: 3 }]);
    expect(await pastSessions(deps(), folder)).toEqual([{ id, account: 3, lastAt: '2026-01-12T10:00:00.000Z', first: 'profile copy', live: false }]);
  });

  it('a folder with no history, or no projects dir at all, is an empty list', async () => {
    expect(await pastSessions(deps(), folder)).toEqual([]);
    await rm(home.paths.claudeProjects, { recursive: true, force: true });
    expect(await pastSessions(deps(), folder)).toEqual([]);
  });
});

describe('LL3: what history opens', () => {
  it('only regular <uuid>.jsonl files: a symlink, a FIFO, a dir and other names are skipped and never opened', async () => {
    await writePastSessions(home, folder, [PAST_SESSIONS[0]!]);
    const dir = sharedDir();
    const outside = join(home.root, 'outside-secret.jsonl');
    await writeFile(outside, `${JSON.stringify({ type: 'user', message: { content: 'SECRET OUTSIDE THE PROJECTS DIR' } })}\n`);
    await symlink(outside, join(dir, '0b4e7c4e-aaaa-4aaa-8aaa-00000000000a.jsonl'));
    execFileSync('/usr/bin/mkfifo', [join(dir, '0b4e7c4e-bbbb-4bbb-8bbb-00000000000b.jsonl')]);
    await mkdir(join(dir, '0b4e7c4e-cccc-4ccc-8ccc-00000000000c.jsonl'));
    for (const name of ['notes.jsonl', '0B4E7C4E-1111-4111-8111-000000000001.jsonl', '0b4e7c4e-1111-4111-8111-000000000009.json', 'x0b4e7c4e-1111-4111-8111-000000000009.jsonl']) {
      // Recorded in this folder (on a case-insensitive disk the upper-case name is NEWEST's own file).
      await writeFile(join(dir, name), `${JSON.stringify({ type: 'user', cwd: folder, message: { content: 'not a transcript' } })}\n`);
    }
    const opened = vi.spyOn(fsx, 'openNoFollow');
    const list = await pastSessions(deps(), folder);
    expect(list.map((s) => s.id)).toEqual([NEWEST]);
    expect(opened.mock.calls.map((c) => basename(c[0] as string))).toEqual([`${NEWEST}.jsonl`]);
    expect(JSON.stringify(list)).not.toContain('SECRET OUTSIDE');
  });

  it('a <uuid>.jsonl whose id the schemas refuse (not the RFC variant) is not listed: it could never be started', async () => {
    await writePastSessions(home, folder, [PAST_SESSIONS[0]!]);
    const odd = '0b4e7c4e-1111-1111-1111-000000000001';
    await writeFile(join(sharedDir(), `${odd}.jsonl`), `${JSON.stringify({ type: 'user', message: { content: 'an odd name' } })}\n`);
    const list = await pastSessions(deps(), folder);
    expect(list.map((s) => s.id)).toEqual([NEWEST]);
    expect(LaunchHistoryResponseSchema.safeParse({ sessions: list }).success).toBe(true);
    expect(await pastFile(deps(), folder, odd)).toBeNull();
  });

  it('a symlink in place of the folder\'s own projects dir is not followed', async () => {
    const elsewhere = join(home.root, 'elsewhere');
    await writePastSessions(home, join(elsewhere, 'x'), [PAST_SESSIONS[0]!]);
    await mkdir(home.paths.claudeProjects, { recursive: true });
    await symlink(join(home.paths.claudeProjects, encodeProjectDir(join(elsewhere, 'x'))), sharedDir());
    expect(await pastSessions(deps(), folder)).toEqual([]);
  });

  it(`at most ${LAUNCH_HISTORY_LIMIT}, the newest by mtime`, async () => {
    const specs = Array.from({ length: LAUNCH_HISTORY_LIMIT + 5 }, (_, i) => ({
      id: `0b4e7c4e-0000-4000-8000-${String(i).padStart(12, '0')}`,
      first: `task ${i}`,
      at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 3_600_000).toISOString(),
    }));
    await writePastSessions(home, folder, specs);
    const opened = vi.spyOn(fsx, 'openNoFollow');
    const list = await pastSessions(deps(), folder);
    expect(list).toHaveLength(LAUNCH_HISTORY_LIMIT);
    expect(list[0]?.first).toBe(`task ${LAUNCH_HISTORY_LIMIT + 4}`);
    expect(list.at(-1)?.first).toBe('task 5');
    expect(opened).toHaveBeenCalledTimes(LAUNCH_HISTORY_LIMIT);
    // The start's check reads no first line at all.
    opened.mockClear();
    expect(await pastFiles(deps(), folder)).toHaveLength(LAUNCH_HISTORY_LIMIT);
    expect(opened).not.toHaveBeenCalled();
  });

  it('reads at most 64 KiB of a transcript: a prompt past that has no first line', async () => {
    await writePastSessions(home, folder, [PAST_SESSIONS[0]!]);
    const file = join(sharedDir(), `${NEWEST}.jsonl`);
    const big = JSON.stringify({ type: 'system', content: 'x'.repeat(70 * 1024) });
    const start = JSON.stringify({ type: 'system', cwd: folder, content: 'start' });
    await writeFile(file, `${start}\n${big}\n${JSON.stringify({ type: 'user', cwd: folder, message: { content: 'too far in' } })}\n`);
    const at = new Date('2026-01-15T09:30:00.000Z');
    await utimes(file, at, at);
    const read = vi.spyOn(fsxModule, 'readRange');
    const [only] = await pastSessions(deps(), folder);
    expect(only).toEqual({ id: NEWEST, account: null, lastAt: at.toISOString(), live: false });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[1]).toBe(0);
    expect(read.mock.calls[0]?.[2]).toBe(HISTORY_READ_BYTES);
  });
});

describe("pastFile (a start's check of one id)", () => {
  it('finds a conversation past the newest 20 by its name alone: no dir of the folder is listed, only that copy opened', async () => {
    const newer = Array.from({ length: LAUNCH_HISTORY_LIMIT + 2 }, (_, i) => ({
      id: `0b4e7c4e-0000-4000-8000-${String(i).padStart(12, '0')}`,
      first: `task ${i}`,
      at: new Date(Date.parse('2026-02-01T00:00:00.000Z') + i * 3_600_000).toISOString(),
    }));
    await writePastSessions(home, folder, [...PAST_SESSIONS, ...newer]);
    const d = deps();
    expect((await pastFiles(d, folder)).map((f) => f.id)).not.toContain(NEWEST);
    const listed = vi.spyOn(fsxModule, 'listDir');
    const opened = vi.spyOn(fsx, 'openNoFollow');
    expect(await pastFile(d, folder, NEWEST)).toEqual({ id: NEWEST, account: null, path: join(sharedDir(), `${NEWEST}.jsonl`), mtimeMs: Date.parse('2026-01-15T09:30:00.000Z') });
    expect(await pastFile(d, folder, ON_TWO)).toMatchObject({ id: ON_TWO, account: 2, path: join(profileDir(2), `${ON_TWO}.jsonl`) });
    // Only the cswap profiles are listed (to find their projects dirs), never a folder's transcripts;
    // only the copy found is opened, for the folder it was recorded in.
    expect(listed.mock.calls.map((c) => c[0])).toEqual([home.paths.cswapProfiles, home.paths.cswapProfiles]);
    expect(opened.mock.calls.map((c) => c[0])).toEqual([join(sharedDir(), `${NEWEST}.jsonl`), join(profileDir(2), `${ON_TWO}.jsonl`)]);
  });

  it('the same id in two dirs is the newest copy, as the list has it', async () => {
    await writePastSessions(home, folder, [{ id: NEWEST, first: 'shared copy', at: '2026-01-10T10:00:00.000Z' }]);
    await writePastSessions(home, folder, [{ id: NEWEST, first: 'profile copy', at: '2026-01-12T10:00:00.000Z', account: 3 }]);
    expect(await pastFile(deps(), folder, NEWEST)).toMatchObject({ account: 3, mtimeMs: Date.parse('2026-01-12T10:00:00.000Z') });
  });

  it('null for anything the list would not show: another folder, a symlink, a FIFO, a dir, an odd name or path', async () => {
    await writePastSessions(home, folder, PAST_SESSIONS);
    const dir = sharedDir();
    const outside = join(home.root, 'outside.jsonl');
    await writeFile(outside, '\n');
    const link = '0b4e7c4e-aaaa-4aaa-8aaa-00000000000a';
    const fifo = '0b4e7c4e-bbbb-4bbb-8bbb-00000000000b';
    const asDir = '0b4e7c4e-cccc-4ccc-8ccc-00000000000c';
    await symlink(outside, join(dir, `${link}.jsonl`));
    execFileSync('/usr/bin/mkfifo', [join(dir, `${fifo}.jsonl`)]);
    await mkdir(join(dir, `${asDir}.jsonl`));
    const elsewhere = join(home.home, 'Desktop', 'work', 'bar');
    await writePastSessions(home, elsewhere, [{ id: '0b4e7c4e-dddd-4ddd-8ddd-00000000000d', first: 'another folder', at: '2026-01-15T10:00:00.000Z' }]);
    const opened = vi.spyOn(fsx, 'openNoFollow');
    for (const id of [link, fifo, asDir, '0b4e7c4e-dddd-4ddd-8ddd-00000000000d', NEWEST.toUpperCase(), `../${NEWEST}`, `${NEWEST}.jsonl`, '', 'last']) {
      expect(await pastFile(deps(), folder, id), id).toBeNull();
    }
    expect(opened).not.toHaveBeenCalled();
  });

  it("a symlink in place of the folder's own dir is not followed; single mode sees the shared dir only", async () => {
    const elsewhere = join(home.root, 'elsewhere');
    await writePastSessions(home, join(elsewhere, 'x'), [PAST_SESSIONS[0]!]);
    await mkdir(home.paths.claudeProjects, { recursive: true });
    await symlink(join(home.paths.claudeProjects, encodeProjectDir(join(elsewhere, 'x'))), sharedDir());
    expect(await pastFile(deps(), folder, NEWEST)).toBeNull();
    await rm(sharedDir());
    await writePastSessions(home, folder, PAST_SESSIONS);
    expect(await pastFile(deps('single'), folder, ON_TWO)).toBeNull();
    expect(await pastFile(deps('single'), folder, NEWEST)).toMatchObject({ account: null });
  });
});

describe('folders whose Claude dir names collide', () => {
  // ~/Desktop/work/private and ~/Desktop/work-private both become "-…-Desktop-work-private".
  it("lists and resumes only what was recorded in this folder, never a colliding one's", async () => {
    const other = join(home.home, 'Desktop', 'work-private');
    const here = join(home.home, 'Desktop', 'work', 'private');
    await mkdir(here, { recursive: true });
    expect(encodeProjectDir(other)).toBe(encodeProjectDir(here));
    await writePastSessions(home, other, [{ id: NEWEST, first: 'from the other folder', at: '2026-01-15T09:30:00.000Z' }]);
    await writePastSessions(home, here, [{ id: ON_TWO, first: 'from this folder', at: '2026-01-14T09:30:00.000Z' }]);
    const d = deps();
    expect((await pastSessions(d, here)).map((s) => s.first)).toEqual(['from this folder']);
    expect((await pastSessions(d, other)).map((s) => s.first)).toEqual(['from the other folder']);
    expect(await pastFile(d, here, NEWEST)).toBeNull();
    expect(await pastFile(d, here, ON_TWO)).toMatchObject({ id: ON_TWO });
  });

  it('leaves out a transcript that names no folder in its first 64 KiB', async () => {
    await mkdir(sharedDir(), { recursive: true });
    await writeFile(join(sharedDir(), `${NEWEST}.jsonl`), `${JSON.stringify({ type: 'user', message: { content: 'no cwd here' } })}\n`);
    expect(await pastSessions(deps(), folder)).toEqual([]);
    expect(await pastFile(deps(), folder, NEWEST)).toBeNull();
  });
});

describe('the first line', () => {
  const line = (e: unknown) => JSON.stringify(e);
  const user = (content: unknown, over: Record<string, unknown> = {}) => line({ type: 'user', message: { role: 'user', content }, ...over });

  it('skips wrappers, meta entries, tool results and sidechains; takes the first non-empty line of the prompt', () => {
    const head = [
      line({ type: 'permission-mode', permissionMode: 'default' }),
      user('<command-name>/model</command-name>'),
      user('  <local-command-stdout>ok</local-command-stdout>'),
      user('Caveat: meta', { isMeta: true }),
      user('from a subagent', { isSidechain: true }),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'output' }]),
      'not json at all',
      user([{ type: 'image' }, { type: 'text', text: '\n\n  refactor the parser  \nthen run the tests' }]),
    ].join('\n');
    expect(firstLineOf(head)).toBe('refactor the parser');
  });

  it('masks e-mail addresses and tokens, drops control characters, and cuts to 80 with an ellipsis', () => {
    expect(firstLineOf(user(`ask ${PAST_SECRET_EMAIL} about ${PAST_SECRET_TOKEN}`))).toMatch(/^ask o\*+@e\*+\.org about \[token\]$/);
    expect(firstLineOf(user('tab\there and bell\u0007 too'))).toBe('tab here and bell  too');
    const long = firstLineOf(user('word '.repeat(40))) ?? '';
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
    // Counted as the schema counts (UTF-16), never cutting a surrogate pair.
    const emoji = firstLineOf(user('🙂'.repeat(60))) ?? '';
    expect(emoji.length).toBeLessThanOrEqual(80);
    expect(emoji.endsWith('🙂…')).toBe(true);
  });

  it('none when nothing the user typed is there', () => {
    expect(firstLineOf('')).toBeUndefined();
    expect(firstLineOf(user('<command-name>/clear</command-name>'))).toBeUndefined();
    expect(firstLineOf(user('   '))).toBeUndefined();
  });
});

describe('launchHistory (the route\'s half)', () => {
  it('goes through the path policy: a folder under a root lists, a refused one is audited by Files and answered', async () => {
    await writePastSessions(home, folder, PAST_SESSIONS);
    const denied: [string, string, FileRefusalCode][] = [];
    const policy = new FakePolicy([{ id: 'r.work', label: 'work', real: join(home.home, 'Desktop', 'work'), display: '~/Desktop/work' }]);
    const d = { ...deps(), files: { policy, denied: (_a: unknown, root: string, rel: string, why: FileRefusalCode) => void denied.push([root, rel, why]) } };
    const r = await launchHistory(d, { root: 'r.work', path: 'foo' }, device());
    expect(r.ok && r.sessions.map((s) => s.id)).toEqual([NEWEST, ON_TWO, SECRET]);
    expect(await launchHistory(d, { root: 'r.work', path: '../../..' }, device())).toEqual({ ok: false, code: 'invalid_request', reason: 'bad path' });
    expect(await launchHistory(d, { root: 'r.work', path: '.ssh' }, device())).toEqual({ ok: false, code: 'forbidden', reason: 'that folder is protected' });
    expect(await launchHistory(d, { root: 'r.nope', path: '' }, device())).toEqual({ ok: false, code: 'not_found', reason: 'no such root' });
    expect(denied).toEqual([
      ['r.work', '../../..', 'bad_path'],
      ['r.work', '.ssh', 'protected'],
      ['r.nope', '', 'no_root'],
    ]);
  });
});
