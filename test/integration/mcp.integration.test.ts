/**
 * v0.5.3 `jantar mcp` end to end (spec 4.1, 9 lane I): jantard in-process
 * on a synthetic HOME (harness.ts) and the real CLI executable,
 * `node packages/cli/bin/jantar.mjs mcp` (the compiled dist/), spoken to
 * over its stdin and stdout the way Claude Code does, with
 * CLAUDE_PROJECT_DIR set to a synthetic folder.
 *
 * 1. The handshake and tools/list (five tools); intel_add saves a capture
 *    via claude with the folder kept on the Mac; intel_search finds it.
 * 2. todos_here before any project is linked: project null. A project is
 *    linked to the folder through the device API (the phone's way); then
 *    todo_add adds to it and todos_here shows it (lane L's folder routes).
 * 3. S10: every line on stdout is one JSON-RPC message; the server exits 0
 *    when stdin ends.
 *
 * Needs `pnpm -r build` first (CI builds before testing); skipped otherwise.
 * Nothing runs `claude`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { perfBudgetMs, projectBody } from '@jantar/fixtures';
import { DEVICE_COOKIE, type PairStartResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';

const CLI_BIN = fileURLToPath(new URL('../../packages/cli/bin/jantar.mjs', import.meta.url));
const DIST_MCP = fileURLToPath(new URL('../../packages/cli/dist/commands/mcp.js', import.meta.url));
const built = existsSync(DIST_MCP) && readFileSync(DIST_MCP, 'utf8').includes('createMcpServer');
if (!built) console.warn('[integration] jantar mcp tests skipped: run `pnpm -r build` first');

interface RpcAnswer {
  jsonrpc: string;
  id: number;
  result?: { content?: { type: string; text: string }[]; isError?: boolean; [k: string]: unknown };
  error?: { code: number; message: string };
}

/** The MCP server as a child process: send a request, wait for its answer by id. */
class McpChild {
  readonly lines: string[] = [];
  stderr = '';
  private buffer = '';
  private next = 0;
  private readonly waiting = new Map<number, (a: RpcAnswer) => void>();

  constructor(readonly child: ChildProcess) {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.lines.push(line);
        try {
          const msg = JSON.parse(line) as RpcAnswer;
          this.waiting.get(msg.id)?.(msg);
        } catch {
          // Kept in `lines`; the test fails on it.
        }
      }
    });
    child.stderr?.on('data', (c: Buffer) => (this.stderr += c.toString('utf8')));
  }

  /** Whatever is left after the last newline (must be empty). */
  get rest(): string {
    return this.buffer;
  }

  send(msg: object): void {
    this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params?: unknown): Promise<RpcAnswer> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no answer to ${method} (stderr: ${this.stderr.slice(-500)})`)), perfBudgetMs(10_000));
      this.waiting.set(id, (a) => {
        clearTimeout(t);
        resolve(a);
      });
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const a = await this.request('tools/call', { name, arguments: args });
    expect(a.error, JSON.stringify(a.error)).toBeUndefined();
    return { text: a.result?.content?.[0]?.text ?? '', isError: a.result?.isError === true };
  }

  exit(): Promise<number | null> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) resolve(this.child.exitCode);
      else this.child.once('exit', (code) => resolve(code));
    });
  }
}

describe.skipIf(!built)('jantar mcp: the real executable against jantard', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let phone: string;
  let mcp: McpChild;
  let folder = '';

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: { todos: true }, intel: { enabled: true } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'Example phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'Example phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    folder = join(d.home.home, 'work', 'example-app');
    // Started elsewhere on purpose: the folder comes from CLAUDE_PROJECT_DIR, as Claude Code sets it.
    const child = spawn(process.execPath, [CLI_BIN, 'mcp'], {
      cwd: d.home.root,
      env: { ...d.home.env, CLAUDE_PROJECT_DIR: folder },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    mcp = new McpChild(child);
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    if (mcp && mcp.child.exitCode === null && mcp.child.signalCode === null) mcp.child.kill('SIGKILL');
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. the handshake, five tools, intel_add via claude and intel_search finds it', async () => {
    const init = await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'example-client', version: '1.0.0' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'jantar' } });
    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect((await mcp.request('server/discover', {})).error?.code).toBe(-32601);
    const list = await mcp.request('tools/list');
    expect((list.result?.tools as { name: string }[]).map((t) => t.name)).toEqual(['intel_search', 'intel_get', 'intel_add', 'todos_here', 'todo_add']);

    const added = await mcp.tool('intel_add', { title: 'Example zephyr toolkit', url: 'https://example.com/zephyr', tags: ['example'] });
    expect(added.isError, added.text).toBe(false);
    const id = /^Added to the shelf: (captures:[0-9A-Z]{26})$/.exec(added.text)?.[1];
    expect(id, added.text).toBeDefined();
    expect((await mcp.tool('intel_add', { title: 'Same link', url: 'https://example.com/zephyr' })).text).toBe(`Already on the shelf: ${id} (nothing added)`);

    const found = await mcp.tool('intel_search', { query: 'zephyr' });
    expect(JSON.parse(found.text)).toMatchObject({ total: 1, items: [{ id, title: 'Example zephyr toolkit', url: 'https://example.com/zephyr', tags: ['example'] }] });
    const full = JSON.parse((await mcp.tool('intel_get', { id })).text) as { fields: { key: string; value: string }[] };
    expect(full.fields).toEqual([{ key: 'via', value: 'claude' }]);
    // The phone sees "via claude"; the session's folder stays in the captures file on the Mac.
    const item = await http(d.port, 'GET', `/v1/intel/items/${encodeURIComponent(id ?? '')}`, { cookie: phone });
    expect((item.body as { item: { fields: unknown } }).item.fields).toEqual([{ key: 'via', value: 'claude' }]);
    expect(item.text).not.toContain(folder);
    const file = readFileSync(join(d.ctx.paths.intelDir, 'captures.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(file.map((r) => [r.via, r.cwd])).toEqual([['claude', folder]]);
  }, perfBudgetMs(60_000));

  it("2. todos_here: no project, then the project linked to the folder; todo_add adds there", async () => {
    const none = await mcp.tool('todos_here');
    expect(none.isError).toBe(false);
    expect(JSON.parse(none.text)).toMatchObject({ project: null, todos: [] });
    expect((await mcp.tool('todo_add', { title: 'Nowhere to go' })).isError).toBe(true);

    const made = await http(d.port, 'POST', '/v1/projects', { cookie: phone, headers: { 'idempotency-key': 'k-mcp-project' }, body: projectBody({ name: 'Example app', folder }) });
    expect(made.status, made.text).toBe(200);
    const added = await mcp.tool('todo_add', { title: 'Check the example deploy', due_day: '2026-11-02', priority: 'high' });
    expect(added.isError, added.text).toBe(false);
    const todoId = /^Added to Example app: ([0-9A-Z]{26})$/.exec(added.text)?.[1];
    expect(todoId, added.text).toBeDefined();
    const here = JSON.parse((await mcp.tool('todos_here')).text) as { project: { name: string }; today: string; todos: { id: string; title: string; due?: { day: string }; priority: string }[] };
    expect(here.project).toEqual({ name: 'Example app' });
    expect(here.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(here.todos).toContainEqual({ id: todoId, title: 'Check the example deploy', due: { day: '2026-11-02' }, priority: 'high' });
  }, perfBudgetMs(60_000));

  it('3. stdout held only JSON-RPC lines; the server exits 0 when stdin ends', async () => {
    mcp.child.stdin?.end();
    expect(await mcp.exit()).toBe(0);
    expect(mcp.rest).toBe('');
    expect(mcp.lines.length).toBeGreaterThan(5);
    for (const line of mcp.lines) {
      const msg = JSON.parse(line) as { jsonrpc?: unknown; id?: unknown };
      expect(msg.jsonrpc, line.slice(0, 200)).toBe('2.0');
      expect(typeof msg.id, line.slice(0, 200)).toBe('number');
    }
    expect(mcp.stderr).not.toMatch(/error|exception/i);
  }, perfBudgetMs(30_000));
});
