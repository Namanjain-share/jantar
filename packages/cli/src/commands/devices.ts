/**
 * jantar devices: paired devices, and the scopes only the Mac hands out
 * (POST /v1/devices/:id/scopes over the control socket; the daemon refuses
 * it over the network, even to an admin device).
 *
 * Scopes are a chain (admin ⊃ launch ⊃ control ⊃ read). Taking one away
 * also takes the ones above it, and read always stays. Taking admin away
 * leaves launch, so every change prints the scopes left and says when
 * launch remains. A change applies at the device's next request.
 */
import {
  ROUTES,
  buildPath,
  type DevicePublic,
  type DeviceResponse,
  type DevicesResponse,
  type Scope,
} from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import { deviceLines, hasScopeNow, parseScopes, resolveDevice, scopesText, shellWord } from '../lib/devices.js';
import { readSettings } from '../lib/settings.js';
import { ago, clip } from '../lib/text.js';

const FLAGS = {
  all: { type: 'boolean', help: 'list: include revoked devices' },
  json: { type: 'boolean', help: 'list: print the devices as JSON' },
} as const;

async function fetchDevices(ctx: CliContext): Promise<DevicePublic[]> {
  return (await callDaemon<DevicesResponse>(ctx.ctl, 'GET', ROUTES.listDevices.path)).devices;
}

/** The device `query` names; otherwise it says why (listing the candidates) and gives the exit code. */
async function findDevice(ctx: CliContext, query: string): Promise<DevicePublic | number> {
  const match = resolveDevice(await fetchDevices(ctx), query);
  if (match.ok) return match.device;
  if (match.reason === 'ambiguous') {
    ctx.io.err(`jantar devices: "${clip(query, 40)}" matches ${match.candidates.length} devices:\n${deviceLines(match.candidates)}\nUse the device id.\n`);
    return EXIT.usage;
  }
  ctx.io.err(`jantar devices: no paired device matches "${clip(query, 40)}" (see: jantar devices list)\n`);
  return EXIT.failed;
}

async function list(ctx: CliContext, flags: { all?: boolean; json?: boolean }): Promise<number> {
  const devices = (await fetchDevices(ctx)).filter((d) => flags.all || !d.revokedAt);
  if (flags.json) {
    ctx.io.out(`${JSON.stringify({ devices }, null, 2)}\n`);
    return EXIT.ok;
  }
  if (devices.length === 0) {
    ctx.io.out('No paired devices. Pair one: jantar pair\n');
    return EXIT.ok;
  }
  const now = ctx.deps.now();
  const nameW = Math.max(...devices.map((d) => clip(d.name, 32).length));
  const idW = Math.max(...devices.map((d) => d.id.length));
  for (const d of devices) {
    const when = d.revokedAt ? `revoked ${ago(d.revokedAt, now)}` : `seen ${ago(d.lastSeenAt, now)}`;
    ctx.io.out(`  ${clip(d.name, 32).padEnd(nameW)}  ${d.id.padEnd(idW)}  ${scopesText(d.scopes)}  · ${when}\n`);
  }
  return EXIT.ok;
}

async function changeScopes(ctx: CliContext, query: string, words: readonly string[], verb: 'grant' | 'revoke-scope'): Promise<number> {
  if (words.length === 0) throw new UsageError(`${verb} needs a scope (e.g. launch)`);
  const scopes = parseScopes(words);
  if (verb === 'revoke-scope' && scopes.includes('read')) {
    throw new UsageError(`read always stays; to cut a device off entirely: jantar devices revoke ${shellWord(query)}`);
  }
  const device = await findDevice(ctx, query);
  if (typeof device === 'number') return device;
  if (device.revokedAt) throw new Error(`${clip(device.name, 40)} was revoked; pair it again (jantar pair)`);
  const body: { add?: Scope[]; remove?: Scope[] } = verb === 'grant' ? { add: scopes } : { remove: scopes };
  const res = await callDaemon<DeviceResponse>(ctx.ctl, 'POST', buildPath(ROUTES.deviceScopes, { id: device.id }), body, {
    idempotencyKey: ctx.deps.randomId(),
  });
  const after = res.device.scopes;
  const name = clip(res.device.name, 40);
  ctx.io.out(`${name} now has ${scopesText(after)}.\n`);
  if (verb === 'revoke-scope' && scopes.includes('admin') && !scopes.includes('launch') && hasScopeNow(after, 'launch')) {
    ctx.io.out(`It can still start sessions from the phone (launch). To stop that, revoke launch too: jantar devices revoke-scope ${shellWord(query)} launch\n`);
  }
  if (verb === 'grant' && hasScopeNow(after, 'launch')) {
    const { settings } = await readSettings(ctx);
    if (!settings.launch.enabled) ctx.io.out('Starting sessions from the phone is off on this Mac: jantar launch on\n');
  }
  ctx.io.out('It applies at the device\'s next request; no new pairing needed.\n');
  return EXIT.ok;
}

async function revoke(ctx: CliContext, query: string): Promise<number> {
  const device = await findDevice(ctx, query);
  if (typeof device === 'number') return device;
  if (device.revokedAt) {
    ctx.io.out(`${clip(device.name, 40)} is already revoked.\n`);
    return EXIT.ok;
  }
  const res = await callDaemon<DeviceResponse>(ctx.ctl, 'DELETE', buildPath(ROUTES.revokeDevice, { id: device.id }), undefined, {
    idempotencyKey: ctx.deps.randomId(),
  });
  ctx.io.out(`Revoked ${clip(res.device.name, 40)} (${res.device.id}): it is signed out now and has to pair again.\n`);
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'devices',
    summary: 'List paired devices, grant or take back scopes such as launch, or revoke a device.',
    usage: 'jantar devices <list [--all] [--json]|grant <device> <scope...>|revoke-scope <device> <scope...>|revoke <device>>',
    owner: 'T2',
    help:
      '<device> is a device id, a unique id prefix (4+ characters), or a unique device name.\n' +
      'Scopes: read < control < launch < admin. launch lets a device start sessions; only this Mac grants it.\n' +
      '  devices grant iPhone launch          let the iPhone start sessions\n' +
      '  devices revoke-scope iPhone launch   take it back (admin goes with it)\n' +
      '  devices revoke iPhone                sign the device out for good',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1 });
    const [action, device, ...scopes] = positionals;
    if ((flags.all || flags.json) && action !== 'list') throw new UsageError('--all and --json are for "devices list"');
    switch (action) {
      case 'list':
        if (device !== undefined) throw new UsageError('list takes no argument');
        return list(ctx, flags);
      case 'grant':
      case 'revoke-scope':
        if (device === undefined) throw new UsageError(`${action} needs a device and a scope`);
        return changeScopes(ctx, device, scopes, action);
      case 'revoke':
        if (device === undefined) throw new UsageError('revoke needs a device');
        if (scopes.length) throw new UsageError(`unexpected argument "${scopes[0]}" (to take one scope away: jantar devices revoke-scope)`);
        return revoke(ctx, device);
      default:
        throw new UsageError(`unknown action "${action}" (list, grant, revoke-scope or revoke)`);
    }
  },
);
