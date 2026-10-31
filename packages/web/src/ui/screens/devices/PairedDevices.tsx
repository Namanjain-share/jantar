/**
 * Paired devices (admin): a Tailscale-style table. Two-line device cell
 * ("iPhone" over "Safari · iOS 26.1"), scopes as tags, when it was paired,
 * when it was last seen, and a "···" button that opens a row holding Revoke
 * (hold 2 s to commit). Revoked devices sink to the bottom in --ink-3.
 */
import { DotsThreeIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CLI_NAME, type DevicePublic } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { ago } from '../../../lib/format.js';
import { useDeps, useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { HoldButton } from '../../kit/HoldButton.js';
import { IconButton } from '../../kit/IconButton.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { Spinner } from '../../kit/Spinner.js';
import { Tag } from '../../kit/Tag.js';
import { describeAgent, readLocalDevice } from './local.js';
import { InlineError, NowMark, Receipt, shortDate } from './parts.js';

const NOW_MS = 2 * 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;

function Seen({ d, now }: { d: DevicePublic; now: number }) {
  if (d.revokedAt) return <span className="type-mono text-ink-3">revoked {shortDate(d.revokedAt)}</span>;
  const t = Date.parse(d.lastSeenAt);
  const age = Number.isFinite(t) ? now - t : Infinity;
  if (age < NOW_MS) return <NowMark />;
  return <span className="type-mono text-ink-2">{age > WEEK_MS ? shortDate(d.lastSeenAt) : ago(d.lastSeenAt, now)}</span>;
}

function sortDevices(list: DevicePublic[]): DevicePublic[] {
  return [...list].sort((a, b) => {
    const r = (a.revokedAt ? 1 : 0) - (b.revokedAt ? 1 : 0);
    return r || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
  });
}

function DeviceRow({
  d,
  now,
  mine,
  open,
  onToggle,
  onRevoke,
  error,
}: {
  d: DevicePublic;
  now: number;
  mine: boolean;
  open: boolean;
  onToggle: () => void;
  onRevoke: () => void;
  error: string | null;
}) {
  const panelId = useId();
  const more = useRef<HTMLButtonElement>(null);
  const revoked = Boolean(d.revokedAt);
  const agent = describeAgent(d.userAgent);
  return (
    <li className="border-b border-line">
      <div className="flex min-h-56 items-center gap-12 py-8 md:gap-16">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-8">
            <span className={clsx('truncate type-row font-medium', revoked ? 'text-ink-3' : 'text-ink')}>{d.name}</span>
            {mine ? <Tag>this device</Tag> : null}
            <span className="ml-auto flex-none pl-8 md:hidden">
              <span className="sr-only">last seen </span>
              <Seen d={d} now={now} />
            </span>
          </div>
          <div className="mt-2 truncate type-mono text-ink-3">
            {agent ? <span>{agent}</span> : <span className="md:hidden">paired {shortDate(d.createdAt)}</span>}
            <span className="md:hidden">
              {' · '}
              {d.scopes.join(', ')}
            </span>
          </div>
        </div>
        <div className="hidden w-200 flex-none flex-wrap gap-4 md:flex">
          <span className="sr-only">scopes </span>
          {d.scopes.map((s) => (
            <Tag key={s}>{s}</Tag>
          ))}
        </div>
        <div className="hidden w-72 flex-none type-mono text-ink-3 md:block">
          <span className="sr-only">paired </span>
          {shortDate(d.createdAt)}
        </div>
        <div className="hidden w-104 flex-none md:block">
          <span className="sr-only">last seen </span>
          <Seen d={d} now={now} />
        </div>
        {revoked ? (
          <span className="w-28 flex-none coarse:w-44" aria-hidden="true" />
        ) : (
          <IconButton ref={more} aria-label={`Actions for ${d.name}`} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle}>
            <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {open && !revoked ? (
        <div
          id={panelId}
          className="flex flex-col gap-12 pb-12 animate-pop md:flex-row md:items-center"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onToggle();
            more.current?.focus();
          }}
        >
          <p className="min-w-0 flex-1 type-small text-ink-2">
            {mine
              ? 'This is the device you are using. Revoking it signs it out here at once.'
              : `Revoking stops ${d.name} at once. Pairing it again brings it back.`}
          </p>
          <div className="flex flex-none items-center gap-8">
            <Button variant="text" onClick={onToggle}>
              Cancel
            </Button>
            <HoldButton onCommit={onRevoke} className="min-w-120">
              Revoke
            </HoldButton>
          </div>
          {error ? <InlineError className="md:basis-full">{error}</InlineError> : null}
        </div>
      ) : null}
    </li>
  );
}

export function PairedDevices({ onCount }: { onCount?: (active: number | null) => void }) {
  const { api } = useDeps();
  const now = useNow(30_000);
  const [devices, setDevices] = useState<DevicePublic[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; text: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const me = readLocalDevice();

  const needsAdmin = `Managing devices needs the admin scope. Do it from the Mac (${CLI_NAME} open) or from a device paired as admin.`;
  // A device that knows it was paired without admin does not ask (the daemon would answer 403).
  const notAdmin = me !== null && Array.isArray(me.scopes) && !me.scopes.includes('admin');
  const load = useCallback(async () => {
    if (notAdmin) {
      setProblem(needsAdmin);
      return;
    }
    try {
      const r = await api.listDevices();
      setDevices(r.devices);
      setProblem(null);
    } catch (e) {
      setProblem(isApiError(e, 'forbidden') ? needsAdmin : errorText(e));
    }
  }, [api, notAdmin, needsAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = devices ? devices.filter((d) => !d.revokedAt).length : null;
  useEffect(() => onCount?.(active), [active, onCount]);

  const revoke = async (d: DevicePublic) => {
    setFailed(null);
    try {
      await api.revokeDevice(d.id);
      setOpen(null);
      setDone(`${d.name} can no longer connect.`);
      await load();
    } catch (e) {
      setFailed({ id: d.id, text: errorText(e) });
    }
  };

  return (
    <section aria-label="Paired devices">
      <RailLabel ground="bg" sticky={false} inset={false} count={active ?? undefined} className="mt-40">
        Paired devices
      </RailLabel>
      {problem ? <p className="max-w-640 py-12 type-small text-ink-2">{problem}</p> : null}
      {!problem && devices === null ? (
        <div className="py-12">
          <Spinner label="Loading devices" />
        </div>
      ) : null}
      {devices?.length === 0 ? <p className="py-12 type-small text-ink-2">No devices yet.</p> : null}
      {devices?.length ? (
        <>
          <div aria-hidden="true" className="hidden h-28 items-center gap-16 border-b border-line type-rail text-ink-3 md:flex">
            <span className="min-w-0 flex-1">Device</span>
            <span className="w-200 flex-none">Scopes</span>
            <span className="w-72 flex-none">Paired</span>
            <span className="w-104 flex-none">Last seen</span>
            <span className="w-28 flex-none" />
          </div>
          <ul aria-label="Paired devices">
            {sortDevices(devices).map((d) => (
              <DeviceRow
                key={d.id}
                d={d}
                now={now}
                mine={me?.id === d.id}
                open={open === d.id}
                onToggle={() => {
                  setFailed(null);
                  setOpen((o) => (o === d.id ? null : d.id));
                }}
                onRevoke={() => void revoke(d)}
                error={failed?.id === d.id ? failed.text : null}
              />
            ))}
          </ul>
        </>
      ) : null}
      {done ? <Receipt className="mt-12">{done}</Receipt> : null}
    </section>
  );
}
