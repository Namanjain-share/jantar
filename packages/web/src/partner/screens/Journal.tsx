/**
 * v0.11 People: her journal (`/p/journal`, spec 3.11), a lazy screen. The
 * header always says who can read it. A one-tap check-in row (five faces,
 * then up to three emotion chips), "+ Write", entries newest first grouped
 * by day with their comment counts, and the streak unless she hides it
 * (milestones show once, here only). An entry opens with its comments: she
 * edits and deletes her entries and her own comments, never his.
 */
import { EMOTIONS, EMOTION_NAMES, type Emotion } from '@jantar/protocol/people-core';
import type { JournalEntryFull, JournalList, PersonMe } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { Faces } from '../../people-shared/Faces.js';
import { JournalEntryCard } from '../../people-shared/JournalEntryCard.js';
import { dayLabel, hmOf } from '../../people-shared/time.js';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { navigate } from '../nav.js';
import { Field, Sheet } from '../ui.js';

export default function Journal({ me, api, id, checkin, tick }: { me: PersonMe; api: PersonApi; id: string | null; checkin: boolean; tick: number }) {
  const [list, setList] = useState<JournalList | null>(null);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.journal().then(setList, (e: Error) => setError(e.message)), [api]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  const owner = me.owner.name;
  const sees = me.agreement?.see.journal === true;
  const comments = sees && me.agreement?.comment.journal === true;
  if (id) return <EntryView api={api} id={id} owner={owner} tick={tick} onGone={() => navigate('/p/journal')} />;
  const days: [string, JournalList['entries']][] = [];
  for (const e of list?.entries ?? []) {
    const last = days[days.length - 1];
    if (last && last[0] === e.day) last[1].push(e);
    else days.push([e.day, [e]]);
  }
  return (
    <div>
      <header className="flex items-baseline justify-between">
        <h1 className="text-title font-semibold">Journal</h1>
        <Button variant="primary" onClick={() => setWriting(true)}>
          + Write
        </Button>
      </header>
      <p className="mt-4 text-small text-ink-2">
        {sees ? `${owner} can read your journal${comments ? ' and comment on it' : ''}.` : `${owner} can't open your journal in Jantar. It is stored on ${owner}'s Mac.`}
      </p>
      {list?.streak && list.streak.current > 0 ? (
        <p className="mt-4 text-small">
          {list.streak.milestoneToday ? `${list.streak.milestoneToday} days in a row today.` : `${list.streak.current} day${list.streak.current === 1 ? '' : 's'} in a row`}
        </p>
      ) : null}
      <CheckinRow api={api} open={checkin} done={() => void load()} />
      {error ? <p role="alert">{error}</p> : null}
      {list?.prompt ? <p className="mt-12 text-ink-2">{list.prompt}</p> : null}
      {days.map(([d, entries]) => (
        <section key={d} aria-label={dayLabel(d)} className="mt-16">
          <h2 className="text-small font-semibold text-ink-2">{dayLabel(d)}</h2>
          <ul className="divide-y divide-line">
            {entries.map((e) => (
              <li key={e.id}>
                <JournalEntryCard e={e} onOpen={() => navigate(`/p/journal?id=${e.id}`)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {list && list.entries.length === 0 ? <p className="mt-16 text-ink-2">Nothing written yet.</p> : null}
      <WriteSheet open={writing} api={api} close={() => setWriting(false)} done={() => void load()} prompt={list?.prompt ?? ''} />
    </div>
  );
}

function CheckinRow({ api, open, done }: { api: PersonApi; open: boolean; done: () => void }) {
  const [mood, setMood] = useState<number | undefined>();
  const [emotions, setEmotions] = useState<Emotion[]>([]);
  const [line, setLine] = useState('');
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(open);
  useEffect(() => setExpanded(open), [open]);
  const pick = (e: Emotion) => setEmotions((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : cur.length < 3 ? [...cur, e] : cur));
  if (saved) return <p className="mt-12 text-small text-ink-2">Checked in.</p>;
  return (
    <section aria-label="Check in" className="mt-12 rounded-btn border border-line p-12">
      <p className="mb-8 font-medium">How are you right now?</p>
      <Faces
        label="Mood"
        value={mood}
        onChange={(v) => {
          setMood(v);
          setExpanded(true);
        }}
      />
      {expanded && mood !== undefined ? (
        <div className="mt-8 flex flex-col gap-8">
          <div className="flex flex-wrap gap-8" aria-label="Emotions (up to 3)">
            {EMOTION_NAMES.map((e) => (
              <button key={e} type="button" aria-pressed={emotions.includes(e)} onClick={() => pick(e)} className={`min-h-44 rounded-chip border px-12 text-small ${emotions.includes(e) ? 'border-ink bg-hover' : 'border-line'}`}>
                {EMOTIONS[e]}
              </button>
            ))}
          </div>
          <Field label="One line (optional)" value={line} onChange={setLine} max={200} />
          <Button
            variant="primary"
            size="lg"
            onClick={() =>
              void api.journalCreate({ kind: 'checkin', mood, ...(emotions.length ? { emotions } : {}), ...(line.trim() ? { text: line.trim() } : {}) }).then(() => {
                setSaved(true);
                done();
              })
            }
          >
            Save check-in
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function WriteSheet({ open, api, close, done, prompt }: { open: boolean; api: PersonApi; close: () => void; done: () => void; prompt: string }) {
  const [text, setText] = useState('');
  const [mood, setMood] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;
  return (
    <Sheet open onOpenChange={(o) => !o && close()} title="Write">
      <div className="flex flex-col gap-12 pb-24">
        {prompt ? <p className="text-small text-ink-2">{prompt}</p> : null}
        <Field label="Your entry" value={text} onChange={setText} max={8000} multiline />
        <p className="text-small text-ink-2">Mood (optional)</p>
        <Faces label="Mood" value={mood} onChange={setMood} />
        {error ? <p role="alert">{error}</p> : null}
        <Button
          variant="primary"
          size="xl"
          disabled={!text.trim() && mood === undefined}
          onClick={() =>
            void api.journalCreate({ kind: 'entry', ...(text.trim() ? { text: text.trim() } : {}), ...(mood ? { mood } : {}) }).then(
              () => {
                setText('');
                setMood(undefined);
                close();
                done();
              },
              (e: Error) => setError(e.message),
            )
          }
        >
          Save
        </Button>
      </div>
    </Sheet>
  );
}

function EntryView({ api, id, owner, tick, onGone }: { api: PersonApi; id: string; owner: string; tick: number; onGone: () => void }) {
  const [full, setFull] = useState<JournalEntryFull | null>(null);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.journalGet(id).then(setFull, (e: Error) => setError(e.message)), [api, id]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  if (!full) return <p className="text-ink-2">{error ?? 'Loading…'}</p>;
  const e = full.entry;
  return (
    <div>
      <Button variant="text" onClick={onGone}>
        ‹ Journal
      </Button>
      <h1 className="text-title font-semibold">{dayLabel(e.day)}</h1>
      {editing !== null ? (
        <div className="mt-8 flex flex-col gap-8">
          <Field label="Your entry" value={editing} onChange={setEditing} max={8000} multiline />
          <div className="flex gap-8">
            <Button variant="primary" onClick={() => void api.journalUpdate(id, { text: editing.trim() || null }).then(() => (setEditing(null), void load()), (x: Error) => setError(x.message))}>
              Save
            </Button>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <JournalEntryCard e={{ ...e, comments: 0 }} />
      )}
      {editing === null ? (
        <div className="flex gap-8">
          {e.kind !== 'checkin' ? (
            <Button variant="text" size="sm" onClick={() => setEditing(e.text ?? '')}>
              Edit
            </Button>
          ) : null}
          <Button variant="text" size="sm" onClick={() => void api.journalDelete(id).then(onGone)}>
            Delete (and its comments)
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <section aria-label="Comments" className="mt-16">
        <h2 className="text-small font-semibold text-ink-2">Comments</h2>
        <ul className="divide-y divide-line">
          {full.comments.map((c) => (
            <li key={c.id} className="flex items-start gap-8 py-8">
              <div className="min-w-0 flex-1">
                <p className="text-small text-ink-2">
                  {c.by === '' ? owner : 'You'} · {hmOf(c.at)}
                </p>
                <p className="whitespace-pre-wrap break-words">{c.text}</p>
              </div>
              {c.by !== '' ? (
                <Button variant="text" size="sm" onClick={() => void api.journalCommentDelete(id, c.id).then(load)}>
                  Delete
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="mt-8 flex flex-col gap-8">
          <Field label="Reply" value={comment} onChange={setComment} max={500} />
          <Button variant="outline" disabled={!comment.trim()} onClick={() => void api.journalComment(id, comment.trim()).then(() => (setComment(''), void load()))}>
            Add comment
          </Button>
        </div>
      </section>
    </div>
  );
}
