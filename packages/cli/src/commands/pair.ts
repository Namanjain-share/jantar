/**
 * jantar pair: ask the daemon (over the 0600 control socket) for a one-time
 * pairing code and show it as a QR code. The code rides in the URL fragment,
 * works once, and expires after 10 minutes.
 *
 * v0.5: `--extension` pairs the Jantar Chrome extension instead: it prints
 * the line to paste into the extension's popup and waits for the claim
 * (commands/meetings.ts `pairExtension`).
 */
import { ROUTES, type PairStartResponse, type Scope } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand } from '../command.js';
import { callDaemon } from '../ctl.js';
import { terminalQr } from '../lib/qr.js';
import { until } from '../lib/text.js';
import { pairExtension } from './meetings.js';

const FLAGS = {
  name: { type: 'string', short: 'n', help: 'name for the new device (default: chosen on the phone)' },
  admin: { type: 'boolean', help: 'also grant admin (settings, devices); only for a device you fully trust' },
  'read-only': { type: 'boolean', help: 'grant read only (no prompts, approvals or focus)' },
  json: { type: 'boolean', help: 'print {code,url,expiresAt} as JSON instead of a QR code' },
  qr: { type: 'boolean', help: 'draw the QR code (default; --no-qr prints the link only)' },
  extension: { type: 'boolean', help: 'pair the Jantar Chrome extension on this Mac instead (prints a line for its popup, then waits)' },
} as const;

/** The phone's flags, which mean nothing for the extension (its key reaches only its own routes). */
const DEVICE_ONLY = ['admin', 'read-only', 'name', 'json', 'qr'] as const;

export function scopesFor(flags: { admin?: boolean; 'read-only'?: boolean }): Scope[] {
  if (flags.admin && flags['read-only']) throw new UsageError('--admin and --read-only exclude each other');
  if (flags['read-only']) return ['read'];
  if (flags.admin) return ['read', 'control', 'admin'];
  return ['read', 'control'];
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

export default defineCommand(
  {
    name: 'pair',
    summary: 'Show a QR code that pairs a phone or browser (one-time, 10 minutes); --extension pairs the Chrome extension.',
    usage: 'jantar pair [--name NAME] [--admin | --read-only] [--json] [--no-qr] | jantar pair --extension',
    owner: 'G',
    help:
      'Scan the code with the phone camera. Remote access must be set up first (jantar remote setup).\n' +
      'jantar pair --extension pairs the Jantar Chrome extension on this Mac: paste the line it prints into the\n' +
      'Jantar popup in Chrome, and it says "Paired." once the extension has its key (docs/extension.md).',
  },
  async (argv, ctx) => {
    const { flags } = parseArgs(argv, FLAGS, { max: 0 });
    if (flags.extension) {
      for (const f of DEVICE_ONLY) {
        // Name the flag as typed: --qr comes in as qr: false when it was --no-qr.
        if (flags[f] !== undefined) throw new UsageError(`--${f === 'qr' && flags.qr === false ? 'no-qr' : f} does not go with --extension`);
      }
      return pairExtension(ctx);
    }
    const scopes = scopesFor(flags);
    if (flags.name !== undefined && (flags.name.length < 1 || flags.name.length > 64)) {
      throw new UsageError('--name must be 1 to 64 characters');
    }
    const body = { scopes, ...(flags.name ? { name: flags.name } : {}) };
    const res = await callDaemon<PairStartResponse>(ctx.ctl, 'POST', ROUTES.pairStart.path, body, {
      idempotencyKey: ctx.deps.randomId(),
    });
    if (flags.json) {
      ctx.io.out(`${JSON.stringify(res, null, 2)}\n`);
      return EXIT.ok;
    }
    if (flags.qr !== false) ctx.io.out(await terminalQr(res.url));
    ctx.io.out(`${res.url}\n\n`);
    const expires = until(res.expiresAt, ctx.deps.now());
    ctx.io.out(
      `One-time link for a new device with ${scopes.join(' + ')} access${expires ? `, expires ${expires}` : ''}.\n` +
        'Anyone who scans it before you gets that access: do not share or screenshot it.\n',
    );
    if (isLoopbackUrl(res.url)) {
      ctx.io.err(
        '\nThis link points at 127.0.0.1, so it only works in a browser on this Mac.\n' +
          'For your phone, set up remote access first: jantar remote setup\n',
      );
    }
    return EXIT.ok;
  },
);
