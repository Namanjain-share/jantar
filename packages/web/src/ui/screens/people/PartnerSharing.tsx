/**
 * v0.11 People: his Partner screen's Sharing and Activity tabs (spec 4.2,
 * 2.9, 8.3, C23, Q16), and the rows for someone invited or ending on his
 * People list (spec 2.3). In the lazy People chunk: his main load doesn't
 * carry any of it.
 *
 * Sharing:
 * - What {name} agreed to, in the words {name}'s page used for the live
 *   agreement (people-shared/join-copy.ts): he reads what she read.
 * - Ask for more: what she doesn't share yet, one request at a time. A
 *   pending one reads "Waiting for {name}"; the daemon's cooling-off and
 *   "Don't ask me about this again" come back as its sentence. Nothing
 *   changes until she says yes. Asking needs a device paired with admin
 *   (`jantar pair` doesn't give it): on any other device the sheet
 *   still lists what can be asked, and instead of a button that can only
 *   fail it shows the Mac command for what is ticked.
 * - {name}'s devices: name, when added and the Access email (no last
 *   seen, C20).
 * - Your pushes about {name}: the day summary (off until he picks a time),
 *   "{name} sent the evening review", and quiet hours. She sees on her
 *   Sharing whether the summary is on.
 *
 * Activity: her record in his voice ("You looked at Asha's Today"), newest
 * first, his views grouped per day (C28): the same rows she reads.
 */
import {
  AGREEMENT_FIELDS,
  BUILT_PHASE,
  OWNER_FALLBACK_NAME,
  PEOPLE_LABEL,
  PERSON_LABEL_MAX,
  PERSON_LABEL_PRESETS,
  fieldValue,
  levelOf,
  personLabelProblem,
  phaseBuilt,
  shortLabel,
  spaceLabel,
  type AgreementField,
  type AgreementFields,
} from '@jantar/protocol/people-core';
import type { OwnerPeoplePrefs, PeopleList, PersonActivity, PersonView } from '@jantar/protocol/people';
import { CLI_NAME } from '@jantar/protocol';
import { useEffect, useState } from 'react';
import { activityText, byDay, hisVoice } from '../../../people-shared/activity.js';
import { joinCopy } from '../../../people-shared/join-copy.js';
import { dayLabel, hmOf } from '../../../people-shared/time.js';
import { Button } from '../../kit/Button.js';
import { readLocalDevice } from '../devices/local.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import type { PeopleClient } from './client.js';

/** This device was paired with admin, or doesn't know its scopes (the daemon decides then). */
export function pairedWithAdmin(): boolean {
  const scopes = readLocalDevice()?.scopes;
  return !Array.isArray(scopes) || scopes.includes('admin');
}

/** CLI flags for each agreement group (cli/src/commands/people.ts fieldPatch). */
const GROUP_FLAG: Record<string, string> = { see: '--see', assign: '--assign', editHers: '--edit-hers', comment: '--comment' };

/** The Mac command that asks for what is ticked (`jantar people ask Asha --see sleep,meds=full`). */
export function askCommand(name: string, picked: Readonly<Record<string, string | boolean>>): string {
  const who = /^[\w.-]+$/.test(name) ? name : `"${name.replace(/["\\$`]/g, '')}"`;
  const parts = Object.entries(proposePatch(picked)).map(([group, fields]) => {
    const list = Object.entries(fields).map(([k, v]) => (typeof v === 'string' ? `${k}=${v}` : k));
    return `${GROUP_FLAG[group] ?? `--${group}`} ${list.join(',')}`;
  });
  return `${CLI_NAME} people ask ${who} ${parts.length ? parts.join(' ') : '--see <area>'}`;
}

/** What asking for one field means, in his words. */
const ASK_WORDS: Record<string, (n: string) => string> = {
  'see.todos': (n) => `See ${n}'s to-dos, reminders and projects`,
  'see.plan': (n) => `See ${n}'s day plan, check-ins and status`,
  'see.review': (n) => `See ${n}'s evening review`,
  'see.meds': (n) => `See ${n}'s medicines`,
  'see.weight': (n) => `See ${n}'s weight`,
  'see.sleep': (n) => `See ${n}'s sleep`,
  'see.journal': (n) => `Read ${n}'s journal`,
  'see.chat': (n) => `Read ${n}'s chats with their assistant`,
  'see.food': (n) => `See ${n}'s food log`,
  'assign.todos': (n) => `Add to-dos and reminders for ${n}`,
  'assign.plan': (n) => `Plan ${n}'s day`,
  'assign.meds': (n) => `Add medicines for ${n}`,
  'editHers.todos': (n) => `Edit or remove to-dos ${n} added`,
  'editHers.plan': (n) => `Edit or remove plan steps ${n} added`,
  'editHers.meds': (n) => `Edit or stop medicines ${n} added`,
  'editHers.weight': (n) => `Correct or remove a weight ${n} logged`,
  'comment.journal': (n) => `Comment on ${n}'s journal`,
};
const LEVEL_WORDS: Record<string, string> = { adherence: 'how often only, no names', full: 'in full', counts: 'the counts only' };

export function askLabel(f: AgreementField, name: string, level?: string | boolean): string {
  const base = ASK_WORDS[f.key]?.(name) ?? f.key;
  return typeof level === 'string' && LEVEL_WORDS[level] ? `${base}: ${LEVEL_WORDS[level]}` : base;
}

/** The built fields he could still ask for, each with the levels above where she is now. */
export function askable(a: AgreementFields, food: boolean, built = BUILT_PHASE): { f: AgreementField; levels: (string | boolean)[] }[] {
  return AGREEMENT_FIELDS.filter((f) => phaseBuilt(f.phase, built) && f.key !== 'assistant' && (f.key !== 'see.food' || food))
    .map((f) => ({ f, levels: (f.levels as readonly (string | boolean)[]).slice(levelOf(a, f) + 1) }))
    .filter((x) => x.levels.length > 0);
}

/** The picked levels as the propose body's patch ({see: {sleep: true}, …}). */
export function proposePatch(picked: Readonly<Record<string, string | boolean>>): Record<string, Record<string, string | boolean>> {
  const out: Record<string, Record<string, string | boolean>> = {};
  for (const [key, v] of Object.entries(picked)) {
    const f = AGREEMENT_FIELDS.find((x) => x.key === key);
    if (!f) continue;
    const [group, field] = f.path as [string, string];
    (out[group] ??= {})[field] = v;
  }
  return out;
}

const stripVersion = (a: NonNullable<PersonView['agreement']>): AgreementFields => {
  const { version: _v, ...fields } = a as AgreementFields & { version: number };
  return fields;
};

export function SharingTab({ client, pid, name, person, list, reload }: { client: PeopleClient; pid: string; name: string; person: PersonView | null; list: PeopleList | null; reload: () => void }) {
  const devices = useLifeLoad(`people:${pid}:devices`, () => client.devices(pid));
  const a = person?.agreement ? stripVersion(person.agreement) : null;
  if (!person || !a) return <p className="mt-12 type-small text-ink-2">Loading…</p>;
  const owner = list?.ownerName ?? OWNER_FALLBACK_NAME;
  const copy = joinCopy(owner, a, { built: BUILT_PHASE, foodModule: person.modules.food, label: person.label });
  return (
    <div className="mt-12 flex flex-col gap-16">
      <section aria-label={`What ${name} agreed to`}>
        <h2 className="type-row font-semibold text-ink">What {name} agreed to</h2>
        <p className="type-small text-ink-2">The words {name}'s page shows for what you see and do now. {name} can turn any of it down at any time.</p>
        <ul className="mt-8 list-disc pl-20 type-row text-ink">
          {[...copy.sees, ...copy.does].map((l) => (
            <li key={l.text} className="break-words">
              {l.text}
            </li>
          ))}
        </ul>
      </section>
      <AskForMore client={client} pid={pid} name={name} a={a} person={person} reload={reload} />
      <section aria-label={`${name}'s devices`}>
        <h2 className="type-row font-semibold text-ink">{name}'s devices</h2>
        {devices.data ? (
          devices.data.devices.length ? (
            <ul className="mt-4 type-row text-ink">
              {devices.data.devices.map((d) => (
                <li key={d.id} className="py-4">
                  {d.name}
                  <span className="block type-small text-ink-2">
                    Added {dayLabel(d.createdAt.slice(0, 10))}
                    {d.accessEmail ? ` · ${d.accessEmail}` : ''}
                    {d.revokedAt ? ' · revoked' : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-small text-ink-2">No devices yet.</p>
          )
        ) : (
          <p className="type-small text-ink-2">{devices.error instanceof Error ? devices.error.message : 'Loading…'}</p>
        )}
        <p className="mt-4 type-small text-ink-3">
          To revoke one: <code className="type-mono">{`${CLI_NAME} people revoke <device-id>`}</code> at the Mac.
        </p>
      </section>
      <OwnerPrefs client={client} name={name} prefs={list?.ownerPrefs ?? null} reload={reload} />
      <SpaceName client={client} pid={pid} name={name} label={person.label} reload={reload} />
    </div>
  );
}

/** The select's value for "Your own words" (no preset is spelled like it). */
const OWN_WORDS = '__own__';

/**
 * What the space with her is called (his label): a preset, or his own words (1 to 40 characters, plain text on
 * one line). Her app's name, the top of her Today and the pushes about it read it; the default is
 * "Accountability partner" (saved as no label). Text only: React renders it, nothing parses it.
 */
export function SpaceName({ client, pid, name, label, reload }: { client: PeopleClient; pid: string; name: string; label: string | undefined; reload: () => void }) {
  const current = spaceLabel(label);
  const isPreset = (l: string) => (PERSON_LABEL_PRESETS as readonly string[]).includes(l);
  const [choice, setChoice] = useState(isPreset(current) ? current : OWN_WORDS);
  const [own, setOwn] = useState(isPreset(current) ? '' : current);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setChoice(isPreset(current) ? current : OWN_WORDS);
    setOwn(isPreset(current) ? '' : current);
  }, [current]);
  const next = choice === OWN_WORDS ? own.trim() : choice;
  const problem = choice === OWN_WORDS ? personLabelProblem(own) : null;
  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      await client.setLabel(pid, next === PEOPLE_LABEL ? null : next);
      setNote(`Saved. ${name}'s app is called "${next}" now.`);
      reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const field = 'min-h-44 w-full max-w-[24rem] rounded-btn border border-line bg-bg px-8 type-row text-ink';
  return (
    <section aria-label="What this space is called">
      <h2 className="type-row font-semibold text-ink">What this space is called</h2>
      <p className="type-small text-ink-2">
        Now: <span className="break-words text-ink">{current}</span>. {name} sees it as the name of their app, at the top of their Today and on notifications. An app already on {name}'s Home Screen keeps the name it was added with.
      </p>
      <select aria-label="What this space is called" className={`mt-8 ${field}`} value={choice} onChange={(e) => setChoice(e.target.value)}>
        {PERSON_LABEL_PRESETS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        <option value={OWN_WORDS}>Your own words…</option>
      </select>
      {choice === OWN_WORDS ? (
        <label className="mt-8 flex flex-col gap-4">
          <span className="type-small text-ink-2">Your own words (up to {PERSON_LABEL_MAX} characters)</span>
          <input className={field} maxLength={PERSON_LABEL_MAX} value={own} onChange={(e) => setOwn(e.target.value)} />
        </label>
      ) : null}
      {choice === OWN_WORDS && own.length > 0 && problem ? <p className="mt-4 type-small text-ink-2">{problem}</p> : null}
      {problem === null && next.length > 0 ? (
        // An icon added to her Home Screen takes a name of at most 12 characters: show it before he saves.
        <p className="mt-4 break-words type-small text-ink-2">
          {name}'s Home Screen title: {shortLabel(next)}
        </p>
      ) : null}
      <Button variant="outline" className="mt-8 min-h-44" disabled={busy || problem !== null || next === current} onClick={() => void save()}>
        Save
      </Button>
      {note ? (
        <p role="status" className="mt-4 break-words type-small text-ink">
          {note}
        </p>
      ) : null}
    </section>
  );
}

function AskForMore({ client, pid, name, a, person, reload }: { client: PeopleClient; pid: string; name: string; a: AgreementFields; person: PersonView; reload: () => void }) {
  const [picked, setPicked] = useState<Record<string, string | boolean>>({});
  const [note, setNote] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = person.pendingProposal;
  if (pending) {
    const asked = AGREEMENT_FIELDS.filter((f) => levelOf(pending.fields, f) > levelOf(a, f));
    return (
      <section aria-label="Ask for more">
        <h2 className="type-row font-semibold text-ink">Ask for more</h2>
        <p className="type-row text-ink">Waiting for {name}'s answer. Nothing changes until {name} says yes.</p>
        <ul className="mt-4 list-disc pl-20 type-small text-ink-2">
          {asked.map((f) => (
            <li key={f.key}>{askLabel(f, name, fieldValue(pending.fields, f))}</li>
          ))}
        </ul>
      </section>
    );
  }
  const options = askable(a, person.modules.food);
  const admin = pairedWithAdmin();
  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      await client.propose(pid, { ...proposePatch(picked), ...(note.trim() ? { note: note.trim() } : {}) });
      setPicked({});
      setNote('');
      setResult(`Asked. ${name} sees it on Today and Sharing; nothing changes until ${name} says yes.`);
      reload();
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Ask for more">
      <h2 className="type-row font-semibold text-ink">Ask for more</h2>
      {options.length === 0 ? (
        <p className="type-small text-ink-2">{name} already shares everything this version offers.</p>
      ) : (
        <>
          <ul className="mt-4">
            {options.map(({ f, levels }) =>
              levels.length === 1 ? (
                <li key={f.key}>
                  <label className="flex min-h-44 items-center gap-8 type-row text-ink">
                    <input
                      type="checkbox"
                      className="size-20"
                      checked={picked[f.key] !== undefined}
                      onChange={(e) => setPicked(({ [f.key]: _drop, ...rest }) => (e.target.checked ? { ...rest, [f.key]: levels[0] as string | boolean } : rest))}
                    />
                    {askLabel(f, name, levels[0])}
                  </label>
                </li>
              ) : (
                <li key={f.key}>
                  <label className="flex min-h-44 flex-wrap items-center gap-8 type-row text-ink">
                    <span>{askLabel(f, name)}</span>
                    <select
                      className="min-h-44 rounded-btn border border-line bg-bg px-8"
                      value={String(picked[f.key] ?? '')}
                      onChange={(e) => setPicked(({ [f.key]: _drop, ...rest }) => (e.target.value ? { ...rest, [f.key]: e.target.value } : rest))}
                    >
                      <option value="">No change</option>
                      {levels.map((l) => (
                        <option key={String(l)} value={String(l)}>
                          {LEVEL_WORDS[String(l)] ?? String(l)}
                        </option>
                      ))}
                    </select>
                  </label>
                </li>
              ),
            )}
          </ul>
          {admin ? (
            <>
              <label className="mt-8 flex flex-col gap-4">
                <span className="type-small text-ink-2">A note for {name} (optional)</span>
                <input className="min-h-44 rounded-btn border border-line bg-bg px-8 type-row text-ink" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <Button variant="outline" className="mt-8 min-h-44" disabled={busy || Object.keys(picked).length === 0} onClick={() => void send()}>
                Ask {name}
              </Button>
            </>
          ) : (
            <p className="mt-8 type-small text-ink-2">
              Asking needs a device paired with admin, and this one isn't. At your Mac:{' '}
              <code className="type-mono break-all text-ink [overflow-wrap:anywhere]">{askCommand(name, picked)}</code>
            </p>
          )}
        </>
      )}
      {result ? (
        <p role="status" className="mt-8 type-small text-ink">
          {result}
        </p>
      ) : null}
      <p className="mt-4 type-small text-ink-3">One request at a time. If {name} says no, you can ask again after a while; if {name} asks you not to, you can't.</p>
    </section>
  );
}

function OwnerPrefs({ client, name, prefs, reload }: { client: PeopleClient; name: string; prefs: OwnerPeoplePrefs | null; reload: () => void }) {
  const [summary, setSummary] = useState(false);
  const [summaryAt, setSummaryAt] = useState('21:00');
  const [reviewPush, setReviewPush] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!prefs) return;
    setSummary(prefs.summaryAt !== undefined);
    setSummaryAt(prefs.summaryAt ?? '21:00');
    setReviewPush(prefs.reviewPush);
    setFrom(prefs.quiet?.from ?? '');
    setTo(prefs.quiet?.to ?? '');
  }, [prefs]);
  if (!prefs) return null;
  const quietOk = (from === '') === (to === '');
  const save = async () => {
    try {
      await client.setPrefs({ summaryAt: summary ? summaryAt : null, reviewPush, quiet: from && to ? { from, to } : null });
      setNote('Saved.');
      reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };
  const field = 'min-h-44 rounded-btn border border-line bg-bg px-8 type-row text-ink';
  return (
    <section aria-label={`Your pushes about ${name}`}>
      <h2 className="type-row font-semibold text-ink">Your pushes about {name}</h2>
      <label className="flex min-h-44 flex-wrap items-center gap-8 type-row text-ink">
        <input type="checkbox" className="size-20" checked={summary} onChange={(e) => setSummary(e.target.checked)} /> A day summary at
        <input type="time" aria-label="Day summary time" className={field} value={summaryAt} disabled={!summary} onChange={(e) => setSummaryAt(e.target.value || '21:00')} />
      </label>
      <p className="type-small text-ink-3">Off unless you turn it on. {name} sees on Sharing whether it is on.</p>
      <label className="flex min-h-44 items-center gap-8 type-row text-ink">
        <input type="checkbox" className="size-20" checked={reviewPush} onChange={(e) => setReviewPush(e.target.checked)} /> Tell me when {name} sends the evening review
      </label>
      <div className="flex flex-wrap items-end gap-8">
        <label className="flex flex-col gap-4">
          <span className="type-small text-ink-2">Quiet from</span>
          <input type="time" className={field} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-4">
          <span className="type-small text-ink-2">Quiet until</span>
          <input type="time" className={field} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {!quietOk ? <p className="type-small text-ink-2">Quiet hours need both times, or neither.</p> : null}
      <Button variant="outline" className="mt-8 min-h-44" disabled={!quietOk} onClick={() => void save()}>
        Save
      </Button>
      {note ? (
        <p role="status" className="mt-4 type-small text-ink">
          {note}
        </p>
      ) : null}
    </section>
  );
}

export function ActivityTab({ client, pid, name }: { client: PeopleClient; pid: string; name: string }) {
  const load = useLifeLoad(`people:${pid}:activity`, () => client.activity(pid));
  const [older, setOlder] = useState<{ rows: PersonActivity[]; before: number | null } | null>(null);
  const rows = [...(load.data?.activity ?? []), ...(older?.rows ?? [])];
  const before = older ? older.before : (load.data?.before ?? null);
  const more = async () => {
    if (before === null) return;
    const r = await client.activity(pid, before);
    setOlder({ rows: [...(older?.rows ?? []), ...r.activity], before: r.before });
  };
  if (!load.data) return <p className="mt-12 type-small text-ink-2">Loading…</p>;
  const voice = hisVoice(name);
  return (
    <div className="mt-12 flex flex-col gap-16">
      <p className="type-small text-ink-2">{name}'s record of every change you make in {name}'s space, and each time you look. {name} reads the same rows.</p>
      {rows.length === 0 ? <p className="type-small text-ink-2">Nothing yet.</p> : null}
      {byDay(rows).map(({ day, groups }) => (
        <section key={day} aria-label={dayLabel(day)}>
          <h2 className="type-small font-semibold text-ink-2">{dayLabel(day)}</h2>
          <ul className="mt-4 flex flex-col gap-8 type-row text-ink">
            {groups.map((g) => (
              <li key={g.key} className="break-words">
                <span className="text-ink-2">{hmOf(g.row.at)}</span> {activityText(voice, g.row)}
                {g.count > 1 ? ` ${g.count} times · last ${hmOf(g.row.at)}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {before !== null ? (
        <Button variant="text" className="min-h-44" onClick={() => void more()}>
          Earlier
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Someone invited (link until …, "Copy link again" on an admin device), whose sharing is ending, or who
 * left (their data kept 30 days, then deleted), on his People list: what happened and the next step.
 */
export function NotSharingRow({ client, p }: { client: PeopleClient; p: PersonView }) {
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const until = (iso: string) => `${dayLabel(iso.slice(0, 10))} ${hmOf(iso)}`;
  const again = async () => {
    setNote(null);
    try {
      const r = await client.inviteLink(p.id);
      setLink(r.url);
      await navigator.clipboard?.writeText(r.url).then(
        () => setNote('Copied.'),
        () => undefined,
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <li className="border-b border-line py-8">
      <p className="type-row text-ink">{p.name}</p>
      {p.state === 'invited' ? (
        <>
          <p className="type-small text-ink-2">
            Invited{p.invite ? ` · the link works once, until ${until(p.invite.expiresAt)}` : ' · no link yet'}. {p.name} joins from it on {p.name}'s own phone.
          </p>
          {p.invite?.linkAvailable && pairedWithAdmin() ? (
            <Button variant="outline" className="mt-4 min-h-44" onClick={() => void again()}>
              Copy link again
            </Button>
          ) : null}
          {link ? <p className="mt-4 break-all type-small text-ink [overflow-wrap:anywhere]">{link}</p> : null}
          {note ? (
            <p role="status" className="type-small text-ink-2">
              {note}
            </p>
          ) : null}
          <p className="mt-4 type-small text-ink-3">
            A new link: <code className="type-mono">{`${CLI_NAME} people invite ${p.name}`}</code> at the Mac.
          </p>
        </>
      ) : p.state === 'left' ? (
        <>
          <p className="type-small text-ink-2">
            Sharing has ended. Nothing of {p.name}'s shows here now: their data stays on this Mac for 30 days after it ended, then it is deleted.
          </p>
          <p className="mt-4 type-small text-ink-3">
            To share again: <code className="type-mono">{`${CLI_NAME} people add ${p.name} --email <address>`}</code>, then{' '}
            <code className="type-mono">{`${CLI_NAME} people invite ${p.name}`}</code> at the Mac. To delete their data now:{' '}
            <code className="type-mono break-all [overflow-wrap:anywhere]">{`${CLI_NAME} people remove ${p.id} --forget`}</code>.
          </p>
        </>
      ) : (
        <p className="type-small text-ink-2">Sharing ends{p.endingUntil ? ` ${until(p.endingUntil)}` : ''}. {p.name} can download their data until then.</p>
      )}
    </li>
  );
}
