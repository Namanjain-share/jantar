/**
 * jantar notify (v0.5.3): the Mac's alert switches. `jantar notify` shows
 * Web Push, the kinds the Mac sends, the urgent alert and the mute; `urgent
 * on|off` is Claude's 2-minute countdown alert (notify.urgent), `done on|off`
 * adds or removes "done" in notify.kinds (the phone's success tune needs
 * it), and `test [group]` sends one test push of an alert group to every
 * device (POST /v1/notify/test). WP0's stub until the alerts package lands.
 */
import { EXIT, defineCommand } from '../command.js';

export default defineCommand(
  {
    name: 'notify',
    summary: 'Show or change how the Mac alerts your phone, and send a test push.',
    usage: 'jantar notify [urgent on|off | done on|off | test [group]]',
    owner: 'WP-AL',
    stub: true,
    help:
      '  notify                  Web Push, the kinds the Mac sends, the urgent alert, the mute\n' +
      "  notify urgent on|off    an urgent push when Claude's 2-minute countdown is running\n" +
      '  notify done on|off      a push when a session finishes its turn (the success tune)\n' +
      '  notify test [group]     one test push: urgent, needs, done, care or problem (default needs)',
  },
  async (_argv, ctx) => {
    ctx.io.err('Not built yet.\n');
    return EXIT.usage;
  },
);
