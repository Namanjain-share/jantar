/**
 * jantar remote status | setup | url
 *
 * The daemon always listens on 127.0.0.1 only. For the phone, an HTTPS front
 * door forwards to it:
 * - Tailscale Serve (recommended): https://<mac>.<tailnet>.ts.net, tailnet
 *   only, real certificate, stable URL (so the Home Screen app and push keep
 *   working). Never Funnel.
 * - Cloudflare quick tunnel (fallback): no app on the phone, but the URL
 *   changes on every restart and TLS ends at Cloudflare.
 * `setup` prints the steps; `setup --apply` runs the one Tailscale command
 * for you and points pairing links at the new URL. Pairing is still needed.
 */
import { ROUTES, type HealthResponse } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, binFinder, defineCommand, type CliContext } from '../command.js';
import { CtlUnavailableError, callDaemon } from '../ctl.js';
import {
  cloudflaredQuickArgs,
  daemonTarget,
  probeTailscale,
  remotePatch,
  shellQuote,
  tailscaleServeArgs,
  tailscaleServeLegacyArgs,
  tailscaleServeOffArgs,
  validatePublicUrl,
} from '../lib/remote.js';
import { readSettings, updateSettings } from '../lib/settings.js';

const FLAGS = {
  tailscale: { type: 'boolean', help: 'setup: use Tailscale Serve (default)' },
  cloudflare: { type: 'boolean', help: 'setup: use a Cloudflare quick tunnel instead' },
  apply: { type: 'boolean', help: 'setup: run the Tailscale command and update the pairing URL' },
  clear: { type: 'boolean', help: 'url: go back to loopback-only pairing links' },
  json: { type: 'boolean', help: 'status: machine-readable output' },
} as const;

async function daemonUp(ctx: CliContext): Promise<boolean> {
  try {
    await callDaemon<HealthResponse>(ctx.ctl, 'GET', ROUTES.health.path, undefined, { timeoutMs: 2000 });
    return true;
  } catch (e) {
    if (e instanceof CtlUnavailableError) return false;
    throw e;
  }
}

async function status(ctx: CliContext, json: boolean): Promise<number> {
  const { settings, source } = await readSettings(ctx);
  const ts = await probeTailscale(ctx.deps.exec, await binFinder(ctx)('tailscale'), settings.remote.port);
  const cloudflared = await binFinder(ctx)('cloudflared');
  if (json) {
    ctx.io.out(`${JSON.stringify({ remote: settings.remote, settingsSource: source, tailscale: ts, cloudflared }, null, 2)}\n`);
    return EXIT.ok;
  }
  const r = settings.remote;
  ctx.io.out(`Daemon:        ${daemonTarget(r.port)} (loopback only)\n`);
  ctx.io.out(`Mode:          ${r.mode}\n`);
  ctx.io.out(`Pairing URL:   ${r.publicUrl ?? '(none: pairing links only work on this Mac)'}\n`);
  if (r.allowedOrigins.length) ctx.io.out(`Origins:       ${r.allowedOrigins.join(', ')}\n`);
  if (!ts.installed) ctx.io.out('Tailscale:     not installed\n');
  else if (!ts.running) ctx.io.out(`Tailscale:     installed, not connected${ts.backendState ? ` (${ts.backendState})` : ''}\n`);
  else {
    const serve = ts.serve;
    ctx.io.out(`Tailscale:     connected as ${ts.dnsName ?? '?'}\n`);
    ctx.io.out(
      `  Serve:       ${serve?.matchesDaemon ? `forwards to Jantar (${serve.urls.join(', ')})` : serve?.configured ? `set up for something else (${serve.proxiesTo.join(', ')})` : 'not set up'}\n`,
    );
    if (serve?.funnel) ctx.io.out('  WARNING:     Funnel is on: that exposes the service to the whole internet.\n');
  }
  ctx.io.out(`cloudflared:   ${cloudflared ?? 'not installed'}\n`);
  return EXIT.ok;
}

async function setUrl(ctx: CliContext, raw: string | null): Promise<number> {
  const { settings } = await readSettings(ctx);
  let patch: Record<string, unknown>;
  if (raw === null) {
    patch = remotePatch(settings, null);
  } else {
    const v = validatePublicUrl(raw);
    if (!v.ok) throw new UsageError(v.reason);
    patch = remotePatch(settings, v.url);
  }
  const r = await updateSettings(ctx, patch);
  ctx.io.out(
    raw === null
      ? 'Pairing links point at this Mac only again (loopback).\n'
      : `Pairing links now use ${r.settings.remote.publicUrl} (mode ${r.settings.remote.mode}).\n`,
  );
  if (r.via === 'file') ctx.io.out('Saved to config.json; the daemon picks it up when it starts.\n');
  else ctx.io.out('Next: jantar pair\n');
  return EXIT.ok;
}

async function setup(ctx: CliContext, flags: { cloudflare?: boolean; apply?: boolean }): Promise<number> {
  const { settings } = await readSettings(ctx);
  const port = settings.remote.port;
  const find = binFinder(ctx);

  if (flags.cloudflare) {
    if (flags.apply) throw new UsageError('--apply is for Tailscale only; a quick tunnel has to keep running in its own terminal');
    const have = await find('cloudflared');
    const n = have ? 0 : 1;
    ctx.io.out(
      'Cloudflare quick tunnel (fallback)\n\n' +
        `${have ? '' : '1. Install cloudflared: brew install cloudflared\n'}` +
        `${1 + n}. In a separate terminal, run (and keep it running):\n` +
        `     ${shellQuote([have ?? 'cloudflared', ...cloudflaredQuickArgs(port)])}\n` +
        '   It prints a https://<random>.trycloudflare.com address.\n' +
        `${2 + n}. Point pairing links at it, then pair:\n` +
        '     jantar remote url https://<random>.trycloudflare.com\n' +
        '     jantar pair\n\n' +
        'Caveats: the address changes every time cloudflared restarts (the Home Screen app and push stop\n' +
        'working until you pair again), and Cloudflare terminates TLS, so it can see the traffic.\n' +
        'Prefer Tailscale when you can: jantar remote setup\n',
    );
    return EXIT.ok;
  }

  const bin = await find('tailscale');
  const ts = await probeTailscale(ctx.deps.exec, bin, port);
  const cmd = shellQuote([bin ?? 'tailscale', ...tailscaleServeArgs(port)]);
  const legacy = shellQuote([bin ?? 'tailscale', ...tailscaleServeLegacyArgs(port)]);
  const off = shellQuote([bin ?? 'tailscale', ...tailscaleServeOffArgs()]);
  const steps =
    'Tailscale Serve (recommended)\n\n' +
    '1. Install Tailscale on this Mac and on your phone, and log in to the same tailnet on both.\n' +
    `2. Forward https://<this mac>.<tailnet>.ts.net/ to the daemon (tailnet only; never use Funnel):\n` +
    `     ${cmd}\n` +
    `   (older Tailscale versions: ${legacy})\n` +
    '3. Point pairing links at it:  jantar remote url https://<this mac>.<tailnet>.ts.net\n' +
    '4. Pair your phone:            jantar pair\n' +
    `To undo: ${off}\n`;

  if (!flags.apply) {
    ctx.io.out(steps);
    if (!ts.installed) ctx.io.out('\nTailscale is not installed on this Mac yet. Fallback: jantar remote setup --cloudflare\n');
    else if (!ts.running) ctx.io.out('\nTailscale is installed but not connected: open it and log in first.\n');
    else if (ts.serve?.matchesDaemon) ctx.io.out(`\nServe already forwards ${ts.serve.urls.join(', ')} to Jantar.\n`);
    else ctx.io.out(`\nTailscale is connected${ts.dnsName ? ` as ${ts.dnsName}` : ''}. "jantar remote setup --apply" runs steps 2 and 3 for you.\n`);
    return EXIT.ok;
  }

  if (!bin || !ts.installed) {
    ctx.io.err('jantar remote setup --apply: Tailscale is not installed. Install it, or use: jantar remote setup --cloudflare\n');
    return EXIT.failed;
  }
  if (!ts.running || !ts.dnsName) {
    ctx.io.err('jantar remote setup --apply: Tailscale is not connected (or has no MagicDNS name). Open it and log in first.\n');
    return EXIT.failed;
  }
  if (ts.serve?.funnel) {
    ctx.io.err('jantar remote setup --apply: Tailscale Funnel is on. Turn it off first (tailscale funnel reset); Jantar must not be public.\n');
    return EXIT.failed;
  }
  if (!ts.serve?.matchesDaemon) {
    if (ts.serve?.configured && ts.serve.urls.some((u) => u === `https://${ts.dnsName}`)) {
      ctx.io.err(
        `jantar remote setup --apply: Serve already forwards https://${ts.dnsName}/ to ${ts.serve.proxiesTo.join(', ')}.\n` +
          'Not replacing it. Change it yourself, then run: jantar remote url https://' +
          `${ts.dnsName}\n`,
      );
      return EXIT.failed;
    }
    ctx.io.out(`Running: ${cmd}\n`);
    const r = await ctx.deps.exec(bin, tailscaleServeArgs(port), { timeoutMs: 30_000 });
    if (r.code !== 0) {
      ctx.io.err(`tailscale serve failed: ${(r.spawnError ?? (r.stderr.trim() || r.stdout.trim())) || `exit ${r.code}`}\n`);
      if (/flag provided but not defined|unknown flag/i.test(`${r.stderr}${r.stdout}`)) ctx.io.err(`Older Tailscale? Try: ${legacy}\n`);
      return EXIT.failed;
    }
  } else {
    ctx.io.out(`Serve already forwards https://${ts.dnsName}/ to Jantar.\n`);
  }
  const url = `https://${ts.dnsName}`;
  const res = await setUrl(ctx, url);
  if (res !== EXIT.ok) return res;
  if (!(await daemonUp(ctx))) ctx.io.out('The daemon is not running yet: jantar install\n');
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'remote',
    summary: 'Set up phone access over Tailscale Serve (or a Cloudflare quick tunnel), or show its state.',
    usage: 'jantar remote <status|setup|url> [--cloudflare] [--apply] [URL | --clear] [--json]',
    owner: 'G',
    help:
      '  remote status              what is set up now\n' +
      '  remote setup               print the steps for Tailscale Serve (recommended)\n' +
      '  remote setup --apply       run "tailscale serve" for the daemon and update the pairing URL\n' +
      '  remote setup --cloudflare  print the steps for a Cloudflare quick tunnel (fallback)\n' +
      '  remote url https://HOST    use HOST in pairing links and accept it as an Origin\n' +
      '  remote url --clear         back to loopback-only pairing links',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1, max: 2 });
    const action = positionals[0];
    if (flags.tailscale && flags.cloudflare) throw new UsageError('--tailscale and --cloudflare exclude each other');
    switch (action) {
      case 'status':
        if (positionals.length > 1) throw new UsageError('status takes no argument');
        return status(ctx, Boolean(flags.json));
      case 'setup':
        if (positionals.length > 1) throw new UsageError('setup takes no argument');
        return setup(ctx, flags);
      case 'url': {
        const url = positionals[1];
        if (flags.clear) {
          if (url) throw new UsageError('give a URL or --clear, not both');
          return setUrl(ctx, null);
        }
        if (!url) throw new UsageError('missing URL (or --clear)');
        return setUrl(ctx, url);
      }
      default:
        throw new UsageError(`unknown action "${action}" (status, setup or url)`);
    }
  },
);
