/**
 * Permission dock (direction.md 5.2). The command sits in a --term box; the
 * buttons use Claude's own words and order (v0.4.2, mac-1):
 *
 *   Yes                   primary
 *   Yes, and … for this   every session-scoped suggestion in one row, as
 *     session             Claude combines them ("allow access to <dirs>;
 *                         switch to auto-accept edits"); hold 2.0 s when one
 *                         of them needs the second tap
 *   Always allow          a suggestion saved beyond the session: hold 2.0 s
 *                         for shell rules (the rule it saves is printed
 *                         under it); one press for the rest
 *   No                    opens an optional note, then "Send No"
 *   No, and stop Claude   says no (with the note, if any) and ends the turn
 *
 * If the daemon still answers needs_confirm, the choice turns into a
 * "Tap again to confirm" button (the server-forced arm, kept from v0.1).
 */
import clsx from 'clsx';
import { m } from 'motion/react';
import { useId, useRef, useState, type ReactNode } from 'react';
import type { PendingRequest } from '@jantar/protocol';
import { describeSuggestion, sessionRow, summarizeTool, type SuggestionInfo } from '../../../lib/describe.js';
import { Button } from '../../kit/Button.js';
import { HoldButton } from '../../kit/HoldButton.js';
import { KeyHints } from '../../kit/Keycap.js';
import { useDecide, type OnDecided } from './decide.js';
import { DockFrame } from './DockFrame.js';
import { Actions, FieldView, InlineError, OfflineLine } from './Fields.js';
import { usePaneKeys } from './keys.js';
import { TwoTap } from './TwoTap.js';

/** "Always allow Bash(npm test:*)" -> rule "Bash(npm test:*)". */
function ruleOf(info: SuggestionInfo): string | null {
  const m = /^Always (?:allow|deny|ask for) (.+)$/.exec(info.text);
  return m?.[1] ?? null;
}

/** The short button label: "Always allow", or the suggestion's own words. */
function shortLabel(info: SuggestionInfo): string {
  return info.text.startsWith('Always allow ') ? 'Always allow' : info.text;
}

const SPRING = { type: 'spring', duration: 0.35, bounce: 0.12 } as const;

export interface CardProps {
  p: PendingRequest;
  folder: string;
  phone: boolean;
  offline: boolean;
  age: string;
  late: boolean;
  aside?: ReactNode;
  onDecided: OnDecided;
  /** Bring the session's tab to the front on the Mac (the plan card's link when the request carries no plan). */
  onShowOnMac?: () => void;
}

/** The session row's arm key (suggestion rows arm by index). */
const SESSION = 'session';

export function PermissionCard({ p, folder, phone, offline, age, late, aside, onDecided }: CardProps) {
  const { busy, error, decide } = useDecide(p, onDecided);
  const [armed, setArmed] = useState<number | typeof SESSION | null>(null);
  const [denyOpen, setDenyOpen] = useState(false);
  const [note, setNote] = useState('');
  const noteRef = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const summary = summarizeTool(p.tool, p.input);
  const disabled = busy || p.state !== 'open' || offline;
  const sugs = p.suggestions.map((s) => describeSuggestion(s, p.tool));
  const session = sessionRow(p.suggestions, p.tool);
  // Suggestions saved beyond this session keep their own rows, as before.
  const others = sugs.flatMap((info, i) => (session?.indices.includes(i) ? [] : [{ i, info }]));
  const why = summary.fields.find((f) => f.label === 'Why');
  const fields = summary.fields.filter((f) => f !== why);
  const title = p.tool === 'Bash' ? `Run this in ${folder}?` : `${summary.title}?`;
  const size = phone ? 'xl' : 'lg';

  const always = async (i: number, confirm: boolean) => {
    const info = sugs[i];
    const rule = info ? ruleOf(info) : null;
    const receipt = info ? (rule ? `Always allowed ${rule}` : info.text) : 'Allowed';
    const r = await decide(confirm ? { behavior: 'allow', suggestion: i, confirm: true } : { behavior: 'allow', suggestion: i }, receipt);
    if (r === 'needs_confirm') setArmed(i);
    else setArmed(null);
  };
  const forSession = async (confirm: boolean) => {
    if (!session) return;
    // One suggestion goes as `suggestion` (the same answer, the v0.4.1 body); several as `suggestions`.
    const [only] = session.indices;
    const pick = session.indices.length === 1 && only !== undefined ? { suggestion: only } : { suggestions: session.indices };
    const r = await decide({ behavior: 'allow', ...pick, ...(confirm ? { confirm: true } : {}) }, 'Allowed for this session');
    setArmed(r === 'needs_confirm' ? SESSION : null);
  };
  const allowOnce = () => void decide({ behavior: 'allow' }, 'Allowed once');
  const deny = (stop: boolean) =>
    void decide(
      { behavior: 'deny', ...(note.trim() ? { message: note.trim() } : {}), ...(stop ? { interrupt: true } : {}) },
      stop ? 'Said no and stopped Claude' : note.trim() ? 'Said no, with a note' : 'Said no',
    );
  const openDeny = () => {
    setDenyOpen(true);
    requestAnimationFrame(() => noteRef.current?.focus());
  };

  usePaneKeys({ a: () => !disabled && allowOnce(), d: () => !disabled && openDeny() }, !phone && !disabled);

  const suggestionButton = (i: number, info: SuggestionInfo, cls?: string, full = false) => {
    const label = full ? info.text : shortLabel(info);
    const name = `${info.text}${info.where ? ` for ${info.where}` : ''}`;
    if (armed === i) {
      return (
        <TwoTap
          key={i}
          size={size}
          className={cls}
          disabled={disabled}
          forceArmed
          onConfirm={() => void always(i, true)}
          confirmLabel={<span className="truncate">Tap again to confirm: {info.text}</span>}
        >
          {label}
        </TwoTap>
      );
    }
    if (info.dangerous) {
      return (
        <HoldButton key={i} size={size} className={cls} disabled={disabled} onCommit={() => void always(i, true)} aria-label={`${name}. Hold for 2 seconds`}>
          {label}
        </HoldButton>
      );
    }
    return (
      <Button key={i} size={size} className={cls} disabled={disabled} aria-label={name} onClick={() => void always(i, false)}>
        {label}
      </Button>
    );
  };

  // The session row names folders, so it wraps rather than cut them off (set
  // through the style prop: two height or white-space classes would be
  // settled by stylesheet order).
  const sessionButton = (cls?: string) => {
    if (!session) return null;
    if (armed === SESSION) {
      return (
        <TwoTap
          size={size}
          className={cls}
          disabled={disabled}
          forceArmed
          onConfirm={() => void forSession(true)}
          confirmLabel={<span className="truncate">Tap again to confirm: {session.label}</span>}
        >
          {session.label}
        </TwoTap>
      );
    }
    if (session.dangerous) {
      return (
        <HoldButton size={size} className={cls} disabled={disabled} onCommit={() => void forSession(true)}>
          {session.label}
        </HoldButton>
      );
    }
    return (
      <Button
        size={size}
        className={clsx(cls, 'py-8')}
        style={{ height: 'auto', minHeight: phone ? 48 : 40, whiteSpace: 'normal' }}
        disabled={disabled}
        onClick={() => void forSession(false)}
      >
        {session.label}
      </Button>
    );
  };

  const firstOther = others[0];
  const first = firstOther?.info;
  const firstRule = first ? ruleOf(first) : null;
  const peek = fields[0]?.text.split('\n')[0] ?? summary.title;

  return (
    <DockFrame
      phone={phone}
      title={`Permission · ${p.tool}`}
      age={age}
      late={late}
      aside={aside}
      peek={peek}
      hints={<KeyHints hints={[{ keys: ['a'], label: 'yes' }, { keys: ['d'], label: 'no' }]} />}
    >
      <p className="mt-8 type-title text-ink">{title}</p>
      {why ? <p className="mt-4 type-small text-ink-2">{why.text}</p> : null}
      {fields.map((f, i) => (
        <FieldView key={i} f={f} />
      ))}

      <Actions phone={phone} layout="grid">
        <Button variant="primary" size={size} className={clsx(phone && 'col-span-2')} disabled={disabled} onClick={allowOnce}>
          Yes
        </Button>
        {sessionButton(clsx(phone && 'col-span-2'))}
        {firstOther ? suggestionButton(firstOther.i, firstOther.info, clsx(phone && 'col-span-2')) : null}
        <Button size={size} disabled={disabled} aria-expanded={denyOpen} onClick={() => (denyOpen ? setDenyOpen(false) : openDeny())}>
          No
        </Button>
        <Button variant="text" size={size} disabled={disabled} onClick={() => deny(true)}>
          No, and stop Claude
        </Button>
      </Actions>

      {session?.dangerous ? (
        <p className="mt-10 type-small text-pretty text-ink-3">
          Hold for 2 seconds to choose <span className="text-ink-2">{session.label}</span>. It lasts until this session ends.
        </p>
      ) : null}
      {first && firstRule ? (
        <p className="mt-10 type-small text-pretty text-ink-3">
          {first.dangerous ? 'Hold Always allow for 2 seconds. It saves the rule ' : 'Always allow saves the rule '}
          <span className="font-mono text-mono text-ink-2">{firstRule}</span>
          {first.where ? ` for ${first.where}.` : '.'}
        </p>
      ) : first?.where ? (
        <p className="mt-10 type-small text-ink-3">It applies to {first.where}.</p>
      ) : null}

      {others.length > 1 ? (
        <div className="mt-12 flex flex-col items-start gap-6">
          {others.slice(1).map(({ i, info }) => (
            <div key={i} className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-4">
              {suggestionButton(i, info, undefined, true)}
              {info.where ? <span className="type-small text-ink-3">for {info.where}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {denyOpen ? (
        <m.div className="mt-12 flex gap-8" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
          <label htmlFor={noteId} className="sr-only">
            Tell Claude what to do instead (optional)
          </label>
          <input
            id={noteId}
            ref={noteRef}
            type="text"
            value={note}
            maxLength={4000}
            placeholder="Tell Claude what to do instead (optional)"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !disabled) deny(false);
              if (e.key === 'Escape') setDenyOpen(false);
            }}
            className={clsx(
              'min-w-0 flex-1 rounded-btn border border-line-strong bg-surface px-10 type-input text-ink focus-visible:outline-offset-0',
              phone ? 'h-48' : 'h-40',
            )}
          />
          <Button size={size} disabled={disabled} onClick={() => deny(false)}>
            Send No
          </Button>
        </m.div>
      ) : null}
      <InlineError error={error} />
      <OfflineLine offline={offline} />
    </DockFrame>
  );
}
