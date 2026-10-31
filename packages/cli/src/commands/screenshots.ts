/**
 * jantar screenshots: switch terminal screenshots on or off (settings
 * screenshots.*, Mac only; off by default, since a screen can show secrets),
 * and whether a screenshot may briefly select a background tab to capture
 * it (allowSelect: the tab flickers on the Mac).
 */
import type { Settings } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand } from '../command.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings, onOff, parseOnOff } from '../lib/switches.js';

function selectLine(s: Settings['screenshots']): string {
  return s.allowSelect
    ? 'Background tabs: selected for a moment to capture them (the tab flickers on the Mac).\n'
    : 'Background tabs: not selected; the phone shows their text instead.\n';
}

export default defineCommand(
  {
    name: 'screenshots',
    summary: 'Turn terminal screenshots on or off, and allow capturing background tabs.',
    usage: 'jantar screenshots <on|off|status|allow-select [on|off]>',
    owner: 'T2',
    help:
      '  screenshots on | off            a Picture view of the session\'s Terminal window on the phone\n' +
      '  screenshots allow-select [on]   capture a tab that is not in front by selecting it for a moment\n' +
      '  screenshots allow-select off    never switch tabs for a picture\n' +
      'A screenshot shows whatever the window shows, secrets included. macOS may ask to allow Screen Recording.',
  },
  async (argv, ctx) => {
    const { positionals } = parseArgs(argv, {}, { min: 1, max: 2 });
    const [action, arg] = positionals;
    switch (action) {
      case 'on':
      case 'off': {
        if (arg !== undefined) throw new UsageError(`${action} takes no argument`);
        const on = parseOnOff(action, 'screenshots');
        await changeSettings(ctx, { screenshots: { enabled: on } }, (s) =>
          on
            ? `Screenshots are on. The session's Screen tab gains a Picture view.\n${selectLine(s.screenshots)}`
            : 'Screenshots are off. The Screen tab shows text only.\n',
        );
        return EXIT.ok;
      }
      case 'status': {
        if (arg !== undefined) throw new UsageError('status takes no argument');
        const s = (await readSettings(ctx)).settings.screenshots;
        ctx.io.out(`Screenshots: ${onOff(s.enabled)} (long edge ${s.maxEdge} px)\n${selectLine(s)}`);
        return EXIT.ok;
      }
      case 'allow-select': {
        const on = arg === undefined ? true : parseOnOff(arg, 'allow-select');
        await changeSettings(ctx, { screenshots: { allowSelect: on } }, (s) =>
          `${selectLine(s.screenshots)}${s.screenshots.enabled ? '' : 'Screenshots themselves are off: jantar screenshots on\n'}`,
        );
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown action "${action}" (on, off, status or allow-select)`);
    }
  },
);
