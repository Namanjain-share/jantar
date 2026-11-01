/**
 * v0.5.3 alerts: `notifyTest` (POST /v1/notify/test, admin, the Mac only:
 * over TCP the pipeline refuses it before a handler runs), one test push of
 * an alert group to every device (jantar notify test [group]).
 *
 * - The group's kind (format.ts TEST_KIND): urgent and needs are
 *   `permission` (urgent with a deadline two minutes ahead, so its payload's
 *   group is `urgent`), done is `done`, care `life`, problem `send-failed`.
 * - Web Push only, through notify/direct.ts with `ignoreMute`: a test asked
 *   for at the Mac skips `notify.kinds` and the mute. `notify.webpush` off
 *   still sends nothing, and each device's own kinds still apply, so a
 *   device that turned Done off gets no Done test.
 * - The answer is the counts only; the audit row names the group.
 */
import type { NotifyTestBody, NotifyTestResponse } from '@jantar/protocol';
import { sendDirect } from '../../notify/direct.js';
import { testNotification } from '../../notify/format.js';
import type { Call, RouteTable } from '../route-kit.js';

export const NOTIFY_ROUTE_IMPLS: RouteTable = {
  notifyTest: {
    handle: async (c: Call<Record<string, string>, unknown, NotifyTestBody>, s): Promise<NotifyTestResponse> => {
      const webpush = s.deps.notifiers.filter((n) => n.channel === 'webpush');
      const r = await sendDirect(s.ctx, webpush, testNotification(c.body.group, s.ctx.clock.iso()), { ignoreMute: true });
      return { delivered: r.delivered, failed: r.failed };
    },
    audit: (c: Call<Record<string, string>, unknown, NotifyTestBody>) => ({ target: c.body.group }),
  },
};
