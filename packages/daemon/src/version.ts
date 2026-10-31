import { readFileSync } from 'node:fs';
import { PROTOCOL_VERSION } from '@jantar/protocol';

function readVersion(): string {
  try {
    // src/ and dist/ both sit one level below the package root.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const DAEMON_VERSION = readVersion();
export const VERSION_INFO = { daemon: DAEMON_VERSION, protocol: PROTOCOL_VERSION } as const;
