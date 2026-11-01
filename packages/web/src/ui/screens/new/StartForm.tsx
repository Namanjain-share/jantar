/**
 * The start form (spec 5.3.3 with decisions U7 and U8): a property list,
 * labels at 88 px in --ink-3, values on the right.
 *
 *   Start in foo
 *   Folder       ~/Desktop/work/foo   git  CLAUDE.md
 *   Account      Auto → 07                                 ›
 *                most room · 5h 12% · resets in 3h40 · 14:20
 *   Permissions  [Skip all checks | Auto | Accept edits | Plan | Ask me]
 *   Chrome       [On | Off]
 *   Effort       [Default | low | medium | high | xhigh | max | ultracode]
 *                An account move restarts it with ultracode effort.
 *                (only while the legacy ccw tool runs: nothing else moves a session)
 *   Model        [Default | opus | sonnet | haiku | fable]
 *   cd -- '/Users/…/foo' && cs 7 -- --dangerously-skip-permissions …   (verbatim, mono)
 *   Claude won't ask before running commands in this session.          (--ink-2 560, not ember)
 *   Name         [ foo-2 ]
 *   First prompt (optional)
 *   [ Hold to start ]      2.0 s for skip and auto, 1.2 s otherwise
 *
 * The pickers start where the daemon says (the flags asked for, else this
 * device's last start, else launch.defaultFlags) and the preview is asked
 * again with only the picks changed here, and with the Name once typing
 * pauses (NAME_SETTLE_MS). The account starts on Auto, or on
 * `initialAccount` (a Board row's "New session here" keeps its account; a
 * held one still asks first). The command line is the daemon's own, shown
 * as it comes, and Hold waits until it is the one for what is on the sheet
 * now. There is no trust box (U8) and no free-text flag.
 *
 * One Idempotency-Key per hold: a retry after a network failure (the Mac
 * may have opened the window) reuses it, so it never opens a second one.
 *
 * v0.4 (spec 5.9):
 *
 *   Resume       [Off | Last | Pick…]
 *                Thu 30 Oct 14:02 · 03 · "fix the push ex…"   (mono --ink-3)
 *
 * Resume, under Name, opens one of the folder's past conversations instead
 * of a new one: Last is the newest one not running (a running one is open
 * on the Board already), Pick… lists them (ResumePicker, in the sheet's
 * place; focus comes back to this row when it closes). Either sends
 * `resume: <id>` with the preview and the start, and the command line shows
 * `--resume <id>` as the daemon types it. With no past sessions the row
 * says so and only Off can be taken. A conversation kept on one account
 * pins it: the Account row shows "This conversation is on 03" and cannot be
 * changed (a held one still asks first). With one Claude login (accounts
 * mode "single") there is no Account row at all: Auto is that login, even
 * when the URL asked for an account.
 *
 * v0.6: on a paired machine (NewSession's Where row) the title and the hold
 * name it ("Start in api-server on build-1", "Hold to start on build-1"),
 * the preview, history and start go there, and its accounts are its own
 * (config dirs show by their alias); nothing moves a server's session.
 */
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  LAUNCH_PROMPT_MAX,
  LaunchNameSchema,
  launchFlagsDangerous,
  type FolderEntry,
  type LaunchFlags,
  type LaunchJob,
  type LaunchPreview,
  type LaunchStartBody,
} from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { accountId } from '../../../lib/format.js';
import { newIdempotencyKey } from '../../../lib/ids.js';
import { useApp, useDeps, useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { HoldButton } from '../../kit/HoldButton.js';
import { Spinner } from '../../kit/Spinner.js';
import { Tag } from '../../kit/Tag.js';
import { usePlan } from '../../plan.js';
import { useAccountsMode } from '../../shell/data.js';
import { FailureLine } from '../launch/Receipt.js';
import { NO_ASK_SENTENCE } from '../session/controls/modes.js';
import { promptProblem } from '../session/sends.js';
import { folderName } from '../launch/stages.js';
import { AccountList, AccountPopover, HeldConfirm, type AccountChoice, type AutoPick } from './AccountPicker.js';
import { NO_PAST, PAST_UNREAD, basename, chosenPast, isNoScope, keepPrompt, lastPast, pastLine, takePrompt, useRequest, useWhere, type ResumeMode } from './data.js';
import { NoScopeNote, OfflineNote, Prop } from './parts.js';
import { CHROME_OPTIONS, Choice, EFFORT_OPTIONS, MODEL_OPTIONS, PERMISSION_OPTIONS } from './Pickers.js';
import { ResumeChoice, ResumePicker } from './ResumePicker.js';

/** Hold to start: 2.0 s when Claude won't ask before running commands (skip, auto), else 1.2 s. */
export const HOLD_DANGEROUS_MS = 2000;
export const HOLD_PLAIN_MS = 1200;
export const holdMs = (flags: Pick<LaunchFlags, 'permission'>) => (launchFlagsDangerous(flags) ? HOLD_DANGEROUS_MS : HOLD_PLAIN_MS);

/** The preview is asked again with the typed Name once typing pauses this long. */
export const NAME_SETTLE_MS = 300;

export const DANGER_SENTENCE = NO_ASK_SENTENCE;
export const EFFORT_NOTE = 'An account move restarts it with ultracode effort.';

/**
 * What Auto picks, from a preview asked with account=auto. A held or
 * unusable account is never offered as Auto, whatever the reply says: it
 * reads as no room, and a manual pick (with its confirmation) still works.
 */
export function autoPickOf(preview: LaunchPreview): AutoPick {
  const pick = preview.account.pick;
  const a = pick === null ? undefined : preview.accounts.find((x) => x.id === pick);
  if (pick === null || (a && (a.held || !a.selectable))) {
    return { pick: null, reason: pick === null ? preview.account.reason : 'No account has room for Auto.' };
  }
  return { pick, reason: preview.account.reason };
}

export interface StartFormProps {
  root: string;
  path: string;
  /** The folder's row in the browser, when it is in hand (its git and CLAUDE.md tags). */
  entry?: FolderEntry;
  /** The account the form starts on (Auto when absent). */
  initialAccount?: AccountChoice;
  /** "Try again" after a failed launch: the Name and the first prompt it had. */
  initialName?: string;
  initialPrompt?: string;
  /** That launch's id: its kept prompt is dropped once this start is accepted. */
  retryOf?: string;
  phone: boolean;
  /** Right side of the title row (the desktop pane's Close). */
  aside?: ReactNode;
  onStarted: (job: LaunchJob) => void;
}

export function StartForm({ root, path, entry, initialAccount = 'auto', initialName = '', initialPrompt = '', retryOf, phone, aside, onStarted }: StartFormProps) {
  const { api } = useDeps();
  const offline = useApp((s) => s.conn.status === 'offline');
  const where = useWhere();
  const hubMode = useAccountsMode();
  const single = (where?.accountsMode ?? hubMode) === 'single';
  // Account moves come only from the legacy ccw tool, which restarts a moved session with ultracode effort (on the Mac only).
  const legacy = usePlan()?.source === 'ccw-legacy';
  const moves = legacy && !where;
  const on = where ? ` on ${where.name}` : '';
  const now = useNow(60_000);
  const ids = useId();
  const [accountPick, setAccount] = useState<AccountChoice>(initialAccount);
  // One login: Auto is it, whatever the URL asked for (there is no Account row to change it).
  const account: AccountChoice = single ? 'auto' : accountPick;
  const [heldOk, setHeldOk] = useState(false);
  const [picks, setPicks] = useState<Partial<LaunchFlags>>({});
  const [name, setName] = useState(initialName);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [picking, setPicking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  const [auto, setAuto] = useState<AutoPick | null>(null);
  const [resumeMode, setResumeMode] = useState<ResumeMode>('off');
  const [picked, setPicked] = useState<string | null>(null);
  const [pickingPast, setPickingPast] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const resumeRow = useRef<HTMLDivElement>(null);
  // Set as the past sessions close, so focus goes back to the Resume row and not to the page.
  const backToResume = useRef(false);
  const attempt = useRef<{ key: string; sig: string } | null>(null);
  const nameTrim = name.trim();
  const nameOk = nameTrim === '' || LaunchNameSchema.safeParse(nameTrim).success;
  // The Name the command should carry ('' : the daemon's suggestion), and the one the preview was asked with.
  const wantName = nameOk ? nameTrim : '';
  const [askedName, setAskedName] = useState(wantName);
  useEffect(() => {
    const t = setTimeout(() => setAskedName(wantName), NAME_SETTLE_MS);
    return () => clearTimeout(t);
  }, [wantName]);

  // The folder's past conversations: what Last and Pick… choose from.
  const history = useRequest(`history\n${root}\n${path}`, () => api.launchHistory({ root, ...(path ? { path } : {}) }));
  const past = history.data?.sessions ?? [];
  const resumed = chosenPast(past, resumeMode, picked);

  useEffect(() => {
    if (pickingPast || !backToResume.current) return;
    backToResume.current = false;
    resumeRow.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, [pickingPast]);

  // Only the picks changed here go to the daemon; it fills the rest.
  const key = JSON.stringify({ root, path, account, picks, name: askedName, resume: resumed?.id ?? null });
  const preview = useRequest(
    key,
    () =>
      api.launchPreview({
        root,
        ...(path ? { path } : {}),
        ...(account === 'auto' ? {} : { account }),
        ...(Object.keys(picks).length ? { flags: picks } : {}),
        ...(askedName ? { name: askedName } : {}),
        ...(resumed ? { resume: resumed.id } : {}),
      }),
    { keep: true },
  );
  const p = preview.data;
  // The command shown is the one a start would type only once the preview has the Name on the sheet.
  const fresh = preview.fresh && askedName === wantName;

  // Remember what Auto gives, so the picker can show it while a manual pick is on (a resume's pinned account is not Auto's).
  useEffect(() => {
    if (p && preview.fresh && account === 'auto' && p.account.source !== 'resume') setAuto(autoPickOf(p));
  }, [p, preview.fresh, account]);

  if (!p) {
    return (
      <section aria-label="Start a session" aria-busy={preview.loading}>
        <Title phone={phone} text={`Start in ${basename(path) || 'this folder'}${on}`} aside={aside} />
        {preview.error ? (
          <div className="mt-12">
            {isNoScope(preview.error) ? <NoScopeNote /> : <p role="alert" className="type-small text-ink-2">{errorText(preview.error)}</p>}
            <Button className="mt-12" onClick={preview.reload}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="mt-12" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex h-48 items-center gap-12 border-b border-line">
                <span className="h-8 w-64 bg-line" />
                <span className="h-8 w-2/5 bg-line" />
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  const flags: LaunchFlags = { ...p.flags, ...picks };
  const dangerous = launchFlagsDangerous(flags);
  // A conversation kept on one account starts there, whatever was picked.
  const pinned = p.account.source === 'resume' ? p.account.pick : null;
  const autoNow = account === 'auto' && preview.fresh && pinned === null ? autoPickOf(p) : auto;
  const autoId = autoNow?.pick ?? null;
  const chosen = pinned !== null ? p.accounts.find((a) => a.id === pinned) : account === 'auto' ? null : p.accounts.find((a) => a.id === account);
  const needsHeldOk = chosen?.held === true && !heldOk;
  const accountReady = pinned === null && account === 'auto' ? autoId !== null : chosen?.selectable === true && !needsHeldOk;
  const nameTaken = fresh ? p.warnings.find((w) => w.kind === 'name') : undefined;
  // What the daemon would refuse at start (a leading !, /clear, control characters): said before the hold.
  const promptBad = prompt.trim() ? promptProblem(prompt, where?.name) : null;
  const ready = fresh && accountReady && nameOk && !nameTaken && !promptBad && !offline && !starting;
  const warnings = p.warnings.filter((w) => w.kind !== 'effort' && w.kind !== 'name' && !(w.kind === 'held' && chosen?.held));

  const pick = (v: AccountChoice, confirmHeld: boolean) => {
    setAccount(v);
    setHeldOk(confirmHeld);
    setPicking(false);
    setStartError(null);
  };
  const change = (next: Partial<LaunchFlags>) => {
    setPicks((cur) => ({ ...cur, ...next }));
    setStartError(null);
  };

  const start = async () => {
    const text = prompt.trim();
    const body: LaunchStartBody = {
      root,
      path,
      account: pinned ?? account,
      flags,
      ...(nameTrim ? { name: nameTrim } : {}),
      ...(text ? { prompt: text } : {}),
      ...(chosen?.held && heldOk ? { confirmHeld: true } : {}),
      ...(resumed ? { resume: resumed.id } : {}),
    };
    const sig = JSON.stringify(body);
    // The same start after a network failure keeps its key: the daemon answers it once.
    if (!attempt.current || attempt.current.sig !== sig) attempt.current = { key: newIdempotencyKey(), sig };
    setStarting(true);
    setStartError(null);
    try {
      const r = await api.launchStart(body, attempt.current.key);
      attempt.current = null;
      if (text) keepPrompt(r.job.id, text);
      if (retryOf) takePrompt(retryOf);
      onStarted(r.job);
    } catch (e) {
      if (!isApiError(e, 'network')) attempt.current = null;
      setStartError(e);
    } finally {
      setStarting(false);
    }
  };

  const listProps = { accounts: p.accounts, value: account, auto: autoNow ?? null, onPick: pick };

  const chooseResume = (mode: Exclude<ResumeMode, 'pick'>) => {
    setStartError(null);
    setResumeMode(mode);
    // Another conversation may pin another account: a held one is confirmed afresh.
    setHeldOk(false);
  };
  // Pick… opens the list; the choice changes once a row is picked.
  const openPast = () => {
    setStartError(null);
    setPickingPast(true);
  };

  // The past sessions take the sheet's place, as the account list does on a phone.
  if (pickingPast) {
    return (
      <ResumePicker
        sessions={past}
        value={resumeMode === 'pick' ? picked : null}
        single={single}
        onBack={() => {
          backToResume.current = true;
          setPickingPast(false);
        }}
        onPick={(id) => {
          setPicked(id);
          setResumeMode('pick');
          backToResume.current = true;
          setPickingPast(false);
          setHeldOk(false);
          setStartError(null);
        }}
      />
    );
  }

  // Phone: the account list takes the sheet's place (one raised surface at a time).
  if (picking && phone) {
    return (
      <section aria-label="Pick an account">
        <div className="mb-8 flex items-center gap-8">
          <Button variant="text" size="sm" className="-ml-8" onClick={() => setPicking(false)}>
            <CaretLeftIcon size={16} aria-hidden="true" />
            Back
          </Button>
          <h2 className="type-title text-ink">Pick an account</h2>
        </div>
        <div className="-mx-16">
          <AccountList {...listProps} />
        </div>
      </section>
    );
  }

  const accountLabel =
    pinned !== null ? (
      <>
        <span className="type-mono font-key text-ink">{accountId(pinned)}</span>
        {chosen?.label ? <span className="ml-8 type-row text-ink-2">{chosen.label}</span> : null}
      </>
    ) : account === 'auto' ? (
      <>
        <span className="type-row font-medium text-ink">Auto</span>
        {autoId !== null ? <span className="type-mono text-ink"> → {accountId(autoId)}</span> : null}
      </>
    ) : (
      <>
        <span className="type-mono font-key text-ink">{accountId(account)}</span>
        {chosen?.label ? <span className="ml-8 type-row text-ink-2">{chosen.label}</span> : null}
      </>
    );

  return (
    <section aria-label="Start a session">
      <Title phone={phone} text={`Start in ${folderName(p.display)}${on}`} aside={aside} />
      <div className="mt-8 border-t border-line">
        <Prop label="Folder">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-4 pt-4">
            <span className="min-w-0 wrap-anywhere type-mono text-ink">{p.display}</span>
            {entry?.git ? <Tag>git</Tag> : null}
            {entry?.claudeMd ? <Tag>CLAUDE.md</Tag> : null}
          </div>
        </Prop>

        {/* One Claude login: Auto is that login, so there is nothing to choose or show. */}
        {!single ? (
          <Prop label="Account" labelId={`${ids}-acct`}>
            <div className="-mx-8">
              <button
                ref={anchor}
                type="button"
                aria-labelledby={`${ids}-acct ${ids}-acct-v`}
                aria-haspopup="dialog"
                aria-expanded={picking}
                disabled={pinned !== null}
                onClick={() => setPicking((o) => !o)}
                className="flex min-h-32 w-full items-center rounded-btn px-8 text-left transition-colors duration-120 ease-hover hover:not-disabled:bg-hover coarse:min-h-44"
              >
                <span id={`${ids}-acct-v`} className="min-w-0 flex-1 truncate">
                  {accountLabel}
                </span>
                {pinned === null ? <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" /> : null}
              </button>
            </div>
            <p className="mt-4 type-mono text-ink-3">{p.account.reason}</p>
            {pinned === null && account === 'auto' && autoNow && autoId === null && autoNow.reason !== p.account.reason ? (
              <p className="mt-4 type-mono text-ink-3">{autoNow.reason}</p>
            ) : null}
            {warnings.map((w) => (
              <div key={`${w.kind}:${w.text}`} className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4">
                <p className="type-small text-ink-2">{w.text}</p>
                {w.account !== undefined && w.account !== account && pinned === null ? (
                  <Button size="sm" onClick={() => pick(w.account as number, false)}>
                    Use {accountId(w.account)}
                  </Button>
                ) : null}
              </div>
            ))}
            {chosen && needsHeldOk ? <HeldConfirm id={chosen.id} className="mt-8" onConfirm={() => setHeldOk(true)} /> : null}
          </Prop>
        ) : null}
        {!phone && !single && pinned === null ? <AccountPopover {...listProps} open={picking} onOpenChange={setPicking} anchor={anchor} /> : null}

        <Prop label="Permissions" labelId={`${ids}-perm`}>
          <Choice labelledBy={`${ids}-perm`} options={PERMISSION_OPTIONS} value={flags.permission} onChange={(v) => change({ permission: v })} />
        </Prop>
        <Prop label="Chrome" labelId={`${ids}-chrome`}>
          <Choice labelledBy={`${ids}-chrome`} options={CHROME_OPTIONS} value={flags.chrome ? 'on' : 'off'} onChange={(v) => change({ chrome: v === 'on' })} />
        </Prop>
        <Prop label="Effort" labelId={`${ids}-effort`}>
          <Choice labelledBy={`${ids}-effort`} options={EFFORT_OPTIONS} value={flags.effort} onChange={(v) => change({ effort: v })} />
          {/* With one login, or no ccw, there is no account move to restart it. */}
          {!single && moves && flags.effort !== 'ultracode' ? <p className="mt-8 type-small text-ink-2">{EFFORT_NOTE}</p> : null}
        </Prop>
        <Prop label="Model" labelId={`${ids}-model`}>
          <Choice labelledBy={`${ids}-model`} options={MODEL_OPTIONS} value={flags.model} onChange={(v) => change({ model: v })} />
        </Prop>

        <div className="border-b border-line py-12">
          <p id={`${ids}-cmd`} className="sr-only">
            The command it types
          </p>
          <code
            aria-labelledby={`${ids}-cmd`}
            data-command
            aria-busy={!fresh}
            className={clsx('block whitespace-pre-wrap type-mono text-ink-2 transition-opacity duration-150 ease-ui', !fresh && 'opacity-60')}
          >
            <CommandText text={p.command} />
          </code>
          {dangerous ? <p className="mt-8 type-small font-medium text-ink-2">{DANGER_SENTENCE}</p> : null}
        </div>

        <Prop label="Name" htmlFor={`${ids}-name`}>
          <input
            id={`${ids}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={p.name}
            maxLength={48}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={!nameOk || nameTaken !== undefined}
            aria-describedby={!nameOk || nameTaken ? `${ids}-name-hint` : undefined}
            className="h-40 w-full rounded-btn border border-line-strong bg-bg px-12 type-input text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink coarse:h-44"
          />
          {!nameOk ? (
            <p id={`${ids}-name-hint`} className="mt-6 type-small text-ink-2">
              Letters, digits, dots, dashes and underscores only, starting with a letter or digit. No spaces.
            </p>
          ) : nameTaken ? (
            <p id={`${ids}-name-hint`} className="mt-6 type-small text-ink-2">
              {nameTaken.text}. Pick another name.
            </p>
          ) : null}
        </Prop>

        <Prop label="Resume" labelId={`${ids}-resume`}>
          {/* Last needs a conversation that is not running, Pick… any past one: until then the row stays on Off. */}
          <ResumeChoice
            groupRef={resumeRow}
            labelledBy={`${ids}-resume`}
            value={resumed ? resumeMode : 'off'}
            lastOk={lastPast(past) !== undefined}
            pickOk={past.length > 0}
            onChange={chooseResume}
            onPick={openPast}
          />
          {history.error ? (
            <p className="mt-6 flex flex-wrap items-center gap-x-8 type-small text-ink-2">
              {PAST_UNREAD}
              <Button variant="text" size="sm" onClick={history.reload}>
                Read again
              </Button>
            </p>
          ) : history.data && !past.length ? (
            <p className="mt-6 type-small text-ink-2">{NO_PAST}</p>
          ) : resumed ? (
            <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4">
              <p data-resume-line className="min-w-0 wrap-anywhere type-mono text-ink-3">
                {pastLine(resumed, now, single)}
              </p>
              {resumed.live ? <Tag>running</Tag> : null}
            </div>
          ) : null}
        </Prop>

        <div className="py-12">
          <label htmlFor={`${ids}-prompt`} className="type-small text-ink-3">
            First prompt <span className="text-ink-3">(optional)</span>
          </label>
          <textarea
            id={`${ids}-prompt`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={LAUNCH_PROMPT_MAX}
            rows={3}
            aria-invalid={promptBad !== null}
            aria-describedby={promptBad ? `${ids}-prompt-hint` : undefined}
            className="mt-8 block w-full resize-y rounded-btn border border-line-strong bg-bg px-12 py-8 type-input text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          />
          {promptBad ? (
            <p id={`${ids}-prompt-hint`} className="mt-6 type-small text-ink-2">
              {promptBad}
            </p>
          ) : null}
          {prompt.length > LAUNCH_PROMPT_MAX - 1000 ? (
            <p className="mt-4 type-mono text-ink-3">
              {prompt.length} of {LAUNCH_PROMPT_MAX}
            </p>
          ) : null}
        </div>
      </div>

      <div className={clsx('mt-8 flex items-center gap-12', phone && 'flex-col items-stretch')}>
        <HoldButton
          variant="primary"
          size={phone ? 'xl' : 'lg'}
          durationMs={holdMs(flags)}
          disabled={!ready}
          className={phone ? 'w-full' : undefined}
          onCommit={() => void start()}
        >
          {`Hold to start${on}`}
        </HoldButton>
        {starting ? <Spinner label="Starting" /> : null}
      </div>
      {offline ? <OfflineNote what="start" className="mt-12" /> : null}
      {!offline && fresh && !accountReady && !needsHeldOk && !single && pinned === null ? <p className="mt-12 type-small text-ink-2">Pick an account to start.</p> : null}
      {preview.error && !preview.fresh ? (
        <p role="alert" className="mt-12 type-small text-ink-2">
          {errorText(preview.error)}{' '}
          <Button variant="text" size="sm" onClick={preview.reload}>
            Try again
          </Button>
        </p>
      ) : null}
      {startError ? isNoScope(startError) ? <NoScopeNote className="mt-12" /> : <FailureLine className="mt-12">{errorText(startError)}</FailureLine> : null}
    </section>
  );
}

/**
 * The command line as it will be typed, character for character, broken
 * only between words: a flag (`--effort`) never splits at its own dashes,
 * which next to the real `--` separator would misread. Long words (a deep
 * path) still break anywhere.
 */
export function CommandText({ text }: { text: string }) {
  const words = text.split(' ');
  return (
    <>
      {words.map((w, i) => (
        <span key={i}>
          <span className={w.startsWith('-') ? 'whitespace-nowrap' : 'wrap-anywhere'}>{w}</span>
          {i < words.length - 1 ? ' ' : null}
        </span>
      ))}
    </>
  );
}

function Title({ phone, text, aside }: { phone: boolean; text: string; aside?: ReactNode }) {
  return (
    <div className={clsx('flex items-center gap-8', phone ? 'mt-4' : '')}>
      <h2 className="min-w-0 truncate type-title text-ink">{text}</h2>
      {aside ? <div className="ml-auto flex-none">{aside}</div> : null}
    </div>
  );
}

