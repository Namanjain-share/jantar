/**
 * Which files a session created or changed, from its transcript (v0.3 spec
 * 4.4.8; decision U9: no git, no diffs).
 *
 * The scanner is pure and built like AlertScanner: an assistant entry's
 * Write, Edit, MultiEdit and NotebookEdit tool_use blocks are kept as
 * pending, and the user entry's tool_result for each one makes it an op:
 *
 * - status: `ok`, or for an `is_error` result `denialKind(text) ?? 'error'`
 *   (blocked, rejected, error), with the same denial texts as the alerts;
 * - counts: from `toolUseResult.structuredPatch`, the line count of a
 *   created file, else estimated from the tool input (`approx`);
 * - `pendingOps()`: calls with no result yet (a Write waiting for approval)
 *   until a new prompt or an interrupt starts the next turn; such a call is
 *   still paired if its result comes after all (the newest STALE_MAX);
 * - lines over 1 MiB give name, id and path only (`large`). The reader skips
 *   a line longer than its `maxBytes` whole, so `scanRead` reads the first
 *   and last 64 KiB of such a line itself and finds them there.
 *
 * The transcript watcher feeds every new entry to one scanner per transcript
 * and publishes `files.changed` (`publishFileOps`); the changes index
 * (files/changes.ts) runs its own scanners over the same transcripts. No op
 * carries file content: paths, ids, times, counts and statuses only.
 */
import { posix } from 'node:path';
import { EVENT, localSession, type FileOp, type FileTool } from '@jantar/protocol';
import type { DaemonContext, TranscriptEntry } from '../../contracts.js';
import { sha256Hex } from '../../core/hash.js';
import { fsx, readRange } from '../lib/fsx.js';
import { isObj, str, toEpochMs, type Obj } from '../lib/values.js';
import { denialKind, toolResultText } from './alerts.js';

/** A transcript line longer than this is only prefix-scanned, and its op is `large`. */
export const LARGE_LINE_BYTES = 1024 * 1024;
/** How much of each end of a large line is read. */
export const PREFIX_SCAN_BYTES = 64 * 1024;
/** files.changed events one read of one transcript publishes at most (the newest; the index reads the transcript itself). */
export const FILE_EVENTS_PER_READ = 32;

const FILE_TOOLS: ReadonlySet<string> = new Set<FileTool>(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const TOOL_ID_RE = /^[\w.-]{1,128}$/;
const PATH_MAX = 4096;
const PENDING_MAX = 400;
/** Calls a new turn left without a result, kept in case the result comes late. */
const STALE_MAX = 50;

/** One file op found in a transcript (never any file content). */
export interface ScannedOp {
  /** The tool_use id. */
  opId: string;
  tool: FileTool;
  /** Absolute, normalised path the op names (a relative one is joined to the entry's cwd). */
  path: string;
  /** Epoch ms of the tool_result (the tool_use's when the result has none). */
  at: number;
  /** `pending` only from pendingOps(): the call has no result yet. */
  status: FileOp['status'];
  added: number | null;
  removed: number | null;
  approx: boolean;
  byAgent: boolean;
  large: boolean;
  /** `toolUseResult.type`: create -> true, update -> false, absent -> null. */
  created: boolean | null;
  /** Byte offset of the tool_result line (of the tool_use line while pending). */
  offset: number;
}

interface Pending {
  tool: FileTool;
  path: string;
  at: number;
  added: number | null;
  removed: number | null;
  byAgent: boolean;
  large: boolean;
  offset: number;
  /** A new turn began after the call: no longer pending, but a late result still pairs. */
  stale: boolean;
}

/** A change's id: stable per session and path, so an event and the index name the same row. */
export function changeIdFor(sid: string, path: string): string {
  return `c_${sha256Hex(`${sid}\n${path}`).slice(0, 24)}`;
}

/**
 * Tracks pending file tool calls across reads of one transcript. One scanner
 * per transcript file; `byAgent` for a subagent's own transcript.
 */
export class FileChangeScanner {
  private readonly pending = new Map<string, Pending>();
  readonly byAgent: boolean;

  constructor(opts: { byAgent?: boolean } = {}) {
    this.byAgent = opts.byAgent ?? false;
  }

  /**
   * Ops completed by the entries of one `readFrom` (`from` -> `next`). A read
   * that returned no entry but moved past more than LARGE_LINE_BYTES skipped
   * one long line: its two ends are read here and prefix-scanned.
   */
  async scanRead(path: string, from: number, entries: readonly TranscriptEntry[], next: number, fallbackMs: number): Promise<ScannedOp[]> {
    if (entries.length) return entries.flatMap((e) => this.scan(e.raw, e.offset, e.length, fallbackMs));
    const length = next - from - 1; // next - 1 is that line's newline
    if (length < LARGE_LINE_BYTES) return [];
    const ends = await readLineEnds(path, from, from + length);
    return ends ? this.scanLarge(ends.head, ends.tail, from, fallbackMs) : [];
  }

  /** Ops completed by one parsed entry. `length` is the line's byte length. */
  scan(e: Obj, offset: number, length: number, fallbackMs: number): ScannedOp[] {
    const content = isObj(e.message) ? e.message.content : undefined;
    if (e.type === 'user' && e.isMeta !== true && e.isSidechain !== true && !hasToolResult(content)) {
      this.newTurn();
      return [];
    }
    if (!Array.isArray(content)) return [];
    const ts = toEpochMs(e.timestamp);
    const large = length > LARGE_LINE_BYTES;

    if (e.type === 'assistant') {
      const byAgent = this.byAgent || e.isSidechain === true;
      for (const b of content) {
        if (!isObj(b) || b.type !== 'tool_use' || typeof b.id !== 'string' || !TOOL_ID_RE.test(b.id)) continue;
        const name = str(b.name);
        if (!name || !FILE_TOOLS.has(name)) continue;
        const tool = name as FileTool;
        const input = isObj(b.input) ? b.input : {};
        const path = opPath(input.file_path ?? input.notebook_path, e.cwd);
        if (!path) continue;
        const counts = large ? { added: null, removed: null } : inputCounts(tool, input);
        this.remember(b.id, { tool, path, at: ts ?? fallbackMs, ...counts, byAgent, large, offset, stale: false });
      }
      return [];
    }

    if (e.type !== 'user') return [];
    const results = content.filter((b): b is Obj => isObj(b) && b.type === 'tool_result');
    // toolUseResult belongs to the entry; with several results it can't be told apart
    const tur = results.length === 1 && isObj(e.toolUseResult) ? e.toolUseResult : null;
    const out: ScannedOp[] = [];
    for (const b of results) {
      const id = str(b.tool_use_id);
      const p = id === undefined ? undefined : this.pending.get(id);
      if (!id || !p) continue;
      this.pending.delete(id);
      const status = b.is_error === true ? (denialKind(toolResultText(b)) ?? 'error') : 'ok';
      const created = tur?.type === 'create' ? true : tur?.type === 'update' ? false : null;
      const op: ScannedOp = {
        opId: id,
        tool: p.tool,
        path: p.path,
        at: ts ?? p.at,
        status,
        added: p.added,
        removed: p.removed,
        approx: true,
        byAgent: p.byAgent,
        large: p.large || large,
        created,
        offset,
      };
      // a line over LARGE_LINE_BYTES is treated as only partly read: no exact counts from it
      if (status === 'ok' && tur && !op.large) {
        const exact = resultCounts(p.tool, tur, created);
        if (exact) Object.assign(op, exact, { approx: false });
      }
      out.push(op);
    }
    return out;
  }

  /** Name, id and path of the calls in a line too long to parse, from its first and last bytes. */
  scanLarge(head: string, tail: string, offset: number, fallbackMs: number): ScannedOp[] {
    const ts = toEpochMs(jsonString(stringValue(tail, 'timestamp', { last: true }) ?? stringValue(head, 'timestamp')));
    if (head.includes('"type":"tool_result"')) return this.largeResults(head, tail, offset, ts);
    const uses = [...head.matchAll(/"type":"tool_use"/g)].map((m) => m.index ?? 0);
    if (!uses.length) {
      // a prompt with a pasted image, say: a new turn, as in scan()
      if (largePrompt(head, tail)) this.newTurn();
      return [];
    }
    const byAgent = this.byAgent || head.includes('"isSidechain":true') || tail.includes('"isSidechain":true');
    const cwd = jsonString(stringValue(tail, 'cwd', { last: true }) ?? stringValue(head, 'cwd'));
    uses.forEach((start, i) => {
      const block = head.slice(start, uses[i + 1] ?? head.length);
      const inputAt = block.indexOf('"input":');
      const keys = block.slice(0, inputAt >= 0 ? inputAt : 1024);
      const id = /"id":"([^"\\]{1,128})"/.exec(keys)?.[1];
      const name = /"name":"([^"\\]{1,64})"/.exec(keys)?.[1];
      if (!id || !TOOL_ID_RE.test(id) || !name || !FILE_TOOLS.has(name)) return;
      // the path is in this block's input in the head, or (written after a long
      // content) near the end of the line
      let raw = inputAt >= 0 ? pathValue(block, { from: inputAt }) : undefined;
      if (raw === undefined && i === uses.length - 1) raw = pathValue(tail, { last: true });
      const path = opPath(jsonString(raw), cwd);
      if (!path) return;
      this.remember(id, { tool: name as FileTool, path, at: ts ?? fallbackMs, added: null, removed: null, byAgent, large: true, offset, stale: false });
    });
    return [];
  }

  private largeResults(head: string, tail: string, offset: number, ts: number | undefined): ScannedOp[] {
    const ids = [...head.matchAll(/"tool_use_id":"([^"\\]{1,128})"/g)].map((m) => m[1] ?? '');
    let status: ScannedOp['status'] = 'ok';
    if (head.includes('"is_error":true')) {
      const from = head.indexOf('"type":"tool_result"');
      const raw = stringValue(head, 'content', { from, cut: true }) ?? stringValue(head, 'text', { from, cut: true }) ?? '';
      status = denialKind(jsonStringPrefix(raw)) ?? 'error';
    }
    const kind = CREATED_RE.exec(head)?.[1] ?? CREATED_RE.exec(tail)?.[1];
    const created = ids.length === 1 && kind ? kind === 'create' : null;
    const out: ScannedOp[] = [];
    for (const id of ids) {
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      // a small tool_use keeps its estimate; the result's own counts were not read
      out.push({ opId: id, tool: p.tool, path: p.path, at: ts ?? p.at, status, added: p.added, removed: p.removed, approx: true, byAgent: p.byAgent, large: true, created, offset });
    }
    return out;
  }

  /** Calls seen without a result yet (since the last prompt), as `pending` ops. */
  pendingOps(): ScannedOp[] {
    return [...this.pending].filter(([, p]) => !p.stale).map(([opId, p]) => ({
      opId,
      tool: p.tool,
      path: p.path,
      at: p.at,
      status: 'pending',
      added: p.added,
      removed: p.removed,
      approx: true,
      byAgent: p.byAgent,
      large: p.large,
      created: null,
      offset: p.offset,
    }));
  }

  /**
   * A prompt or an interrupt starts a new turn: calls still without a result
   * are not pending any more. The newest STALE_MAX of them are kept, so a
   * result that lands after all (a queued prompt, say) still makes an op.
   */
  private newTurn(): void {
    let stale = 0;
    for (const p of this.pending.values()) {
      p.stale = true;
      stale++;
    }
    for (const id of this.pending.keys()) {
      if (stale-- <= STALE_MAX) break;
      this.pending.delete(id);
    }
  }

  private remember(id: string, p: Pending): void {
    this.pending.delete(id);
    this.pending.set(id, p);
    if (this.pending.size <= PENDING_MAX) return;
    const keep = [...this.pending].slice(-PENDING_MAX / 2);
    this.pending.clear();
    for (const [k, v] of keep) this.pending.set(k, v);
  }
}

/**
 * Publish ops as `files.changed` (compact: no content, no counts), only while
 * Files is on. Ops older than `quietBefore` are history the changes index
 * backfills itself (a transcript's first read after a daemon start).
 */
export function publishFileOps(ctx: DaemonContext, sid: string, ops: readonly ScannedOp[], quietBefore: number): void {
  if (!ops.length || !ctx.settings.get().files.enabled) return;
  const fresh = ops.filter((op) => op.at >= quietBefore).slice(-FILE_EVENTS_PER_READ);
  const account = localSession(ctx.store.getState(), sid)?.account ?? null;
  for (const op of fresh) {
    try {
      ctx.store.emit({
        type: EVENT.FILES_CHANGED,
        sid,
        ...(account !== null ? { account } : {}),
        data: {
          changeId: changeIdFor(sid, op.path),
          path: op.path,
          tool: op.tool,
          at: new Date(op.at).toISOString(),
          status: op.status,
          opId: op.opId,
          transcriptOffset: op.offset,
          byAgent: op.byAgent,
        },
      });
    } catch (e) {
      ctx.log.error('could not publish files.changed', { sid, error: String(e) });
    }
  }
}

/** The first line start at or after `pos` (just past a newline), or `size` if none. */
export async function lineStartAtOrAfter(path: string, pos: number, size: number): Promise<number> {
  if (pos <= 0) return 0;
  const fh = await fsx.open(path).catch(() => null);
  if (!fh) return size;
  try {
    const chunk = 64 * 1024;
    for (let p = pos - 1; p < size; p += chunk) {
      const buf = await readRange(fh, p, Math.min(chunk, size - p));
      const i = buf.indexOf(0x0a);
      if (i >= 0) return p + i + 1;
    }
    return size;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------

const CREATED_RE = /"toolUseResult":\{"type":"(create|update)"/;

/**
 * The raw body of the JSON string after `"key":"` in a piece of a line, read
 * up to its closing quote (undefined when it is not closed within `max`
 * chars, unless `cut`). Only structural keys match: inside a JSON string
 * every quote is escaped, so `"key":"` can't come from content.
 */
function stringValue(s: string, key: string, opts: { from?: number; last?: boolean; cut?: boolean; max?: number } = {}): string | undefined {
  const needle = `"${key}":"`;
  const at = opts.last ? s.lastIndexOf(needle) : s.indexOf(needle, Math.max(0, opts.from ?? 0));
  if (at < 0) return undefined;
  const start = at + needle.length;
  const max = opts.max ?? PATH_MAX * 2;
  let i = start;
  while (i < s.length && i - start <= max) {
    const c = s.charCodeAt(i);
    if (c === 0x22) return s.slice(start, i);
    i += c === 0x5c ? 2 : 1; // a backslash escapes the next char
  }
  return opts.cut ? s.slice(start, Math.min(i, s.length)) : undefined;
}

/** The raw `file_path` value, else the `notebook_path` one. */
function pathValue(s: string, opts: { from?: number; last?: boolean }): string | undefined {
  const a = stringValue(s, 'file_path', opts);
  return a !== undefined ? a : stringValue(s, 'notebook_path', opts);
}

/**
 * Whether a line too long to parse is a prompt (by its two ends): a user
 * entry with no tool_result, neither meta nor a subagent's. Inside a JSON
 * string every quote is escaped, so `"type":"user"` is the entry's own type.
 */
function largePrompt(head: string, tail: string): boolean {
  const has = (s: string) => head.includes(s) || tail.includes(s);
  return has('"type":"user"') && !has('"isMeta":true') && !has('"isSidechain":true');
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'tool_result');
}

/** A JSON string body (between the quotes) decoded, or undefined. */
function jsonString(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(`"${raw}"`);
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The start of a JSON string body that may be cut anywhere, decoded as far as it goes. */
function jsonStringPrefix(raw: string): string {
  for (let cut = raw.length; cut >= Math.max(0, raw.length - 6); cut--) {
    const v = jsonString(raw.slice(0, cut));
    if (v !== undefined) return v;
  }
  return '';
}

/** An op's path: absolute and normalised; a relative one joined to the entry's (absolute) cwd. */
function opPath(raw: unknown, cwd: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > PATH_MAX || raw.includes('\0')) return null;
  let p: string;
  if (posix.isAbsolute(raw)) p = posix.normalize(raw);
  else if (typeof cwd === 'string' && posix.isAbsolute(cwd)) p = posix.resolve(cwd, raw);
  else return null;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p === '/' ? null : p;
}

/** Lines in a text, as a diff counts them (a trailing newline ends the last line). */
function lineCount(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  if (s === '') return 0;
  let n = 1;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return s.endsWith('\n') ? n - 1 : n;
}

function add(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

/** Counts estimated from the tool input (what the call asked for). */
function inputCounts(tool: FileTool, input: Obj): { added: number | null; removed: number | null } {
  switch (tool) {
    case 'Write':
      return { added: lineCount(input.content), removed: null };
    case 'Edit':
      return { added: lineCount(input.new_string), removed: lineCount(input.old_string) };
    case 'MultiEdit': {
      if (!Array.isArray(input.edits)) return { added: null, removed: null };
      let added: number | null = 0;
      let removed: number | null = 0;
      for (const ed of input.edits) {
        const o = isObj(ed) ? ed : {};
        added = add(added, lineCount(o.new_string));
        removed = add(removed, lineCount(o.old_string));
      }
      return { added, removed };
    }
    case 'NotebookEdit':
      return { added: input.edit_mode === 'delete' ? 0 : lineCount(input.new_source), removed: null };
  }
}

/** Exact counts from a successful result: its structuredPatch, or a created file's line count. */
function resultCounts(tool: FileTool, tur: Obj, created: boolean | null): { added: number; removed: number } | null {
  const patch = tur.structuredPatch;
  if (tool === 'Write' && created === true) {
    const n = lineCount(tur.content);
    return n === null ? null : { added: n, removed: 0 };
  }
  if (!Array.isArray(patch)) return null;
  // a Write that rewrote the same content: an update with an empty patch changed nothing
  if (!patch.length) return created === false ? { added: 0, removed: 0 } : null;
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    const lines = isObj(hunk) ? hunk.lines : undefined;
    if (!Array.isArray(lines)) return null;
    for (const l of lines) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

/** The first and last PREFIX_SCAN_BYTES of the line [start, end) (end is its newline). */
async function readLineEnds(path: string, start: number, end: number): Promise<{ head: string; tail: string } | null> {
  const fh = await fsx.open(path).catch(() => null);
  if (!fh) return null;
  try {
    const headLen = Math.min(PREFIX_SCAN_BYTES, end - start);
    const head = await readRange(fh, start, headLen);
    const tailStart = Math.max(start + headLen, end - PREFIX_SCAN_BYTES);
    const tail = tailStart < end ? await readRange(fh, tailStart, end - tailStart) : Buffer.alloc(0);
    return { head: head.toString('utf8'), tail: tail.toString('utf8') };
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => undefined);
  }
}
