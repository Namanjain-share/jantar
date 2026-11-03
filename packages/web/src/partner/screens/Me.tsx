/**
 * v0.11 People: Me (`/p/me?tab=…`): Sharing, Activity, Devices,
 * Notifications, Leave, plus Pause and Export (spec 3.8, P1).
 *
 * - Sharing is rendered from `me.agreement`, the object every view of her
 *   reads (no second copy). Its switches only lower (narrow applies before
 *   his next read). It lists his devices that can open her space, and
 *   "See what {owner} sees" opens each area as he gets it (her mirror).
 * - Activity: newest first, under day headers, in plain words with HH:MM;
 *   his views of an area are grouped per day (C28).
 * - Devices: hers, with last seen and the Access email they joined with;
 *   Revoke; Link another device (a 5-minute code).
 * - Notifications: turn on and test, lock screen, mute.
 * - Leave: download first, keep 30 days or delete now, type LEAVE.
 */
import { AGREEMENT_FIELDS, AREAS, closeDependents, phaseBuilt, fieldsChanged, withField, type AgreementFields, type AgreementPatch, CHAT_KEEP_DAYS } from '@jantar/protocol/people-core';
import type { PersonActivity, PersonMe, PersonPrefsPatch } from '@jantar/protocol/people';
import { Suspense, lazy, useEffect, useState } from 'react';
import { activityText, byDay, localDayOf } from '../../people-shared/activity.js';
import { dayLabel, hmOf } from '../../people-shared/time.js';
import { Button } from '../../ui/kit/Button.js';
import { navigate } from '../nav.js';
import type { PersonApi, PersonDevice } from '../api.js';
import { joinCopy, levelLabel, lowerLevels, switchLabel } from '../../people-shared/join-copy.js';
import { turnOnNotifications } from '../notify.js';
import { ME_TABS, type MeTab } from '../router.js';
import { ProposalCard } from './Today.js';

export { activityText, byDay, groupViews } from '../../people-shared/activity.js';

const TAB_LABEL: Record<MeTab, string> = { sharing: 'Sharing', activity: 'Activity', devices: 'Devices', notifications: 'Notifications', leave: 'Leave' };

// "See what {owner} sees": loads when she opens one area.
const Mirror = lazy(() => import('./Mirror.js'));

/** The `see` fields with a view in this build, and the mirror area each opens. */
const MIRROR_AREA: Record<string, string> = {
  'see.todos': 'todos',
  'see.meds': 'meds',
  'see.weight': 'weight',
  'see.food': 'food',
  'see.plan': 'plan',
  'see.review': 'review',
  'see.sleep': 'sleep',
  'see.journal': 'journal',
  'see.chat': 'chat',
};

export function Me({ me, api, reload, tab, see }: { me: PersonMe; api: PersonApi; reload: () => void; tab: MeTab; see?: string | null }) {
  return (
    <div>
      <div role="tablist" className="flex flex-wrap gap-4 border-b border-line">
        {ME_TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={t === tab}
            className={`min-h-44 px-8 text-small ${t === tab ? 'font-medium text-ink' : 'text-ink-2'}`}
            onClick={() => navigate(`/p/me?tab=${t}`)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="pt-16">
        {tab === 'sharing' && see ? (
          <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
            <Mirror me={me} api={api} area={see} />
          </Suspense>
        ) : null}
        {tab === 'sharing' && !see ? <Sharing me={me} api={api} reload={reload} /> : null}
        {tab === 'activity' ? <Activity api={api} owner={me.owner.name} /> : null}
        {tab === 'devices' ? <Devices api={api} /> : null}
        {tab === 'notifications' ? <Notifications me={me} api={api} reload={reload} /> : null}
        {tab === 'leave' ? <Leave me={me} api={api} reload={reload} /> : null}
      </div>
    </div>
  );
}

/** The patch that turns `from` into `to` (her narrowing). */
function patchOf(from: AgreementFields, to: AgreementFields): AgreementPatch {
  const out: Record<string, Record<string, unknown> | boolean> = {};
  for (const key of fieldsChanged(from, to)) {
    const f = AGREEMENT_FIELDS.find((x) => x.key === key);
    if (!f) continue;
    const [group, name] = f.path;
    const value = name === undefined ? to[group] : (to[group] as unknown as Record<string, unknown>)[name];
    if (name === undefined) out[group] = value as boolean;
    else out[group] = { ...((out[group] as Record<string, unknown>) ?? {}), [name]: value };
  }
  return out as AgreementPatch;
}

/** The pushes the owner gets about her unasked (spec 3.8), so none of them is ever a surprise. */
export function toldWithoutLooking(me: PersonMe): string[] {
  const a = me.agreement;
  const o = me.owner.name;
  const out = ['When you join, pause, resume, leave or change what you share', `Alerts you send ${o}, and your replies to ${o}'s alerts`];
  if (a?.assign.todos || a?.assign.plan) out.push(`When an item ${o} asked about ("Tell me if not done by") is still open at that time: its title only`);
  if (a?.see.meds === 'full') out.push(`When you change or stop a medicine ${o} added (it doesn't say which or how)`);
  if (a?.see.plan) out.push('When you mark a rough day (one line, no details)');
  if (a?.see.review !== 'off' && me.ownerTells?.reviewPush !== false) out.push('When you send your evening review (no note text)');
  if (a?.see.journal) out.push('When you reply to a comment in your journal (no text)');
  if (me.ownerTells?.summaryAt) {
    const kcal = me.person.modules.food && a?.see.food === 'full';
    out.push(`A day summary at ${me.ownerTells.summaryAt} (counts only${kcal ? ", and your day's calories" : ''}: never journal, chat or sleep${me.person.modules.food ? ', or what you ate' : ''})`);
  }
  return out;
}

export function Sharing({ me, api, reload }: { me: PersonMe; api: PersonApi; reload: () => void }) {
  const a = me.agreement;
  const [error, setError] = useState<string | null>(null);
  if (!a) return <p>Nothing is shared.</p>;
  const copy = joinCopy(me.owner.name, a, { built: me.built, foodModule: me.person.modules.food });
  return (
    <div>
      {me.pending ? <ProposalCard me={me} api={api} reload={reload} /> : null}
      <h2 className="mt-8 font-semibold">What {me.owner.name} can see</h2>
      <p className="mt-4">
        <SeeLink owner={me.owner.name} area="today" label={`See ${me.owner.name}'s Today of you`} />
      </p>
      <ul className="mt-8 flex flex-col gap-12">
        {copy.sees.map((line) => (
          <li key={line.text} className="flex flex-wrap items-start justify-between gap-x-12 gap-y-4">
            <span className="min-w-0 flex-1 basis-[14rem]">
              {line.text}
              {line.key && MIRROR_AREA[line.key] && line.level !== false && line.level !== 'off' ? (
                <span className="block">
                  <SeeLink owner={me.owner.name} area={MIRROR_AREA[line.key] as string} />
                </span>
              ) : null}
            </span>
            {lowerLevels(line).length > 0 ? (
              <select
                aria-label={switchLabel(me.owner.name, line.key)}
                className="min-h-44 rounded-btn border border-line bg-bg px-8"
                value={String(line.level)}
                onChange={(e) => {
                  const field = AGREEMENT_FIELDS.find((f) => f.key === line.key);
                  const picked = line.levels?.find((l) => String(l) === e.target.value);
                  if (!field || picked === undefined) return;
                  const next = closeDependents(withField(a, field, picked));
                  api.narrow(patchOf(a, next)).then(reload, (err: Error) => setError(err.message));
                }}
              >
                {[...lowerLevels(line), line.level].map((l) => (
                  <option key={String(l)} value={String(l)}>
                    {levelLabel(l as string | boolean)}
                  </option>
                ))}
              </select>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <p role="alert">{error}</p> : null}
      <h2 className="mt-24 font-semibold">What {me.owner.name} can do</h2>
      <ul className="mt-8 list-disc pl-20">{copy.does.map((l) => <li key={l.text}>{l.text}</li>)}</ul>
      <h2 className="mt-24 font-semibold">Who can open your space</h2>
      <ul className="mt-8 list-disc pl-20">
        {me.ownerDevices.map((d) => (
          <li key={`${d.name}-${d.createdAt}`}>{d.name}</li>
        ))}
        <li>{me.owner.name}'s Mac (the jantar command, and programs {me.owner.name} runs there)</li>
      </ul>
      {/* Her food module (O6): on or off is the Mac's switch; what he sees of it is the line above. */}
      {phaseBuilt(AREAS.food, me.built) ? (
        <p className="mt-16 text-small text-ink-2">Food: {me.person.modules.food ? 'on' : `off (${me.owner.name} set this up without a food log)`}</p>
      ) : null}
      <h2 className="mt-24 font-semibold">What {me.owner.name} is told without looking</h2>
      <ul className="mt-8 list-disc pl-20">
        {toldWithoutLooking(me).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <div className="mt-24 flex gap-12">
        {me.person.state === 'paused' ? (
          <Button variant="primary" onClick={() => void api.resume().then(reload)}>
            Resume
          </Button>
        ) : (
          <Button variant="outline" onClick={() => void api.pause().then(reload)}>
            Pause
          </Button>
        )}
        <a className="inline-flex min-h-44 items-center underline" href={api.exportUrl('html')}>
          Download my data
        </a>
      </div>
    </div>
  );
}

function Activity({ api, owner }: { api: PersonApi; owner: string }) {
  const [rows, setRows] = useState<PersonActivity[] | null>(null);
  useEffect(() => {
    api.activity().then((r) => setRows(r.activity), () => setRows([]));
  }, [api]);
  if (!rows) return <p>Loading…</p>;
  if (rows.length === 0) return <p>Nothing yet.</p>;
  return (
    <div className="flex flex-col gap-16">
      {byDay(rows).map(({ day, groups }) => (
        <section key={day} aria-label={dayLabel(day)}>
          <h2 className="text-small font-semibold text-ink-2">{dayLabel(day)}</h2>
          <ul className="mt-4 flex flex-col gap-8">
            {groups.map((g) => (
              <li key={g.key} className="break-words">
                <span className="text-ink-2">{hmOf(g.row.at)}</span> {activityText(owner, g.row)}
                {g.count > 1 ? ` ${g.count} times · last ${hmOf(g.row.at)}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** "See what {owner} sees" of one area: her mirror, exactly his view. */
function SeeLink({ owner, area, label }: { owner: string; area: string; label?: string }) {
  return (
    <a
      href={`/p/me?tab=sharing&see=${area}`}
      className="inline-flex min-h-44 items-center text-small text-ink-2 underline"
      onClick={(e) => {
        e.preventDefault();
        navigate(`/p/me?tab=sharing&see=${area}`);
      }}
    >
      {label ?? `See what ${owner} sees`}
    </a>
  );
}

function Devices({ api }: { api: PersonApi }) {
  const [devices, setDevices] = useState<PersonDevice[] | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.devices().then((r) => setDevices(r.devices), (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div>
      <ul className="flex flex-col gap-8">
        {(devices ?? []).map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-12">
            <span>
              {d.name}
              {d.current ? ' (this one)' : ''}
              <span className="block text-small text-ink-2">
                Last used {dayLabel(localDayOf(d.lastSeenAt))}
                {d.accessEmail ? ` · ${d.accessEmail}` : ''}
              </span>
            </span>
            <Button variant="outline" className="min-h-44" onClick={() => void api.revokeDevice(d.id).then(load)}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      <Button className="mt-16" variant="outline" onClick={() => void api.linkCode().then((r) => setCode(r.code), (e: Error) => setError(e.message))}>
        Link another device
      </Button>
      {code ? (
        <p className="mt-8 break-all">
          On the other device open <code>/p/link</code> and enter: <code>{code}</code> (5 minutes)
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

function Notifications({ me, api, reload }: { me: PersonMe; api: PersonApi; reload: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const turnOn = async () => setNote(await turnOnNotifications(api));
  const mute = (hours: number | null) => {
    const until = hours === null ? null : new Date(Date.now() + hours * 3600_000).toISOString();
    void api.prefs({ muteUntil: until }).then(reload);
  };
  return (
    <div className="flex flex-col gap-12">
      <Button variant="primary" onClick={() => void turnOn()}>
        Turn on notifications
      </Button>
      {note ? <p role="status">{note}</p> : null}
      <label className="flex min-h-44 items-center justify-between gap-12">
        <span>Lock screen</span>
        <select
          className="min-h-44 rounded-btn border border-line bg-bg px-8"
          value={me.person.prefs.lockScreen}
          onChange={(e) => void api.prefs({ lockScreen: e.target.value as 'all' | 'hide_alerts' | 'hide_all' }).then(reload)}
        >
          <option value="all">Show everything</option>
          <option value="hide_alerts">Hide alert text from {me.owner.name}</option>
          <option value="hide_all">Hide everything</option>
        </select>
      </label>
      <div className="flex flex-wrap gap-8">
        <Button variant="outline" className="min-h-44" onClick={() => mute(1)}>
          Mute 1 h
        </Button>
        <Button variant="outline" className="min-h-44" onClick={() => mute(8)}>
          Mute 8 h
        </Button>
        <Button variant="text" className="min-h-44" onClick={() => mute(null)}>
          Unmute
        </Button>
      </div>
      {me.person.prefs.muteUntil ? <p className="text-small text-ink-2">Muted until {hmOf(me.person.prefs.muteUntil)}</p> : null}
      <P2Prefs me={me} api={api} reload={reload} />
    </div>
  );
}

/** Her P2 notification settings (spec 3.6, 3.8, 6.3): quiet hours, Urgent, times, holds, caps and ring switches. */
function P2Prefs({ me, api, reload }: { me: PersonMe; api: PersonApi; reload: () => void }) {
  const p = me.person.prefs;
  const owner = me.owner.name;
  const [error, setError] = useState<string | null>(null);
  const save = (patch: PersonPrefsPatch) => void api.prefs(patch).then(() => (setError(null), reload()), (e: Error) => setError(e.message));
  const caps = p.alertCaps;
  const row = 'flex min-h-44 items-center justify-between gap-12';
  const select = 'min-h-44 rounded-btn border border-line bg-bg px-8';
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return (
    <div className="mt-12 flex flex-col gap-8">
      <h2 className="font-semibold">Quiet hours</h2>
      <div className={row}>
        <label className="flex min-h-44 items-center gap-8">
          <input type="checkbox" checked={p.quiet !== undefined} onChange={(e) => save({ quiet: e.target.checked ? { from: '22:00', to: '07:00' } : null })} /> Quiet hours
        </label>
        {p.quiet ? (
          <span className="flex items-center gap-4">
            <input aria-label="Quiet from" type="time" className={select} value={p.quiet.from} onChange={(e) => p.quiet && save({ quiet: { ...p.quiet, from: e.target.value } })} />–
            <input aria-label="Quiet to" type="time" className={select} value={p.quiet.to} onChange={(e) => p.quiet && save({ quiet: { ...p.quiet, to: e.target.value } })} />
          </span>
        ) : null}
      </div>
      <label className={row}>
        <span>Urgent from {owner} breaks through quiet hours</span>
        <input type="checkbox" checked={p.urgentBreaksQuiet} onChange={(e) => save({ urgentBreaksQuiet: e.target.checked })} />
      </label>
      <label className={row}>
        <span>Hold alerts while I sleep</span>
        <input type="checkbox" checked={p.sleepHolds} onChange={(e) => save({ sleepHolds: e.target.checked })} />
      </label>
      <label className={row}>
        <span>Plan push time</span>
        <input type="time" className={select} value={p.planPushAt} onChange={(e) => save({ planPushAt: e.target.value })} />
      </label>
      <label className={row}>
        <span>Evening review time</span>
        <input type="time" min="17:00" max="23:30" className={select} value={p.reviewAt} onChange={(e) => save({ reviewAt: e.target.value })} />
      </label>
      <label className={row}>
        <span>Hide my journal streak (on my screens and {owner}'s)</span>
        <input type="checkbox" checked={p.hideStreaks} onChange={(e) => save({ hideStreaks: e.target.checked })} />
      </label>
      <label className={row}>
        <span>Keep my assistant chat for</span>
        <select className={select} value={String(p.chatKeepDays)} onChange={(e) => save({ chatKeepDays: Number(e.target.value) as 1 | 7 | 30 })}>
          {CHAT_KEEP_DAYS.map((d) => (
            <option key={d} value={String(d)}>
              {d === 1 ? '1 day' : `${d} days`}
            </option>
          ))}
        </select>
      </label>
      <h2 className="mt-12 font-semibold">From your plan</h2>
      {(
        [
          ['steps', 'Ring for plan steps'],
          ['between', 'Ring for check-betweens'],
          ['planChanges', `Tell me when ${owner} changes my plan`],
        ] as const
      ).map(([k, label]) => (
        <label key={k} className={row}>
          <span>{label}</span>
          <input type="checkbox" checked={p.rings[k]} onChange={(e) => save({ rings: { [k]: e.target.checked } })} />
        </label>
      ))}
      <h2 className="mt-12 font-semibold">Limits on alerts from {owner}</h2>
      {(
        [
          ['hour', 'Alerts an hour', range(1, 12)],
          ['day', 'Alerts a day', range(3, 40)],
          ['urgentDay', 'Urgent a day', range(1, 6)],
          ['nudgeDay', 'Reminders a day', range(0, 15)],
        ] as const
      ).map(([k, label, values]) => (
        <label key={k} className={row}>
          <span>{label}</span>
          <select className={select} value={caps[k]} onChange={(e) => save({ alertCaps: { ...caps, [k]: Number(e.target.value) } })}>
            {values.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      ))}
      <label className={row}>
        <span>Reminders about one item</span>
        <select className={select} value={caps.nudgeGapMin} onChange={(e) => save({ alertCaps: { ...caps, nudgeGapMin: Number(e.target.value) === 30 ? 30 : 60 } })}>
          <option value={60}>1 an hour</option>
          <option value={30}>1 per 30 min</option>
        </select>
      </label>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

function Leave({ me, api, reload }: { me: PersonMe; api: PersonApi; reload: () => void }) {
  const [data, setData] = useState<'keep30' | 'delete'>('keep30');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-12">
      <p>1. Download your data first.</p>
      <p>
        <a className="inline-flex min-h-44 items-center underline" href={api.exportUrl('html')}>Download as a page</a> ·{' '}
        <a className="inline-flex min-h-44 items-center underline" href={api.exportUrl('json')}>data file (JSON)</a>
      </p>
      <p>2. What happens to your data on {me.owner.name}'s Mac?</p>
      <label className="flex min-h-44 items-center gap-8">
        <input type="radio" checked={data === 'keep30'} onChange={() => setData('keep30')} /> Keep it for 30 days, then delete it
      </label>
      <label className="flex min-h-44 items-center gap-8">
        <input type="radio" checked={data === 'delete'} onChange={() => setData('delete')} /> Delete it now
      </label>
      <label className="flex flex-col gap-4">
        <span>3. Type LEAVE to confirm</span>
        <input aria-label="Type LEAVE" className="rounded-btn border border-line bg-bg px-8 py-8" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <Button
        variant="primary"
        disabled={typed !== 'LEAVE'}
        onClick={() =>
          void api.leave(data).then(
            () => {
              navigate('/p/left');
              reload();
            },
            (e: Error) => setError(e.message),
          )
        }
      >
        Leave
      </Button>
    </div>
  );
}
