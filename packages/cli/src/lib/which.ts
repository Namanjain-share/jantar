/**
 * Find executables by absolute path: $PATH first, then well-known install
 * locations. launchd's PATH is minimal, so whatever the CLI finds here is
 * recorded as an absolute path (settings.bins) for the daemon.
 */
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, join } from 'node:path';

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Extra tools the CLI looks for (the daemon's own binaries are in config.ts). */
export const EXTRA_LOCATIONS: Record<string, (userHome: string) => string[]> = {
  tailscale: () => [
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ],
  cloudflared: () => ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'],
  pgrep: () => ['/usr/bin/pgrep'],
  launchctl: () => ['/bin/launchctl'],
  open: () => ['/usr/bin/open'],
  'xdg-open': () => ['/usr/bin/xdg-open'],
  cswap: (h) => [join(h, '.local', 'bin', 'cswap'), '/opt/homebrew/bin/cswap', '/usr/local/bin/cswap'],
  // ~/.claude/local/claude: the older "local" install, which a shell alias reaches, not PATH.
  claude: (h) => [join(h, '.local', 'bin', 'claude'), join(h, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
  osascript: () => ['/usr/bin/osascript'],
};

export interface FindOptions {
  env: Readonly<Record<string, string | undefined>>;
  userHome: string;
  /** Skip $PATH (only well-known locations). */
  noPath?: boolean;
  /** v0.6: on win32 a bare name is looked for as `<name>.exe` first (default: this machine's). */
  platform?: NodeJS.Platform;
}

export type BinFinder = (name: string) => Promise<string | null>;

/**
 * The file names a command may have. v0.6, Windows: `claude.exe` before
 * `claude` (npm's extensionless sh shim there can be found but not started).
 */
function namesOf(name: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' && extname(name) === '' ? [`${name}.exe`, name] : [name];
}

export function createBinFinder(opts: FindOptions): BinFinder {
  const platform = opts.platform ?? process.platform;
  return async (name) => {
    const dirs = opts.noPath ? [] : (opts.env.PATH ?? '').split(delimiter).filter(Boolean);
    for (const file of namesOf(name, platform)) {
      for (const dir of dirs) {
        const p = join(dir, file);
        if (await isExecutable(p)) return p;
      }
    }
    for (const p of EXTRA_LOCATIONS[name]?.(opts.userHome) ?? []) if (await isExecutable(p)) return p;
    return null;
  };
}
