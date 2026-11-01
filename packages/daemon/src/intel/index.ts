/**
 * The Intel shelf (v0.4): a read-only shelf over JSONL files plus captures.
 * v0.8: the Mac reads links saved to it (intel/read/).
 *
 * `createIntelService` is the Factories['intel'] entry wired in daemon.ts,
 * plus the daemon's mode (`readOnly`: items are saved failed with the
 * readOnly reason, no read runs) and two seams for tests only: `net` (the
 * guard's and the CONNECT proxy's DNS lookup, CA and dial, for local HTTPS
 * servers with a test CA) and `browser` (playwright-core's own Chromium, or
 * a fake playwright module, for the headless tier). Nothing else reaches the
 * seams: no env var, flag, setting or CLI option; main.ts never passes them
 * (an arch test checks). The BlockList is never relaxed by them: a test's
 * lookup answers a public address, and `dial` sends that address to the
 * local server standing in for it.
 */
import type { LookupFunction } from 'node:net';
import type { Factories, IntelService } from '../contracts.js';
import type { PwModule } from './read/tiers/browser.js';
import { buildIntelService } from './service.js';

/** v0.8, tests only: what the guard and the CONNECT proxy resolve with, trust and dial. */
export interface IntelNetSeam {
  /** dns.lookup's shape (all: true is asked for); every address it returns still passes the BlockList. */
  lookup: LookupFunction;
  /** Extra CA certificates (a test CA for local HTTPS servers). */
  ca?: string | Buffer | (string | Buffer)[];
  /** Where a vetted public address is dialed (the local test server standing in for it). */
  dial?: (address: string, port: number) => { address: string; port: number };
}

/** v0.8, tests only: the headless tier's browser binary (playwright-core's own Chromium) instead of the system Chrome, or a fake module. */
export interface IntelBrowserSeam {
  executablePath: string;
  load?: () => Promise<PwModule>;
}

export interface IntelOptions {
  /** jantard --read-only: links are saved failed with the readOnly reason; nothing is read. */
  readOnly?: boolean;
  net?: IntelNetSeam;
  browser?: IntelBrowserSeam;
}

export function createIntelService(ctx: Parameters<Factories['intel']>[0], deps: Parameters<Factories['intel']>[1], opts: IntelOptions = {}): IntelService {
  return buildIntelService(ctx, deps, { read: opts });
}
