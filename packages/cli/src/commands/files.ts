/**
 * jantar files: switch Files on or off at the Mac (settings files.enabled),
 * and keep the folders it may browse. The phone can never change either:
 * files.* and folders.* are Mac-only settings groups.
 *
 * Files and New session browse the same roots (folders.roots), so
 * `files roots ...` and `folders add-root | rm-root | list` are one list.
 */
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand } from '../command.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings, onOff, parseOnOff } from '../lib/switches.js';
import { addRootCommand, listRoots, removeRootCommand } from './folders.js';

const FLAGS = {
  id: { type: 'string', help: 'roots add: the root id (default: from the folder name)' },
  label: { type: 'string', help: 'roots add: the name the phone shows (default: the folder name)' },
} as const;

export default defineCommand(
  {
    name: 'files',
    summary: 'Turn Files (changed files and the read-only viewer) on or off, and keep its folders.',
    usage: 'jantar files <on|off|status|roots [add <path> [--id ID] [--label L] | remove <id>]>',
    owner: 'T2',
    help:
      '  files on                      the phone shows which files sessions changed, and opens them read-only\n' +
      '  files off                     hide Files again\n' +
      '  files status                  whether Files is on, and its roots\n' +
      '  files roots                   the folders Files may browse (live sessions\' folders are always included)\n' +
      '  files roots add <path>        add a folder (refuses /, /Users, ~/Library and protected folders)\n' +
      '  files roots remove <id>       remove one\n' +
      'The same roots serve New session: see also jantar folders.',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1, max: 3 });
    const [action, sub, arg] = positionals;
    if (action !== 'roots' && (flags.id !== undefined || flags.label !== undefined)) throw new UsageError('--id and --label are for "files roots add"');
    switch (action) {
      case 'on':
      case 'off': {
        if (positionals.length > 1) throw new UsageError(`${action} takes no argument`);
        const on = parseOnOff(action, 'files');
        await changeSettings(ctx, { files: { enabled: on } }, (s) =>
          on
            ? `Files is on. The phone lists the files sessions created or changed and opens them read-only.\n${
                s.folders.roots.length ? '' : 'It browses live sessions\' folders; add more with: jantar files roots add ~/Desktop\n'
              }`
            : 'Files is off. The phone no longer shows changed files or the viewer.\n',
        );
        return EXIT.ok;
      }
      case 'status': {
        if (positionals.length > 1) throw new UsageError('status takes no argument');
        const { settings } = await readSettings(ctx);
        ctx.io.out(`Files: ${onOff(settings.files.enabled)}\n`);
        await listRoots(ctx, settings);
        return EXIT.ok;
      }
      case 'roots':
        if (sub === undefined || sub === 'list') {
          if (arg !== undefined) throw new UsageError('roots list takes no argument');
          if (flags.id !== undefined || flags.label !== undefined) throw new UsageError('--id and --label are for "files roots add"');
          await listRoots(ctx, (await readSettings(ctx)).settings);
          return EXIT.ok;
        }
        if (sub === 'add') {
          if (arg === undefined) throw new UsageError('roots add needs a folder');
          return addRootCommand(ctx, arg, flags);
        }
        if (sub === 'remove' || sub === 'rm') {
          if (arg === undefined) throw new UsageError('roots remove needs a root id (see: jantar files roots)');
          if (flags.id !== undefined || flags.label !== undefined) throw new UsageError('--id and --label are for "files roots add"');
          return removeRootCommand(ctx, arg);
        }
        throw new UsageError(`unknown roots action "${sub}" (add, remove or list)`);
      default:
        throw new UsageError(`unknown action "${action}" (on, off, status or roots)`);
    }
  },
);
