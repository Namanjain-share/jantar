/**
 * What a launch tells the world besides launch.progress: a push to every
 * device for each start, dialog and failure (kind "launch", which web push
 * delivers whatever kinds a device chose, so a start from a stolen phone is
 * seen on the others), and audit rows that carry hashes, ids and paths but
 * never prompt or screen text.
 *
 *   session.launch         one row per launch, at its final stage
 *   session.launch.answer  one row per dialog answer (auto or from a card)
 */
import { basename } from 'node:path';
import type { AuditEntry, LaunchJob, LaunchStage } from '@jantar/protocol';
import type { DaemonContext, Notification, Notifier } from '../contracts.js';
import { GENERIC_TITLE, acct, clip, oneLine, titled } from '../notify/format.js';

export type LaunchPushKind = 'started' | 'dialog' | 'failed' | 'prompt';

/** Who started it, as the push says it ("from Kitchen iPad"). */
function starter(ctx: DaemonContext, actor: string): string {
  if (actor === 'cli') return 'from the Mac';
  const id = actor.startsWith('device:') ? actor.slice('device:'.length) : null;
  const name = id ? ctx.db.devices.get(id)?.name : undefined;
  return name ? `from ${oneLine(name)}` : '';
}

export function launchNotification(ctx: DaemonContext, job: LaunchJob, kind: LaunchPushKind, detail: string): Notification {
  const bodies = ctx.settings.get().notify.bodies;
  const folder = basename(job.folder) || job.display;
  const base = { kind: 'launch' as const, tag: `launch:${job.id}`, url: `/new?launch=${encodeURIComponent(job.id)}`, ts: ctx.clock.iso() };
  if (bodies === 'generic') return { ...base, title: GENERIC_TITLE.launch, body: '' };
  const on = acct(job.actualAccount ?? job.account);
  switch (kind) {
    case 'started': {
      const by = starter(ctx, job.actor);
      return { ...base, title: titled(folder, ' started'), body: bodies === 'short' ? 'Start' : `Start · ${job.name} on ${on}${by ? ` · ${by}` : ''}` };
    }
    case 'dialog':
      return { ...base, title: titled(folder, ' needs you'), body: bodies === 'short' ? 'Start · needs you' : `Start · ${clip(oneLine(detail), 200)}` };
    case 'failed':
      return { ...base, title: titled(folder, " didn't start"), body: bodies === 'short' ? 'Start failed' : `Start failed · ${clip(oneLine(detail), 300)}` };
    case 'prompt':
      return { ...base, title: titled(folder, ' started'), body: bodies === 'short' ? 'First prompt not sent' : `First prompt not sent · ${clip(oneLine(detail), 300)}` };
  }
}

/** Send to every notifier: web push always (launch pushes are locked on); Mac and Telegram when their switch is on. */
export async function pushLaunch(ctx: DaemonContext, notifiers: readonly Notifier[], n: Notification): Promise<void> {
  const s = ctx.settings.get().notify;
  await Promise.all(
    notifiers
      .filter((x) => x.channel === 'webpush' || (x.channel === 'mac' ? s.mac : s.telegram))
      .map(async (x) => {
        try {
          const r = await x.send(n);
          ctx.log.info('launch push sent', { channel: x.channel, ...r });
        } catch (e) {
          ctx.log.error('launch push failed', { channel: x.channel, error: String(e) });
        }
      }),
  );
}

function auditResult(stage: LaunchStage): AuditEntry['result'] {
  if (stage === 'done' || stage === 'done-no-prompt') return 'ok';
  if (stage === 'refused') return 'refused';
  return 'failed';
}

function append(ctx: DaemonContext, entry: Omit<AuditEntry, 'seq'>): void {
  try {
    ctx.db.audit.append(entry);
  } catch (e) {
    ctx.log.error('audit write failed', { action: entry.action, error: String(e) });
  }
}

/** The launch's one audit row, at its final stage. */
export function auditLaunch(ctx: DaemonContext, job: LaunchJob): void {
  const params: Record<string, unknown> = {
    launchId: job.id,
    folder: job.folder,
    rootId: job.rootId,
    account: job.account,
    accountSource: job.accountSource,
    requested: job.requested,
    flags: job.flags,
    dangerous: job.dangerous,
    name: job.name,
    sid: job.sid,
    stage: job.stage,
  };
  if (job.actualAccount != null) params.actualAccount = job.actualAccount;
  // A resumed conversation: its id is `sid`; its first line is never here.
  if (job.resumed) params.resumed = true;
  if (job.tty) params.tty = job.tty;
  if (job.reason) params.reason = job.reason;
  if (job.prompt) {
    params.promptHash = job.prompt.hash;
    params.promptLength = job.prompt.length;
    if (job.prompt.sendJobId) params.sendJobId = job.prompt.sendJobId;
  }
  const entry: Omit<AuditEntry, 'seq'> = { ts: ctx.clock.iso(), actor: job.actor, action: 'session.launch', target: job.id, params, result: auditResult(job.stage) };
  if (job.reason) entry.detail = job.reason.slice(0, 500);
  append(ctx, entry);
}

/** One dialog answer: who (a device, or the daemon itself for an auto answer), which dialog, which option. */
export function auditAnswer(ctx: DaemonContext, actor: string, job: LaunchJob, title: string, option: number, auto: boolean): void {
  append(ctx, {
    ts: ctx.clock.iso(),
    actor,
    action: 'session.launch.answer',
    target: job.id,
    params: { launchId: job.id, title, option, auto },
    result: 'ok',
  });
}
