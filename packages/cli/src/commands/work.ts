/**
 * jantar work (v0.13): the Mac-only switch of Work, a Life module (settings
 * life.work; a phone can never change it). Work's projects and follow-ups
 * are todos, so `work on` turns Todos on too and says so; `work off` leaves
 * Todos as it is. `jantar life off todos` turns Work off with it.
 *
 * Switches go through the daemon over ctl.sock (with the daemon down they
 * land in config.json, lib/settings.ts).
 */
import { workOn, type Settings } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand } from '../command.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings } from '../lib/switches.js';

/** The status line: on, off, or on but waiting for Todos (a config.json edited by hand). */
export function workLine(s: Pick<Settings, 'life'>): string {
  if (workOn(s)) return 'Work: on (projects as a hub, and one search across Jantar on the phone)\n';
  if (s.life.work) return 'Work: off, because Todos is off (jantar work on turns both on)\n';
  return 'Work: off (turn it on: jantar work on)\n';
}

/** What `work on` says when Todos came on with it. */
export const TODOS_TOO = "Todos is on too: Work's projects and follow-ups are todos.\n";

export default defineCommand(
  {
    name: 'work',
    summary: 'Turn Work (projects as a hub, search on the phone) on or off.',
    usage: 'jantar work <on|off|status>',
    owner: 'WP-WORK',
    help:
      '  work on        the phone shows Work: each project as one screen, and search from every screen (turns Todos on too)\n' +
      "  work off       hide Work again (Todos stays as it is; nothing is deleted)\n" +
      '  work status    whether Work is on\n' +
      'The switch changes only here, at the Mac.',
  },
  async (argv, ctx) => {
    const { positionals } = parseArgs(argv, {}, { min: 1, max: 1 });
    const [action] = positionals;
    switch (action) {
      case 'on': {
        const before = (await readSettings(ctx)).settings;
        await changeSettings(ctx, { life: { work: true, todos: true } }, (s) => `${workLine(s)}${before.life.todos ? '' : TODOS_TOO}`);
        return EXIT.ok;
      }
      case 'off':
        await changeSettings(ctx, { life: { work: false } }, (s) => `${workLine(s)}Its projects stay in Todos.\n`);
        return EXIT.ok;
      case 'status': {
        const { settings } = await readSettings(ctx);
        ctx.io.out(workLine(settings));
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown action "${action}" (on, off or status)`);
    }
  },
);
