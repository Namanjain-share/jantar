/**
 * jantar ask: switch Ask on or off at the Mac (setting ask.enabled, Mac
 * only, v0.5.3).
 *
 * Ask is a chat page on the phone. What the user types goes to one isolated
 * headless Claude run on Rewrite's model, which only proposes todos,
 * reminders, food, money and posts as cards; nothing is added until the
 * user taps Add. Its history lives in the daemon's memory only, so `off`
 * (and a restart) forgets it; items already added stay in Life.
 */
import { ASK_SENTENCES } from '@jantar/daemon/ask/answer';
import { ASK_KEEP_DAYS, ASK_TURNS_KEPT, type Settings } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand } from '../command.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings, onOff, parseOnOff } from '../lib/switches.js';
import { clip } from '../lib/text.js';

/** What goes to Claude and what stays, as the phone's page and the docs say it. */
function dataFlow(s: Settings): string {
  return (
    'Only what you type there goes to Claude (medicine names or amounts you type do go), with the date, time and time zone, ' +
    'which Life parts are on, the currency code and the fixed category names, ' +
    `through Claude Code on your account (model ${s.rewrite.model}, as Rewrite).\n` +
    'Your saved lists, medicines and money stay on this Mac. Nothing is added until you tap Add.\n' +
    `The last ${ASK_TURNS_KEPT} messages per phone stay in memory for up to ${ASK_KEEP_DAYS} days; a restart forgets them.\n`
  );
}

/** Ask suggests todos, food, money and posts, and shows medicines: with none of them on, it has nothing to do (the daemon's own sentence). */
function lifeHint(s: Settings): string {
  const l = s.life;
  return l.todos || l.food || l.finance || l.medicines || l.posts ? '' : `${ASK_SENTENCES.noModules}\n`;
}

function modelLine(s: Settings): string {
  return `Model: ${s.rewrite.model} (Rewrite's model; change it with jantar rewrite model <m>)\n`;
}

export default defineCommand(
  {
    name: 'ask',
    summary: 'Turn Ask (a chat page that suggests todos, reminders, food, money and posts) on or off.',
    usage: 'jantar ask <on|off|status>',
    owner: 'WP-ASK',
    help:
      '  ask on       show Ask on the phone (says what goes to Claude)\n' +
      "  ask off      hide it, stop any answer being written, and forget Ask's history\n" +
      "  ask status   the switch and the model (Rewrite's: jantar rewrite model <m>)\n" +
      'Ask runs one headless claude per message on an account with room (never accounts kept or held for other work).',
  },
  async (argv, ctx) => {
    const { positionals } = parseArgs(argv, {}, { min: 1 });
    const [action, extra] = positionals;
    switch (action) {
      case 'on':
      case 'off': {
        if (extra !== undefined) throw new UsageError(`${action} takes no argument`);
        const on = parseOnOff(action, 'ask');
        await changeSettings(ctx, { ask: { enabled: on } }, (s) =>
          on ? `Ask is on. The phone shows Ask.\n${dataFlow(s)}${lifeHint(s)}` : 'Ask is off. Its history is forgotten; items you added stay in Life.\n',
        );
        return EXIT.ok;
      }
      case 'status': {
        if (extra !== undefined) throw new UsageError('status takes no argument');
        const s = (await readSettings(ctx)).settings;
        ctx.io.out(`Ask: ${onOff(s.ask.enabled)}\n${modelLine(s)}`);
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown action "${clip(action ?? '', 20)}" (on, off or status)`);
    }
  },
);
