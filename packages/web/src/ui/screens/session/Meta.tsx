/**
 * Facts about the session, said once (rule 19):
 *
 *   MetaLine   one mono line with no pills, under the header on a phone and
 *              on desktop below 1360 px:
 *              "03 work · 5h 81 · resets in 12m · 14:20 · auto mode · started 2h ago"
 *   Props      the 208 px property column at 1360 px and wider (dir-k.html):
 *              Account, 5-hour, Resets, Burn, Mode, Started, Folder, Also on.
 *
 * Usage at or past the autoswitch ceiling is --signal-text; every % says
 * its window. While the control bar's mode chip is on screen (v0.3) the
 * mode is said there, so both leave it out (`modeOnChip`).
 *
 * With one Claude login (v0.4 single-account mode) nothing reads usage, so
 * the account, its 5-hour %, the resets, burn and "Also on" are left out:
 * "auto mode · started 2h ago". With nothing left to say, there is no line.
 *
 * v0.6: a server's session follows its own machine. One login on the Mac
 * hides nothing of a server's; a server that reads no usage (config dirs,
 * or one login: `noUsage`) names the account by its alias, as the Board
 * does, and says nothing of usage (its accounts' status is always unknown,
 * never a reason for --signal-text).
 */
import clsx from 'clsx';
import { Fragment, type ReactNode } from 'react';
import type { Account, Session, State } from '@jantar/protocol';
import { accountId, agoLong, clock, fiveHourPct, usageStatusText } from '../../../lib/format.js';
import { glyphStateOf } from '../../kit/glyph.js';
import { pastCeiling } from '../../kit/meterMath.js';
import { Meter } from '../../kit/Meter.js';
import { StatusGlyph } from '../../kit/StatusGlyph.js';
import { useAccountsMode } from '../../shell/data.js';
import { inShort, modeWords, tildePath } from './order.js';

function usage(account: Account | undefined, now: number) {
  const pct = fiveHourPct(account, now);
  const w = pct === null ? undefined : account?.windows.find((x) => x.kind === 'five_hour');
  return { w, pct };
}

function resetsText(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t) || t <= now) return null;
  return `in ${inShort(t - now)} · ${clock(resetsAt, now)}`;
}

/** What the meta line says about the account and its usage: left out with one Claude login. */
const ACCOUNT_PARTS: ReadonlySet<string> = new Set(['move', 'acct', 'status', 'pct', 'reset']);

export function MetaLine({
  session,
  account,
  ceiling,
  now,
  phone,
  modeOnChip = false,
  noUsage = false,
}: {
  session: Session;
  account: Account | undefined;
  ceiling: number;
  now: number;
  phone: boolean;
  modeOnChip?: boolean;
  /** A server that reads no usage: the account by its alias, and no usage parts. */
  noUsage?: boolean;
}) {
  const single = useAccountsMode() === 'single' && session.node === undefined;
  const { w, pct } = usage(account, now);
  const parts: { key: string; node: ReactNode }[] = [];
  const acct =
    session.account === null
      ? 'unknown account'
      : noUsage && account?.alias
        ? account.alias
        : account?.alias
          ? `${accountId(session.account)} ${account.alias}`
          : accountId(session.account);
  if (session.move) {
    const m = session.move;
    parts.push({ key: 'move', node: `${accountId(m.from)} → ${m.to !== undefined ? accountId(m.to) : '?'} · ${m.step}` });
  } else {
    parts.push({ key: 'acct', node: <span>{acct}</span> });
  }
  if (noUsage) {
    // Nothing reads usage there.
  } else if (account && account.usageStatus !== 'ok') {
    parts.push({ key: 'status', node: <span className="text-signal-text">{usageStatusText(account.usageStatus)}</span> });
  } else if (pct !== null) {
    parts.push({
      key: 'pct',
      node: (
        <span>
          5h <span className={pastCeiling(pct, ceiling) ? 'text-signal-text' : 'text-ink-2'}>{pct}</span>
        </span>
      ),
    });
    const r = resetsText(w?.resetsAt, now);
    if (r) parts.push({ key: 'reset', node: `resets ${r}` });
  }
  const mode = modeOnChip ? null : modeWords(session.mode);
  if (mode) parts.push({ key: 'mode', node: mode });
  if (session.startedAt) parts.push({ key: 'start', node: `started ${agoLong(session.startedAt, now)}` });
  const shown = single ? parts.filter((p) => !ACCOUNT_PARTS.has(p.key)) : parts;
  // One login, the mode on the chip and no start time: nothing to say, so no empty line.
  if (!shown.length) return null;
  return (
    <p className={clsx('flex min-w-0 flex-none items-center overflow-hidden whitespace-nowrap type-mono text-ink-3', phone ? 'h-24 px-16' : 'h-32')}>
      <span className="min-w-0 truncate">
        {shown.map((p, i) => (
          <Fragment key={p.key}>
            {i > 0 ? <span aria-hidden="true"> · </span> : null}
            {p.node}
          </Fragment>
        ))}
      </span>
    </p>
  );
}

function Row({ k, children, className }: { k: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex min-h-32 items-start gap-8 border-b border-line py-7 first:border-t', className)}>
      <dt className="w-72 flex-none type-small text-ink-3">{k}</dt>
      <dd className="flex min-h-18 min-w-0 flex-1 flex-wrap items-center gap-x-8 gap-y-4 type-mono text-ink">{children}</dd>
    </div>
  );
}

export function Props({
  session,
  account,
  state,
  ceiling,
  now,
  onOpen,
  modeOnChip = false,
  noUsage = false,
}: {
  session: Session;
  account: Account | undefined;
  state: State;
  ceiling: number;
  now: number;
  onOpen: (sid: string) => void;
  modeOnChip?: boolean;
  /** A server that reads no usage: the account by its alias, and no 5-hour, resets or burn. */
  noUsage?: boolean;
}) {
  const single = useAccountsMode() === 'single' && session.node === undefined;
  const { w, pct } = usage(account, now);
  const id = session.account;
  const others = id === null ? [] : Object.values(state.sessions).filter((s) => s.account === id && s.sid !== session.sid);
  const burn = account?.projection?.burnPctPerMin;
  const mode = modeOnChip ? null : modeWords(session.mode);
  const reset = resetsText(w?.resetsAt, now);
  let note: string | null = null;
  if (w?.projectedExhaustionAt && w.resetsAt && Date.parse(w.projectedExhaustionAt) < Date.parse(w.resetsAt)) {
    note = `Full around ${clock(w.projectedExhaustionAt, now)} at this pace, before it resets.`;
  } else if (w?.willLastToReset) {
    note = 'Lasts to the reset at this pace.';
  }
  return (
    <aside aria-label="Session properties" className="w-220 flex-none pt-24">
      <dl className="flex flex-col">
        {single ? null : (
          <Row k="Account">
            {session.move ? (
              <>
                <span>{accountId(session.move.from)}</span>
                <span className="text-ink-3">→ {session.move.to !== undefined ? accountId(session.move.to) : '?'}</span>
              </>
            ) : noUsage && account?.alias ? (
              <span>{account.alias}</span>
            ) : (
              <>
                <span>{accountId(id)}</span>
                {account?.alias ? <span className="text-ink-3">{account.alias}</span> : null}
              </>
            )}
          </Row>
        )}
        {single || noUsage ? null : (
          <>
            <Row k="5-hour">
              {account && account.usageStatus !== 'ok' ? (
                <span className="text-signal-text">{usageStatusText(account.usageStatus)}</span>
              ) : (
                <>
                  <Meter value={pct} width={96} ceiling={ceiling} label={`${accountId(id)} 5-hour usage`} />
                  <span className={pastCeiling(pct, ceiling) ? 'text-signal-text' : undefined}>{pct === null ? '–' : `${pct}%`}</span>
                </>
              )}
            </Row>
            <Row k="Resets">
              {reset ? (
                reset.split(' · ').map((part, i) => (
                  <span key={i} className="whitespace-nowrap">
                    {i > 0 ? <span aria-hidden="true">· </span> : null}
                    {part}
                  </span>
                ))
              ) : (
                <span className="text-ink-3">no window open</span>
              )}
            </Row>
            {burn !== undefined ? <Row k="Burn">{`+${Math.round(burn * 60)}%/h`}</Row> : null}
          </>
        )}
        {mode ? <Row k="Mode">{mode}</Row> : null}
        {session.startedAt ? <Row k="Started">{agoLong(session.startedAt, now)}</Row> : null}
        <Row k="Folder">
          <span className="min-w-0 wrap-anywhere">
            {tildePath(session.cwd)
              .split('/')
              .map((part, i) => (
                <Fragment key={i}>
                  {i > 0 ? (
                    <>
                      /<wbr />
                    </>
                  ) : null}
                  {part}
                </Fragment>
              ))}
          </span>
        </Row>
        {session.subagentsRunning > 0 ? <Row k="Subagents">{session.subagentsRunning}</Row> : null}
        {id !== null && !single ? (
          <Row k={`Also on ${accountId(id)}`}>
            {others.length ? (
              <>
                <span className="-mx-4 flex items-center">
                  {others.slice(0, 8).map((o) => (
                    <button
                      key={o.sid}
                      type="button"
                      className="flex size-16 items-center justify-center rounded-chip hover:bg-hover coarse:size-44"
                      aria-label={`${o.folder} · ${o.name?.trim() || o.sid.slice(0, 8)}`}
                      onClick={() => onOpen(o.sid)}
                    >
                      <StatusGlyph state={glyphStateOf(state, o, now)} size="cell" />
                    </button>
                  ))}
                </span>
                <span className="text-ink-3">{others.length} more</span>
              </>
            ) : (
              <span className="text-ink-3">none</span>
            )}
          </Row>
        ) : null}
      </dl>
      {note && !single && !noUsage ? <p className="mt-12 type-small text-ink-3">{note}</p> : null}
    </aside>
  );
}
