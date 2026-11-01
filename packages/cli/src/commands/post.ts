/**
 * jantar post (v0.7): add a post to make and list them, over ctl.sock, so
 * scripts and Claude sessions on this Mac can load posts (at most 30 adds
 * an hour from here). Jantar never posts anything: the phone rings at the
 * time, copies the text, opens the link, and counts what is marked Posted.
 * Marking posted, skipping, editing, deleting and the weekly goals are the
 * phone's; ctl.sock has no route for them.
 *
 * Wave 0's shell until lane A builds it (pattern: commands/intel.ts, `add`
 * and `list`, `only()` refusing another action's flags): the usage and help
 * are final, a run says "Not built yet."
 */
import { POST_KINDS, POST_PLATFORMS } from '@jantar/protocol';
import { EXIT, defineCommand } from '../command.js';

export default defineCommand(
  {
    name: 'post',
    summary: 'Add a social post to make (it rings at its time on the phone), and list them. Jantar never posts.',
    usage: 'jantar post <add --platform <p> [options]|list [--done] [--json]>',
    owner: 'WP-POSTS',
    stub: true,
    help:
      '  post add --platform <p> [--where <w>] [--kind <k>] [--at "YYYY-MM-DD HH:MM" | --at YYYY-MM-DD]\n' +
      '           [--title <t>] [--text-file <path> | --text <t>] [--notes <n>] [--link <https url>]\n' +
      '           [--status idea|ready]\n' +
      '                                 add a post to make; a day and a time ring on the phone (a day alone does not)\n' +
      '  post list [--done] [--json]    this week against the goals, then the posts to make (--done: posted and skipped)\n' +
      `Platforms: ${POST_PLATFORMS.join(', ')}. Kinds: ${POST_KINDS.join(', ')}.\n` +
      'Posted, Skip, editing, deleting and the weekly goals are on the phone. Turn Posts on: jantar life on posts',
  },
  async (_argv, ctx) => {
    ctx.io.err('Not built yet.\n');
    return EXIT.usage;
  },
);
