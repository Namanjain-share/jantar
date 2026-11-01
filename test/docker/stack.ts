/**
 * The Docker suite's hands: docker compose on the stack in compose.yaml
 * (argv only, never a host shell), the phone's calls (phone.mjs in the phone
 * container), a machine's control socket and databases (machine.mjs), the
 * fake Claude's control file and record on a node, logs, and waiting. Used
 * by fleet.e2e.test.ts.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { NodeRow, State } from '@jantar/protocol';

export const COMPOSE_FILE = fileURLToPath(new URL('./compose.yaml', import.meta.url));
export const PROJECT = 'jantar-fleet-e2e';
/** The door's Access service token (compose.yaml, service door): synthetic. */
export const ACCESS = { id: 'jantar-nodes-test.access', secret: 'synthetic-access-secret-for-the-test-door' } as const;
export const HUB_URL = 'https://hub.fleet.test';
/** Where the nodes' fake Claude reads its control files and writes its record (FAKE_CLAUDE_CTL). */
export const FAKE_CTL = '/tmp/fake-claude';
/** The nodes' state dir (the default, ~/.jantar of the node user). */
export const NODE_STATE = '/home/node/.jantar';
export const HUB_STATE = '/data/hub';
const PHONE = '/repo/test/docker/phone.mjs';
const MACHINE = '/repo/test/docker/machine.mjs';

export type Service = 'ca' | 'door' | 'hub' | 'node1' | 'node2' | 'phone';

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function docker(args: readonly string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function compose(args: readonly string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<Ran> {
  return docker(['compose', '-f', COMPOSE_FILE, '-p', PROJECT, ...args], opts);
}

/** `docker compose exec -T` (stdin passed when given; `detach` leaves the program running). */
export function exec(
  service: Service,
  argv: readonly string[],
  opts: { env?: Record<string, string>; input?: string; detach?: boolean; workdir?: string; timeoutMs?: number } = {},
): Promise<Ran> {
  const flags = ['-T'];
  for (const [k, v] of Object.entries(opts.env ?? {})) flags.push('-e', `${k}=${v}`);
  if (opts.workdir) flags.push('-w', opts.workdir);
  if (opts.detach) flags.push('-d');
  return compose(['exec', ...flags, service, ...argv], opts);
}

/** Like exec, but a non-zero exit is an error carrying what the program printed. */
export async function run(service: Service, argv: readonly string[], opts: Parameters<typeof exec>[2] = {}): Promise<string> {
  const r = await exec(service, argv, opts);
  if (r.code !== 0) throw new Error(`${service}: ${argv.join(' ')} exited ${String(r.code)}\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

/** `jantar <args>` on a machine (its own ctl socket). */
export function jantar(service: Service, args: readonly string[], env?: Record<string, string>): Promise<Ran> {
  return exec(service, ['jantar', ...args], env ? { env } : {});
}

export interface Reply<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
}

/** phone.mjs <args> in the phone container, its JSON reply parsed. */
export async function phone<T = Reply>(args: readonly string[]): Promise<T> {
  const r = await exec('phone', ['node', PHONE, ...args]);
  if (r.code !== 0) throw new Error(`phone ${args[0] ?? ''} failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout) as T;
}

/** One REST call of the paired phone through the door; a write carries a fresh Idempotency-Key unless one is given. */
export function call<T = any>(method: string, path: string, opts: { body?: unknown; key?: string } = {}): Promise<Reply<T>> {
  const args = ['call', method, path];
  if (opts.body !== undefined) args.push('--body', JSON.stringify(opts.body));
  const key = opts.key ?? (method.toUpperCase() === 'GET' ? undefined : randomUUID());
  if (key) args.push('--key', key);
  return phone<Reply<T>>(args);
}

/** One call on a machine's own control socket (machine.mjs ctl), as the CLI there makes it. */
export async function ctl<T = any>(service: Service, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const args = ['node', MACHINE, 'ctl', method, path];
  if (body !== undefined) args.push('--body', JSON.stringify(body));
  return JSON.parse(await run(service, args)) as { status: number; body: T };
}

/** The hub's state as the phone gets it. */
export async function state(): Promise<State> {
  const r = await call<{ state: State }>('GET', '/v1/state');
  if (r.status !== 200) throw new Error(`GET /v1/state answered ${r.status}`);
  return r.body.state;
}

/** The hub's paired servers, revoked ones too (GET /v1/machines on its control socket). */
export async function machines(): Promise<NodeRow[]> {
  const r = await ctl<{ machines: NodeRow[] }>('hub', 'GET', '/v1/machines');
  if (r.status !== 200) throw new Error(`GET /v1/machines answered ${r.status}`);
  return r.body.machines;
}

export async function machine(name: string): Promise<NodeRow | undefined> {
  return (await machines()).find((m) => m.name === name);
}

/** `jantar node status --json` on a node, parsed (null while it fails). */
export async function nodeStatus(service: Service): Promise<Record<string, any> | null> {
  const r = await jantar(service, ['node', 'status', '--json']);
  return r.code === 0 ? (JSON.parse(r.stdout) as Record<string, any>) : null;
}

/** Every push the stand-in for fcm.googleapis.com received (sizes and headers, never a payload). */
export function pushes(): Promise<Array<Record<string, unknown>>> {
  return phone<Array<Record<string, unknown>>>(['pushes']);
}

export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tell the fake Claude of session `sid` on `service` what to do next (its control file). */
export async function fakeControl(service: Service, sid: string, cmd: unknown): Promise<void> {
  await run(service, ['sh', '-c', 'cat > "$0.tmp" && mv "$0.tmp" "$0"', `${FAKE_CTL}/${sid}.json`], { input: JSON.stringify(cmd) });
}

export interface FakeRecord {
  at: number;
  event: string;
  [k: string]: unknown;
}

/** What the fake Claude of session `sid` recorded (start, keys typed into a dialog, rows chosen, hooks, decisions). */
export async function fakeRecords(service: Service, sid: string): Promise<FakeRecord[]> {
  const r = await exec(service, ['cat', `${FAKE_CTL}/${sid}.events.jsonl`]);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FakeRecord);
}

/** The transcript lines of session `sid` on a node (`configDir` ~/.claude unless given), parsed. */
export async function transcriptOn(service: Service, sid: string, cwd: string, configDir = '/home/node/.claude'): Promise<Array<Record<string, any>>> {
  const r = await exec(service, ['cat', `${configDir}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sid}.jsonl`]);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
}

/** What the user typed, line by line of the transcript (string contents only: tool results and interrupts left out). */
export function userTexts(entries: Array<Record<string, any>>): string[] {
  return entries.filter((e) => e.type === 'user' && typeof e.message?.content === 'string').map((e) => e.message.content as string);
}

/** Everything the services printed (jantard's logs, the door's request lines), optionally within a time window (RFC 3339). */
export async function logs(services: readonly Service[], window: { since?: string; until?: string } = {}): Promise<string> {
  const args = ['logs', '--no-color', '--no-log-prefix'];
  if (window.since) args.push('--since', window.since);
  if (window.until) args.push('--until', window.until);
  const r = await compose([...args, ...services], { timeoutMs: 60_000 });
  return r.stdout + r.stderr;
}

/** The hub answers behind the door. */
export function hubUp(ms = 120_000): Promise<boolean> {
  return eventually(async () => (await phone<Reply>(['call', 'GET', '/healthz', '--anon'])).status === 200, ms, 'the hub behind the door');
}

/**
 * A fresh stack: whatever an earlier run left is taken down (containers and
 * the certs volume), then everything comes up from the jantar-fleet-test
 * image (run.mjs builds it; compose builds it only when it is missing).
 */
export async function up(): Promise<void> {
  await compose(['down', '-v', '--remove-orphans', '-t', '3'], { timeoutMs: 300_000 });
  const r = await compose(['up', '-d'], { timeoutMs: 1_800_000 });
  if (r.code !== 0) throw new Error(`docker compose up failed:\n${r.stderr}`);
  await hubUp();
}
