/**
 * jantar send <session> <text>: queue a prompt with the daemon's writer and
 * wait until the transcript proves Claude received it. The CLI never types
 * anything itself; it only reports what the daemon's send-with-proof did,
 * and it is loud when a prompt was not sent.
 */
import {
  ROUTES,
  SEND_FINAL_STAGES,
  buildPath,
  type PromptAccepted,
  type SendJob,
  type SendJobResponse,
  type SessionsResponse,
} from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand } from '../command.js';
import { DaemonError, callDaemon } from '../ctl.js';
import { resolveSession } from '../lib/sessions.js';
import { clip } from '../lib/text.js';

const FLAGS = {
  replace: { type: 'boolean', help: 'replace a draft in the input box (tmux sessions only) instead of refusing' },
  wait: { type: 'boolean', help: 'wait for the transcript proof (default; --no-wait returns once queued)' },
  timeout: { type: 'number', help: 'seconds to wait for the proof (default 60)' },
  json: { type: 'boolean', help: 'print the final job as JSON' },
} as const;

const POLL_MS = 500;
const MAX_TEXT = 16_000;

function isFinal(job: SendJob): boolean {
  return SEND_FINAL_STAGES.includes(job.stage);
}

export default defineCommand(
  {
    name: 'send',
    summary: 'Send a prompt to a session and wait until the transcript proves it arrived.',
    usage: 'jantar send <session> <text...|-> [--replace] [--no-wait] [--timeout S] [--json]',
    owner: 'G',
    help:
      '<session> is a session id, a unique id prefix (4+ characters), or a unique session or folder name.\n' +
      'Use "-" as the text to read it from stdin, and "--" before text that starts with a dash.\n' +
      'Exit status: 0 proven, 1 not sent (refused, failed or not proven in time), 3 daemon not running.',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 2 });
    const [query, ...words] = positionals as [string, ...string[]];
    let text = words.join(' ');
    if (words.length === 1 && words[0] === '-') {
      if (!ctx.io.readStdin) throw new UsageError('cannot read stdin here');
      text = (await ctx.io.readStdin()).replace(/\r?\n$/, '');
    }
    if (!text.trim()) throw new UsageError('the prompt is empty');
    if (text.length > MAX_TEXT) throw new UsageError(`the prompt is longer than ${MAX_TEXT} characters`);
    const timeoutS = flags.timeout ?? 60;
    if (timeoutS <= 0) throw new UsageError('--timeout must be positive');

    const { sessions } = await callDaemon<SessionsResponse>(ctx.ctl, 'GET', ROUTES.listSessions.path);
    const match = resolveSession(sessions, query);
    if (!match.ok) {
      if (match.reason === 'ambiguous') {
        ctx.io.err(
          `jantar send: "${clip(query, 40)}" matches ${match.candidates.length} sessions:\n${match.candidates
            .map((s) => `  ${s.sid}  ${clip(s.folder, 30)} · ${clip(s.name ?? '', 40)}`)
            .join('\n')}\nUse more of the session id.\n`,
        );
        return EXIT.usage;
      }
      ctx.io.err(`jantar send: no live session matches "${clip(query, 40)}" (see: jantar status)\n`);
      return EXIT.failed;
    }
    const session = match.session;
    const label = `${session.folder} · ${clip(session.name ?? session.sid.slice(0, 8), 40)}`;

    let accepted: PromptAccepted;
    try {
      accepted = await callDaemon<PromptAccepted>(
        ctx.ctl,
        'POST',
        buildPath(ROUTES.sendPrompt, { sid: session.sid }),
        { text, onDraft: flags.replace ? 'replace' : 'refuse' },
        { idempotencyKey: ctx.deps.randomId(), timeoutMs: 30_000 },
      );
    } catch (e) {
      if (e instanceof DaemonError) {
        ctx.io.err(`Prompt NOT sent · ${label}: ${e.message}\n`);
        return EXIT.failed;
      }
      throw e;
    }

    let job = accepted.job;
    const report = (j: SendJob) => ctx.io.err(`  ${j.stage}${j.reason ? `: ${clip(j.reason, 120)}` : ''}\n`);
    ctx.io.err(`Sending to ${label} (job ${accepted.jobId})\n`);
    report(job);
    if (flags.wait === false && !isFinal(job)) {
      if (flags.json) ctx.io.out(`${JSON.stringify({ job }, null, 2)}\n`);
      ctx.io.err(`Queued. Follow it with: jantar status\n`);
      return EXIT.ok;
    }

    const deadline = ctx.deps.now() + timeoutS * 1000;
    while (!isFinal(job) && ctx.deps.now() < deadline) {
      await ctx.deps.sleep(POLL_MS);
      let next: SendJob;
      try {
        next = (await callDaemon<SendJobResponse>(ctx.ctl, 'GET', buildPath(ROUTES.getSend, { jobId: accepted.jobId }))).job;
      } catch (e) {
        if (e instanceof DaemonError && e.status === 404) continue;
        throw e;
      }
      if (next.stage !== job.stage || next.reason !== job.reason) report(next);
      job = next;
    }

    if (flags.json) ctx.io.out(`${JSON.stringify({ job }, null, 2)}\n`);
    if (job.stage === 'proven' || job.stage === 'proven-merged') {
      const merged = job.stage === 'proven-merged' ? ' (Claude recorded extra text in front of it: check the session)' : '';
      ctx.io.out(`Prompt sent · ${label}: proven by the transcript${job.proof ? ` (${job.proof.kind} at ${job.proof.at})` : ''}${merged}\n`);
      return EXIT.ok;
    }
    if (isFinal(job)) {
      ctx.io.err(`Prompt NOT sent · ${label}: ${job.stage}${job.reason ? ` (${clip(job.reason, 200)})` : ''}\n`);
      return EXIT.failed;
    }
    ctx.io.err(
      `Prompt NOT proven yet · ${label}: still "${job.stage}" after ${timeoutS}s. The daemon keeps trying and alerts if it gives up (job ${accepted.jobId}).\n`,
    );
    return EXIT.failed;
  },
);
