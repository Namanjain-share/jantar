/**
 * Transcripts with file operations, for the changed-files index (spec 8.2.5;
 * no git and no diffs, U9). Built on the transcripts.ts builders: an
 * assistant `tool_use` (Write, Edit, MultiEdit, NotebookEdit) paired with a
 * user `tool_result` that carries Claude's `toolUseResult`.
 *
 *   const s = fileOpsScenario({ sid, cwd, at: home.now });
 *   await writeFileOpsSession(home, sid, s);     // transcript, subagent file and the files on disk
 *   expect(myIndex).toMatchObject(s.expected)    // one ExpectedOp per op, in transcript order
 *
 * The shapes follow Claude Code 2.1 transcripts. One is unverified (spec 9):
 * the Write `toolUseResult` fields. A PreToolUse hook's block message was read
 * from the Claude Code 2.1.310 to 2.1.314 binaries.
 */
import { lstat, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { FileTool } from '@jantar/protocol';
import { SECRET_MARKER, type FakeHome } from './home.js';
import { FILE_MARKER } from './privacy.js';
import { assistantToolUse, timeline, toJsonl, toolResult, type Entry, type EntryContext } from './transcripts.js';

/** Claude Code's own tool_result texts (the alert scanner's DENIALS recognise the first five). */
export const DENIAL_TEXT = {
  rejected:
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
  denyRule: (tool: string, path: string) => `Permission to use ${tool} with file_path ${path} has been denied.`,
  autoMode:
    'Permission for this Edit was denied by the Claude Code auto mode classifier. Reason: Editing CI config is out of scope. If you have a reason, ask the user.',
  safety: 'Permission for this Edit was denied by a built-in Claude Code safety check for sensitive files. Writing to .git is not allowed.',
  /** A PreToolUse hook that exits 2, in Claude Code 2.1's words ("PreToolUse:<tool> hook error: [<command>]: <stderr>"); DENIALS read it as blocked. */
  hook: 'PreToolUse:Write hook error: [synthetic-tool hook claude]: Blocked by a synthetic hook: no writes under generated/',
  /** A failed edit (not a denial). */
  notFound: '<tool_use_error>String to replace not found in file.\nString: does-not-exist</tool_use_error>',
} as const;

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** ' ' context, '-' removed, '+' added, as in jsdiff's structuredPatch. */
  lines: string[];
}

const linesOf = (s: string): string[] => {
  if (s === '') return [];
  const l = s.split('\n');
  if (l.at(-1) === '') l.pop();
  return l;
};

/** A one-hunk structuredPatch for a change in one region (enough for fixtures: exact counts). */
export function simplePatch(before: string, after: string, context = 3): PatchHunk[] {
  const a = linesOf(before);
  const b = linesOf(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  if (pre === a.length && pre === b.length) return [];
  const ctxBefore = Math.min(context, pre);
  const ctxAfter = Math.min(context, suf);
  const start = pre - ctxBefore;
  const lines = [
    ...a.slice(start, pre).map((l) => ` ${l}`),
    ...a.slice(pre, a.length - suf).map((l) => `-${l}`),
    ...b.slice(pre, b.length - suf).map((l) => `+${l}`),
    ...a.slice(a.length - suf, a.length - suf + ctxAfter).map((l) => ` ${l}`),
  ];
  const oldLines = a.length - suf + ctxAfter - start;
  const newLines = b.length - suf + ctxAfter - start;
  return [{ oldStart: oldLines ? start + 1 : start, oldLines, newStart: newLines ? start + 1 : start, newLines, lines }];
}

export function patchCounts(hunks: readonly PatchHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

/** A tool_result with Claude's `toolUseResult` next to the message (a string for errors, as Claude writes it). */
export function fileToolResult(ctx: EntryContext, toolUseId: string, content: string, toolUseResult: unknown, isError = false): Entry {
  return { ...toolResult(ctx, toolUseId, content, isError), toolUseResult };
}

/** What a changed-files scanner should make of one op. */
export interface ExpectedOp {
  /** The tool_use id. */
  opId: string;
  tool: FileTool;
  /** Absolute path as written (a relative file_path joined to the entry's cwd). */
  path: string;
  status: 'ok' | 'rejected' | 'blocked' | 'error' | 'pending';
  /** Line counts the transcript states: from structuredPatch, or a Write create's content lines. Null when it states none. */
  added: number | null;
  removed: number | null;
  byAgent: boolean;
  /** The tool_use line is over 1 MiB (only a prefix is scanned). */
  large: boolean;
  /** toolUseResult.type === 'create'. */
  created: boolean;
  /** For a large line: whether the path is in its first 64 KiB. */
  pathInPrefix: boolean;
  /** The path is on the hard denylist (.env): listed with counts, opened never. */
  protectedPath: boolean;
  /** Which fixture case this is. */
  label: string;
  /** When it ended: its tool_result's timestamp (ISO), or the tool_use's for a pending op. */
  at: string;
}

export interface FileOpsScenario {
  sid: string;
  cwd: string;
  /** Main transcript entries, in order. */
  main: Entry[];
  /** A subagent transcript: <projects>/<enc cwd>/<sid>/subagents/<name>. */
  subagent: { name: string; entries: Entry[] };
  /** Every file op, main transcript first, then the subagent's. */
  expected: ExpectedOp[];
  /** Tool use ids that are not file ops (a Bash command that edits a file is not listed). */
  notListed: string[];
  /** Each path's content after the ops (absolute path -> text), for writing the files to disk. */
  files: Record<string, string>;
  /** Two spellings of one dir (/tmp vs /private/tmp): ops through both must merge by realpath. */
  alias: { lexical: string; real: string };
}

export interface FileOpsOptions {
  sid: string;
  cwd: string;
  /** Time of the first entry (ms or ISO). */
  at: string | number;
  /** Two spellings of one dir. Default /tmp/jantar-fixture and /private/tmp/jantar-fixture (strings only). */
  alias?: { lexical: string; real: string };
  /** Size of the big Write lines' content. Default 6 MB. */
  largeBytes?: number;
}

/**
 * Every case spec 8.2.5 names, minus the git-only group: a Write create, an
 * Edit with structuredPatch, a MultiEdit, a NotebookEdit, a rejected Edit, a
 * deny-rule and an auto-mode block, a hook-blocked Write, a failed Edit, a
 * Write still waiting for its result, two 6 MB Write lines (path before and
 * after the content), a relative path, the same file through /tmp and
 * /private/tmp, a Write to .env, a Bash edit (not listed) and a subagent Edit.
 */
export function fileOpsScenario(opts: FileOpsOptions): FileOpsScenario {
  const { sid, cwd } = opts;
  const alias = opts.alias ?? { lexical: '/tmp/jantar-fixture', real: '/private/tmp/jantar-fixture' };
  const largeBytes = opts.largeBytes ?? 6 * 1024 * 1024;
  const tl = timeline(opts.at, sid, cwd);
  const main: Entry[] = [];
  const expected: ExpectedOp[] = [];
  const notListed: string[] = [];
  const files: Record<string, string> = {};
  let n = 0;
  const nextId = () => `toolu_fixture_${String(++n).padStart(4, '0')}`;
  const abs = (p: string) => (isAbsolute(p) ? p : join(cwd, p));
  // `at` is filled in from the entries at the end
  const exp = (e: Partial<ExpectedOp> & Pick<ExpectedOp, 'opId' | 'tool' | 'path' | 'status' | 'label'>): ExpectedOp => ({
    at: '',
    added: null,
    removed: null,
    byAgent: false,
    large: false,
    created: false,
    pathInPrefix: true,
    protectedPath: false,
    ...e,
  });

  // A Write that creates a file (its content carries FILE_MARKER: it must never reach an event).
  const created = `// ${FILE_MARKER}\nexport function hello() {\n  return "hi";\n}\n`;
  {
    const id = nextId();
    const path = join(cwd, 'src', 'hello.ts');
    main.push(assistantToolUse(tl.next(), 'Write', { file_path: path, content: created }, id));
    main.push(fileToolResult(tl.next(), id, `File created successfully at: ${path}`, { type: 'create', filePath: path, content: created, structuredPatch: [], originalFile: null }));
    files[path] = created;
    expected.push(exp({ opId: id, tool: 'Write', path, status: 'ok', added: 4, removed: 0, created: true, label: 'write-create' }));
  }

  // An Edit with structuredPatch.
  {
    const id = nextId();
    const path = join(cwd, 'src', 'hello.ts');
    const updated = created.replace('"hi"', '"hello"');
    const patch = simplePatch(created, updated);
    main.push(assistantToolUse(tl.next(), 'Edit', { file_path: path, old_string: '"hi"', new_string: '"hello"' }, id));
    main.push(
      fileToolResult(tl.next(), id, `The file ${path} has been updated.`, {
        filePath: path,
        oldString: '"hi"',
        newString: '"hello"',
        originalFile: created,
        structuredPatch: patch,
        userModified: false,
        replaceAll: false,
      }),
    );
    files[path] = updated;
    expected.push(exp({ opId: id, tool: 'Edit', path, status: 'ok', ...patchCounts(patch), label: 'edit' }));
  }

  // A MultiEdit.
  {
    const id = nextId();
    const path = join(cwd, 'src', 'config.ts');
    const before = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';
    const after = 'export const a = 10;\nexport const b = 20;\nexport const c = 3;\n';
    const edits = [
      { old_string: 'a = 1', new_string: 'a = 10' },
      { old_string: 'b = 2', new_string: 'b = 20' },
    ];
    const patch = simplePatch(before, after);
    main.push(assistantToolUse(tl.next(), 'MultiEdit', { file_path: path, edits }, id));
    main.push(
      fileToolResult(tl.next(), id, `Applied 2 edits to ${path}`, {
        filePath: path,
        edits: edits.map((e) => ({ ...e, replace_all: false })),
        originalFileContents: before,
        structuredPatch: patch,
        userModified: false,
      }),
    );
    files[path] = after;
    expected.push(exp({ opId: id, tool: 'MultiEdit', path, status: 'ok', ...patchCounts(patch), label: 'multi-edit' }));
  }

  // A NotebookEdit (no structuredPatch: approximate counts are the scanner's).
  {
    const id = nextId();
    const path = join(cwd, 'analysis.ipynb');
    const nb = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', id: 'c1', metadata: {}, source: ['print(2)\n'], outputs: [], execution_count: null }] });
    main.push(assistantToolUse(tl.next(), 'NotebookEdit', { notebook_path: path, cell_id: 'c1', new_source: 'print(2)\n', edit_mode: 'replace' }, id));
    main.push(
      fileToolResult(tl.next(), id, 'Updated cell c1 with print(2)', {
        new_source: 'print(2)\n',
        cell_id: 'c1',
        cell_type: 'code',
        language: 'python',
        edit_mode: 'replace',
        error: '',
        notebook_path: path,
      }),
    );
    files[path] = `${nb}\n`;
    expected.push(exp({ opId: id, tool: 'NotebookEdit', path, status: 'ok', label: 'notebook-edit' }));
  }

  // Refusals: the user said no; a deny rule and auto mode blocked; a hook blocked; a failed edit.
  const refused: Array<[FileTool, string, string, ExpectedOp['status'], string]> = [
    ['Edit', join(cwd, 'src', 'hello.ts'), DENIAL_TEXT.rejected, 'rejected', 'rejected-edit'],
    ['Write', join(cwd, 'src', 'blocked.ts'), DENIAL_TEXT.denyRule('Write', join(cwd, 'src', 'blocked.ts')), 'blocked', 'deny-rule-write'],
    ['Edit', join(cwd, '.github', 'ci.yml'), DENIAL_TEXT.autoMode, 'blocked', 'auto-mode-edit'],
    ['Write', join(cwd, 'generated', 'out.ts'), DENIAL_TEXT.hook, 'blocked', 'hook-blocked-write'],
    ['Edit', join(cwd, 'src', 'config.ts'), DENIAL_TEXT.notFound, 'error', 'failed-edit'],
  ];
  for (const [tool, path, text, status, label] of refused) {
    const id = nextId();
    const input = tool === 'Write' ? { file_path: path, content: 'never written\n' } : { file_path: path, old_string: 'does-not-exist', new_string: 'x' };
    main.push(assistantToolUse(tl.next(), tool, input, id));
    main.push(fileToolResult(tl.next(), id, text, `Error: ${text}`, true));
    expected.push(exp({ opId: id, tool, path, status, label }));
  }

  // Two 6 MB Writes: the path before the content, then after it (a prefix scan sees only the first).
  for (const [label, first] of [
    ['large-write-path-first', true],
    ['large-write-path-last', false],
  ] as const) {
    const id = nextId();
    const path = join(cwd, 'data', `${label}.json`);
    const content = `${'x'.repeat(largeBytes - 1)}\n`;
    const input = first ? { file_path: path, content } : { content, file_path: path };
    main.push(assistantToolUse(tl.next(), 'Write', input, id));
    main.push(fileToolResult(tl.next(), id, `File created successfully at: ${path}`, { type: 'create', filePath: path, content, structuredPatch: [], originalFile: null }));
    files[path] = content;
    expected.push(exp({ opId: id, tool: 'Write', path, status: 'ok', large: true, created: true, pathInPrefix: first, label }));
  }

  // A relative file_path: joined to the entry's cwd.
  {
    const id = nextId();
    const rel = 'src/rel.ts';
    const text = 'export const rel = true;\n';
    main.push(assistantToolUse(tl.next(), 'Write', { file_path: rel, content: text }, id));
    main.push(fileToolResult(tl.next(), id, `File created successfully at: ${rel}`, { type: 'create', filePath: rel, content: text, structuredPatch: [], originalFile: null }));
    files[abs(rel)] = text;
    expected.push(exp({ opId: id, tool: 'Write', path: abs(rel), status: 'ok', added: 1, removed: 0, created: true, label: 'relative-path' }));
  }

  // One file through two spellings of its dir: one change after realpath.
  {
    const before = 'one\n';
    const after = 'one\ntwo\n';
    const w = nextId();
    const lexical = join(alias.lexical, 'x');
    const real = join(alias.real, 'x');
    main.push(assistantToolUse(tl.next(), 'Write', { file_path: lexical, content: before }, w));
    main.push(fileToolResult(tl.next(), w, `File created successfully at: ${lexical}`, { type: 'create', filePath: lexical, content: before, structuredPatch: [], originalFile: null }));
    expected.push(exp({ opId: w, tool: 'Write', path: lexical, status: 'ok', added: 1, removed: 0, created: true, label: 'alias-write' }));
    const e = nextId();
    const patch = simplePatch(before, after);
    main.push(assistantToolUse(tl.next(), 'Edit', { file_path: real, old_string: 'one\n', new_string: 'one\ntwo\n' }, e));
    main.push(
      fileToolResult(tl.next(), e, `The file ${real} has been updated.`, {
        filePath: real,
        oldString: 'one\n',
        newString: 'one\ntwo\n',
        originalFile: before,
        structuredPatch: patch,
        userModified: false,
        replaceAll: false,
      }),
    );
    files[real] = after;
    expected.push(exp({ opId: e, tool: 'Edit', path: real, status: 'ok', ...patchCounts(patch), label: 'alias-edit' }));
  }

  // A Write to .env: listed with name, tool, time and counts; never opened.
  {
    const id = nextId();
    const path = join(cwd, '.env');
    const text = `API_TOKEN=${SECRET_MARKER}\n`;
    main.push(assistantToolUse(tl.next(), 'Write', { file_path: path, content: text }, id));
    main.push(fileToolResult(tl.next(), id, `File created successfully at: ${path}`, { type: 'create', filePath: path, content: text, structuredPatch: [], originalFile: null }));
    files[path] = text;
    expected.push(exp({ opId: id, tool: 'Write', path, status: 'ok', added: 1, removed: 0, created: true, protectedPath: true, label: 'protected-write' }));
  }

  // A Bash command that edits a file: not a file op, never listed (no git, U9).
  {
    const id = nextId();
    main.push(assistantToolUse(tl.next(), 'Bash', { command: "sed -i '' s/hello/hey/ src/hello.ts", description: 'Rename the greeting' }, id));
    main.push(toolResult(tl.next(), id, ''));
    notListed.push(id);
  }

  // A Write whose result has not come back yet.
  {
    const id = nextId();
    const path = join(cwd, 'src', 'pending.ts');
    main.push(assistantToolUse(tl.next(), 'Write', { file_path: path, content: 'export {};\n' }, id));
    expected.push(exp({ opId: id, tool: 'Write', path, status: 'pending', label: 'pending-write' }));
  }

  // A subagent's Edit, in its own transcript.
  const subagent: Entry[] = [];
  {
    const id = nextId();
    const path = join(cwd, 'src', 'sub.ts');
    const before = 'export const sub = 1;\n';
    const after = 'export const sub = 2;\n';
    const patch = simplePatch(before, after);
    const side = (ctx: EntryContext): EntryContext => ({ ...ctx, isSidechain: true });
    subagent.push({ ...assistantToolUse(side(tl.next()), 'Edit', { file_path: path, old_string: '1', new_string: '2' }, id), agentId: 'a1fixture' });
    subagent.push({
      ...fileToolResult(side(tl.next()), id, `The file ${path} has been updated.`, {
        filePath: path,
        oldString: '1',
        newString: '2',
        originalFile: before,
        structuredPatch: patch,
        userModified: false,
        replaceAll: false,
      }),
      agentId: 'a1fixture',
    });
    files[path] = after;
    expected.push(exp({ opId: id, tool: 'Edit', path, status: 'ok', ...patchCounts(patch), byAgent: true, label: 'subagent-edit' }));
  }

  // each op's time: its tool_result's, or its tool_use's while it waits
  const times = new Map<string, string>();
  for (const e of [...main, ...subagent]) {
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<Record<string, unknown>>) {
      const id = b.type === 'tool_result' ? b.tool_use_id : b.type === 'tool_use' ? b.id : undefined;
      if (typeof id === 'string' && (b.type === 'tool_result' || !times.has(id))) times.set(id, e.timestamp as string);
    }
  }
  for (const op of expected) op.at = times.get(op.opId) ?? '';

  return { sid, cwd, main, subagent: { name: 'agent-a1fixture.jsonl', entries: subagent }, expected, notListed, files, alias };
}

/**
 * Two spellings of one existing dir inside `dir`'s temp tree: on macOS the
 * temp dir itself (/var/folders/... and /private/var/folders/..., like /tmp
 * and /private/tmp), elsewhere a symlink next to it.
 */
export async function aliasPair(dir: string): Promise<{ lexical: string; real: string }> {
  await mkdir(dir, { recursive: true });
  const real = await realpath(dir);
  if (real.startsWith('/private/')) {
    const lexical = real.slice('/private'.length);
    try {
      if ((await realpath(lexical)) === real) return { lexical, real };
    } catch {
      // no such alias here
    }
  }
  const lexical = `${real}-alias`;
  try {
    await lstat(lexical);
  } catch {
    await symlink(real, lexical);
  }
  return { lexical, real };
}

/**
 * Put a scenario into a fake home session: append the main entries to its
 * transcript, write the subagent transcript, and write each file's final
 * content to disk (so a viewer opens current content). Every file must lie
 * inside the fake home: build the scenario with the session's cwd and
 * `alias: await aliasPair(join(home.root, 'tmp'))`, not the default /tmp
 * strings. Returns the subagent transcript's path.
 */
export async function writeFileOpsSession(home: FakeHome, sid: string, scenario: FileOpsScenario): Promise<{ subagentPath: string }> {
  const s = home.session(sid);
  const outside = Object.keys(scenario.files).filter((p) => !resolve(p).startsWith(`${home.root}/`));
  if (outside.length) throw new Error(`writeFileOpsSession writes only inside the fake home, not ${outside.join(', ')}`);
  await home.appendTranscript(sid, scenario.main);
  const subagentPath = join(dirname(s.transcriptPath), sid, 'subagents', scenario.subagent.name);
  await mkdir(dirname(subagentPath), { recursive: true });
  await writeFile(subagentPath, toJsonl(scenario.subagent.entries));
  for (const [path, text] of Object.entries(scenario.files)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { mode: path.endsWith('/.env') ? 0o600 : 0o644 });
  }
  return { subagentPath };
}
