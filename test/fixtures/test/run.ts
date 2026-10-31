/** Run a fake executable for real (spawned, argv only) and collect what it printed. */
import { spawn } from 'node:child_process';
import type { FakeHome } from '../src/index.js';

export interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  pid: number;
}

export async function sh(
  home: FakeHome,
  file: string,
  args: string[],
  input?: string,
  opts: { env?: Record<string, string>; cwd?: string; killAfterMs?: number; killWith?: NodeJS.Signals } = {},
): Promise<Ran> {
  const child = spawn(file, args, { env: opts.env ?? home.env, cwd: opts.cwd ?? home.root, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdin.end(input ?? '');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = opts.killAfterMs === undefined ? null : setTimeout(() => child.kill(opts.killWith ?? 'SIGTERM'), opts.killAfterMs);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('close', (c, s) => resolve([c, s])));
  if (timer) clearTimeout(timer);
  return { code, signal, stdout, stderr, pid: child.pid ?? -1 };
}
