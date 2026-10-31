/**
 * jantar controls: switch the phone's control keys, mode switching and slash
 * commands on or off (settings controls.*, Mac only; the controls addendum).
 * On by default: every key is gated (Claude in the foreground, no open
 * card, no dialog) and audited by the daemon.
 *
 * `escape` and `clear-draft` switch the two keys a real Mac tried on
 * 30 Oct 2026 (controls.escapeVerified, controls.clearVerified). They are on
 * by default since 0.4.1, but the daemon writes every setting when it saves,
 * so a config.json from 0.4.0 usually holds false for both: these turn them
 * on (or off again) without editing the file.
 */
import type { Settings } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand } from '../command.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings, onOff, parseOnOff } from '../lib/switches.js';

function escapeLine(c: Settings['controls']): string {
  return `Escape key: ${c.escapeVerified ? 'allowed' : 'refused (turn it on: jantar controls escape on)'}\n`;
}

function clearLine(c: Settings['controls']): string {
  return `Clear draft: ${c.clearVerified ? 'allowed' : 'hidden and refused (turn it on: jantar controls clear-draft on)'}\n`;
}

export default defineCommand(
  {
    name: 'controls',
    summary: 'Turn control keys, mode switching and slash commands on or off.',
    usage: 'jantar controls <on|off|status|escape on|off|clear-draft on|off>',
    owner: 'T2',
    help:
      '  controls on | off               Interrupt, the permission mode, a commands menu and Clear draft on the phone\n' +
      '  controls escape on | off        allow the Escape key (Interrupt sends it when controls.interruptKey is escape)\n' +
      '  controls clear-draft on | off   show Clear draft, which empties a draft left in Claude\'s input box\n' +
      'Escape and Clear draft were tried on a real Mac and are on by default; a config.json saved by an\n' +
      'older Jantar may hold them off.',
  },
  async (argv, ctx) => {
    const { positionals } = parseArgs(argv, {}, { min: 1, max: 2 });
    const [action, arg] = positionals;
    switch (action) {
      case 'status': {
        if (arg !== undefined) throw new UsageError('status takes no argument');
        const c = (await readSettings(ctx)).settings.controls;
        ctx.io.out(`Controls: ${onOff(c.enabled)}\n${escapeLine(c)}${clearLine(c)}`);
        return EXIT.ok;
      }
      case 'on':
      case 'off': {
        if (arg !== undefined) throw new UsageError(`${action} takes no argument`);
        const on = parseOnOff(action, 'controls');
        await changeSettings(ctx, { controls: { enabled: on } }, () =>
          on
            ? 'Controls are on. The session screen shows Interrupt, the mode chip and the commands menu.\n'
            : 'Controls are off. The phone can still send prompts and answer cards, but presses no keys.\n',
        );
        return EXIT.ok;
      }
      case 'escape': {
        const on = parseOnOff(arg, 'escape');
        await changeSettings(ctx, { controls: { escapeVerified: on } }, (s) => escapeLine(s.controls));
        return EXIT.ok;
      }
      case 'clear-draft': {
        const on = parseOnOff(arg, 'clear-draft');
        await changeSettings(ctx, { controls: { clearVerified: on } }, (s) => clearLine(s.controls));
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown action "${action}" (on, off, status, escape or clear-draft)`);
    }
  },
);
