/**
 * jantar chat (v0.10, replaces `jantar ask`): Chat at the Mac (setting group
 * `ask`, Mac only; the switch keeps its name so a 0.9 daemon keeps it).
 *
 *   chat on | off | status
 *   chat clear [--broken] [--yes]      asks y/N on a terminal
 *   chat keep <days>                   1-365
 *   chat voice-model <opus|sonnet|haiku>
 *   chat shortcut add | list | revoke | steps   (the Siri door's keys)
 *
 * Chat is a page on the phone: what the user types, and the photos they
 * send, go to one isolated headless Claude run with Jantar's own tools,
 * which adds and changes things at once (each with Undo) and never deletes
 * without the user's tap; sessions are read only. History stays on the Mac
 * in chat.db for `ask.keepDays` days.
 */
import { CHAT_PAGE, RewriteModelSchema, ROUTES, type ChatStatus, type Settings } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { CtlUnavailableError, callDaemon } from '../ctl.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings, onOff, parseOnOff } from '../lib/switches.js';
import { clip, plural } from '../lib/text.js';
import { CHAT_SHORTCUT_HELP, doorLine, runChatShortcut } from './chat-shortcut.js';

/** What goes to Claude and what stays (spec 0.10 B2), as the phone's empty thread and the docs say it. */
export function chatDataFlow(s: Settings): string {
  return (
    `What you type and the photos you send go to Claude through Claude Code on your account (model ${s.rewrite.model}; by voice ${s.ask.voiceModel}), ` +
    'with the date, time and zone, the last messages of this chat, and whatever Chat looks up to answer: your todos, medicines, food, cafés, money, ' +
    'posts, Intel shelf, meetings, and your sessions, waiting prompts and usage (read only), for the parts that are on.\n' +
    'Chat adds and changes things at once and shows each change with Undo; it never deletes without your tap, and never types into a session.\n' +
    `History stays on this Mac in chat.db for ${s.ask.keepDays} days (jantar chat keep <days>); jantar chat clear deletes it.\n`
  );
}

/** With nothing Chat can look into but sessions, a hint. */
function partsHint(s: Settings): string {
  const l = s.life;
  const any = l.todos || l.food || l.finance || l.medicines || l.posts || l.places || s.intel.enabled || s.meetings.enabled;
  return any ? '' : 'Chat can read your sessions now. For more, turn a part on: jantar life on todos (or intel on, meetings on)\n';
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function status(ctx: CliContext): Promise<void> {
  const s = (await readSettings(ctx)).settings;
  const io = ctx.io;
  io.out(`Chat: ${onOff(s.ask.enabled)}\n`);
  io.out(`Model: ${s.rewrite.model} (Rewrite's model; jantar rewrite model <m>); by voice ${s.ask.voiceModel} (jantar chat voice-model <m>)\n`);
  io.out(`History: kept ${plural(s.ask.keepDays, 'day')} (jantar chat keep <days>)\n`);
  try {
    const st = await callDaemon<ChatStatus>(ctx.ctl, 'GET', ROUTES.chatStatus.path);
    if (st.broken) io.out(`chat.db: ${st.broken}\n`);
    else io.out(`On disk: ${plural(st.turns, 'message')}, ${plural(st.photos, 'photo')} (${size(st.bytes)})\n`);
  } catch (e) {
    if (!(e instanceof CtlUnavailableError)) throw e;
    io.out("On disk: the daemon isn't running.\n");
  }
  io.out(await doorLine(ctx, s));
}

async function clear(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags, positionals } = parseArgs(argv, { broken: { type: 'boolean', help: 'move a chat.db that will not open aside' }, yes: { type: 'boolean', help: 'do not ask' } }, { max: 0 });
  if (positionals.length) throw new UsageError('clear takes no argument');
  if (!flags.yes) {
    if (!ctx.io.ask) throw new UsageError('clear deletes the whole chat: run it in a terminal, or add --yes');
    const q = flags.broken ? 'Move chat.db aside and start a new one? [y/N] ' : 'Clear chat? Its messages, photos and Undo go; what it added stays. [y/N] ';
    const answer = (await ctx.io.ask(q)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      ctx.io.out('Nothing cleared.\n');
      return EXIT.ok;
    }
  }
  await callDaemon(ctx.ctl, 'DELETE', `${ROUTES.chatClear.path}${flags.broken ? '?broken=1' : ''}`);
  ctx.io.out(flags.broken ? 'chat.db moved aside; Chat starts a new history. The old file is beside it (chat.db.broken-<day>).\n' : 'Chat cleared. What it added stays in Life, Intel and Meetings.\n');
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'chat',
    summary: 'Turn Chat (ask Jantar anything; it changes things with Undo) on or off, and manage its history and Siri keys.',
    usage: 'jantar chat <on|off|status|clear|keep|voice-model|shortcut>',
    owner: 'WP-CHAT',
    help:
      '  chat on            show Chat on the phone (says what goes to Claude)\n' +
      '  chat off           hide it and stop any answer being written (history stays until clear)\n' +
      '  chat status        the switch, the models, the history on disk, the Siri door and its keys\n' +
      '  chat clear [--broken] [--yes]\n' +
      '                     delete the history (what it added stays); --broken moves an unreadable chat.db aside\n' +
      '  chat keep <days>   how long history is kept, 1 to 365 (default 30)\n' +
      '  chat voice-model <opus|sonnet|haiku>\n' +
      '                     the model a Siri question runs on (default sonnet)\n' +
      CHAT_SHORTCUT_HELP +
      `Chat runs one headless claude per message on an account with room (never accounts kept or held for other work); the phone shows ${CHAT_PAGE} messages a page.`,
  },
  async (argv, ctx) => {
    const [action, ...rest] = argv;
    switch (action) {
      case 'on':
      case 'off': {
        if (rest.length) throw new UsageError(`${action} takes no argument`);
        const on = parseOnOff(action, 'chat');
        await changeSettings(ctx, { ask: { enabled: on } }, (s) =>
          on ? `Chat is on. The phone shows Chat.\n${chatDataFlow(s)}${partsHint(s)}` : 'Chat is off: the phone hides it and the Siri door closes. Its history stays until jantar chat clear; what it added stays in Life.\n',
        );
        return EXIT.ok;
      }
      case 'status':
        if (rest.length) throw new UsageError('status takes no argument');
        await status(ctx);
        return EXIT.ok;
      case 'clear':
        return clear(rest, ctx);
      case 'keep': {
        const { positionals } = parseArgs(rest, {}, { min: 1, max: 1 });
        const days = Number(positionals[0]);
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new UsageError('keep takes a number of days from 1 to 365');
        await changeSettings(ctx, { ask: { keepDays: days } }, (s) => `Chat keeps its history ${plural(s.ask.keepDays, 'day')}.\n`);
        return EXIT.ok;
      }
      case 'voice-model': {
        const { positionals } = parseArgs(rest, {}, { min: 1, max: 1 });
        const m = RewriteModelSchema.safeParse(positionals[0]);
        if (!m.success) throw new UsageError('voice-model is opus, sonnet or haiku');
        await changeSettings(ctx, { ask: { voiceModel: m.data } }, (s) => `Siri questions run on ${s.ask.voiceModel}.\n`);
        return EXIT.ok;
      }
      case 'shortcut':
        return runChatShortcut(rest, ctx);
      default:
        throw new UsageError(action === undefined ? 'chat needs an action: on, off, status, clear, keep, voice-model or shortcut' : `unknown action "${clip(action, 20)}" (on, off, status, clear, keep, voice-model or shortcut)`);
    }
  },
);
