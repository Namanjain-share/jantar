/**
 * The launch receipt (spec 5.3.4): the start sheet (phone) or the detail
 * pane (desktop) turns into it once the hold commits, and a Board ghost row
 * opens it while a launch runs.
 *
 *   14:02:11  Opened a window   ttys014
 *   14:02:13  Started on 07     cs 7
 *   14:02:31  Claude asks       Trust this folder?
 *   [dialog card: needs you]
 *   14:02:40  Ready
 *   14:02:43  First prompt      delivered 14:02 ✓
 *   [ Open session → ]  [ Show on Mac ]
 *
 * Rows are mono: the time in --ink-3, the stage in --ink, the daemon's
 * detail in --ink-2. A failure shows its reason in --signal-text, the masked
 * screen tail and one primary way out: Show on Mac (the window is there,
 * with Edit and resend beside it when a first prompt was never typed),
 * Edit and resend (the first prompt did not arrive) or Try again (the start
 * form again, with the account, Name and first prompt this launch had).
 *
 * The job comes from the event stream (state.launches) and from
 * GET /v1/launches/:id, which alone carries the masked screen tail; it is
 * read again whenever the launch reaches a dialog or a failure. The prompt
 * text never appears here: events and the job carry its hash only.
 */
import { ArrowRightIcon, CheckIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { machineName, machineOf, type LaunchJob } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { sessionViewPath } from '../../../lib/router.js';
import { useApp, useDeps, useNavigate, useToast } from '../../context.js';
import { useAccountsMode } from '../../shell/data.js';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { hasPrompt, takePrompt, useRequest } from '../new/data.js';
import { OfflineNote } from '../new/parts.js';
import { askAbout } from '../session/ask.js';
import { DialogCard, ScreenTail } from './DialogCard.js';
import { OPENABLE_STAGES, folderName, hms, isFailed, isFinal, stepWord } from './stages.js';

/** A launch that went wrong, or a start the daemon refused: the "Not delivered" family, in --signal-text. */
export function FailureLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" data-failure className={clsx('type-small text-signal-text', className)}>
      {children}
    </p>
  );
}

/** When the daemon gave no sentence of its own. */
const FALLBACK_REASON: Partial<Record<LaunchJob['stage'], string>> = {
  failed: "The session didn't start.",
  refused: 'The Mac refused this start.',
  stalled: 'Nothing moved for 30 minutes. Check the window on the Mac.',
  'ready-prompt-failed': "The session is running, but the first prompt didn't arrive.",
};

/** Stages whose screen tail the receipt shows (the daemon keeps one for these only). */
const needsTail = (job: LaunchJob) => job.stage === 'dialog' || isFailed(job.stage);
const tailKeyOf = (job: LaunchJob) => `${job.stage}|${job.dialog?.title ?? ''}`;

/** The newer of two copies of a launch (the event stream and a GET race each other). */
function newer(a: LaunchJob | undefined, b: LaunchJob | undefined): LaunchJob | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

function Steps({ job }: { job: LaunchJob }) {
  const single = useAccountsMode() === 'single';
  const last = job.steps.length - 1;
  return (
    <ol aria-label="Steps" className="mt-12 border-t border-line">
      {job.steps.map((s, i) => {
        const current = i === last && s.stage === job.stage && !isFinal(job.stage);
        return (
          <li
            key={`${s.at}:${s.stage}:${i}`}
            data-step={s.stage}
            className="flex min-h-32 items-baseline gap-12 border-b border-line py-8 type-mono transition-opacity duration-150 ease-ui starting:opacity-0"
          >
            <span className="w-64 flex-none text-ink-3">{hms(s.at)}</span>
            <span className="flex-none text-ink">{stepWord(s.stage, job, current, single)}</span>
            {s.detail ? <span className="min-w-0 flex-1 wrap-break-word text-ink-2">{s.detail}</span> : <span className="flex-1" />}
            {s.stage === 'done' ? <CheckIcon size={12} weight="bold" className="flex-none self-center text-ink" aria-label="delivered" /> : null}
            {current ? <Spinner label={stepWord(s.stage, job, true, single)} className="self-center" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export interface ReceiptProps {
  id: string;
  phone: boolean;
  /** Where "Try again" goes for this launch: the start form for its folder (null: none). */
  retryTo: (job: LaunchJob) => string | null;
  /** Right side of the title row (the desktop pane's Close). */
  aside?: ReactNode;
}

export function Receipt({ id, phone, retryTo, aside }: ReceiptProps) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const toast = useToast();
  // Own keys only: an id from the URL such as "constructor" is no launch.
  const live = useApp((s) => (Object.hasOwn(s.state.launches, id) ? s.state.launches[id] : undefined));
  const sessions = useApp((s) => s.state.sessions);
  const offline = useApp((s) => s.conn.status === 'offline');
  // v0.6: a launch on a paired server shows its window there (a Mac server), or has none to show (tmux, Windows).
  const node = live?.node;
  const where = useApp((s) => (node === undefined ? undefined : machineName(s.state, node)));
  const raisable = useApp((s) => node === undefined || machineOf(s.state, node)?.backend === 'terminal-app');
  const got = useRequest(id, () => api.launchGet(id));
  const [focusing, setFocusing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const job = newer(got.data?.job, live);
  // The tail belongs to the stage it was read at; a newer stage waits for its own.
  const tail = got.data && job && got.data.job.stage === job.stage ? got.data.screenTail : undefined;

  // A dialog or a failure has a screen tail the events do not carry: read
  // it again when the stream brings a new one (a new stage or a new title).
  const { reload } = got;
  const tailKey = live && needsTail(live) ? tailKeyOf(live) : null;
  const seen = useRef({ fetched: got.data ? tailKeyOf(got.data.job) : null, reload });
  seen.current = { fetched: got.data ? tailKeyOf(got.data.job) : null, reload };
  useEffect(() => {
    if (tailKey && tailKey !== seen.current.fetched) seen.current.reload();
  }, [tailKey]);

  if (!job) {
    if (got.error) {
      return (
        <section aria-label="Launch" className="py-8">
          <p role="alert" className="type-small text-ink-2">
            {isApiError(got.error, 'not_found') ? 'That launch is no longer here.' : errorText(got.error)}
          </p>
          <div className="mt-12 flex gap-8">
            {isApiError(got.error, 'not_found') ? (
              <Button onClick={() => navigate('/new')}>Pick a folder</Button>
            ) : (
              <Button onClick={reload}>Try again</Button>
            )}
          </div>
        </section>
      );
    }
    return (
      <section aria-label="Launch" aria-busy="true" className="flex items-center gap-8 py-8 type-mono text-ink-3">
        <Spinner label="Reading the launch" />
        <span>reading the launch</span>
      </section>
    );
  }

  const known = Boolean(sessions[job.sid]);
  const failed = isFailed(job.stage);
  const sessionPath = sessionViewPath(job.sid, 'transcript');
  const size = phone ? 'xl' : 'lg';

  const showOnMac = async () => {
    setFocusing(true);
    setActionError(null);
    try {
      await api.focus(job.sid);
      toast(`Brought the window to the front on ${where ?? 'the Mac'}`, 'ok');
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setFocusing(false);
    }
  };
  const showButton = (variant: 'primary' | 'outline') =>
    raisable ? (
      <Button key="show" variant={variant} size={size} disabled={offline || focusing} onClick={() => void showOnMac()}>
        {focusing ? <Spinner label={`Asking ${where ?? 'the Mac'}`} /> : null}
        Show on {where ?? 'Mac'}
      </Button>
    ) : null;
  const openButton = (variant: 'primary' | 'outline') => (
    <Button key="open" variant={variant} size={size} onClick={() => navigate(sessionPath)}>
      Open session
      <ArrowRightIcon size={16} weight="bold" aria-hidden="true" />
    </Button>
  );

  // The first prompt, back in the session's composer (it was never typed, or never arrived).
  const resendButton = (variant: 'primary' | 'outline') => (
    <Button
      key="resend"
      variant={variant}
      size={size}
      onClick={() => {
        const text = takePrompt(job.id);
        if (text) askAbout(job.sid, text);
        navigate(sessionPath);
      }}
    >
      Edit and resend
    </Button>
  );

  let actions: ReactNode[] = [];
  if (job.stage === 'ready-prompt-failed') {
    actions = [hasPrompt(job.id) ? resendButton('primary') : openButton('primary'), known ? showButton('outline') : null];
  } else if (failed) {
    const retry = retryTo(job);
    // The session runs (a launch that stalled, say): its window is there, and so is the prompt it never got.
    if (known) actions = [showButton('primary'), hasPrompt(job.id) ? resendButton('outline') : null];
    else if (retry)
      actions = [
        <Button key="retry" variant="primary" size={size} onClick={() => navigate(retry)}>
          Try again
        </Button>,
      ];
  } else if (OPENABLE_STAGES.includes(job.stage)) {
    actions = [openButton('primary'), known ? showButton('outline') : null];
  }
  actions = actions.filter(Boolean);

  return (
    <section aria-label="Launch" data-stage={job.stage}>
      <div className="flex items-center gap-8">
        <h2 className="min-w-0 truncate type-title text-ink">Start in {folderName(job.display)}</h2>
        {aside ? <div className="ml-auto flex-none">{aside}</div> : null}
      </div>
      <p className="mt-4 wrap-anywhere type-mono text-ink-3">
        {job.display} · {job.name}
      </p>
      <Steps job={job} />
      {job.stage === 'dialog' ? <DialogCard job={job} screenTail={tail} phone={phone} offline={offline} onStale={reload} /> : null}
      {failed ? (
        <div className="mt-16">
          <FailureLine>{job.reason ?? FALLBACK_REASON[job.stage]}</FailureLine>
          {tail ? <ScreenTail text={tail} className="mt-12" /> : null}
        </div>
      ) : null}
      {actions.length ? <div className={clsx('mt-16 gap-8', phone ? 'flex flex-col' : 'flex flex-wrap items-center')}>{actions}</div> : null}
      {actionError ? <FailureLine className="mt-8">{actionError}</FailureLine> : null}
      {offline && !isFinal(job.stage) ? <OfflineNote what="follow the launch" className="mt-12" /> : null}
    </section>
  );
}
