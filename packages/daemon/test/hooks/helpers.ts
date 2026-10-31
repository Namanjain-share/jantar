/**
 * Test helpers for the hooks bridge: a synthetic state dir, fake session
 * source and transcript reader, and a tiny hook client that speaks the
 * socket protocol directly. Everything lives in a fresh temp dir.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountId, DaemonEvent, HookPayload } from '@jantar/protocol';
import { makeSession } from '@jantar/fixtures';
import type {
  SessionRecord,
  SessionSource,
  TranscriptEntry,
  TranscriptReader,
  TranscriptTail,
} from '../../src/contracts.js';
import { createFakeExec, createTestContext, onCommand, type TestContext } from '../../src/core/testing.js';
import { createHooksBridge, type HooksBridgeOptions } from '../../src/hooks/index.js';
import type { HooksBridgeImpl } from '../../src/hooks/bridge.js';

export const SID = '11111111-1111-4111-8111-111111111111';
export const SID2 = '22222222-2222-4222-8222-222222222222';
export const T0 = Date.parse('2026-01-15T10:00:00.000Z');

export async function tempDir(prefix = 'jantar-hb-'): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function fakeSessions(accounts: Record<string, AccountId> = {}): SessionSource & { scans: number } {
  const src = {
    scans: 0,
    async start() {},
    async stop() {},
    async scan(): Promise<SessionRecord[]> {
      src.scans += 1;
      return [];
    },
    current: () => [],
    accountForConfigDir: (dir: string) => accounts[dir] ?? null,
  };
  return src;
}

/** An in-memory transcript store with byte offsets like a real JSONL file. */
export class FakeTranscripts implements TranscriptReader {
  private readonly files = new Map<string, { entries: TranscriptEntry[]; size: number }>();
  reads = 0;

  append(path: string, raw: Record<string, unknown>): TranscriptEntry {
    const f = this.files.get(path) ?? { entries: [], size: 0 };
    this.files.set(path, f);
    const line = JSON.stringify(raw);
    const e: TranscriptEntry = {
      offset: f.size,
      length: Buffer.byteLength(line),
      type: String(raw.type),
      raw,
      ...(typeof raw.uuid === 'string' ? { uuid: raw.uuid } : {}),
      ...(raw.isSidechain === true ? { isSidechain: true } : {}),
    };
    f.entries.push(e);
    f.size += e.length + 1;
    return e;
  }

  toolUse(path: string, id: string, name: string, input: unknown): TranscriptEntry {
    return this.append(path, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  }

  toolResult(path: string, toolUseId: string, isError = false): TranscriptEntry {
    return this.append(path, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: isError ? 'rejected' : 'ok', is_error: isError }] },
    });
  }

  async pathFor(): Promise<string | null> {
    return null;
  }

  async size(path: string): Promise<number> {
    return this.files.get(path)?.size ?? 0;
  }

  async readFrom(path: string, offset: number): Promise<{ entries: TranscriptEntry[]; next: number }> {
    this.reads += 1;
    const f = this.files.get(path);
    if (!f) return { entries: [], next: offset };
    return { entries: f.entries.filter((e) => e.offset >= offset), next: f.size };
  }

  async tail(): Promise<TranscriptTail> {
    return {};
  }

  async page() {
    return { items: [], nextBefore: null };
  }
}

let monoBase = 1_000_000_000n;

export interface TagOptions {
  /** Wall clock ms (default: the test clock's start). */
  ts?: number;
  wait?: boolean;
  /** Monotonic stamp; default: increasing per call. */
  mono?: bigint | null;
  ppid?: number;
  claudeConfigDir?: string;
}

/** A hook payload as jantar-hook would forward it. */
export function hookEvent(event: string, fields: Record<string, unknown> = {}, tag: TagOptions = {}): HookPayload {
  monoBase += 1000n;
  const t: Record<string, unknown> = { v: 1, ts: tag.ts ?? T0, ppid: tag.ppid ?? 4242, wait: tag.wait ?? false, hookVersion: '0.1.0' };
  if (tag.mono !== null) t.mono = String(tag.mono ?? monoBase);
  if (tag.claudeConfigDir) t.claudeConfigDir = tag.claudeConfigDir;
  return {
    hook_event_name: event,
    session_id: SID,
    transcript_path: '/synthetic/home/.claude/projects/-synthetic-alpha/11111111.jsonl',
    cwd: '/synthetic/home/work/alpha-app',
    permission_mode: 'default',
    ...fields,
    _jantar: t,
  } as HookPayload;
}

export interface Sent {
  socket: Socket;
  /** Everything the daemon wrote before closing. */
  reply: Promise<string>;
  /** Resolves when the daemon side closed the connection. */
  closed: Promise<void>;
  /** Simulate the hook process going away (end-of-file). */
  hangUp(): void;
}

/**
 * Send one event the way the real client does: async events half-close
 * after writing, blocking ones keep their side open.
 */
export function send(path: string, payload: unknown, opts: { keepOpen?: boolean; raw?: string } = {}): Sent {
  const socket = connect({ path });
  let data = '';
  let resolveReply!: (s: string) => void;
  const reply = new Promise<string>((r) => (resolveReply = r));
  const closed = new Promise<void>((r) => socket.on('close', () => r()));
  socket.on('data', (c) => (data += c.toString('utf8')));
  socket.on('end', () => resolveReply(data));
  socket.on('close', () => resolveReply(data));
  socket.on('error', () => resolveReply(data));
  socket.on('connect', () => {
    socket.write(opts.raw ?? `${JSON.stringify(payload)}\n`);
    if (!opts.keepOpen) socket.end();
  });
  return { socket, reply, closed, hangUp: () => socket.destroy() };
}

export async function waitFor(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

export interface Harness {
  ctx: TestContext;
  bridge: HooksBridgeImpl;
  sessions: ReturnType<typeof fakeSessions>;
  transcripts: FakeTranscripts;
  events: DaemonEvent[];
  sock: string;
  dir: string;
  of<T extends DaemonEvent['type']>(type: T): Extract<DaemonEvent, { type: T }>[];
  /** Send and wait until the bridge has processed it (events count grows or `until` holds). */
  push(payload: unknown, opts?: { keepOpen?: boolean; until?: () => boolean }): Promise<Sent>;
  addSession(over?: Parameters<typeof makeSession>[0]): void;
  close(): Promise<void>;
}

export async function harness(opts: HooksBridgeOptions = {}, extra: { psTty?: string } = {}): Promise<Harness> {
  const tmp = await tempDir();
  const userHome = join(tmp.dir, 'home');
  const exec = createFakeExec(onCommand('ps', { stdout: `${extra.psTty ?? 'ttys009'}\n` }, ['-o', 'tty=']));
  const ctx = createTestContext({ userHome, home: join(tmp.dir, 's'), exec });
  const sessions = fakeSessions({ [ctx.paths.claudeHome]: 1, '/synthetic/home/.claude-swap-backup/sessions/3-profile': 3 });
  const transcripts = new FakeTranscripts();
  const bridge = createHooksBridge(ctx, { sessions, transcripts }, { reorderMs: 0, transcriptPollMs: 1000, ...opts }) as HooksBridgeImpl;
  await bridge.start();
  const events: DaemonEvent[] = [];
  ctx.store.subscribe((e) => events.push(e));
  let seen = 0;
  const h: Harness = {
    ctx,
    bridge,
    sessions,
    transcripts,
    events,
    sock: bridge.socketPath,
    dir: tmp.dir,
    of: (type) => events.filter((e) => e.type === type) as never,
    async push(payload, o = {}) {
      const before = seen;
      let processed = false;
      const off = bridge.onHookEvent(() => {
        processed = true;
      });
      const sent = send(h.sock, payload, o.keepOpen ? { keepOpen: true } : {});
      try {
        await waitFor(() => (o.until ? o.until() : processed), 3000, 'hook event to be processed');
      } finally {
        off();
      }
      seen = before + 1;
      return sent;
    },
    addSession(over = {}) {
      ctx.store.emit({ type: 'session.added', sid: over.sid ?? SID, data: { session: makeSession({ sid: SID, statusSource: 'session-file', status: 'idle', ...over }) } });
    },
    async close() {
      await bridge.stop();
      await tmp.cleanup();
    },
  };
  return h;
}
