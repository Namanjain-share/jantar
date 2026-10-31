/**
 * The start form's account picker (spec 5.3.3): Auto (most room, decided by
 * the daemon) first, then one row per account in the Accounts phone-row
 * anatomy:
 *
 *   Auto   most room → 07
 *   07  ▮▮▯▯▯▯▯▯ 12           resets 14:20 · 0 live
 *   02  ▮▮▮▮▮▯▯▯ 48   held    resets 15:10 · 2 live
 *   05  ...                   token expired          (--ink-3, not a button)
 *
 * A held account asks first: "Held for other work. ccw will never move this
 * session, even when 02 fills up." with "Use 02 anyway" (the start then
 * carries confirmHeld). Auto never names a held account: the form treats
 * such a pick as no room at all.
 *
 * Phone: the list replaces the start sheet's body (one raised surface at a
 * time). Desktop: a popover beside the Account row.
 */
import { Popover } from '@base-ui/react/popover';
import { XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useState, type ReactNode, type RefObject } from 'react';
import type { LaunchAccount } from '@jantar/protocol';
import { accountId, clock } from '../../../lib/format.js';
import { useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { IconButton } from '../../kit/IconButton.js';
import { Meter } from '../../kit/Meter.js';
import { Tag } from '../../kit/Tag.js';
import { useCeiling } from '../../shell/data.js';
import { LEGACY_TOOL } from '../accounts/model.js';

/** What Auto picks right now: an account, none (no room), or not known yet. */
export interface AutoPick {
  pick: number | null;
  reason: string;
}

export type AccountChoice = number | 'auto';

/** The warning a held account carries before it is used. */
export function heldSentence(id: number): string {
  return `Held for other work. ${LEGACY_TOOL} will never move this session, even when ${accountId(id)} fills up.`;
}

/** "Held for other work…" with "Use 02 anyway". */
export function HeldConfirm({ id, onConfirm, className }: { id: number; onConfirm: () => void; className?: string }) {
  return (
    <div className={clsx('flex flex-col items-start gap-8', className)}>
      <p className="type-small font-medium text-ink-2">{heldSentence(id)}</p>
      <Button size="sm" onClick={onConfirm}>
        Use {accountId(id)} anyway
      </Button>
    </div>
  );
}

function rowMeta(a: LaunchAccount, now: number): string {
  const parts: string[] = [];
  if (a.resetsAt) parts.push(`resets ${clock(a.resetsAt, now)}`);
  parts.push(`${a.live} live`);
  return parts.join(' · ');
}

export interface AccountListProps {
  accounts: LaunchAccount[];
  value: AccountChoice;
  /** What Auto would pick (null: not asked yet). */
  auto: AutoPick | null;
  onPick: (v: AccountChoice, confirmHeld: boolean) => void;
  /** Meter width: 96 on a phone, 120 in the popover. */
  bar?: number;
}

export function AccountList({ accounts, value, auto, onPick, bar = 96 }: AccountListProps) {
  const now = useNow(30_000);
  const ceiling = useCeiling();
  const [confirming, setConfirming] = useState<number | null>(null);
  const autoNone = auto !== null && auto.pick === null;
  const rowCls = (on: boolean, live = true) =>
    clsx(
      'relative flex min-h-48 w-full items-center gap-12 px-16 py-8 text-left transition-colors duration-120 ease-hover coarse:min-h-52',
      on ? 'row-tick bg-select' : live && 'hover:not-disabled:bg-hover',
    );

  return (
    <ul aria-label="Accounts" className="border-t border-line">
      <li className="border-b border-line">
        <button type="button" aria-pressed={value === 'auto'} disabled={autoNone} onClick={() => onPick('auto', false)} className={rowCls(value === 'auto')}>
          <span className={clsx('w-48 flex-none type-row font-medium', autoNone ? 'text-ink-3' : 'text-ink')}>Auto</span>
          <span className="min-w-0 flex-1 truncate type-mono text-ink-3">
            {auto === null ? 'most room' : auto.pick === null ? auto.reason : `most room → ${accountId(auto.pick)}`}
          </span>
        </button>
      </li>
      {accounts.map((a) => {
        const on = value === a.id;
        const pct = a.fiveHourPct === undefined ? null : Math.round(a.fiveHourPct);
        const body: ReactNode = (
          <>
            <span className={clsx('w-24 flex-none type-mono font-key', a.selectable ? 'text-ink' : 'text-ink-3')}>{accountId(a.id)}</span>
            <Meter value={pct} label={`${accountId(a.id)} 5-hour usage`} width={bar} ceiling={ceiling} stale={!a.selectable} />
            <span className={clsx('w-24 flex-none type-mono', a.selectable ? 'text-ink' : 'text-ink-3')}>{pct ?? '–'}</span>
            {a.held ? <Tag>held</Tag> : null}
            <span className="ml-auto min-w-0 truncate pl-8 type-mono text-ink-3">{a.selectable ? rowMeta(a, now) : (a.why ?? 'not usable')}</span>
          </>
        );
        return (
          <li key={a.id} className="border-b border-line" data-account={a.id}>
            {a.selectable ? (
              <button
                type="button"
                aria-pressed={on}
                aria-label={`${accountId(a.id)}${a.label ? ` ${a.label}` : ''}${a.held ? ', held' : ''}`}
                onClick={() => {
                  if (a.held) setConfirming(a.id);
                  else onPick(a.id, false);
                }}
                className={rowCls(on)}
              >
                {body}
              </button>
            ) : (
              <div aria-disabled="true" className={rowCls(false, false)}>
                {body}
              </div>
            )}
            {confirming === a.id ? <HeldConfirm id={a.id} className="px-16 pb-12" onConfirm={() => onPick(a.id, true)} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Desktop: the list in a popover anchored to the Account row's button. */
export function AccountPopover({
  open,
  onOpenChange,
  anchor,
  ...list
}: AccountListProps & { open: boolean; onOpenChange: (o: boolean) => void; anchor: RefObject<HTMLButtonElement | null> }) {
  return (
    <Popover.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <Popover.Portal>
        <Popover.Positioner anchor={anchor} side="bottom" align="start" sideOffset={6} collisionPadding={12} className="z-30">
          <Popover.Popup finalFocus={anchor} className="w-480 max-w-full rounded-dock bg-raised pb-8 pt-12 text-ink shadow-float outline-none animate-pop">
            <div className="mb-8 flex items-center px-16">
              <Popover.Title className="type-title">Pick an account</Popover.Title>
              <Popover.Close render={<IconButton aria-label="Close the account list" className="ml-auto -mr-4" />}>
                <XIcon size={16} aria-hidden="true" />
              </Popover.Close>
            </div>
            <AccountList {...list} bar={120} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
