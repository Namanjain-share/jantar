/**
 * Finding and reading Claude Code session files (read-only).
 *
 * Layout (ccw's SESSION_GLOBS, ported):
 *   ~/.claude/sessions/<pid>.json                              the default login
 *   ~/.claude<anything>/sessions/<pid>.json                    other config dirs
 *   ~/.claude-swap-backup/sessions/<n>-<slug>/sessions/<pid>.json   cswap profiles
 *
 * Only `*.json` files are opened. The `<pid>.<hash>.key` files that sit next
 * to them are secrets and are never read.
 */
import { join, resolve } from 'node:path';
import type { Paths } from '../../contracts.js';
import { isDirEntry, listDir } from '../lib/fsx.js';
import { int, isObj, nonEmpty, num, str } from '../lib/values.js';

/** One session file as Claude wrote it (only the fields we use). */
export interface ParsedSessionFile {
  sid: string;
  pid: number;
  procStart: string;
  version?: string;
  cwd: string;
  name?: string;
  entrypoint: string;
  kind?: string;
  rawStatus: string;
  waitingFor?: string;
  statusUpdatedAt?: number;
  updatedAt?: number;
  startedAt?: number;
}

/** Validate a session file's JSON; null if it isn't one. */
export function parseSessionFile(raw: unknown): ParsedSessionFile | null {
  if (!isObj(raw)) return null;
  const sid = nonEmpty(raw.sessionId);
  const pid = int(raw.pid);
  if (!sid || pid === undefined || pid <= 0) return null;
  const out: ParsedSessionFile = {
    sid,
    pid,
    procStart: str(raw.procStart) ?? '',
    cwd: str(raw.cwd) ?? '',
    // a headless `claude -p` worker says "sdk-cli"; missing means an interactive terminal (ccw's default)
    entrypoint: nonEmpty(raw.entrypoint) ?? 'cli',
    rawStatus: nonEmpty(raw.status) ?? 'idle',
  };
  const version = nonEmpty(raw.version);
  if (version) out.version = version;
  const name = nonEmpty(raw.name);
  if (name) out.name = name;
  const kind = nonEmpty(raw.kind);
  if (kind) out.kind = kind;
  const waitingFor = nonEmpty(raw.waitingFor);
  if (waitingFor) out.waitingFor = waitingFor;
  for (const key of ['statusUpdatedAt', 'updatedAt', 'startedAt'] as const) {
    const v = num(raw[key]);
    if (v !== undefined && v > 0) out[key] = v;
  }
  return out;
}

/** Headless SDK sessions have no terminal and are not the user's to answer (ccw drops `sdk*`). */
export function isHeadless(entrypoint: string): boolean {
  return entrypoint.startsWith('sdk');
}

export interface ConfigDirs {
  /** Every Claude config dir that may hold a sessions/ folder. */
  configDirs: string[];
  /** cswap profile dirs (a subset of configDirs). */
  profiles: string[];
}

/** List config dirs: ~/.claude, other ~/.claude* dirs, and every cswap profile dir. */
export async function listConfigDirs(paths: Paths): Promise<ConfigDirs> {
  const out = new Set<string>([resolve(paths.claudeHome)]);
  const cswapRoot = resolve(paths.cswapRoot);
  const userHome = resolve(paths.userHome);
  for (const d of await listDir(userHome)) {
    if (!d.name.startsWith('.claude')) continue;
    const full = join(userHome, d.name);
    if (full === cswapRoot) continue; // its sessions/ holds profile dirs, not session files
    if (await isDirEntry(userHome, d)) out.add(full);
  }
  const profiles: string[] = [];
  const profilesDir = resolve(paths.cswapProfiles);
  for (const d of await listDir(profilesDir)) {
    if (d.name.startsWith('.')) continue; // cswap's sibling markers
    if (await isDirEntry(profilesDir, d)) profiles.push(join(profilesDir, d.name));
  }
  profiles.sort();
  for (const p of profiles) out.add(p);
  return { configDirs: [...out].sort(), profiles };
}

export interface SessionFileRef {
  file: string;
  configDir: string;
}

/** Every `<configDir>/sessions/*.json`. */
export async function listSessionFiles(configDirs: readonly string[]): Promise<SessionFileRef[]> {
  const out: SessionFileRef[] = [];
  for (const configDir of configDirs) {
    const dir = join(configDir, 'sessions');
    for (const d of await listDir(dir)) {
      if (d.name.startsWith('.') || !d.name.endsWith('.json')) continue;
      if (!d.isFile() && !d.isSymbolicLink()) continue;
      out.push({ file: join(dir, d.name), configDir });
    }
  }
  return out;
}

/** The directories worth watching for session changes. */
export function watchDirsFor(paths: Paths, dirs: ConfigDirs): string[] {
  return [resolve(paths.cswapProfiles), ...dirs.configDirs.map((d) => join(d, 'sessions'))];
}
