/**
 * Helpers for the native Windows checks (W1-W8): run a program and collect
 * its output, find a free port, and the minimal session and transcript
 * sources a hooks bridge needs on its own. Nothing here runs anywhere but
 * windows-latest (every suite skips itself elsewhere).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { SessionSource, TranscriptReader } from '@jantar/daemon';

export const WINDOWS = process.platform === 'win32';

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Run `command args` (no shell), write `input` to its stdin, and wait for it to end. */
export function run(command: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<Ran> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

/** This process's environment without a state dir, as Claude's sessions run hooks. */
export function envWithout(...names: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const n of ['JANTAR_HOME', 'CCW_V2_HOME', ...names]) delete env[n];
  return env;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port: 0 }, () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

/** Poll until `cond` holds. */
export async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A session source that knows nothing (the test adds sessions to the store itself). */
export function noSessions(): SessionSource {
  return {
    async start() {},
    async stop() {},
    async scan() {
      return [];
    },
    current: () => [],
    accountForConfigDir: () => null,
  };
}

/** A transcript reader with no transcripts. */
export function noTranscripts(): TranscriptReader {
  return {
    async pathFor() {
      return null;
    },
    async size() {
      return 0;
    },
    async readFrom(_path: string, offset: number) {
      return { entries: [], next: offset };
    },
    async tail() {
      return {};
    },
    async page() {
      return { items: [], nextBefore: null };
    },
  };
}

/** A PermissionRequest as Claude sends it on Windows (the hook client adds its tag). */
export function permissionRequest(sid: string, cwd: string, command = 'Get-ChildItem'): string {
  return JSON.stringify({
    hook_event_name: 'PermissionRequest',
    session_id: sid,
    transcript_path: `${cwd}\\synthetic.jsonl`,
    cwd,
    permission_mode: 'default',
    tool_name: 'PowerShell',
    tool_input: { command, description: 'A synthetic command' },
    permission_suggestions: [],
  });
}
