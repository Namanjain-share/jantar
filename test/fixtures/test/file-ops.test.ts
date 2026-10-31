import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_SIDS,
  SECRET_MARKER,
  aliasPair,
  fileOpsScenario,
  makeFakeHome,
  patchCounts,
  simplePatch,
  writeFileOpsSession,
  type FakeHome,
  type FileOpsScenario,
} from '../src/index.js';

const SID = DEFAULT_LIVE_SIDS[1];
let home: FakeHome;
let s: FileOpsScenario;
let subagentPath: string;

beforeAll(async () => {
  home = await makeFakeHome();
  const cwd = home.session(SID).cwd;
  s = fileOpsScenario({ sid: SID, cwd, at: home.now, alias: await aliasPair(join(home.root, 'tmp')), largeBytes: 6 * 1024 * 1024 });
  ({ subagentPath } = await writeFileOpsSession(home, SID, s));
});
afterAll(async () => {
  await home.cleanup();
});

const byLabel = (label: string) => {
  const e = s.expected.find((x) => x.label === label);
  if (!e) throw new Error(`no op ${label}`);
  return e;
};

/** Lines of a JSONL file, parsed lazily (some are 6 MB). */
async function lines(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean);
}

describe('fileOpsScenario', () => {
  it('covers every case of spec 8.2.5 except the git-only group', () => {
    expect(s.expected.map((e) => e.label)).toEqual([
      'write-create',
      'edit',
      'multi-edit',
      'notebook-edit',
      'rejected-edit',
      'deny-rule-write',
      'auto-mode-edit',
      'hook-blocked-write',
      'failed-edit',
      'large-write-path-first',
      'large-write-path-last',
      'relative-path',
      'alias-write',
      'alias-edit',
      'protected-write',
      'pending-write',
      'subagent-edit',
    ]);
    expect(new Set(s.expected.map((e) => e.opId)).size).toBe(s.expected.length);
    expect(s.notListed).toHaveLength(1);
  });

  it('states the counts the transcript carries', () => {
    expect(byLabel('write-create')).toMatchObject({ tool: 'Write', status: 'ok', added: 4, removed: 0, created: true });
    expect(byLabel('edit')).toMatchObject({ tool: 'Edit', added: 1, removed: 1, created: false });
    expect(byLabel('multi-edit')).toMatchObject({ tool: 'MultiEdit', added: 2, removed: 2 });
    expect(byLabel('notebook-edit')).toMatchObject({ tool: 'NotebookEdit', added: null, removed: null });
    expect(byLabel('rejected-edit')).toMatchObject({ status: 'rejected', added: null });
    expect(byLabel('deny-rule-write').status).toBe('blocked');
    expect(byLabel('auto-mode-edit').status).toBe('blocked');
    expect(byLabel('hook-blocked-write').status).toBe('blocked');
    expect(byLabel('failed-edit').status).toBe('error');
    expect(byLabel('pending-write').status).toBe('pending');
    expect(byLabel('subagent-edit')).toMatchObject({ byAgent: true, added: 1, removed: 1 });
    expect(byLabel('protected-write')).toMatchObject({ protectedPath: true, path: join(s.cwd, '.env') });
  });

  it('joins a relative file_path to the cwd', async () => {
    expect(byLabel('relative-path').path).toBe(join(s.cwd, 'src', 'rel.ts'));
    const all = await lines(home.session(SID).transcriptPath);
    const use = all.map((l) => JSON.parse(l)).find((e) => e.message?.content?.[0]?.id === byLabel('relative-path').opId);
    expect(use.message.content[0].input.file_path).toBe('src/rel.ts');
  });
});

describe('writeFileOpsSession', () => {
  it('appends tool_use / tool_result pairs carrying toolUseResult', async () => {
    const entries = (await lines(home.session(SID).transcriptPath)).filter((l) => l.length < 1024 * 1024).map((l) => JSON.parse(l));
    const edit = byLabel('edit');
    const use = entries.find((e) => e.type === 'assistant' && e.message.content[0].id === edit.opId);
    expect(use.message.content[0]).toMatchObject({ type: 'tool_use', name: 'Edit', input: { file_path: edit.path } });
    const result = entries.find((e) => e.type === 'user' && e.message.content[0].tool_use_id === edit.opId);
    expect(result.message.content[0]).toMatchObject({ type: 'tool_result', is_error: false });
    expect(patchCounts(result.toolUseResult.structuredPatch)).toEqual({ added: 1, removed: 1 });
    const rejected = entries.find((e) => e.type === 'user' && e.message.content[0].tool_use_id === byLabel('rejected-edit').opId);
    expect(rejected.message.content[0].is_error).toBe(true);
    expect(typeof rejected.toolUseResult).toBe('string');
    expect(entries.some((e) => e.type === 'user' && e.message.content[0]?.tool_use_id === byLabel('pending-write').opId)).toBe(false);
  });

  it('writes two 6 MB lines: the path within the first 64 KiB in one, after it in the other', async () => {
    const all = await lines(home.session(SID).transcriptPath);
    for (const label of ['large-write-path-first', 'large-write-path-last'] as const) {
      const op = byLabel(label);
      const line = all.find((l) => l.length > 1024 * 1024 && l.includes(`"id":"${op.opId}"`) && l.includes('"type":"tool_use"'));
      expect(line, label).toBeDefined();
      expect(Buffer.byteLength(line!)).toBeGreaterThan(6 * 1024 * 1024);
      const prefix = line!.slice(0, 64 * 1024);
      expect(prefix.includes(op.opId)).toBe(true);
      expect(prefix.includes('"name":"Write"')).toBe(true);
      expect(prefix.includes(op.path)).toBe(op.pathInPrefix);
      expect(op.large).toBe(true);
    }
  });

  it('puts the subagent Edit in <sid>/subagents/ as a sidechain', async () => {
    expect(subagentPath).toBe(join(dirname(home.session(SID).transcriptPath), SID, 'subagents', 'agent-a1fixture.jsonl'));
    const entries = (await lines(subagentPath)).map((l) => JSON.parse(l));
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.isSidechain === true && e.sessionId === SID)).toBe(true);
  });

  it('writes the files at their final content; one file through two spellings resolves to one realpath', async () => {
    expect(await readFile(byLabel('edit').path, 'utf8')).toContain('"hello"');
    const w = byLabel('alias-write');
    const e = byLabel('alias-edit');
    expect(w.path).not.toBe(e.path);
    expect(await realpath(w.path)).toBe(await realpath(e.path));
    expect(await readFile(w.path, 'utf8')).toBe('one\ntwo\n');
    const env = await stat(byLabel('protected-write').path);
    expect(env.mode & 0o777).toBe(0o600);
    expect(await readFile(byLabel('protected-write').path, 'utf8')).toContain(SECRET_MARKER);
  });

  it('refuses to write files outside the fake home (the default /tmp spellings are strings only)', async () => {
    const plain = fileOpsScenario({ sid: SID, cwd: home.session(SID).cwd, at: home.now, largeBytes: 1000 });
    expect(plain.alias).toEqual({ lexical: '/tmp/jantar-fixture', real: '/private/tmp/jantar-fixture' });
    await expect(writeFileOpsSession(home, SID, plain)).rejects.toThrow(/only inside the fake home/);
    // a path that starts inside the home and climbs out with ..
    const escaped = `${home.root}/../jantar-fixture-escaped.txt`;
    await expect(writeFileOpsSession(home, SID, { ...s, files: { [escaped]: 'x\n' } })).rejects.toThrow(/only inside the fake home/);
    expect(existsSync(escaped)).toBe(false);
  });
});

describe('ExpectedOp.at', () => {
  it("is each op's tool_result time, or its tool_use's while it waits", () => {
    const sc = fileOpsScenario({ sid: 'sid', cwd: '/w', at: '2026-01-15T10:00:00.000Z', largeBytes: 100 });
    const at = (label: string) => sc.expected.find((x) => x.label === label)?.at;
    expect(at('write-create')).toBe('2026-01-15T10:00:01.000Z'); // the result, one second after the tool_use
    for (const op of sc.expected) expect(op.at, op.label).toMatch(/^2026-01-15T10:\d\d:\d\d\.000Z$/);
    const pending = sc.main.find((e) => JSON.stringify(e).includes(sc.expected.find((x) => x.status === 'pending')!.opId));
    expect(at('pending-write')).toBe(pending?.timestamp);
    expect(new Set(sc.expected.map((x) => x.at)).size).toBe(sc.expected.length);
  });
});

describe('simplePatch', () => {
  it('makes one hunk with context and exact counts', () => {
    expect(simplePatch('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }]);
    expect(simplePatch('', 'x\ny\n')).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }]);
    expect(simplePatch('same\n', 'same\n')).toEqual([]);
    expect(patchCounts(simplePatch('1\n2\n3\n4\n5\n6\n7\n8\n', '1\n2\n3\n4\nfive\n6\n7\n8\n'))).toEqual({ added: 1, removed: 1 });
  });
});
