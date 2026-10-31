/**
 * The changed-files scanner (v0.3 spec 4.4.8, 8.2.5) and its hook in the
 * transcript watcher: Write / Edit / MultiEdit / NotebookEdit calls paired
 * with their results, statuses from the shared denial texts, counts, large
 * lines read from their two ends, and `files.changed` while Files is on.
 */
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SECRET_MARKER,
  assistantToolUse,
  fileOpsScenario,
  markersIn,
  metaUser,
  timeline,
  toJsonl,
  toolResult,
  userPrompt,
  type Entry,
  type EntryContext,
} from '@jantar/fixtures';
import { EventDataSchemas, SettingsSchema } from '@jantar/protocol';
import { createTestContext } from '../../src/core/testing.js';
import { createClaudeFilesSource, type ClaudeFilesSource } from '../../src/sources/claude-files/index.js';
import {
  FILE_EVENTS_PER_READ,
  FileChangeScanner,
  LARGE_LINE_BYTES,
  changeIdFor,
  type ScannedOp,
} from '../../src/sources/transcripts/file-changes.js';
import {
  createFileTranscriptReader,
  createTranscriptWatcherWith,
  type FileTranscriptReader,
  type TranscriptWatcherImpl,
} from '../../src/sources/transcripts/index.js';
import { SID, at, sourceEnv, type SourceEnv } from './helpers.js';

const T0 = '2026-01-15T10:00:00.000Z';
const CWD = '/w/app';
const SESSION = 'sess-file-ops';

const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:\nput it in docs/";
const DENY_RULE = 'Permission to use Write with file_path /w/app/src/blocked.ts has been denied.';
const AUTO_MODE = 'Permission for this Edit was denied by the Claude Code auto mode classifier. Reason: Touches CI config.';

/** A tool result with Claude's `toolUseResult` beside it. */
function result(ctx: EntryContext, id: string, toolUseResult?: unknown, text = 'The file has been updated.'): Entry {
  const e = toolResult(ctx, id, text);
  if (toolUseResult !== undefined) e.toolUseResult = toolUseResult;
  return e;
}

function denied(ctx: EntryContext, id: string, text: string): Entry {
  const e = toolResult(ctx, id, text, true);
  e.toolUseResult = `Error: ${text}`;
  return e;
}

/** Feed entries in order, as one scanner would see them; returns every op and each line's offset. */
function scanAll(entries: readonly Entry[], scanner = new FileChangeScanner()): { ops: ScannedOp[]; offsets: number[] } {
  const ops: ScannedOp[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const e of entries) {
    const line = JSON.stringify(e);
    offsets.push(offset);
    ops.push(...scanner.scan(e, offset, Buffer.byteLength(line), 0));
    offset += Buffer.byteLength(line) + 1;
  }
  return { ops, offsets };
}

const patch = (lines: string[]) => [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines }];

describe('FileChangeScanner: ops from parsed entries', () => {
  let tl: ReturnType<typeof timeline>;
  beforeEach(() => {
    tl = timeline(T0, SESSION, CWD);
  });

  it('a created file: Write paired with its result, counted from its content', () => {
    const { ops, offsets } = scanAll([
      assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/src/new.ts', content: 'a\nb\nc\n' }, 'toolu_w1'),
      result(tl.next(), 'toolu_w1', { type: 'create', filePath: '/w/app/src/new.ts', content: 'a\nb\nc\n', structuredPatch: [], originalFile: null }),
    ]);
    expect(ops).toEqual([
      {
        opId: 'toolu_w1',
        tool: 'Write',
        path: '/w/app/src/new.ts',
        at: Date.parse(T0) + 1000,
        status: 'ok',
        added: 3,
        removed: 0,
        approx: false,
        byAgent: false,
        large: false,
        created: true,
        offset: offsets[1],
      },
    ]);
  });

  it('Edit counts from structuredPatch; MultiEdit and NotebookEdit without one are estimated', () => {
    const { ops } = scanAll([
      assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/src/app.ts', old_string: 'x', new_string: 'y\nz' }, 'toolu_e1'),
      result(tl.next(), 'toolu_e1', { filePath: '/w/app/src/app.ts', structuredPatch: patch([' keep', '-x', '+y', '+z']), userModified: false }),
      assistantToolUse(
        tl.next(),
        'MultiEdit',
        { file_path: '/w/app/src/app.ts', edits: [{ old_string: 'a\nb', new_string: 'c' }, { old_string: 'd', new_string: 'e\nf\ng' }] },
        'toolu_m1',
      ),
      result(tl.next(), 'toolu_m1'),
      assistantToolUse(tl.next(), 'NotebookEdit', { notebook_path: '/w/app/nb.ipynb', cell_id: 'c1', new_source: 'print(1)\nprint(2)', edit_mode: 'replace' }, 'toolu_n1'),
      result(tl.next(), 'toolu_n1', { new_source: 'print(1)\nprint(2)', cell_id: 'c1' }),
    ]);
    expect(ops.map((o) => [o.tool, o.path, o.added, o.removed, o.approx, o.created])).toEqual([
      ['Edit', '/w/app/src/app.ts', 2, 1, false, null],
      ['MultiEdit', '/w/app/src/app.ts', 4, 3, true, null],
      ['NotebookEdit', '/w/app/nb.ipynb', 2, null, true, null],
    ]);
  });

  it('is_error results use the alert scanner’s denial texts: rejected, blocked, else error', () => {
    const { ops } = scanAll([
      assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/src/old.ts', old_string: 'a', new_string: 'b' }, 'toolu_r1'),
      denied(tl.next(), 'toolu_r1', REJECTED),
      assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/src/blocked.ts', content: 'x' }, 'toolu_b1'),
      denied(tl.next(), 'toolu_b1', DENY_RULE),
      assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/.github/ci.yml', old_string: 'a', new_string: 'b' }, 'toolu_b2'),
      denied(tl.next(), 'toolu_b2', AUTO_MODE),
      assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/src/app.ts', old_string: 'nope', new_string: 'b' }, 'toolu_x1'),
      denied(tl.next(), 'toolu_x1', 'String to replace not found in file.'),
    ]);
    expect(ops.map((o) => [o.opId, o.status, o.approx])).toEqual([
      ['toolu_r1', 'rejected', true],
      ['toolu_b1', 'blocked', true],
      ['toolu_b2', 'blocked', true],
      ['toolu_x1', 'error', true],
    ]);
  });

  it('joins a relative path to the entry’s cwd and normalises it; one without a usable cwd is dropped', () => {
    const rel = assistantToolUse(tl.next(), 'Write', { file_path: 'docs/../docs/readme.md', content: '# hi' }, 'toolu_rel');
    const noCwd = assistantToolUse({ ...tl.next(), cwd: 'relative/cwd' }, 'Write', { file_path: 'x.md', content: '' }, 'toolu_nocwd');
    const dotted = assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/src/../lib/./util.ts/', old_string: 'a', new_string: 'b' }, 'toolu_dot');
    const { ops } = scanAll([rel, result(tl.next(), 'toolu_rel'), noCwd, result(tl.next(), 'toolu_nocwd'), dotted, result(tl.next(), 'toolu_dot')]);
    expect(ops.map((o) => o.path)).toEqual(['/w/app/docs/readme.md', '/w/app/lib/util.ts']);
  });

  it('ignores other tools, unknown or repeated results, and bad paths or ids', () => {
    const { ops } = scanAll([
      assistantToolUse(tl.next(), 'Bash', { command: 'echo hi > out.txt' }, 'toolu_bash'),
      result(tl.next(), 'toolu_bash'),
      assistantToolUse(tl.next(), 'Read', { file_path: '/w/app/a.ts' }, 'toolu_read'),
      result(tl.next(), 'toolu_read'),
      result(tl.next(), 'toolu_never_asked'),
      assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/nul\0.ts', content: '' }, 'toolu_nul'),
      result(tl.next(), 'toolu_nul'),
      assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/ok.ts', content: '' }, 'bad id with spaces'),
      result(tl.next(), 'bad id with spaces'),
      assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/once.ts', content: '' }, 'toolu_once'),
      result(tl.next(), 'toolu_once'),
      result(tl.next(), 'toolu_once'),
    ]);
    expect(ops.map((o) => o.opId)).toEqual(['toolu_once']);
  });

  it('marks subagent ops: a sidechain entry, or every op of a subagent’s own transcript', () => {
    const side = assistantToolUse({ ...tl.next(), isSidechain: true }, 'Edit', { file_path: '/w/app/a.ts', old_string: 'a', new_string: 'b' }, 'toolu_s1');
    const main = assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/b.ts', old_string: 'a', new_string: 'b' }, 'toolu_s2');
    expect(scanAll([side, result(tl.next(), 'toolu_s1'), main, result(tl.next(), 'toolu_s2')]).ops.map((o) => o.byAgent)).toEqual([true, false]);
    const sub = new FileChangeScanner({ byAgent: true });
    expect(scanAll([main, result(tl.next(), 'toolu_s2')], sub).ops.map((o) => o.byAgent)).toEqual([true]);
  });

  it('a line over 1 MiB gives no counts (large); a small call with a large result keeps its estimate', () => {
    const scanner = new FileChangeScanner();
    const use = assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/big.txt', content: 'a\nb' }, 'toolu_big');
    scanner.scan(use, 0, LARGE_LINE_BYTES + 1, 0);
    const [big] = scanner.scan(result(tl.next(), 'toolu_big', { type: 'create', content: 'a\nb' }), 100, 200, 0);
    expect(big).toMatchObject({ large: true, added: null, removed: null, approx: true, created: true });

    const edit = assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/huge.ts', old_string: 'a', new_string: 'b\nc' }, 'toolu_huge');
    scanner.scan(edit, 300, 400, 0);
    const res = result(tl.next(), 'toolu_huge', { structuredPatch: patch(['-a', '+b', '+c']), originalFile: 'x' });
    const [huge] = scanner.scan(res, 500, LARGE_LINE_BYTES + 1, 0);
    expect(huge).toMatchObject({ large: true, added: 2, removed: 1, approx: true });
  });

  it('a result without a timestamp takes the call’s time; two results in one entry ignore toolUseResult', () => {
    const scanner = new FileChangeScanner();
    scanner.scan(assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/a.ts', content: 'a' }, 'toolu_t1'), 0, 10, 0);
    const bare = result(tl.next(), 'toolu_t1', { type: 'create', content: 'a' });
    delete bare.timestamp;
    expect(scanner.scan(bare, 20, 10, 999)[0]?.at).toBe(Date.parse(T0));

    scanner.scan(assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/b.ts', content: 'b' }, 'toolu_t2'), 40, 10, 0);
    scanner.scan(assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/c.ts', content: 'c' }, 'toolu_t3'), 60, 10, 0);
    const both: Entry = {
      ...result(tl.next(), 'toolu_t2', { type: 'create', content: 'b' }),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_t2', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'toolu_t3', content: 'ok' },
        ],
      },
    };
    expect(scanner.scan(both, 80, 10, 0).map((o) => [o.opId, o.created, o.approx])).toEqual([
      ['toolu_t2', null, true],
      ['toolu_t3', null, true],
    ]);
  });

  it('lists calls still waiting for a result until a new prompt or an interrupt; a result that comes after all still pairs', () => {
    const scanner = new FileChangeScanner();
    const { offsets } = scanAll(
      [
        assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/wait.ts', content: 'w\n' }, 'toolu_p1'),
        assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/done.ts', old_string: 'a', new_string: 'b' }, 'toolu_p2'),
        result(tl.next(), 'toolu_p2'),
        metaUser(tl.next(), '<system-reminder>synthetic</system-reminder>'),
      ],
      scanner,
    );
    expect(scanner.pendingOps()).toEqual([
      { opId: 'toolu_p1', tool: 'Write', path: '/w/app/wait.ts', at: Date.parse(T0), status: 'pending', added: 1, removed: null, approx: true, byAgent: false, large: false, created: null, offset: offsets[0] },
    ]);
    scanner.scan(userPrompt(tl.next(), 'never mind, do the docs'), 999, 40, 0);
    expect(scanner.pendingOps()).toEqual([]);
    scanner.scan(assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/x.ts', content: '' }, 'toolu_p3'), 1000, 10, 0);
    scanner.scan(userPrompt(tl.next(), '[Request interrupted by user for tool use]'), 1100, 10, 0);
    expect(scanner.pendingOps()).toEqual([]);
    expect(scanner.scan(result(tl.next(), 'toolu_p3'), 1200, 10, 0).map((o) => [o.opId, o.status, o.offset])).toEqual([['toolu_p3', 'ok', 1200]]);
    expect(scanner.scan(result(tl.next(), 'toolu_p1'), 1300, 10, 0).map((o) => [o.opId, o.path])).toEqual([['toolu_p1', '/w/app/wait.ts']]);
    expect(scanner.pendingOps()).toEqual([]);
  });

  it('keeps the newest 50 calls a new turn left without a result for a late one, not more', () => {
    const scanner = new FileChangeScanner();
    for (let i = 0; i < 60; i++) scanner.scan(assistantToolUse(tl.next(), 'Edit', { file_path: `/w/app/f${i}.ts`, old_string: 'a', new_string: 'b' }, `toolu_l${i}`), i * 10, 10, 0);
    scanner.scan(userPrompt(tl.next(), 'next thing'), 1000, 10, 0);
    expect(scanner.scan(result(tl.next(), 'toolu_l9'), 1100, 10, 0)).toEqual([]);
    expect(scanner.scan(result(tl.next(), 'toolu_l10'), 1200, 10, 0).map((o) => o.opId)).toEqual(['toolu_l10']);
    expect(scanner.scan(result(tl.next(), 'toolu_l59'), 1300, 10, 0).map((o) => o.opId)).toEqual(['toolu_l59']);
  });

  it('a Write that rewrote the same content (an update with an empty patch) changed 0 lines, exactly', () => {
    const { ops } = scanAll([
      assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/same.ts', content: 'a\nb\nc\nd\n' }, 'toolu_same'),
      result(tl.next(), 'toolu_same', { type: 'update', filePath: '/w/app/same.ts', content: 'a\nb\nc\nd\n', structuredPatch: [], originalFile: 'a\nb\nc\nd\n' }),
      // a create with an empty patch still counts its lines; an Edit without a type still estimates
      assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/e.ts', old_string: 'a', new_string: 'b' }, 'toolu_e0'),
      result(tl.next(), 'toolu_e0', { filePath: '/w/app/e.ts', structuredPatch: [] }),
    ]);
    expect(ops.map((o) => [o.opId, o.added, o.removed, o.approx, o.created])).toEqual([
      ['toolu_same', 0, 0, false, false],
      ['toolu_e0', 1, 1, true, null],
    ]);
  });

  it('changeIdFor is stable per session and path', () => {
    expect(changeIdFor('s1', '/w/a.ts')).toBe(changeIdFor('s1', '/w/a.ts'));
    expect(changeIdFor('s1', '/w/a.ts')).not.toBe(changeIdFor('s2', '/w/a.ts'));
    expect(changeIdFor('s1', '/w/a.ts')).toMatch(/^c_[0-9a-f]{24}$/);
  });
});

// ---------------------------------------------------------------------------
// Lines the reader skips (over its maxBytes): read from their two ends.

/** A Write call shaped like Claude's own lines: message first, type / uuid / timestamp / cwd after it. */
function claudeOrderWrite(id: string, path: string, content: string, pathFirst: boolean, at: string, cwd = CWD): string {
  const input = pathFirst ? { file_path: path, content } : { content, file_path: path };
  return JSON.stringify({
    parentUuid: 'p-1',
    isSidechain: false,
    message: { model: 'claude-synthetic', id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input, caller: { type: 'direct' } }] },
    requestId: 'req_1',
    type: 'assistant',
    uuid: `u-${id}`,
    timestamp: at,
    userType: 'external',
    cwd,
    sessionId: SESSION,
  });
}

/** Its result, as Claude writes it: the whole content again in toolUseResult. */
function claudeOrderResult(id: string, path: string, content: string, at: string, text = `File created successfully at: ${path}`, isError = false): string {
  const block: Record<string, unknown> = isError ? { type: 'tool_result', content: text, is_error: true, tool_use_id: id } : { tool_use_id: id, type: 'tool_result', content: text };
  return JSON.stringify({
    parentUuid: `u-${id}`,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [block] },
    uuid: `r-${id}`,
    timestamp: at,
    toolUseResult: { type: 'create', filePath: path, content, structuredPatch: [], originalFile: null },
    cwd: CWD,
    sessionId: SESSION,
  });
}

describe('FileChangeScanner: lines too long to parse', () => {
  let dir: string;
  let reader: FileTranscriptReader;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'ccw-fc-scan-')));
    reader = createFileTranscriptReader(createTestContext({ userHome: dir }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Read a file the way the changes index does (1 MiB reads) and scan it. */
  async function readAll(path: string, scanner = new FileChangeScanner(), maxBytes = LARGE_LINE_BYTES): Promise<ScannedOp[]> {
    const ops: ScannedOp[] = [];
    let offset = 0;
    for (;;) {
      const r = await reader.readFrom(path, offset, { maxBytes });
      if (r.next <= offset) return ops;
      ops.push(...(await scanner.scanRead(path, offset, r.entries, r.next, 0)));
      offset = r.next;
    }
  }

  const BIG = `${'0123456789abcdef'.repeat(4)}\n`.repeat(6 * 1024 * 1024 / 65); // ~6 MB of text

  it('finds name, id and path of a 6 MB Write whether file_path comes before or after the content', async () => {
    const t = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
    const lines = [
      claudeOrderWrite('toolu_before', '/w/app/big/a.txt', BIG, true, t(1)),
      claudeOrderResult('toolu_before', '/w/app/big/a.txt', BIG, t(2)),
      claudeOrderWrite('toolu_after', 'big/b.txt', BIG, false, t(3)),
      claudeOrderResult('toolu_after', '/w/app/big/b.txt', BIG, t(4)),
    ];
    expect(lines.every((l) => Buffer.byteLength(l) > 4 * 1024 * 1024)).toBe(true);
    const path = join(dir, 't.jsonl');
    await writeFile(path, `${lines.join('\n')}\n`);
    const offsets = [0];
    for (const l of lines) offsets.push((offsets.at(-1) ?? 0) + Buffer.byteLength(l) + 1);
    const ops = await readAll(path);
    expect(ops).toEqual([
      { opId: 'toolu_before', tool: 'Write', path: '/w/app/big/a.txt', at: Date.parse(t(2)), status: 'ok', added: null, removed: null, approx: true, byAgent: false, large: true, created: true, offset: offsets[1] },
      { opId: 'toolu_after', tool: 'Write', path: '/w/app/big/b.txt', at: Date.parse(t(4)), status: 'ok', added: null, removed: null, approx: true, byAgent: false, large: true, created: true, offset: offsets[3] },
    ]);
    // the watcher's 4 MiB reads skip these lines too, and find the same ops
    expect((await readAll(path, new FileChangeScanner(), 4 * 1024 * 1024)).map((o) => [o.opId, o.path])).toEqual(ops.map((o) => [o.opId, o.path]));
  });

  it('reads the denial at the start of a long error result', async () => {
    const path = join(dir, 'denied.jsonl');
    const use = claudeOrderWrite('toolu_no', '/w/app/x.txt', 'small', true, T0);
    const res = claudeOrderResult('toolu_no', '/w/app/x.txt', BIG, T0, REJECTED, true);
    await writeFile(path, `${use}\n${res}\n`);
    const [op] = await readAll(path);
    expect(op).toMatchObject({ opId: 'toolu_no', status: 'rejected', large: true, added: 1, removed: null });
  });

  it('a prompt line too long to parse (a pasted image) starts a new turn; a long meta or subagent line does not', async () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2 * LARGE_LINE_BYTES) } };
    const prompt = (over: Record<string, unknown>) =>
      JSON.stringify({
        parentUuid: 'p-1',
        isSidechain: false,
        userType: 'external',
        cwd: CWD,
        sessionId: SESSION,
        type: 'user',
        ...over,
        message: { role: 'user', content: [{ type: 'text', text: 'what is wrong here?' }, image] },
        uuid: 'u-prompt',
        timestamp: T0,
      });
    const waiting = claudeOrderWrite('toolu_wait', '/w/app/wait.ts', 'w', true, T0);
    for (const [label, line, pending] of [
      ['prompt', prompt({}), []],
      ['meta', prompt({ isMeta: true }), ['toolu_wait']],
      ['subagent', prompt({ isSidechain: true }), ['toolu_wait']],
    ] as const) {
      const path = join(dir, `${label}.jsonl`);
      await writeFile(path, `${waiting}\n${line}\n`);
      const scanner = new FileChangeScanner();
      expect(await readAll(path, scanner), label).toEqual([]);
      expect(scanner.pendingOps().map((o) => o.opId), label).toEqual(pending);
    }
  });

  it('a long line that is not JSON, or names no file tool, gives nothing and does not throw', async () => {
    const path = join(dir, 'junk.jsonl');
    const bash = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_sh', name: 'Bash', input: { command: BIG } }] } });
    await writeFile(path, `${'x'.repeat(2 * LARGE_LINE_BYTES)}\n${bash}\n${claudeOrderResult('toolu_sh', '/w/app/a', BIG, T0)}\n`);
    expect(await readAll(path)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Spec 8.2.5's transcripts (WP-T1's fileOpsScenario), read like the index reads them.

describe('FileChangeScanner: the 8.2.5 fixture transcripts', () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds every op of the scenario with its status, path, flags and stated counts', async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'ccw-fc-825-')));
    const reader = createFileTranscriptReader(createTestContext({ userHome: dir }));
    const scenario = fileOpsScenario({ sid: SESSION, cwd: CWD, at: T0 });
    const read = async (path: string, scanner: FileChangeScanner): Promise<ScannedOp[]> => {
      const ops: ScannedOp[] = [];
      for (let offset = 0; ; ) {
        const r = await reader.readFrom(path, offset, { maxBytes: LARGE_LINE_BYTES });
        if (r.next <= offset) break;
        ops.push(...(await scanner.scanRead(path, offset, r.entries, r.next, 0)));
        offset = r.next;
      }
      return [...ops, ...scanner.pendingOps()];
    };
    const main = join(dir, 'main.jsonl');
    const sub = join(dir, 'sub.jsonl');
    await writeFile(main, toJsonl(scenario.main));
    await writeFile(sub, toJsonl(scenario.subagent.entries));
    const ops = [...(await read(main, new FileChangeScanner())), ...(await read(sub, new FileChangeScanner({ byAgent: true })))];

    const found = new Map(ops.map((o) => [o.opId, o]));
    expect(ops).toHaveLength(scenario.expected.length);
    for (const want of scenario.expected) {
      const got = found.get(want.opId);
      expect(got, want.label).toBeDefined();
      expect([got?.tool, got?.path, got?.status, got?.byAgent, got?.large, got?.created === true], want.label).toEqual([
        want.tool,
        want.path,
        want.status,
        want.byAgent,
        want.large,
        want.created,
      ]);
      // counts the transcript states are exact; anything else is our estimate, flagged approx
      if (want.added !== null) expect([got?.added, got?.removed, got?.approx], want.label).toEqual([want.added, want.removed, false]);
      else expect(got?.approx, want.label).toBe(true);
    }
    for (const id of scenario.notListed) expect(found.has(id), id).toBe(false);
    expect(markersIn(ops)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The watcher hook: files.changed while Files is on.

interface Rig {
  env: SourceEnv;
  sessions: ClaudeFilesSource;
  watcher: TranscriptWatcherImpl;
  step(): Promise<void>;
}

async function rig(env: SourceEnv): Promise<Rig> {
  const sessions = createClaudeFilesSource(env.ctx, { watch: false, pollMs: 1e9 });
  const reader = createFileTranscriptReader(env.ctx);
  const watcher = createTranscriptWatcherWith(env.ctx, { sessions, transcripts: reader }, { pollMs: 1e9 });
  await sessions.start();
  await watcher.start();
  return {
    env,
    sessions,
    watcher,
    async step() {
      await sessions.scan();
      await watcher.pollOnce();
    },
  };
}

const FILES_ON = SettingsSchema.parse({ files: { enabled: true } });

describe('transcript watcher: files.changed', () => {
  let env: SourceEnv;
  let r: Rig;
  afterEach(async () => {
    await r.watcher.stop();
    await r.sessions.stop();
    await env.cleanup();
  });

  it('publishes one compact event per finished op, with the result line’s offset and no content', async () => {
    env = await sourceEnv({ settings: FILES_ON });
    r = await rig(env);
    const s = env.home.session(SID.idle);
    const path = `${s.cwd}/src/secret-notes.ts`;
    const content = `export const note = '${SECRET_MARKER}';\n`;
    env.ctx.clock.advance(1000);
    const use = assistantToolUse(at(env.ctx, SID.idle, s.cwd), 'Write', { file_path: path, content }, 'toolu_live1');
    const res = result(at(env.ctx, SID.idle, s.cwd, 500), 'toolu_live1', { type: 'create', filePath: path, content, structuredPatch: [] });
    const { before } = await env.home.appendTranscript(SID.idle, [use, res]);
    await r.step();
    const evs = env.events.of('files.changed', SID.idle);
    expect(evs).toHaveLength(1);
    const ev = evs[0];
    expect(ev?.account).toBe(env.ctx.store.getState().sessions[SID.idle]?.account);
    expect(ev?.data).toEqual({
      changeId: changeIdFor(SID.idle, path),
      path,
      tool: 'Write',
      at: new Date(env.ctx.clock.now() + 500).toISOString(),
      status: 'ok',
      opId: 'toolu_live1',
      transcriptOffset: before + Buffer.byteLength(JSON.stringify(use)) + 1,
      byAgent: false,
    });
    expect(EventDataSchemas['files.changed'].parse(ev?.data)).toEqual(ev?.data);
    expect(JSON.stringify(env.events.all)).not.toContain(SECRET_MARKER);
  });

  it('publishes nothing while Files is off (alerts still work)', async () => {
    env = await sourceEnv();
    r = await rig(env);
    const s = env.home.session(SID.idle);
    env.ctx.clock.advance(1000);
    await env.home.appendTranscript(SID.idle, [
      assistantToolUse(at(env.ctx, SID.idle, s.cwd), 'Edit', { file_path: `${s.cwd}/a.ts`, old_string: 'a', new_string: 'b' }, 'toolu_off'),
      denied(at(env.ctx, SID.idle, s.cwd), 'toolu_off', AUTO_MODE),
    ]);
    await r.step();
    expect(env.events.of('files.changed')).toEqual([]);
    expect(env.events.of('alert.blocked', SID.idle)).toHaveLength(1);
  });

  it('does not republish history at start, but pairs a result that lands later with its earlier call', async () => {
    env = await sourceEnv({ settings: FILES_ON });
    const s = env.home.session(SID.idle);
    const old = (ms: number) => at(env.ctx, SID.idle, s.cwd, ms);
    await env.home.appendTranscript(SID.idle, [
      assistantToolUse(old(-60_000), 'Write', { file_path: `${s.cwd}/old.ts`, content: 'x' }, 'toolu_hist'),
      result(old(-59_000), 'toolu_hist'),
    ]);
    r = await rig(env);
    expect(env.events.of('files.changed')).toEqual([]);

    // the waiting session's Edit (toolu_synthetic_wait) was asked before the daemon started
    const w = env.home.session(SID.waiting);
    env.ctx.clock.advance(2000);
    await env.home.appendTranscript(SID.waiting, [result(at(env.ctx, SID.waiting, w.cwd), 'toolu_synthetic_wait')]);
    await r.step();
    expect(env.events.of('files.changed', SID.waiting).map((e) => [e.data.opId, e.data.path, e.data.tool])).toEqual([
      ['toolu_synthetic_wait', `${w.cwd}/src/header.tsx`, 'Edit'],
    ]);
  });

  it('marks ops from a subagent’s transcript as byAgent', async () => {
    env = await sourceEnv({ settings: FILES_ON });
    r = await rig(env);
    const sid = SID.busy;
    const s = env.home.session(sid);
    const sub = join(dirname(s.transcriptPath), sid, 'subagents', 'agent-a1.jsonl');
    await mkdir(dirname(sub), { recursive: true });
    env.ctx.clock.advance(1000);
    const side = { ...at(env.ctx, sid, s.cwd), isSidechain: true };
    await writeFile(sub, toJsonl([assistantToolUse(side, 'Edit', { file_path: `${s.cwd}/src/sub.ts`, old_string: 'a', new_string: 'b' }, 'toolu_sub1'), result(side, 'toolu_sub1')]));
    env.ctx.clock.advance(20_000); // subagent folders are listed every 20 s
    await r.step();
    expect(env.events.of('files.changed', sid).map((e) => [e.data.opId, e.data.byAgent])).toEqual([['toolu_sub1', true]]);
  });

  it('finds a Write whose lines are longer than the watcher’s 4 MiB reads', async () => {
    env = await sourceEnv({ settings: FILES_ON });
    r = await rig(env);
    const s = env.home.session(SID.idle);
    env.ctx.clock.advance(1000);
    const big = 'y'.repeat(5 * 1024 * 1024);
    const when = new Date(env.ctx.clock.now()).toISOString();
    await appendFile(s.transcriptPath, `${claudeOrderWrite('toolu_huge1', 'gen/big.txt', big, false, when, s.cwd)}\n${claudeOrderResult('toolu_huge1', `${s.cwd}/gen/big.txt`, big, when)}\n`);
    await r.step();
    expect(env.events.of('files.changed', SID.idle).map((e) => [e.data.opId, e.data.path])).toEqual([['toolu_huge1', `${s.cwd}/gen/big.txt`]]);
  });

  it('a transcript that shrank is read again from its start with a fresh scanner', async () => {
    env = await sourceEnv({ settings: FILES_ON });
    r = await rig(env);
    const s = env.home.session(SID.idle);
    env.ctx.clock.advance(1000);
    const filler = Array.from({ length: 20 }, (_, i) => userPrompt(at(env.ctx, SID.idle, s.cwd, i), `filler prompt ${i} ${'x'.repeat(200)}`));
    await env.home.appendTranscript(SID.idle, [
      ...filler,
      assistantToolUse(at(env.ctx, SID.idle, s.cwd), 'Write', { file_path: `${s.cwd}/first.ts`, content: '' }, 'toolu_first'),
      result(at(env.ctx, SID.idle, s.cwd), 'toolu_first'),
    ]);
    await r.step();
    expect(env.events.of('files.changed', SID.idle).map((e) => e.data.opId)).toEqual(['toolu_first']);

    env.ctx.clock.advance(1000);
    await writeFile(
      s.transcriptPath,
      toJsonl([assistantToolUse(at(env.ctx, SID.idle, s.cwd), 'Edit', { file_path: `${s.cwd}/again.ts`, old_string: 'a', new_string: 'b' }, 'toolu_again'), result(at(env.ctx, SID.idle, s.cwd, 10), 'toolu_again')]),
    );
    await r.step();
    expect(env.events.of('files.changed', SID.idle).map((e) => [e.data.opId, e.data.transcriptOffset])).toEqual([
      ['toolu_first', expect.any(Number)],
      ['toolu_again', expect.any(Number)],
    ]);
  });

  it(`publishes at most ${FILE_EVENTS_PER_READ} events per read (the newest)`, async () => {
    env = await sourceEnv({ settings: FILES_ON });
    r = await rig(env);
    const s = env.home.session(SID.idle);
    env.ctx.clock.advance(1000);
    const entries: Entry[] = [];
    for (let i = 0; i < FILE_EVENTS_PER_READ + 8; i++) {
      entries.push(assistantToolUse(at(env.ctx, SID.idle, s.cwd, i), 'Write', { file_path: `${s.cwd}/gen/f${i}.ts`, content: '' }, `toolu_many${i}`));
      entries.push(result(at(env.ctx, SID.idle, s.cwd, i), `toolu_many${i}`));
    }
    await env.home.appendTranscript(SID.idle, entries);
    await r.step();
    const ids = env.events.of('files.changed', SID.idle).map((e) => e.data.opId);
    expect(ids).toHaveLength(FILE_EVENTS_PER_READ);
    expect(ids.at(-1)).toBe(`toolu_many${FILE_EVENTS_PER_READ + 7}`);
  });
});
