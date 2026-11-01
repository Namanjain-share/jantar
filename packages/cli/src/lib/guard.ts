/**
 * A safety net for the test suite: while running under a test runner, the
 * CLI refuses to write, delete or load anything in the real user's home
 * (LaunchAgents, v0.6's systemd user units, ~/.jantar and ccw-v2's
 * ~/.ccw-v2, Claude's and cswap's dirs, ccw's config). Tests work on a
 * synthetic HOME, so this only ever fires on a test bug.
 */
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';

export function underTest(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === 'test';
}

function realHome(): string | null {
  try {
    return userInfo().homedir;
  } catch {
    return null;
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Throws when `path` is inside one of the real user's protected dirs and a test runner is active. */
export function guardRealPath(path: string, what: string): void {
  if (!underTest()) return;
  const home = realHome();
  if (!home) return;
  const protectedDirs = [
    join(home, 'Library', 'LaunchAgents'),
    // v0.6: where `jantar install` writes jantar.service on a Linux server.
    join(home, '.config', 'systemd'),
    join(home, '.jantar'),
    join(home, '.ccw-v2'),
    join(home, '.claude'),
    join(home, '.claude-swap-backup'),
    join(home, '.config', 'ccw'),
    join(home, '.local', 'bin'),
  ].map(real);
  const target = real(path);
  for (const dir of protectedDirs) {
    if (target === dir || target.startsWith(dir + sep)) {
      throw new Error(`refusing to touch ${what} at ${target} during tests (use a synthetic HOME)`);
    }
  }
}
