import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiError,
  assistantText,
  assistantToolUse,
  encodeProjectDir as fixtureEncode,
  permissionMode,
  queuedCommand,
  slashCommand,
  toJsonl,
  toolResult,
  userPrompt,
  metaUser,
  type Entry,
} from '@jantar/fixtures';
import { createFileTranscriptReader, encodeProjectDir } from '../../src/sources/transcripts/index.js';
import { linesBackward } from '../../src/sources/transcripts/reader.js';
import { summarizeTail, classifyUser, itemsFromEntry } from '../../src/sources/transcripts/parse.js';
import { fsx } from '../../src/sources/lib/fsx.js';
import { SID, sourceEnv, type SourceEnv } from './helpers.js';

const T0 = Date.parse('2026-01-15T09:00:00.000Z');
const ctxAt = (sid: string, cwd: string, sec: number) => ({ sessionId: sid, cwd, at: new Date(T0 + sec * 1000).toISOString() });

describe('transcripts: path lookup', () => {
  let env: SourceEnv;
  beforeEach(async () => {
    env = await sourceEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('encodes cwds the way Claude names project dirs', () => {
    expect(encodeProjectDir('/Users/you/work/my_app.v2')).toBe('-Users-you-work-my-app-v2');
    expect(encodeProjectDir('/a/b')).toBe(fixtureEncode('/a/b'));
  });

  it('finds the shared transcript from the cwd, and a profile-private one from the config dir', async () => {
    const r = createFileTranscriptReader(env.ctx);
    const busy = env.home.session(SID.busy);
    expect(await r.pathFor(SID.busy, { cwd: busy.cwd, configDir: busy.configDir })).toBe(busy.transcriptPath);
    const priv = env.home.session(SID.private);
    expect(priv.transcriptPath.startsWith(priv.configDir)).toBe(true);
    expect(await r.pathFor(SID.private, { cwd: priv.cwd, configDir: priv.configDir })).toBe(priv.transcriptPath);
  });

  it('falls back to one listing of the projects dirs, then serves from its cache', async () => {
    const r = createFileTranscriptReader(env.ctx);
    const readdir = vi.spyOn(fsx, 'readdir');
    expect(await r.pathFor(SID.idle)).toBe(env.home.session(SID.idle).transcriptPath);
    expect(await r.pathFor(SID.private)).toBe(env.home.session(SID.private).transcriptPath);
    const listed = readdir.mock.calls.length;
    expect(listed).toBeGreaterThan(0);
    expect(await r.pathFor(SID.idle)).toBe(env.home.session(SID.idle).transcriptPath);
    expect(readdir.mock.calls.length).toBe(listed); // cached: no listing
  });

  it('backs off after a miss instead of listing on every call', async () => {
    const r = createFileTranscriptReader(env.ctx);
    const sid = 'abababab-abab-4bab-8bab-abababababab';
    expect(await r.pathFor(sid)).toBeNull();
    const readdir = vi.spyOn(fsx, 'readdir');
    const target = join(env.home.paths.claudeProjects, fixtureEncode('/x/new-project'), `${sid}.jsonl`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, toJsonl([userPrompt(ctxAt(sid, '/x/new-project', 0), 'hello')]));
    expect(await r.pathFor(sid)).toBeNull(); // still backing off
    expect(readdir).not.toHaveBeenCalled();
    expect(await r.pathFor(sid, { cwd: '/x/new-project' })).toBe(target); // a cwd hint is cheap and always tried
    r.forget(sid);
    env.ctx.clock.advance(16_000);
    expect(await r.pathFor(sid)).toBe(target);
  });

  it('accepts a transcript path from a hook only inside a projects dir and named <sid>.jsonl', async () => {
    const r = createFileTranscriptReader(env.ctx);
    const idle = env.home.session(SID.idle);
    expect(await r.pathFor(SID.idle, { transcriptPath: idle.transcriptPath })).toBe(idle.transcriptPath);
    const outside = join(env.home.paths.cswapRoot, 'credentials', `${SID.busy}.jsonl`);
    await writeFile(outside, '{}\n');
    expect(await r.allowedPath(outside, SID.busy)).toBeNull();
    expect(await r.allowedPath(idle.transcriptPath, SID.busy)).toBeNull(); // wrong sid
    // falls back to the normal lookup
    expect(await r.pathFor(SID.busy, { transcriptPath: outside })).toBe(env.home.session(SID.busy).transcriptPath);
    expect(await r.pathFor('../../etc/passwd')).toBeNull();
  });
});

describe('transcripts: reading', () => {
  let env: SourceEnv;
  let file: string;
  beforeEach(async () => {
    env = await sourceEnv({ home: { sessions: [] } });
    file = join(env.home.root, 'home', '.claude', 'projects', '-t', 'x.jsonl');
    await mkdir(dirname(file), { recursive: true });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('reads complete lines from a byte offset and leaves a partial last line for later', async () => {
    const a = JSON.stringify({ type: 'user', uuid: 'u-1', message: { content: 'héllo wörld ✓' } });
    const b = JSON.stringify({ type: 'assistant', uuid: 'a-1', isSidechain: false, timestamp: '2026-01-15T09:00:00Z', message: { content: [] } });
    await writeFile(file, `${a}\n\nnot json\n${b}\n{"type":"user","par`);
    const r = createFileTranscriptReader(env.ctx);
    const first = await r.readFrom(file, 0);
    expect(first.entries.map((e) => e.uuid)).toEqual(['u-1', 'a-1']);
    expect(first.entries[0]).toMatchObject({ offset: 0, length: Buffer.byteLength(a), type: 'user' });
    expect(first.entries[1]?.offset).toBe(Buffer.byteLength(`${a}\n\nnot json\n`));
    expect(first.entries[1]).toMatchObject({ isSidechain: false, timestamp: '2026-01-15T09:00:00Z' });
    expect(first.next).toBe(Buffer.byteLength(`${a}\n\nnot json\n${b}\n`));
    expect(await r.readFrom(file, first.next)).toEqual({ entries: [], next: first.next });
    await appendFile(file, 'tial":1}\n');
    const second = await r.readFrom(file, first.next);
    expect(second.entries.map((e) => e.type)).toEqual(['user']);
    expect(second.next).toBe(await r.size(file));
  });

  it('respects maxBytes, skips a line longer than it, and restarts when the file shrank', async () => {
    const small = JSON.stringify({ type: 'user', uuid: 's' });
    const huge = JSON.stringify({ type: 'user', uuid: 'h', pad: 'x'.repeat(5000) });
    await writeFile(file, `${small}\n${huge}\n${small}\n`);
    const r = createFileTranscriptReader(env.ctx);
    const one = await r.readFrom(file, 0, { maxBytes: 100 });
    expect(one.entries.map((e) => e.uuid)).toEqual(['s']);
    const two = await r.readFrom(file, one.next, { maxBytes: 100 });
    expect(two.entries).toEqual([]);
    expect(two.next).toBe(one.next + Buffer.byteLength(huge) + 1); // skipped whole
    const three = await r.readFrom(file, two.next, { maxBytes: 100 });
    expect(three.entries.map((e) => e.uuid)).toEqual(['s']);
    const shrunk = await r.readFrom(file, 10_000_000);
    expect(shrunk.entries).toHaveLength(3);
    expect(await r.size(join(env.home.root, 'missing.jsonl'))).toBe(0);
  });

  it('reads lines backwards across chunk borders', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: 'y'.repeat(i * 7) }));
    await writeFile(file, `${lines.join('\n')}\npartial`);
    const fh = await fsx.open(file);
    const got: number[] = [];
    for await (const { line } of linesBackward(fh, Buffer.byteLength(`${lines.join('\n')}\npartial`), 1e6, 64)) {
      got.push(JSON.parse(String(line)).i as number);
    }
    await fh.close();
    expect(got).toEqual(lines.map((_, i) => 49 - i));
  });
});

describe('transcripts: tail summary', () => {
  const sid = 's-1';
  const cwd = '/w/p';
  const c = (sec: number) => ctxAt(sid, cwd, sec);

  it('reports now, the reply after the newest prompt, mode and away', () => {
    const entries: Entry[] = [
      permissionMode(c(0), 'acceptEdits'),
      userPrompt(c(1), 'first task'),
      assistantText(c(2), 'Reply one.'),
      userPrompt(c(3), 'second task'),
      assistantToolUse(c(4), 'Bash', { command: 'npm test', description: 'Run tests' }),
      assistantText(c(5), 'Reply two: tests pass.'),
    ];
    const { tail } = summarizeTail(entries, 'x');
    expect(tail.now).toEqual({ kind: 'said', text: 'Reply two: tests pass.' });
    expect(tail.lastReply).toEqual({ text: 'Reply two: tests pass.', at: c(5).at });
    expect(tail.lastUserPromptAt).toBe(c(3).at);
    expect(tail.mode).toBe('acceptEdits');
  });

  it('never reports a reply older than the newest prompt (the Done race)', () => {
    const entries: Entry[] = [userPrompt(c(1), 'first'), assistantText(c(2), 'Old reply.'), userPrompt(c(3), 'second')];
    const { tail } = summarizeTail(entries, 'x');
    expect(tail.lastReply).toBeUndefined();
    expect(tail.lastUserPromptAt).toBe(c(3).at);
    expect(tail.now).toEqual({ kind: 'prompt', text: 'second' });
  });

  it('treats queued prompts and slash commands as turn starts, but not tool results, meta or interrupts', () => {
    const base: Entry[] = [userPrompt(c(1), 'first'), assistantText(c(2), 'Answer.')];
    expect(summarizeTail([...base, queuedCommand(c(3), 'and also this')], 'x').tail.lastReply).toBeUndefined();
    expect(summarizeTail([...base, slashCommand(c(3), '/compact', 'keep tests')], 'x').tail).toMatchObject({
      lastUserPromptAt: c(3).at,
      now: { kind: 'prompt', text: '/compact keep tests' },
    });
    const notTurns: Entry[] = [
      toolResult(c(3), 'toolu_x', 'ok'),
      metaUser(c(4), 'caveat'),
      userPrompt(c(5), '[Request interrupted by user]'),
      userPrompt(c(6), '<local-command-stdout>done</local-command-stdout>'),
    ];
    const t = summarizeTail([...base, ...notTurns], 'x').tail;
    expect(t.lastReply?.text).toBe('Answer.');
    expect(t.lastUserPromptAt).toBe(c(1).at);
    expect(classifyUser(userPrompt(c(1), '<task-notification>x</task-notification>'))?.cls).toBe('wrapped');
  });

  it('flags an API error only when it is the latest thing that happened', () => {
    const e = [userPrompt(c(1), 'go'), apiError(c(2), 'API Error: Rate limit reached\nretry later', true)];
    expect(summarizeTail(e, 'x').tail.errorLast).toBe('API Error: Rate limit reached');
    expect(summarizeTail([...e, assistantText(c(3), 'Recovered.')], 'x').tail.errorLast).toBeUndefined();
  });

  it('describes the current tool', () => {
    const { tail } = summarizeTail([userPrompt(c(1), 'x'), assistantToolUse(c(2), 'Edit', { file_path: '/w/p/src/header.tsx' })], 'x');
    expect(tail.now).toEqual({ kind: 'tool', tool: 'Edit', text: 'Edit · header.tsx' });
  });
});

describe('transcripts: tail() and page() on files', () => {
  let env: SourceEnv;
  beforeEach(async () => {
    env = await sourceEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('summarises the fixture conversations', async () => {
    const r = createFileTranscriptReader(env.ctx);
    const idle = await r.tail(env.home.session(SID.idle).transcriptPath);
    expect(idle).toMatchObject({
      mode: 'default',
      lastReply: { text: 'Changelog updated and version bumped.' },
      away: 'Fixed the synthetic tests and updated the changelog.',
      now: { kind: 'said', text: 'Changelog updated and version bumped.' },
    });
    const busy = await r.tail(env.home.session(SID.busy).transcriptPath);
    expect(busy.now).toEqual({ kind: 'tool', tool: 'Bash', text: 'Bash · Run tests' });
    expect(busy.lastReply?.text).toBe('Looking at the code now.');
    expect(await r.tail(join(env.home.root, 'nope.jsonl'))).toEqual({});
  });

  it('looks further back when the tail window is one giant tool result', async () => {
    const s = env.home.session(SID.idle);
    const cwd = s.cwd;
    await env.home.appendTranscript(SID.idle, [
      userPrompt(ctxAt(SID.idle, cwd, 100), 'dump the logs'),
      assistantToolUse(ctxAt(SID.idle, cwd, 101), 'Bash', { command: 'cat big.log' }, 'toolu_big'),
      toolResult(ctxAt(SID.idle, cwd, 102), 'toolu_big', 'z'.repeat(400 * 1024)),
    ]);
    const tail = await createFileTranscriptReader(env.ctx, { tailWindowBytes: 64 * 1024 }).tail(s.transcriptPath);
    expect(tail.now).toEqual({ kind: 'tool', tool: 'Bash', text: 'Bash · cat big.log' });
    expect(tail.lastUserPromptAt).toBe(ctxAt(SID.idle, cwd, 100).at);
    expect(tail.lastReply).toBeUndefined();
  });

  it('pages the conversation newest first with a cursor, text only', async () => {
    const r = createFileTranscriptReader(env.ctx);
    const first = await r.page(SID.idle, { limit: 3 });
    expect(first.items.map((i) => [i.role, i.kind, i.text])).toEqual([
      ['system', 'meta', 'Fixed the synthetic tests and updated the changelog.'],
      ['assistant', 'text', 'Changelog updated and version bumped.'],
      ['user', 'queued', 'also update the changelog'],
    ]);
    expect(first.nextBefore).toMatch(/^\d+$/);
    const rest = await r.page(SID.idle, { limit: 50, before: first.nextBefore ?? undefined });
    expect(rest.items.map((i) => [i.role, i.kind])).toEqual([
      ['assistant', 'text'],
      ['user', 'text'],
    ]);
    expect(rest.nextBefore).toBeNull();
    const ids = [...first.items, ...rest.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await r.page(SID.idle, { limit: 5, before: 'not-a-cursor' })).toEqual({ items: [], nextBefore: null });
    expect(await r.page('no-such-session', { limit: 5 })).toEqual({ items: [], nextBefore: null });
  });

  it('a plan approval (ExitPlanMode) shows its line, then the plan itself as text', () => {
    const entry = (input: unknown) => ({
      type: 'assistant',
      uuid: 'plan-entry',
      timestamp: new Date(T0).toISOString(),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'ExitPlanMode', input }] },
    });
    const plan = '# Plan: notes page\n\n- Add a list.\n- Add a form.';
    expect(itemsFromEntry(entry({ plan }), 0).map((i) => [i.kind, i.text])).toEqual([
      ['tool_use', 'plan ready for your approval'],
      ['text', plan],
    ]);
    // No plan text (or a blank one): the line alone.
    for (const input of [{}, { plan: '  ' }, { plan: 7 }, null]) expect(itemsFromEntry(entry(input), 0)).toHaveLength(1);
  });

  it('shows tool calls as one-line items', async () => {
    const r = createFileTranscriptReader(env.ctx);
    const page = await r.page(SID.busy, { limit: 10 });
    expect(page.items[0]).toMatchObject({ role: 'assistant', kind: 'tool_use', tool: 'Bash', text: 'Bash · Run tests' });
  });
});
