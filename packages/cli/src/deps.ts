/**
 * Everything a command does to the machine goes through these injectable
 * dependencies, so tests run against a synthetic HOME with a fake exec and
 * never start launchctl, osascript, tailscale or a browser for real.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createExecFile, type ExecFile } from '@jantar/daemon';
import { HOOK_CLIENT_PATH } from '@jantar/hook';
import { fetchJson } from './lib/doctor.js';
import type { BinFinder } from './lib/which.js';

export interface PackageLocations {
  /** packages/daemon/bin/jantard.mjs (what launchd runs with the absolute node path). */
  daemonBin: string;
  /** packages/hook/bin/jantar-hook.mjs (copied to ~/.jantar/bin/jantar-hook at install). */
  hookClient: string;
}

export interface CliDeps {
  /** Argv-only runner (absolute paths, never a shell). */
  exec: ExecFile;
  platform: NodeJS.Platform;
  uid: number;
  /** The node binary that launchd and the hooks will run (absolute). */
  nodePath: string;
  nodeVersion: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** True when nothing listens on host:port. */
  portFree(host: string, port: number): Promise<boolean>;
  randomId(): string;
  locations: PackageLocations;
  /** Find an executable by absolute path (default: $PATH, then well-known places). */
  findBin?: BinFinder;
  /** GET a URL and parse its JSON body; null when nothing answers. */
  httpJson(url: string): Promise<unknown | null>;
}

function locate(): PackageLocations {
  const require = createRequire(import.meta.url);
  let daemonBin: string;
  try {
    daemonBin = join(dirname(require.resolve('@jantar/daemon/package.json')), 'bin', 'jantard.mjs');
  } catch {
    daemonBin = join(dirname(HOOK_CLIENT_PATH), '..', '..', 'daemon', 'bin', 'jantard.mjs');
  }
  return { daemonBin, hookClient: HOOK_CLIENT_PATH };
}

export function checkPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ host, port, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

export function defaultDeps(env: Readonly<Record<string, string | undefined>> = process.env): CliDeps {
  return {
    exec: createExecFile({ env }),
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    nodePath: process.execPath,
    nodeVersion: process.version,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    portFree: checkPortFree,
    randomId: () => randomUUID(),
    locations: locate(),
    httpJson: fetchJson,
  };
}
