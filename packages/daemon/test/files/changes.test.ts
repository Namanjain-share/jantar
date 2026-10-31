/**
 * The changed-files index and its routes (v0.3 spec 4.4.8, 8.2.5; decision
 * U9: no git, no diffs). Transcripts with every kind of file op are
 * backfilled, live `files.changed` nudges add to the index, ops are deduped
 * and merged per realpath, a protected file never gets a viewer link (F8),
 * and `filesChanged` follows the Files switch. The index runs on WP-FP's
 * real Files policy; a fake one only stages what the real one can't (a
 * policy that throws).
 */
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, realpath, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SECRET_MARKER,
  aliasPair,
  assistantToolUse,
  encodeProjectDir,
  fileOpsScenario,
  markersIn,
  timeline,
  toJsonl,
  toolResult,
  userPrompt,
  type Entry,
  type EntryContext,
} from '@jantar/fixtures';
import {
  FileChangeSchema,
  FilesChangesResponseSchema,
  SessionChangeResponseSchema,
  SessionChangesResponseSchema,
  SettingsSchema,
  type DaemonEvent,
  type FileChange,
  type Session,
} from '@jantar/protocol';
import type { ChangesService, FileRefusal, FilesService } from '../../src/contracts.js';
import { buildChangesService, privateSpelling, type ChangesIndex, type ChangesOptions } from '../../src/files/changes.js';
import { buildFilesService } from '../../src/files/service.js';
import { createTestContext, notBuiltParts, type TestContext } from '../../src/core/testing.js';
import { fsx } from '../../src/sources/lib/fsx.js';
import { changeIdFor } from '../../src/sources/transcripts/file-changes.js';
import { createFileTranscriptReader, type FileTranscriptReader } from '../../src/sources/transcripts/index.js';
import { FakeSessions, h, makeApi, makeSession, pairCookie, type TestApi } from '../api/fakes.js';

const FILES_ON = SettingsSchema.parse({ files: { enabled: true } });
const NOW = Date.parse('2026-01-15T10:00:00.000Z');
const SID = 'sess-fc-0001';
const SID2 = 'sess-fc-0002';
const TICK_MS = 100;

const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected.";
const HOOK_BLOCKED = 'PreToolUse:Write hook error: [./hooks/guard.sh]: no writes to src/blocked.ts';

// ---------------------------------------------------------------------------
// A temp dir with a HOME in it, a project, its transcripts, and the Files policy.

interface Env {
  /** The temp dir: outside HOME, so under /private/var on macOS it is protected, as /tmp is. */
  dir: string;
  /** $HOME (dir/home, or the given context's). */
  home: string;
  ctx: TestContext;
  /** The session's cwd (HOME/work/app, root r.work). */
  work: string;
  /** The Files service, its FilePolicy.locate calls recorded. */
  files: FilesService & { located: string[] };
  reader: FileTranscriptReader;
  svc: ChangesIndex;
  events: DaemonEvent[];
  addSession(sid: string, over?: Partial<Session>): Session;
  transcript(sid: string): string;
  subTranscript(sid: string, name: string): string;
  append(path: string, entries: readonly Entry[] | string): Promise<{ before: number }>;
  /** Run background ticks (and due timers) until the index is quiet. */
  settle(rounds?: number): Promise<void>;
  close(): Promise<void>;
}

/** WP-FP's Files service on the test context; its locate calls are recorded. */
function realFiles(ctx: TestContext): FilesService & { located: string[] } {
  const files = buildFilesService(ctx, { sessions: new FakeSessions(), notifiers: [] });
  const located: string[] = [];
  const policy = files.policy;
  const locate = policy.locate.bind(policy);
  policy.locate = async (abs) => {
    located.push(abs);
    return locate(abs);
  };
  return Object.assign(files, { located });
}

/** A fake FilePolicy over one root, for what the real one can't stage (an isProtected that throws). */
function fakeFiles(root: string, isProtected: (p: string) => boolean): FilesService & { located: string[] } {
  const base = notBuiltParts().files;
  const located: string[] = [];
  const refuse = (refused: FileRefusal['refused']): FileRefusal => ({ refused, message: refused });
  return {
    ...base,
    located,
    policy: {
      ...base.policy,
      isProtected,
      underRoot: async (abs: string) => abs === root || abs.startsWith(`${root}/`),
      locate: async (abs: string) => {
        located.push(abs);
        if (isProtected(abs)) return refuse('protected');
        let real: string;
        try {
          real = realpathSync(abs);
        } catch {
          return refuse('missing');
        }
        const rel = relative(root, real);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return refuse('outside');
        return { rootId: 'r.work', rel };
      },
    },
  };
}

async function makeEnv(opts: { svc?: ChangesOptions; ctx?: TestContext; isProtected?: (p: string) => boolean } = {}): Promise<Env> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ccw-fc-')));
  const home = opts.ctx?.paths.userHome ?? join(dir, 'home');
  const work = join(home, 'work', 'app');
  await mkdir(work, { recursive: true });
  const settings = SettingsSchema.parse({ files: { enabled: true }, folders: { roots: [{ id: 'work', path: work, label: 'app' }] } });
  const ctx = opts.ctx ?? createTestContext({ userHome: home, settings });
  ctx.clock.set(NOW);
  const files = opts.isProtected ? fakeFiles(work, opts.isProtected) : realFiles(ctx);
  const reader = createFileTranscriptReader(ctx);
  const svc = buildChangesService(ctx, { sessions: new FakeSessions(), transcripts: reader, files }, { tickMs: TICK_MS, ...opts.svc });
  const events: DaemonEvent[] = [];
  const unsub = ctx.store.subscribe((ev) => events.push(ev));
  const env: Env = {
    dir,
    home,
    ctx,
    work,
    files,
    reader,
    svc,
    events,
    addSession(sid, over = {}) {
      const s = makeSession({ sid, cwd: work, folder: 'app', configDir: join(home, 'profile'), account: 7, ...over });
      ctx.store.emit({ type: 'session.added', sid, ...(s.account !== null ? { account: s.account } : {}), data: { session: s } });
      return s;
    },
    transcript: (sid) => join(ctx.paths.claudeProjects, encodeProjectDir(work), `${sid}.jsonl`),
    subTranscript: (sid, name) => join(ctx.paths.claudeProjects, encodeProjectDir(work), sid, 'subagents', name),
    async append(path, entries) {
      await mkdir(dirname(path), { recursive: true });
      const before = await fsx.stat(path).then(
        (s) => Number(s.size),
        () => 0,
      );
      await appendFile(path, typeof entries === 'string' ? entries : toJsonl(entries));
      return { before };
    },
    async settle(rounds = 30) {
      for (let i = 0; i < rounds; i++) {
        ctx.clock.advance(TICK_MS);
        await svc.idle();
      }
    },
    async close() {
      unsub();
      await svc.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return env;
}

const ok = (c: EntryContext, id: string, toolUseResult?: unknown): Entry => {
  const e = toolResult(c, id, 'The file has been updated.');
  if (toolUseResult !== undefined) e.toolUseResult = toolUseResult;
  return e;
};
const denied = (c: EntryContext, id: string, text: string): Entry => ({ ...toolResult(c, id, text, true), toolUseResult: `Error: ${text}` });
const patch = (lines: string[]) => [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines }];

/** A Write whose two lines (call and result) are each ~6 MB; `pathFirst` puts file_path before the content. */
function bigWrite(c: EntryContext, id: string, path: string, pathFirst: boolean): string {
  const content = `${'z'.repeat(63)}\n`.repeat(96 * 1024);
  const input = pathFirst ? { file_path: path, content } : { content, file_path: path };
  return toJsonl([assistantToolUse(c, 'Write', input, id), ok(c, id, { type: 'create', filePath: path, content, structuredPatch: [] })]);
}

/**
 * Spec 8.2.5's transcripts (no git-only group, U9): Write create, Edit with a
 * structuredPatch, MultiEdit, NotebookEdit, a rejected Edit, a hook-blocked
 * Write, a subagent Edit, two 6 MB Writes, a relative path, one file by two
 * spellings, and a Write to .env.
 */
async function writeFixture(env: Env, sid = SID): Promise<{ alias: string; real: string }> {
  const { work } = env;
  for (const f of ['src/new.ts', 'src/app.ts', 'src/old.ts', 'src/sub.ts', 'nb.ipynb', 'docs/readme.md', 'big/a.txt', 'big/b.txt', '.env']) {
    await mkdir(dirname(join(work, f)), { recursive: true });
    await writeFile(join(work, f), f === '.env' ? `TOKEN=${SECRET_MARKER}\n` : 'now\n');
  }
  // one file by two spellings through a symlink in the root (outside every root a path is never resolved)
  await mkdir(join(work, 'private', 'tmp'), { recursive: true });
  await symlink(join(work, 'private', 'tmp'), join(work, 'tmp'));
  await writeFile(join(work, 'private', 'tmp', 'x.txt'), 'x\n');
  const alias = join(work, 'tmp', 'x.txt');
  const real = join(work, 'private', 'tmp', 'x.txt');

  const tl = timeline(NOW - 10 * 60_000, sid, work);
  await env.append(env.transcript(sid), [
    assistantToolUse(tl.next(), 'Write', { file_path: `${work}/src/new.ts`, content: 'a\nb\nc\n' }, 'toolu_new'),
    ok(tl.next(), 'toolu_new', { type: 'create', filePath: `${work}/src/new.ts`, content: 'a\nb\nc\n', structuredPatch: [] }),
    assistantToolUse(tl.next(), 'Edit', { file_path: `${work}/src/app.ts`, old_string: 'a', new_string: 'b\nc' }, 'toolu_app1'),
    ok(tl.next(), 'toolu_app1', { filePath: `${work}/src/app.ts`, structuredPatch: patch(['-a', '+b', '+c']) }),
    assistantToolUse(tl.next(), 'MultiEdit', { file_path: `${work}/src/app.ts`, edits: [{ old_string: 'p', new_string: 'q' }] }, 'toolu_app2'),
    ok(tl.next(), 'toolu_app2'),
    assistantToolUse(tl.next(), 'NotebookEdit', { notebook_path: `${work}/nb.ipynb`, cell_id: 'c1', new_source: 'x\ny' }, 'toolu_nb'),
    ok(tl.next(), 'toolu_nb'),
    assistantToolUse(tl.next(), 'Edit', { file_path: `${work}/src/old.ts`, old_string: 'a', new_string: 'b' }, 'toolu_rej'),
    denied(tl.next(), 'toolu_rej', REJECTED),
    assistantToolUse(tl.next(), 'Write', { file_path: `${work}/src/blocked.ts`, content: 'x' }, 'toolu_blk'),
    denied(tl.next(), 'toolu_blk', HOOK_BLOCKED),
    assistantToolUse(tl.next(), 'Write', { file_path: 'docs/readme.md', content: '# readme' }, 'toolu_rel'),
    ok(tl.next(), 'toolu_rel', { type: 'update', structuredPatch: patch(['-now', '+# readme']) }),
    assistantToolUse(tl.next(), 'Write', { file_path: alias, content: 'x\ny\n' }, 'toolu_tmp1'),
    ok(tl.next(), 'toolu_tmp1', { type: 'create', content: 'x\ny\n', structuredPatch: [] }),
    assistantToolUse(tl.next(), 'Edit', { file_path: real, old_string: 'y', new_string: 'z' }, 'toolu_tmp2'),
    ok(tl.next(), 'toolu_tmp2', { structuredPatch: patch(['-y', '+z']) }),
    assistantToolUse(tl.next(), 'Write', { file_path: `${work}/.env`, content: `TOKEN=${SECRET_MARKER}\n` }, 'toolu_env'),
    ok(tl.next(), 'toolu_env', { type: 'create', filePath: `${work}/.env`, content: `TOKEN=${SECRET_MARKER}\n`, structuredPatch: [] }),
  ]);
  await env.append(env.transcript(sid), bigWrite(tl.next(), 'toolu_big_a', `${work}/big/a.txt`, true));
  await env.append(env.transcript(sid), bigWrite(tl.next(), 'toolu_big_b', 'big/b.txt', false));
  const side = { ...tl.next(), isSidechain: true };
  await env.append(env.subTranscript(sid, 'agent-a1.jsonl'), [
    assistantToolUse(side, 'Edit', { file_path: `${work}/src/sub.ts`, old_string: 'a', new_string: 'b' }, 'toolu_sub'),
    ok(side, 'toolu_sub', { structuredPatch: patch(['-a', '+b']) }),
  ]);
  return { alias, real };
}

const byPath = (changes: readonly FileChange[], work: string) => new Map(changes.map((c) => [c.path.startsWith(work) ? c.path.slice(work.length + 1) : c.path, c]));

// ---------------------------------------------------------------------------

describe('changes index: backfill', () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await env.close();
  });

  it('sessionChanges after backfill holds every op of the fixture, one row per file', async () => {
    await writeFixture(env);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    const r = await env.svc.forSession(SID);
    expect(r).not.toBeNull();
    expect(SessionChangesResponseSchema.parse(r)).toEqual(r);
    expect(r?.scan.done).toBe(true);
    expect(r?.scan.bytes).toBe(r?.scan.total);
    expect(r?.truncated).toBe(false);
    const rows = byPath(r?.changes ?? [], env.work);
    const view = (k: string) => {
      const c = rows.get(k);
      return c && [c.tools, c.ops, c.added, c.removed, c.created, c.viewable, c.last.status];
    };
    expect(view('src/new.ts')).toEqual([['Write'], 1, 3, 0, true, 'yes', 'ok']);
    expect(view('src/app.ts')).toEqual([['Edit', 'MultiEdit'], 2, 3, 2, false, 'yes', 'ok']);
    expect(view('nb.ipynb')).toEqual([['NotebookEdit'], 1, 2, 0, false, 'yes', 'ok']);
    expect(view('src/old.ts')).toEqual([['Edit'], 1, 0, 0, false, 'yes', 'rejected']);
    expect(view('src/blocked.ts')).toEqual([['Write'], 1, 0, 0, false, 'missing', 'blocked']);
    expect(view('docs/readme.md')).toEqual([['Write'], 1, 1, 1, false, 'yes', 'ok']);
    expect(view('private/tmp/x.txt')).toEqual([['Write', 'Edit'], 2, 3, 1, true, 'yes', 'ok']);
    expect(view('.env')).toEqual([['Write'], 1, 1, 0, true, 'protected', 'ok']);
    expect(view('big/a.txt')).toEqual([['Write'], 1, 0, 0, true, 'yes', 'ok']);
    expect(view('big/b.txt')).toEqual([['Write'], 1, 0, 0, true, 'yes', 'ok']);
    expect(view('src/sub.ts')).toEqual([['Edit'], 1, 1, 1, false, 'yes', 'ok']);
    expect(rows.size).toBe(11);
    expect(rows.get('src/new.ts')).toMatchObject({ rootId: 'r.work', rel: 'src/new.ts', sid: SID, changeId: changeIdFor(SID, `${env.work}/src/new.ts`) });
    // newest first
    const times = (r?.changes ?? []).map((c) => Date.parse(c.lastAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const detail = await env.svc.change(SID, rows.get('big/b.txt')?.changeId ?? '');
    expect(detail?.ops).toEqual([expect.objectContaining({ opId: 'toolu_big_b', large: true, added: null, removed: null, approx: true })]);
    const sub = await env.svc.change(SID, rows.get('src/sub.ts')?.changeId ?? '');
    expect(sub?.ops.map((o) => [o.opId, o.byAgent])).toEqual([['toolu_sub', true]]);
  });

  it('F8: a Write to .env is listed with its counts but never linked to the viewer, and no reply holds its content', async () => {
    const realpathSpy = vi.spyOn(fsx, 'realpath');
    await writeFixture(env);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    const list = await env.svc.forSession(SID);
    const envRow = list?.changes.find((c) => c.path === `${env.work}/.env`);
    expect(envRow).toMatchObject({ viewable: 'protected', added: 1, ops: 1, created: true, tools: ['Write'] });
    expect(envRow).not.toHaveProperty('rootId');
    expect(envRow).not.toHaveProperty('rel');
    const detail = await env.svc.change(SID, envRow?.changeId ?? '');
    expect(detail?.ops).toEqual([
      { opId: 'toolu_env', tool: 'Write', at: expect.any(String), status: 'ok', added: 1, removed: 0, approx: false, byAgent: false, large: false },
    ]);
    expect(detail?.change).not.toHaveProperty('rel');
    // the protected path is neither resolved nor located
    expect(realpathSpy.mock.calls.map((c) => c[0]).filter((p) => p.endsWith('.env'))).toEqual([]);
    expect(env.files.located.filter((p) => p.endsWith('.env'))).toEqual([]);
    expect(env.svc.changedPathsFor(SID)).not.toContain(`${env.work}/.env`);
    const everything = JSON.stringify([list, detail, env.svc.recent({ limit: 200 }), env.events]);
    expect(everything).not.toContain(SECRET_MARKER);
    expect(everything).not.toContain('a\\nb\\nc');
  });

  it('merges two spellings of one file under its realpath; either changeId opens it', async () => {
    const { alias, real } = await writeFixture(env);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    const rows = (await env.svc.forSession(SID))?.changes ?? [];
    const merged = rows.filter((c) => c.path === real || c.path === alias);
    expect(merged.map((c) => c.path)).toEqual([real]);
    const viaAlias = await env.svc.change(SID, changeIdFor(SID, alias));
    expect(viaAlias?.change.changeId).toBe(changeIdFor(SID, real));
    expect(viaAlias?.ops.map((o) => o.opId)).toEqual(['toolu_tmp1', 'toolu_tmp2']);
  });

  it('a file outside every root is never resolved or located; its key is its name, and stays when a root covers it later', async () => {
    const realpathSpy = vi.spyOn(fsx, 'realpath');
    const docs = join(env.home, 'Documents');
    // Not there yet: whatever the disk says, the row reads outside, not missing.
    const plan = join(docs, 'plan.md');
    const tl = timeline(NOW - 60_000, SID, env.work);
    await env.append(env.transcript(SID), [
      assistantToolUse(tl.next(), 'Write', { file_path: plan, content: '# plan\n' }, 'toolu_out'),
      ok(tl.next(), 'toolu_out', { type: 'create', filePath: plan, content: '# plan\n', structuredPatch: [] }),
    ]);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    const row = (await env.svc.forSession(SID))?.changes.find((c) => c.path === plan);
    expect(row).toMatchObject({ path: plan, changeId: changeIdFor(SID, plan), viewable: 'outside', created: true, ops: 1 });
    expect(row).not.toHaveProperty('rootId');
    expect(realpathSpy.mock.calls.map((c) => String(c[0])).filter((p) => p.startsWith(docs))).toEqual([]);
    expect(env.files.located.filter((p) => p.startsWith(docs))).toEqual([]);
    expect(env.svc.changedPathsFor(SID)).toContain(plan);

    // A session starts in ~/Documents: once the view is due again the row opens through that root, same key and changeId.
    await mkdir(docs, { recursive: true });
    await writeFile(plan, '# plan\n');
    env.addSession(SID2, { cwd: docs, folder: 'Documents' });
    env.ctx.clock.advance(10_000);
    const later = (await env.svc.forSession(SID))?.changes.find((c) => c.changeId === row?.changeId);
    expect(later).toMatchObject({ path: plan, viewable: 'yes', rootId: `s.${SID2}`, rel: 'plan.md' });
  });

  it('reads a long transcript a tick at a time (whole 1 MiB reads) and reports progress', async () => {
    await env.close();
    env = await makeEnv({ svc: { tickBytes: 64 * 1024 } });
    const tl = timeline(NOW - 60_000, SID, env.work);
    const entries: Entry[] = [];
    for (let i = 0; i < 400; i++) {
      entries.push(assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/gen/f${i}.ts`, content: 'x'.repeat(6000) }, `toolu_g${i}`));
      entries.push(ok(tl.next(), `toolu_g${i}`));
    }
    await env.append(env.transcript(SID), entries);
    env.addSession(SID);
    await env.svc.start();
    const first = await env.svc.forSession(SID);
    expect(first?.scan.done).toBe(false);
    expect(first?.scan.bytes).toBeGreaterThan(0);
    expect(first?.scan.bytes).toBeLessThan(first?.scan.total ?? 0);
    expect(first?.changes.length).toBeGreaterThan(0);
    expect(first?.changes.length).toBeLessThan(400);
    // no count from a part-read transcript, even once the 2 s have passed
    env.ctx.clock.advance(2000);
    await env.svc.idle();
    expect(env.ctx.store.getState().sessions[SID]?.filesChanged).toBeUndefined();
    await env.settle(60);
    const done = await env.svc.forSession(SID);
    expect(done?.scan).toEqual({ done: true, bytes: done?.scan.total, total: done?.scan.total });
    expect(done?.changes).toHaveLength(400);
    expect(env.ctx.store.getState().sessions[SID]?.filesChanged).toBe(400);
  });

  it('backfills at most `totalBytes`, newest first, and says so', async () => {
    await env.close();
    env = await makeEnv({ svc: { totalBytes: 2000 } });
    const tl = timeline(NOW - 60_000, SID, env.work);
    const entries: Entry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push(assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/gen/f${i}.ts`, content: '' }, `toolu_t${i}`));
      entries.push(ok(tl.next(), `toolu_t${i}`));
    }
    await env.append(env.transcript(SID), entries);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    const r = await env.svc.forSession(SID);
    expect(r?.truncated).toBe(true);
    expect(r?.scan.total).toBeLessThanOrEqual(2000);
    const names = (r?.changes ?? []).map((c) => basename(c.path));
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThan(20);
    expect(names[0]).toBe('f19.ts');
  });

  it('caps files and op details per session; rows keep their sums', async () => {
    await env.close();
    env = await makeEnv({ svc: { maxPaths: 2, maxOps: 3 } });
    const tl = timeline(NOW - 60_000, SID, env.work);
    const entries: Entry[] = [];
    for (const [i, f] of ['a.ts', 'a.ts', 'a.ts', 'a.ts', 'b.ts', 'c.ts'].entries()) {
      entries.push(assistantToolUse(tl.next(), 'Edit', { file_path: `${env.work}/${f}`, old_string: 'x', new_string: 'y' }, `toolu_c${i}`));
      entries.push(ok(tl.next(), `toolu_c${i}`, { structuredPatch: patch(['-x', '+y']) }));
    }
    await env.append(env.transcript(SID), entries);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    const r = await env.svc.forSession(SID);
    expect(r?.truncated).toBe(true);
    const rows = byPath(r?.changes ?? [], env.work);
    expect([...rows.keys()].sort()).toEqual(['a.ts', 'b.ts']);
    expect(rows.get('a.ts')).toMatchObject({ ops: 4, added: 4, removed: 4 });
    const a = await env.svc.change(SID, rows.get('a.ts')?.changeId ?? '');
    expect(a?.ops.map((o) => o.opId)).toEqual(['toolu_c2', 'toolu_c3']);
  });

  it('answers null for an unknown session or change, and an empty list while Files is off', async () => {
    await writeFixture(env);
    env.addSession(SID);
    await env.svc.start();
    expect(await env.svc.forSession('sess-nope')).toBeNull();
    expect(await env.svc.change(SID, 'c_000000000000000000000000')).toBeNull();
    await env.ctx.settings.patch({ files: { enabled: false } });
    expect(await env.svc.forSession(SID)).toEqual({ changes: [], scan: { done: true, bytes: 0, total: 0 }, truncated: false });
    expect(env.svc.recent({ limit: 10 })).toEqual([]);
    expect(env.svc.changedPathsFor(SID)).toEqual([]);
  });

  it('a transcript rewritten from scratch is read again without counting anything twice', async () => {
    const tl = timeline(NOW - 60_000, SID, env.work);
    const first = [assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/a.ts`, content: 'a' }, 'toolu_once'), ok(tl.next(), 'toolu_once')];
    await env.append(env.transcript(SID), [...first, ...first, ...first]);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    await writeFile(env.transcript(SID), toJsonl(first));
    await env.append(env.transcript(SID), [assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/b.ts`, content: 'b' }, 'toolu_b'), ok(tl.next(), 'toolu_b')]);
    const r = await env.svc.forSession(SID);
    expect(byPath(r?.changes ?? [], env.work).get('a.ts')?.ops).toBe(1);
    expect(byPath(r?.changes ?? [], env.work).get('b.ts')?.ops).toBe(1);
  });

  it('fails closed when the policy can’t judge a path: listed as outside, never resolved, located or given to Rewrite', async () => {
    await env.close();
    env = await makeEnv({
      isProtected: (p) => {
        if (p.includes('/boom/')) throw new Error('policy broke');
        return basename(p) === '.env';
      },
    });
    const realpathSpy = vi.spyOn(fsx, 'realpath');
    await mkdir(join(env.work, 'boom'), { recursive: true });
    await writeFile(join(env.work, 'boom', 'a.ts'), 'a\n');
    await writeFile(join(env.work, 'fine.ts'), 'f\n');
    const tl = timeline(NOW - 60_000, SID, env.work);
    await env.append(env.transcript(SID), [
      assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/boom/a.ts`, content: 'a\n' }, 'toolu_boom'),
      ok(tl.next(), 'toolu_boom', { type: 'create', content: 'a\n', structuredPatch: [] }),
      assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/fine.ts`, content: 'f\n' }, 'toolu_fine'),
      ok(tl.next(), 'toolu_fine', { type: 'create', content: 'f\n', structuredPatch: [] }),
    ]);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    const rows = byPath((await env.svc.forSession(SID))?.changes ?? [], env.work);
    expect(rows.get('boom/a.ts')).toMatchObject({ viewable: 'outside', ops: 1, added: 1, created: true });
    expect(rows.get('boom/a.ts')).not.toHaveProperty('rootId');
    expect(rows.get('fine.ts')).toMatchObject({ viewable: 'yes', rootId: 'r.work', rel: 'fine.ts' });
    expect(realpathSpy.mock.calls.map((c) => String(c[0])).filter((p) => p.includes('/boom/'))).toEqual([]);
    expect(env.files.located.filter((p) => p.includes('/boom/'))).toEqual([]);
    expect(env.svc.changedPathsFor(SID)).toEqual([`${env.work}/fine.ts`]);
  });

  it('a prototype key (constructor, __proto__, toString) is no session and takes no index slot', async () => {
    await env.close();
    env = await makeEnv({ svc: { maxSessions: 1 } });
    await writeFixture(env);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    for (const sid of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(await env.svc.forSession(sid), sid).toBeNull();
      expect(await env.svc.change(sid, 'c_000000000000000000000000'), sid).toBeNull();
    }
    // the one slot still holds the real session's index
    expect(env.svc.recent({ limit: 200 })).toHaveLength(11);
  });

  it('keeps at most maxSessions indexes: the least recently used goes, and is rebuilt when asked for', async () => {
    await env.close();
    env = await makeEnv({ svc: { maxSessions: 2 } });
    const sids = ['sess-fc-lru-a', 'sess-fc-lru-b', 'sess-fc-lru-c'];
    for (const [i, sid] of sids.entries()) {
      const tl = timeline(NOW - 60_000 + i * 1000, sid, env.work);
      await env.append(env.transcript(sid), [assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/${sid}.ts`, content: 'x' }, `toolu_lru${i}`), ok(tl.next(), `toolu_lru${i}`)]);
      env.addSession(sid);
    }
    await env.svc.start();
    await env.settle();
    const indexed = () => new Set(env.svc.recent({ limit: 200 }).map((c) => c.sid));
    expect(indexed()).toEqual(new Set(['sess-fc-lru-b', 'sess-fc-lru-c']));
    expect((await env.svc.forSession('sess-fc-lru-a'))?.changes.map((c) => basename(c.path))).toEqual(['sess-fc-lru-a.ts']);
    expect(indexed()).toEqual(new Set(['sess-fc-lru-c', 'sess-fc-lru-a']));
  });

  it('stays within maxIndexBytes (opIds and spellings count too): old op details go first, a new file before them, rows keep their sums', async () => {
    await env.close();
    env = await makeEnv({ svc: { maxIndexBytes: 12 * 1024 } });
    const tl = timeline(NOW - 60_000, SID, env.work);
    const entries: Entry[] = [];
    for (let i = 0; i < 100; i++) {
      entries.push(assistantToolUse(tl.next(), 'Edit', { file_path: `${env.work}/a.ts`, old_string: 'x', new_string: 'y' }, `toolu_m${i}`));
      entries.push(ok(tl.next(), `toolu_m${i}`, { structuredPatch: patch(['-x', '+y']) }));
    }
    entries.push(assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/late.ts`, content: 'z' }, 'toolu_late'), ok(tl.next(), 'toolu_late'));
    await env.append(env.transcript(SID), entries);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    const rows = byPath((await env.svc.forSession(SID))?.changes ?? [], env.work);
    expect(rows.get('a.ts')).toMatchObject({ ops: 100, added: 100, removed: 100 });
    expect(rows.get('late.ts')).toMatchObject({ ops: 1, last: { status: 'ok' } });
    const details = (await env.svc.change(SID, rows.get('a.ts')?.changeId ?? ''))?.ops ?? [];
    expect(details.length).toBeGreaterThan(0);
    expect(details.length).toBeLessThan(100);
    expect(details.at(-1)?.opId).toBe('toolu_m99');
  });

  it('a read that fails is tried again after a pause, and the other sessions go on meanwhile', async () => {
    const other = 'sess-fc-0003';
    for (const [sid, id] of [
      [SID, 'toolu_eio1'],
      [other, 'toolu_eio2'],
    ] as const) {
      const tl = timeline(NOW - 60_000, sid, env.work);
      await env.append(env.transcript(sid), [assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/${id}.ts`, content: 'x' }, id), ok(tl.next(), id)]);
      env.addSession(sid);
    }
    const readFrom = vi.spyOn(env.reader, 'readFrom').mockRejectedValueOnce(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }));
    await env.svc.start();
    await env.settle(5);
    expect(readFrom).toHaveBeenCalled();
    expect(env.ctx.log.records.filter((r) => r.level === 'warn' && r.msg === 'changed files: read failed').map((r) => r.fields.sid)).toEqual([SID]);
    expect(env.svc.changedPathsFor(other)).toEqual([`${env.work}/toolu_eio2.ts`]);
    expect(env.svc.changedPathsFor(SID)).toEqual([]);
    await env.settle(40);
    expect(env.svc.changedPathsFor(SID)).toEqual([`${env.work}/toolu_eio1.ts`]);
    expect([env.ctx.store.getState().sessions[SID]?.filesChanged, env.ctx.store.getState().sessions[other]?.filesChanged]).toEqual([1, 1]);
  });

  it('stop() leaves no timer behind, even with a read still running', async () => {
    const tl = timeline(NOW - 60_000, SID, env.work);
    await env.append(env.transcript(SID), [assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/a.ts`, content: 'a' }, 'toolu_stop'), ok(tl.next(), 'toolu_stop')]);
    env.addSession(SID);
    await env.svc.start();
    const reading = env.svc.forSession(SID);
    await env.svc.stop();
    expect((await reading)?.changes).toHaveLength(1);
    env.ctx.clock.advance(120_000);
    await env.svc.idle();
    expect(env.events.filter((e) => e.type === 'session.updated')).toEqual([]);
  });

  it('lets go of a subagent transcript read to its end once it is gone or no longer among the newest 50; its rows stay', async () => {
    const tl = timeline(NOW - 60_000, SID, env.work);
    await env.append(env.transcript(SID), [assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/main.ts`, content: 'm' }, 'toolu_main'), ok(tl.next(), 'toolu_main')]);
    const sub = (i: number) => env.subTranscript(SID, `agent-p${i}.jsonl`);
    const writeSub = async (i: number) => {
      const side = { ...tl.next(), isSidechain: true };
      await env.append(sub(i), [assistantToolUse(side, 'Write', { file_path: `${env.work}/agent${i}.ts`, content: 'a' }, `toolu_agent${i}`), ok(side, `toolu_agent${i}`)]);
      const t = (NOW - 3_600_000 + i * 1000) / 1000; // agent-p0 is the oldest
      await utimes(sub(i), t, t);
    };
    for (let i = 0; i < 50; i++) await writeSub(i);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    const size = async (i: number) => (await stat(sub(i))).size;
    const total0 = (await env.svc.forSession(SID))?.scan.total ?? 0;

    await writeSub(50); // now agent-p0 is not among the newest 50
    env.ctx.clock.advance(20_000);
    const total1 = (await env.svc.forSession(SID))?.scan.total ?? 0;
    expect(total1).toBe(total0 - (await size(0)));

    const gone = await size(1);
    await rm(sub(1));
    env.ctx.clock.advance(20_000);
    const after = await env.svc.forSession(SID);
    expect(after?.scan.total).toBe(total1 - gone);
    const rows = byPath(after?.changes ?? [], env.work);
    expect([rows.get('agent0.ts')?.ops, rows.get('agent1.ts')?.ops, rows.get('agent50.ts')?.ops]).toEqual([1, 1, 1]);
  });

  it('a pending call that goes away leaves its row’s last op right, even with the row’s op details trimmed', async () => {
    await env.close();
    env = await makeEnv({ svc: { maxOps: 1 } });
    const tl = timeline(NOW - 60_000, SID, env.work);
    await env.append(env.transcript(SID), [
      assistantToolUse(tl.next(), 'Edit', { file_path: `${env.work}/a.ts`, old_string: 'x', new_string: 'y' }, 'toolu_t1'),
      ok(tl.next(), 'toolu_t1', { structuredPatch: patch(['-x', '+y']) }),
      assistantToolUse(tl.next(), 'Edit', { file_path: `${env.work}/b.ts`, old_string: 'x', new_string: 'y' }, 'toolu_t2'),
      ok(tl.next(), 'toolu_t2', { structuredPatch: patch(['-x', '+y']) }),
    ]);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    const row = async () => byPath((await env.svc.forSession(SID))?.changes ?? [], env.work).get('a.ts');
    const before = await row();
    expect((await env.svc.change(SID, before?.changeId ?? ''))?.ops).toEqual([]); // trimmed
    await env.append(env.transcript(SID), [assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/a.ts`, content: 'w' }, 'toolu_t3')]);
    expect((await row())?.last.status).toBe('pending');
    await env.append(env.transcript(SID), [userPrompt(tl.next(), 'never mind')]);
    expect(await row()).toEqual(before);
  });
});

describe('changes index: the 8.2.5 fixture transcripts', () => {
  let env: Env;
  afterEach(async () => {
    vi.restoreAllMocks();
    await env.close();
  });

  it('lists every op of the scenario under its file, merges the two spellings, and keeps .env unlinked', async () => {
    env = await makeEnv();
    const realpathSpy = vi.spyOn(fsx, 'realpath');
    // On macOS, outside HOME: /var/folders/... and /private/var/folders/..., both protected (as /tmp and /private/tmp)
    // and merged by name. Elsewhere a symlink, inside the root: a path outside every root is never resolved.
    const alias = await aliasPair(join(process.platform === 'darwin' ? env.dir : env.work, 'tmp'));
    const scenario = fileOpsScenario({ sid: SID, cwd: env.work, at: NOW - 30 * 60_000, alias, largeBytes: 2 * 1024 * 1024 });
    await env.append(env.transcript(SID), scenario.main);
    await env.append(env.subTranscript(SID, scenario.subagent.name), scenario.subagent.entries);
    for (const [path, text] of Object.entries(scenario.files)) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
    const list = await env.svc.forSession(SID);
    expect(list?.scan.done).toBe(true);
    const rows = list?.changes ?? [];
    const realOf = (p: string) => (p.startsWith(alias.lexical) ? alias.real + p.slice(alias.lexical.length) : p);
    for (const want of scenario.expected) {
      const row = rows.find((c) => c.path === realOf(want.path));
      expect(row, want.label).toBeDefined();
      const detail = await env.svc.change(SID, row?.changeId ?? '');
      expect(detail?.ops.find((o) => o.opId === want.opId), want.label).toMatchObject({ tool: want.tool, status: want.status, byAgent: want.byAgent, large: want.large });
      if (want.protectedPath) expect([row?.viewable, row?.rootId, row?.rel], want.label).toEqual(['protected', undefined, undefined]);
    }
    expect(new Set(scenario.expected.map((e) => realOf(e.path))).size).toBe(rows.length);
    // the two spellings are one row, and count as one file
    const x = (p: string) => join(p, 'x');
    expect(rows.filter((c) => c.path === x(alias.lexical) || c.path === x(alias.real)).map((c) => c.path)).toEqual([x(alias.real)]);
    const okFiles = new Set(scenario.expected.filter((e) => e.status === 'ok').map((e) => realOf(e.path)));
    expect(env.ctx.store.getState().sessions[SID]?.filesChanged).toBe(okFiles.size);
    // a protected spelling is never resolved
    if (env.files.policy.isProtected(x(alias.lexical))) {
      const resolved = realpathSpy.mock.calls.map((c) => String(c[0]));
      expect(resolved.filter((p) => p.startsWith(alias.lexical) || p.startsWith(alias.real))).toEqual([]);
      expect(env.files.located.filter((p) => p.startsWith(alias.lexical) || p.startsWith(alias.real))).toEqual([]);
    }
    const opIds = new Set((await Promise.all(rows.map((r) => env.svc.change(SID, r.changeId)))).flatMap((d) => d?.ops.map((o) => o.opId) ?? []));
    for (const id of scenario.notListed) expect(opIds.has(id), id).toBe(false);
    expect(markersIn([list, env.svc.recent({ limit: 200 }), env.events])).toEqual([]);
  });

  it('privateSpelling: macOS /var, /tmp and /etc are spelled /private/..., by name alone', () => {
    expect(privateSpelling('/var/folders/ab/T/x', 'darwin')).toBe('/private/var/folders/ab/T/x');
    expect(privateSpelling('/tmp/x', 'darwin')).toBe('/private/tmp/x');
    expect(privateSpelling('/etc', 'darwin')).toBe('/private/etc');
    for (const same of ['/private/var/x', '/variable/x', '/Users/me/var/x', '/opt/tmp/x']) expect(privateSpelling(same, 'darwin')).toBe(same);
    expect(privateSpelling('/var/x', 'linux')).toBe('/var/x');
  });
});

describe('changes index: live', () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
    await writeFixture(env);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
  });
  afterEach(async () => {
    await env.close();
  });

  /** What the watcher publishes for an op (only a nudge for the index). */
  const nudge = (sid: string, path: string, opId: string, byAgent = false) =>
    env.ctx.store.emit({
      type: 'files.changed',
      sid,
      data: { changeId: changeIdFor(sid, path), path, tool: 'Edit', at: env.ctx.clock.iso(), status: 'ok', opId, transcriptOffset: 0, byAgent },
    });
  const counts = (sid: string) =>
    env.events.flatMap((e) => (e.type === 'session.updated' && e.sid === sid && 'filesChanged' in e.data.patch ? [e.data.patch.filesChanged] : []));

  it('keeps filesChanged (files with an ok op) on the session, at most once per 2 s', async () => {
    expect(counts(SID)).toEqual([9]);
    expect(env.ctx.store.getState().sessions[SID]?.filesChanged).toBe(9);
    const tl = timeline(env.ctx.clock.now(), SID, env.work);
    await env.append(env.transcript(SID), [
      assistantToolUse(tl.next(), 'Edit', { file_path: `${env.work}/src/live.ts`, old_string: 'a', new_string: 'b' }, 'toolu_live'),
      ok(tl.next(), 'toolu_live', { structuredPatch: patch(['-a', '+b']) }),
    ]);
    nudge(SID, `${env.work}/src/live.ts`, 'toolu_live');
    env.ctx.clock.advance(TICK_MS);
    await env.svc.idle();
    expect(byPath((await env.svc.forSession(SID))?.changes ?? [], env.work).get('src/live.ts')).toMatchObject({ ops: 1, added: 1, removed: 1 });
    env.ctx.clock.advance(1800);
    expect(counts(SID)).toEqual([9]);
    env.ctx.clock.advance(200);
    expect(counts(SID)).toEqual([9, 10]);
    // a repeated event, or the same op read again, changes nothing
    nudge(SID, `${env.work}/src/live.ts`, 'toolu_live');
    await env.settle(25);
    expect(counts(SID)).toEqual([9, 10]);
    expect(byPath((await env.svc.forSession(SID))?.changes ?? [], env.work).get('src/live.ts')?.ops).toBe(1);
  });

  it('a subagent’s event makes the index look for new subagent transcripts soon', async () => {
    const side = { ...timeline(env.ctx.clock.now(), SID, env.work).next(), isSidechain: true };
    await env.append(env.subTranscript(SID, 'agent-b2.jsonl'), [
      assistantToolUse(side, 'Write', { file_path: `${env.work}/src/agent.ts`, content: 'k' }, 'toolu_agent'),
      ok(side, 'toolu_agent'),
    ]);
    env.ctx.clock.advance(5000);
    nudge(SID, `${env.work}/src/agent.ts`, 'toolu_agent', true);
    await env.settle(5);
    expect(env.svc.changedPathsFor(SID)).toContain(`${env.work}/src/agent.ts`);
  });

  it('turning Files off unsets filesChanged and drops the index; on again rebuilds it', async () => {
    await env.ctx.settings.patch({ files: { enabled: false } });
    expect(env.ctx.store.getState().sessions[SID]?.filesChanged).toBeUndefined();
    nudge(SID, `${env.work}/src/new.ts`, 'toolu_whatever');
    await env.settle(5);
    expect(env.svc.recent({ limit: 10 })).toEqual([]);
    await env.ctx.settings.patch({ files: { enabled: true } });
    await env.settle();
    expect(env.ctx.store.getState().sessions[SID]?.filesChanged).toBe(9);
    expect(env.svc.recent({ limit: 200 })).toHaveLength(11);
  });

  it('recent() covers live sessions, newest first, with since and limit', async () => {
    env.addSession(SID2);
    const tl = timeline(NOW + 60_000, SID2, env.work);
    await env.append(env.transcript(SID2), [
      assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/second.ts`, content: 's' }, 'toolu_second'),
      ok(tl.next(), 'toolu_second'),
    ]);
    await env.settle();
    const all = env.svc.recent({ limit: 200 });
    expect(FilesChangesResponseSchema.parse({ changes: all }).changes).toHaveLength(12);
    expect(all[0]).toMatchObject({ sid: SID2, path: `${env.work}/second.ts` });
    expect(env.svc.recent({ limit: 1 }).map((c) => c.sid)).toEqual([SID2]);
    expect(env.svc.recent({ since: new Date(NOW).toISOString(), limit: 200 }).map((c) => c.sid)).toEqual([SID2]);
    env.ctx.store.emit({ type: 'session.removed', sid: SID2, data: {} });
    expect(env.svc.recent({ limit: 200 }).map((c) => c.sid)).not.toContain(SID2);
    expect(env.svc.changedPathsFor(SID2)).toEqual([]);
  });

  it('changedPathsFor: files with an ok op, newest first, never a protected one', async () => {
    const paths = env.svc.changedPathsFor(SID);
    expect(paths).toHaveLength(8);
    expect(paths).not.toContain(`${env.work}/.env`);
    expect(paths).not.toContain(`${env.work}/src/old.ts`);
    expect(paths).not.toContain(`${env.work}/src/blocked.ts`);
    expect(paths[0]).toBe(`${env.work}/src/sub.ts`);
  });

  it('a call still waiting for its result shows as pending, then as what became of it', async () => {
    const tl = timeline(env.ctx.clock.now(), SID, env.work);
    const row = async (rel: string) => byPath((await env.svc.forSession(SID))?.changes ?? [], env.work).get(rel);
    await env.append(env.transcript(SID), [assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/src/wait.ts`, content: 'w\n' }, 'toolu_wait')]);
    const waiting = await row('src/wait.ts');
    expect(waiting).toMatchObject({ ops: 1, added: 0, created: false, last: { status: 'pending', tool: 'Write' } });
    expect((await env.svc.change(SID, waiting?.changeId ?? ''))?.ops).toEqual([expect.objectContaining({ opId: 'toolu_wait', status: 'pending', approx: true })]);
    expect(env.svc.changedPathsFor(SID)).not.toContain(`${env.work}/src/wait.ts`);

    await env.append(env.transcript(SID), [ok(tl.next(), 'toolu_wait', { type: 'create', content: 'w\n', structuredPatch: [] })]);
    expect(await row('src/wait.ts')).toMatchObject({ ops: 1, added: 1, created: true, last: { status: 'ok' } });

    // a call a new prompt left behind goes away
    await env.append(env.transcript(SID), [assistantToolUse(tl.next(), 'Edit', { file_path: `${env.work}/src/never.ts`, old_string: 'a', new_string: 'b' }, 'toolu_never')]);
    expect((await row('src/never.ts'))?.last.status).toBe('pending');
    await env.append(env.transcript(SID), [userPrompt(tl.next(), 'stop, do the docs instead')]);
    expect(await row('src/never.ts')).toBeUndefined();
    // its result can still come after all (a prompt queued while it ran): then it is an op like any other
    await env.append(env.transcript(SID), [ok(tl.next(), 'toolu_never', { structuredPatch: patch(['-a', '+b']) })]);
    expect(await row('src/never.ts')).toMatchObject({ ops: 1, added: 1, removed: 1, last: { status: 'ok', tool: 'Edit' } });
  });

  it('a pending call that never gets its result leaves its file’s row as it was (tools, times, last op)', async () => {
    const tl = timeline(env.ctx.clock.now(), SID, env.work);
    const row = async () => byPath((await env.svc.forSession(SID))?.changes ?? [], env.work).get('src/app.ts');
    const before = await row();
    expect(before).toMatchObject({ tools: ['Edit', 'MultiEdit'], ops: 2, added: 3, removed: 2, last: { status: 'ok', tool: 'MultiEdit' } });
    await env.append(env.transcript(SID), [assistantToolUse(tl.next(), 'Write', { file_path: `${env.work}/src/app.ts`, content: 'w\n' }, 'toolu_pw')]);
    expect(await row()).toMatchObject({ tools: ['Edit', 'MultiEdit', 'Write'], ops: 3, added: 3, removed: 2, last: { status: 'pending', tool: 'Write' } });
    await env.append(env.transcript(SID), [userPrompt(tl.next(), 'no, leave app.ts alone')]);
    expect(await row()).toEqual(before);
  });

  it('a link follows the file: once it is deleted the row says missing', async () => {
    await unlink(join(env.work, 'src/new.ts'));
    env.ctx.clock.advance(10_000);
    const row = byPath((await env.svc.forSession(SID))?.changes ?? [], env.work).get('src/new.ts');
    expect(row).toMatchObject({ viewable: 'missing' });
    expect(row).not.toHaveProperty('rootId');
    expect(FileChangeSchema.parse(row)).toEqual(row);
  });
});

// ---------------------------------------------------------------------------

describe('changes routes', () => {
  let api: TestApi;
  let env: Env;
  let home: string;
  let cookie: string;
  let deviceId: string;
  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ccw-fc-api-')));
    // makeApi builds the context; the index is built on it right after
    const holder: { svc?: ChangesIndex } = {};
    const svc = (): ChangesIndex => {
      if (!holder.svc) throw new Error('changes index not built yet');
      return holder.svc;
    };
    const changes: ChangesService = {
      start: async () => {},
      stop: async () => {},
      forSession: (sid) => svc().forSession(sid),
      change: (sid, id) => svc().change(sid, id),
      recent: (o) => svc().recent(o),
      changedPathsFor: (sid) => svc().changedPathsFor(sid),
    };
    api = await makeApi({ ctx: { userHome: home, settings: FILES_ON }, sessions: [], deps: () => ({ changes }) });
    env = await makeEnv({ ctx: api.ctx });
    holder.svc = env.svc;
    ({ cookie, deviceId } = await pairCookie(api, ['read', 'control']));
    await writeFixture(env);
    env.addSession(SID);
    await env.svc.start();
    await env.settle();
  });
  afterEach(async () => {
    await env.close();
    await api.close();
    await rm(home, { recursive: true, force: true });
  });

  const get = (url: string) => api.tcp.inject({ method: 'GET', url, headers: h(cookie) });

  it('sessionChanges, sessionChange and filesChanges answer the protocol shapes', async () => {
    const list = await get(`/v1/sessions/${SID}/changes`);
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toContain('no-store');
    const body = SessionChangesResponseSchema.parse(list.json());
    expect(body.changes).toHaveLength(11);
    const one = body.changes.find((c) => c.path.endsWith('/src/app.ts'));
    const detail = await get(`/v1/sessions/${SID}/changes/${one?.changeId}`);
    expect(detail.statusCode).toBe(200);
    expect(SessionChangeResponseSchema.parse(detail.json()).ops.map((o) => o.opId)).toEqual(['toolu_app1', 'toolu_app2']);
    const recent = await get(`/v1/files/changes?limit=5&since=${encodeURIComponent(new Date(NOW - 3_600_000).toISOString())}`);
    expect(recent.statusCode).toBe(200);
    expect(FilesChangesResponseSchema.parse(recent.json()).changes).toHaveLength(5);
    for (const res of [list, detail, recent]) expect(res.body).not.toContain(SECRET_MARKER);
  });

  it('unknown sessions and changes are 404', async () => {
    expect((await get('/v1/sessions/sess-nope/changes')).statusCode).toBe(404);
    expect((await get(`/v1/sessions/sess-nope/changes/c_1`)).statusCode).toBe(404);
    // a prototype key is no session
    for (const sid of ['constructor', '__proto__', 'toString']) {
      expect((await get(`/v1/sessions/${sid}/changes`)).statusCode, sid).toBe(404);
      expect((await get(`/v1/sessions/${sid}/changes/c_000000000000000000000000`)).statusCode, sid).toBe(404);
    }
    const res = await get(`/v1/sessions/${SID}/changes/c_000000000000000000000000`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('counts against the per-device files limit', async () => {
    for (let i = 0; i < 1000 && api.services.filesLimiter.hit(`device:${deviceId}`).ok; i++);
    for (const url of [`/v1/sessions/${SID}/changes`, '/v1/files/changes']) {
      const res = await get(url);
      expect(res.statusCode).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    }
  });
});
