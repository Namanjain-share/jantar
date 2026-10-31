/**
 * Test doubles for CLI commands: an in-memory control-socket client, fake
 * deps (fake exec, fixed clock, injected binary finder) and a context on a
 * synthetic HOME. Nothing here spawns launchctl, osascript or a browser.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePaths, type Paths } from '@jantar/daemon';
import { createFakeExec, type ExecCall, type ExecHandler } from '@jantar/daemon/core/testing';
import type { FakeHome } from '@jantar/fixtures';
import { applySettingsPatch, defaultSettings, errorBody, type ErrorCode, type Settings } from '@jantar/protocol';
import { CtlUnavailableError, type CtlBytesResponse, type CtlClient, type CtlRequestOptions, type CtlResponse } from '../src/ctl.js';
import type { CliContext } from '../src/command.js';
import type { CliDeps } from '../src/deps.js';
import { memoryIo, type MemoryIoOptions } from '../src/io.js';

export interface CtlCall {
  method: string;
  path: string;
  body: unknown;
  opts: CtlRequestOptions;
}

export type Handler = (call: CtlCall) => CtlResponse | Promise<CtlResponse>;

export function ok(body: unknown, status = 200): CtlResponse {
  return { status, body };
}

export function fail(code: ErrorCode, message: string, status: number): CtlResponse {
  return { status, body: errorBody(code, message) };
}

/**
 * A CtlClient answering from `routes` ("GET /v1/state" -> handler); a path
 * with a query string falls back to its route without one. `down` = no daemon.
 * v0.5: `bytes(path)` answers from the same "GET <path>" routes: a Buffer
 * body comes back as image/jpeg, anything else as JSON (an error).
 */
export function fakeCtl(routes: Record<string, Handler | CtlResponse> = {}, opts: { down?: boolean } = {}) {
  const calls: CtlCall[] = [];
  const client: CtlClient & { calls: CtlCall[]; routes: typeof routes } = {
    socketPath: '/synthetic/run/ctl.sock',
    calls,
    routes,
    async request<T>(method: string, path: string, body?: unknown, o: CtlRequestOptions = {}) {
      const call = { method, path, body, opts: o };
      calls.push(call);
      if (opts.down) throw new CtlUnavailableError('/synthetic/run/ctl.sock', 'ENOENT');
      const r = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`];
      if (!r) return fail('not_found', `no fake route ${method} ${path}`, 404) as CtlResponse<T>;
      return (typeof r === 'function' ? await r(call) : r) as CtlResponse<T>;
    },
    async bytes(path: string): Promise<CtlBytesResponse> {
      const res = await client.request('GET', path);
      if (Buffer.isBuffer(res.body)) return { status: res.status, type: 'image/jpeg', body: res.body };
      return { status: res.status, type: 'application/json', body: Buffer.from(JSON.stringify(res.body)) };
    },
  };
  return client;
}

/**
 * The daemon's settings routes on a live Settings object: GET answers it,
 * PATCH goes through applySettingsPatch as the daemon's does (an invalid or
 * unknown setting is a 400). `patches` records every PATCH body.
 */
export function fakeSettings(start: Record<string, unknown> = {}) {
  const first = applySettingsPatch(defaultSettings(), start);
  if (!first.ok) throw new Error(first.error);
  let current: Settings = first.settings;
  const patches: unknown[] = [];
  const routes: Record<string, Handler> = {
    'GET /v1/settings': () => ok({ settings: current }),
    'PATCH /v1/settings': (call) => {
      patches.push(call.body);
      const r = applySettingsPatch(current, call.body);
      if (!r.ok) return fail('invalid_request', r.error, 400);
      current = r.settings;
      return ok({ settings: current });
    },
  };
  return {
    routes,
    patches,
    get settings(): Settings {
      return current;
    },
  };
}

export const T0 = Date.parse('2026-01-15T10:00:00.000Z');

export interface TestDepsOptions extends Partial<Omit<CliDeps, 'exec' | 'findBin'>> {
  handlers?: ExecHandler[];
  /** name -> absolute path (null / missing = not installed). */
  bins?: Record<string, string | null>;
}

export function testDeps(o: TestDepsOptions = {}) {
  let now = o.now ? o.now() : T0;
  let n = 0;
  const exec = createFakeExec(...(o.handlers ?? []));
  const deps: CliDeps & { exec: typeof exec } = {
    platform: 'darwin',
    uid: 501,
    nodePath: '/opt/synthetic/node/bin/node',
    nodeVersion: 'v22.15.0',
    sleep: async (ms: number) => {
      now += ms;
    },
    portFree: async () => true,
    randomId: () => `id-${++n}`,
    locations: { daemonBin: '/synthetic/repo/packages/daemon/bin/jantard.mjs', hookClient: '/synthetic/repo/packages/hook/bin/jantar-hook.mjs' },
    httpJson: async () => null,
    ...o,
    now: () => now,
    exec,
    findBin: async (name: string) => o.bins?.[name] ?? null,
  };
  return deps;
}

export function contextFor(
  home: FakeHome | { env: Record<string, string> },
  over: { ctl?: CtlClient; deps?: CliDeps; io?: ReturnType<typeof memoryIo>; ioOptions?: MemoryIoOptions; paths?: Paths } = {},
) {
  const io = over.io ?? memoryIo(home.env, over.ioOptions);
  const ctx: CliContext = {
    io,
    paths: over.paths ?? resolvePaths({ env: home.env }),
    ctl: over.ctl ?? fakeCtl({}, { down: true }),
    deps: over.deps ?? testDeps(),
  };
  return { ctx, io };
}

/** Fake package layout: a built daemon and a hook client file, under `root`. */
export async function fakePackages(root: string): Promise<CliDeps['locations']> {
  const daemonBin = join(root, 'repo', 'packages', 'daemon', 'bin', 'jantard.mjs');
  const hookClient = join(root, 'repo', 'packages', 'hook', 'bin', 'jantar-hook.mjs');
  await mkdir(join(root, 'repo', 'packages', 'daemon', 'bin'), { recursive: true });
  await mkdir(join(root, 'repo', 'packages', 'daemon', 'dist'), { recursive: true });
  await mkdir(join(root, 'repo', 'packages', 'hook', 'bin'), { recursive: true });
  await writeFile(daemonBin, '// synthetic daemon launcher\n');
  await writeFile(join(root, 'repo', 'packages', 'daemon', 'dist', 'main.js'), '// synthetic daemon\n');
  await writeFile(hookClient, '#!/usr/bin/env node\n// synthetic hook client\nprocess.exit(0);\n');
  return { daemonBin, hookClient };
}

export function argsOf(calls: readonly ExecCall[], file: string): string[][] {
  return calls.filter((c) => c.file === file).map((c) => c.args);
}
