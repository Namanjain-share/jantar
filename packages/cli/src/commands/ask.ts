/**
 * jantar ask (v0.5.3 to 0.9): Ask is now Chat. `jantar ask <...>` says so on
 * stderr and runs `jantar chat <...>` (spec 0.10 B12).
 */
import { defineCommand } from '../command.js';
import chat from './chat.js';

export default defineCommand(
  {
    name: 'ask',
    summary: 'Ask is now Chat: runs jantar chat.',
    usage: 'jantar ask <on|off|status|...>',
    owner: 'WP-CHAT',
    help: '  Ask is now Chat. Every action runs as jantar chat <action> (see jantar chat --help).',
  },
  async (argv, ctx) => {
    ctx.io.err(`Ask is now Chat: jantar chat ${argv.join(' ')}`.trimEnd() + '\n');
    return chat.run(argv, ctx);
  },
);
