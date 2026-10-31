/**
 * The installed copy of the hook client: ~/.jantar/bin/jantar-hook.
 *
 * Claude Code runs hooks with whatever PATH it was started with, so the
 * hooks in settings.json call `"<abs node>" "<abs ~/.jantar/bin/jantar-hook>"`.
 * A copy under ~/.jantar keeps working if the repo checkout moves. Same
 * conventions as the hooks installer's own copy step: byte-equal to the
 * shipped client, mode 0700 (node runs it, nobody else needs to read it).
 */
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { writeFileAtomic, type Paths } from '@jantar/daemon';
import { guardRealPath } from './guard.js';

export interface HookClientInstall {
  path: string;
  changed: boolean;
}

export const HOOK_CLIENT_MODE = 0o700;

export async function installHookClient(paths: Pick<Paths, 'binDir' | 'hookBin'>, source: string): Promise<HookClientInstall> {
  guardRealPath(paths.hookBin, 'the hook client');
  const code = await readFile(source);
  await mkdir(paths.binDir, { recursive: true, mode: 0o700 });
  await chmod(paths.binDir, 0o700);
  try {
    const current = await readFile(paths.hookBin);
    const mode = (await stat(paths.hookBin)).mode & 0o777;
    if (current.equals(code) && mode === HOOK_CLIENT_MODE) return { path: paths.hookBin, changed: false };
  } catch {
    // not installed yet
  }
  await writeFileAtomic(paths.hookBin, code, { mode: HOOK_CLIENT_MODE });
  return { path: paths.hookBin, changed: true };
}
