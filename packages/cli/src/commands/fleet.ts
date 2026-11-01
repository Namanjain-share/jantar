/**
 * jantar fleet on | off | status: v0.6 Fleet, the Mac-only switch for
 * paired servers (settings fleet.enabled, off by default).
 *
 * - on: refuses a door servers can't use (loopback, LAN, http, no public
 *   address, a quick tunnel), sets the switch (the daemon's Fleet part then
 *   makes the hub key and opens /v1/node/*), and says what the door needs
 *   next: the Access application with Service Auth on Cloudflare (and that
 *   its token's expiry takes every server offline at once), or the tag and
 *   grant on Tailscale. It says plainly that the Mac is the one way in: while
 *   it sleeps or is off, the phone reaches no server; and, when pmset says
 *   this Mac sleeps on power (read only), that it does.
 * - off: every link closes (4403) and the servers' sessions leave the board;
 *   the pairings stay, so `fleet on` brings them back without joining again.
 * - status: on or off, the door, servers online; per server its last close
 *   and the Access refusals it counted while away; and, on a Cloudflare
 *   door, one hint when every server dropped within two minutes of each
 *   other while the Mac stayed up (an expired Access token).
 */
import { NODE_CLOSE, NODE_LINK_PATH } from '@jantar/protocol/node-link';
import { ROUTES, type MachinesResponse, type NodeRow } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { CtlUnavailableError, DaemonError, callDaemon } from '../ctl.js';
import { FIXED_DOOR, TAILSCALE_GRANT, closeWords, fleetDoor, macSleepMinutes, readCtlStatus } from '../lib/doctor.js';
import { readSettings, updateSettings } from '../lib/settings.js';
import { SAVED_TO_FILE, changeSettings } from '../lib/switches.js';
import { ago, duration, plural } from '../lib/text.js';
import { wrongRole } from './node.js';

const FLAGS = {
  json: { type: 'boolean', help: 'status: print JSON' },
} as const;

/** Every live server offline, each closed within this of the others. */
export const DROPPED_TOGETHER_MS = 2 * 60_000;

export const DROPPED_HINT =
  'Every server dropped at once: if you use Cloudflare Access, the service token may have expired (docs/fleet.md#rotate-the-access-token)';

/**
 * Whether every live server went offline within two minutes of the others,
 * seen by this hub (lastClose is since it started, so the Mac stayed up),
 * and not because the Mac closed them itself (removed, Fleet off).
 */
export function droppedTogether(rows: readonly NodeRow[]): boolean {
  const live = rows.filter((r) => r.revokedAt === null);
  if (live.length < 2) return false;
  const at: number[] = [];
  for (const r of live) {
    if (r.online || !r.lastClose) return false;
    if (r.lastClose.code === NODE_CLOSE.unknown || r.lastClose.code === NODE_CLOSE.fleetOff) return false;
    at.push(Date.parse(r.lastClose.at));
  }
  return Math.max(...at) - Math.min(...at) <= DROPPED_TOGETHER_MS;
}

/** The lines `fleet on` prints for a Cloudflare door. */
export function accessSteps(host: string): string {
  return (
    'With Cloudflare Access in front (the setup in docs/install.md), add one Access\n' +
    `application for ${host}/v1/node/* with a single Service Auth policy\n` +
    'and a service token (docs/fleet.md#cloudflare-access). Each server needs that\n' +
    "token's id and secret. Note the token's expiry date: when it lapses every server\n" +
    'goes offline at once (renew it with jantar node access on each server).\n'
  );
}

export const HUB_LINE = "This Mac is the hub: while it sleeps or is off, the phone can't reach any server.\n";

async function on(ctx: CliContext): Promise<number> {
  if (ctx.deps.platform !== 'darwin') {
    ctx.io.err('The hub is a Mac: turn Fleet on there. This machine joins it with jantar node join <line from the Mac>.\n');
    return EXIT.failed;
  }
  const { settings } = await readSettings(ctx);
  const door = fleetDoor(settings);
  if (!door.ok) {
    ctx.io.err(`${FIXED_DOOR}\n`);
    return EXIT.failed;
  }
  const r = await updateSettings(ctx, { fleet: { enabled: true } });
  ctx.io.out(`Fleet is on. Servers reach this Mac at ${door.url}${NODE_LINK_PATH}\n`);
  ctx.io.out(door.kind === 'cloudflare' ? accessSteps(door.host) : `${TAILSCALE_GRANT}\n`);
  ctx.io.out(HUB_LINE);
  const sleep = await macSleepMinutes(ctx.deps.exec);
  if (sleep !== null && sleep > 0) ctx.io.out(`This Mac sleeps after ${plural(sleep, 'minute')} on power: jantar doctor says how to stop that.\n`);
  if (r.via === 'file') ctx.io.out(SAVED_TO_FILE);
  ctx.io.out('Next: jantar node pair --name <name> [--count K] here, then run each line on its server.\n');
  return EXIT.ok;
}

async function off(ctx: CliContext): Promise<number> {
  await changeSettings(ctx, { fleet: { enabled: false } }, () =>
    "Fleet is off. Every server's link is closed and its sessions left the board. The pairings stay: jantar fleet on brings the servers back without joining again.\n",
  );
  return EXIT.ok;
}

async function status(ctx: CliContext, json: boolean): Promise<number> {
  const { settings } = await readSettings(ctx);
  const door = fleetDoor(settings);
  const st = await readCtlStatus(ctx.ctl);
  let rows: NodeRow[] | null = null;
  let listError: string | null = null;
  if (st) {
    try {
      rows = (await callDaemon<MachinesResponse>(ctx.ctl, 'GET', ROUTES.machinesList.path)).machines;
    } catch (e) {
      if (!(e instanceof DaemonError || e instanceof CtlUnavailableError)) throw e;
      listError = e.message;
    }
  }
  const live = (rows ?? []).filter((r) => r.revokedAt === null);
  // The hint names the Access token: only a Cloudflare door has one.
  const hint = settings.fleet.enabled && door.ok && door.kind === 'cloudflare' && droppedTogether(live);
  if (json) {
    ctx.io.out(
      `${JSON.stringify(
        {
          enabled: settings.fleet.enabled,
          door: door.ok ? { url: door.url, kind: door.kind } : { url: null, problem: door.why },
          daemon: st !== null,
          machines: rows,
          droppedTogether: hint,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.ok;
  }
  const now = ctx.deps.now();
  const out: string[] = [];
  out.push(`Fleet:   ${settings.fleet.enabled ? 'on' : 'off'}${settings.fleet.enabled ? '' : ' (turn it on: jantar fleet on)'}`);
  out.push(`Door:    ${door.ok ? `${door.url}${NODE_LINK_PATH} (${door.kind === 'tailscale' ? 'Tailscale Serve' : 'Cloudflare'})` : `none for servers: ${door.why}`}`);
  if (!st) {
    out.push('Servers: the daemon is not running (start it: jantar install)');
  } else if (listError !== null) {
    out.push(`Servers: the daemon did not list them (${listError})`);
  } else {
    const online = live.filter((r) => r.online).length;
    out.push(`Servers: ${live.length ? `${online} of ${live.length} online` : 'none paired (jantar node pair --name <name>)'}`);
    const w = Math.max(0, ...live.map((r) => r.name.length));
    for (const r of live) {
      const parts: string[] = [];
      // lastSeenAt is refreshed every few minutes while linked: it says nothing about since when.
      if (r.online) parts.push(`online · ${plural(r.sessions, 'session')}`);
      else if (r.lastClose) parts.push(`offline for ${duration(now - Date.parse(r.lastClose.at))} · last: ${closeWords(r.lastClose.code)}`);
      else parts.push(r.lastSeenAt ? `offline, last seen ${ago(r.lastSeenAt, now)}` : 'never linked');
      if (r.accessRefused > 0) parts.push(`${plural(r.accessRefused, 'Cloudflare Access refusal')} while away`);
      if (r.problem === 'version') parts.push('runs an older link version: update Jantar there');
      out.push(`  ${r.name.padEnd(w)}  ${parts.join(' · ')}`);
    }
  }
  if (hint) out.push(DROPPED_HINT);
  if (settings.fleet.enabled && !door.ok) out.push(FIXED_DOOR);
  ctx.io.out(`${out.join('\n')}\n`);
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'fleet',
    summary: 'v0.6: turn Fleet (servers paired to this Mac) on or off, and see how they are.',
    usage: 'jantar fleet <on|off|status> [--json]',
    owner: 'WP-FLEET',
    help:
      '  fleet on       servers may pair and link to this Mac through its front door (off by default)\n' +
      "  fleet off      close every server's link; pairings stay, so on brings them back\n" +
      '  fleet status   on or off, the door, servers online, why each last dropped\n' +
      'Then: jantar node pair at this Mac, jantar node join on each server. A Mac-only switch:\n' +
      'a phone can never turn it on. While this Mac sleeps or is off, the phone reaches no server.\n' +
      'More: docs/fleet.md.',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1, max: 1 });
    const [action] = positionals;
    if (action !== 'on' && action !== 'off' && action !== 'status') throw new UsageError(`unknown action "${action}" (on, off or status)`);
    const wrong = await wrongRole(ctx, 'hub');
    if (wrong) {
      // On a server: the switch lives at the hub.
      ctx.io.err(`${wrong.replace(/pair servers at the hub\.$/, 'Fleet is turned on and off at the hub.')}\n`);
      return EXIT.failed;
    }
    if (action === 'on') return on(ctx);
    if (action === 'off') return off(ctx);
    return status(ctx, flags.json === true);
  },
);
