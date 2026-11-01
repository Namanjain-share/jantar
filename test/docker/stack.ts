/**
 * The Docker suite's hands: docker compose on the stack in compose.yaml
 * (argv only, never a host shell), the phone's calls (phone.mjs in the phone
 * container), the fake Claude's control file and record on a node, logs, and
 * waiting. Used by fleet.e2e.test.ts.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  const r = await exec('phone', ['node', '/repo/test/docker/phone.mjs', ...args]);
  if (r.code !== 0) throw new Error(`phone ${args[0] ?? ''} failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout) as T;
}

/** One REST call of the paired phone through the door. */
export function call<T = any>(method: string, path: string, opts: { body?: unknown; key?: string; as?: string } = {}): Promise<Reply<T>> {
  const args = ['call', method, path];
  if (opts.body !== undefined) args.push('--body', JSON.stringify(opts.body));
  if (opts.key) args.push('--key', opts.key);
  if (opts.as) args.push('--as', opts.as);
  return phone<Reply<T>>(args);
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
  await run(service, ['tee', `${FAKE_CTL}/${sid}.json`], { input: JSON.stringify(cmd) });
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

/** Everything the services printed (jantard's logs, the door's request lines). */
export async function logs(services: readonly Service[]): Promise<string> {
  const r = await compose(['logs', '--no-color', '--no-log-prefix', ...services], { timeoutMs: 60_000 });
  return r.stdout + r.stderr;
}

/** Bring the stack up (building the image when it is missing) and wait for the hub behind the door. */
export async function up(): Promise<void> {
  const r = await compose(['up', '-d', '--build'], { timeoutMs: 1_800_000 });
  if (r.code !== 0) throw new Error(`docker compose up failed:\n${r.stderr}`);
  await eventually(async () => (await phone<Reply>(['call', 'GET', '/healthz', '--anon'])).status === 200, 120_000, 'the hub behind the door');
}
