/**
 * jantar notify (v0.5.3): the Mac's alert switches.
 *
 * - `jantar notify` shows Web Push, the kinds the Mac sends, the urgent
 *   alert and the mute.
 * - `urgent on|off`: the urgent push when Claude's 2-minute auto-block
 *   countdown is on an unattended ask (notify.urgent, default on).
 * - `done on|off` adds or removes "done" in notify.kinds: a push when a
 *   session finishes its turn, which the phone plays as its success tune.
 * - `test [group]`: one test push of an alert group (default needs) to
 *   every device, through the daemon (POST /v1/notify/test, ctl.sock only).
 *   It skips notify.kinds and the mute; each device's own kinds still apply.
 *
 * Switches go through the daemon over ctl.sock (with the daemon down they
 * land in config.json, lib/settings.ts), like `jantar life set`.
 */
import { ALERT_GROUPS, AlertGroupSchema, ROUTES, type AlertGroup, type NotifyTestResponse, type Settings } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings, onOff, parseOnOff } from '../lib/switches.js';
import { duration, plural } from '../lib/text.js';

type Notify = Settings['notify'];

function kindsLine(n: Notify): string {
  const kinds = n.kinds.length ? n.kinds.join(', ') : 'none';
  return `Kinds the Mac sends: ${kinds}${n.kinds.includes('done') ? '' : ' (Done is off: jantar notify done on)'}\n`;
}

function urgentLine(n: Notify): string {
  // The urgent alert goes out as a permission push, so the kinds must hold permission.
  const blocked = n.urgent && !n.kinds.includes('permission') ? ' (it goes out as a permission push, and permission is not in the kinds)' : '';
  return `Urgent alert for Claude's 2-minute countdown: ${onOff(n.urgent)}${blocked}\n`;
}

function mutedLine(n: Notify, now: number): string {
  const until = n.muted_until ? Date.parse(n.muted_until) : NaN;
  if (!Number.isFinite(until) || until <= now) return 'Muted: no\n';
  return `Muted: yes, for ${duration(until - now)} more (medicines and failed sends still come)\n`;
}

async function status(ctx: CliContext): Promise<number> {
  const { settings, source } = await readSettings(ctx);
  const n = settings.notify;
  if (source !== 'daemon') ctx.io.out(`jantard is not running; from ${ctx.paths.configFile}:\n`);
  ctx.io.out(`Web Push to devices: ${onOff(n.webpush)}\n${kindsLine(n)}${urgentLine(n)}${mutedLine(n, ctx.deps.now())}`);
  return EXIT.ok;
}

async function urgent(ctx: CliContext, on: boolean): Promise<number> {
  await changeSettings(ctx, { notify: { urgent: on } }, (s) =>
    s.notify.urgent
      ? "Urgent alert: on. When Claude's 2-minute countdown runs on an ask nobody answers, your phone gets \"about 2 min to answer\", and once more with about a minute left.\n"
      : 'Urgent alert: off. Such an ask gets the plain "needs you" push.\n',
  );
  return EXIT.ok;
}

async function done(ctx: CliContext, on: boolean): Promise<number> {
  const { settings } = await readSettings(ctx);
  const have = settings.notify.kinds;
  const words = (s: Settings) =>
    (s.notify.kinds.includes('done')
      ? 'Done: on. Your phone gets a push when a session finishes its turn (the success tune plays while Jantar is open).\n'
      : 'Done: off. No push when a session finishes its turn.\n') + kindsLine(s.notify);
  if (have.includes('done') === on) {
    ctx.io.out(words(settings));
    return EXIT.ok;
  }
  const kinds = on ? [...have, 'done'] : have.filter((k) => k !== 'done');
  await changeSettings(ctx, { notify: { kinds } }, words);
  return EXIT.ok;
}

async function test(ctx: CliContext, word: string | undefined): Promise<number> {
  const parsed = AlertGroupSchema.safeParse(word ?? 'needs');
  if (!parsed.success) throw new UsageError(`unknown group "${word}" (${ALERT_GROUPS.join(', ')})`);
  const group: AlertGroup = parsed.data;
  const r = await callDaemon<NotifyTestResponse>(ctx.ctl, 'POST', ROUTES.notifyTest.path, { group }, { idempotencyKey: ctx.deps.randomId() });
  const failed = r.failed > 0 ? ` ${plural(r.failed, 'push', 'pushes')} failed (the daemon log says why).` : '';
  if (r.delivered === 0) {
    ctx.io.out(`No device got it. A device that turned this kind off in Devices › Notifications gets no test.${failed}\n`);
    return EXIT.failed;
  }
  ctx.io.out(`Sent to ${plural(r.delivered, 'device')}.${failed}\n`);
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'notify',
    summary: 'Show or change how the Mac alerts your phone, and send a test push.',
    usage: 'jantar notify [urgent on|off | done on|off | test [group]]',
    owner: 'WP-AL',
    help:
      '  notify                  Web Push, the kinds the Mac sends, the urgent alert, the mute\n' +
      "  notify urgent on|off    an urgent push when Claude's 2-minute countdown is running\n" +
      '  notify done on|off      a push when a session finishes its turn (the success tune)\n' +
      `  notify test [group]     one test push: ${ALERT_GROUPS.join(', ')} (default needs)\n` +
      'A test push skips the kinds above and the mute; each device keeps its own kinds.',
  },
  async (argv, ctx) => {
    const { positionals } = parseArgs(argv, {});
    const [action, ...rest] = positionals;
    switch (action) {
      case undefined:
      case 'status':
        if (rest.length) throw new UsageError('status takes no argument');
        return status(ctx);
      case 'urgent':
      case 'done':
        if (rest.length > 1) throw new UsageError(`unexpected argument "${rest[1]}"`);
        return (action === 'urgent' ? urgent : done)(ctx, parseOnOff(rest[0], action));
      case 'test':
        if (rest.length > 1) throw new UsageError(`unexpected argument "${rest[1]}"`);
        return test(ctx, rest[0]);
      default:
        throw new UsageError(`unknown action "${action}" (urgent, done or test)`);
    }
  },
);
