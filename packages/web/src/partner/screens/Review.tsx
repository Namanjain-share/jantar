/**
 * v0.12 People: her evening review (`/p?review=1&day=`, spec 3.10). Every
 * step as sent, each check-between, her to-dos due; her own open steps
 * carry to tomorrow with one tap, his go to him as one "Ask to carry";
 * her own open to-dos move to tomorrow. An optional note and mood, "Also
 * save to my journal", and one Send. Afterwards the screen is read-only.
 * Moved and missed are grey, never red, and nothing is scored.
 */
import type { PersonMe, ReviewItem, ReviewView } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { Faces } from '../../people-shared/Faces.js';
import { ReviewList } from '../../people-shared/ReviewList.js';
import { dayLabel, face, hmOf, shiftDay, weekdayOf } from '../../people-shared/time.js';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { navigate } from '../nav.js';
import { Field } from '../ui.js';

export function Review({ me, api, day: asked, tick }: { me: PersonMe; api: PersonApi; day: string | null; tick: number }) {
  const [day, setDay] = useState<string | null>(asked);
  const [v, setV] = useState<ReviewView | null>(null);
  const [carry, setCarry] = useState<Set<string>>(new Set());
  const [askCarry, setAskCarry] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [mood, setMood] = useState<number | undefined>();
  const [toJournal, setToJournal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = me.owner.name;
  useEffect(() => {
    if (asked) setDay(asked);
    else void api.today().then((t) => setDay(t.review?.day ?? t.today), () => setDay(null));
  }, [api, asked]);
  const load = useCallback(() => {
    if (day) void api.review(day).then(setV, (e: Error) => setError(e.message));
  }, [api, day]);
  useEffect(load, [load, tick]);
  if (!day || !v || v.level !== 'full') return <p className="text-ink-2">{error ?? 'Loading…'}</p>;
  const tomorrow = shiftDay(day, 1);
  const toggle = (set: Set<string>, id: string, put: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    put(next);
  };
  const action = (i: ReviewItem) => {
    if (v.sent || i.outcome !== undefined || i.kind === 'between') return null;
    if (i.kind === 'todo') {
      if (i.by === '') return null;
      return (
        <Button variant="outline" size="sm" onClick={() => void api.moveTodo(i.ref, tomorrow).then(load, (e: Error) => setError(e.message))}>
          Tomorrow
        </Button>
      );
    }
    const mine = i.by !== '';
    const on = (mine ? carry : askCarry).has(i.ref);
    return (
      <Button variant={on ? 'primary' : 'outline'} size="sm" aria-pressed={on} onClick={() => (mine ? toggle(carry, i.ref, setCarry) : toggle(askCarry, i.ref, setAskCarry))}>
        {mine ? 'Carry to tomorrow' : `Ask ${owner} to carry`}
      </Button>
    );
  };
  const send = () => {
    setBusy(true);
    api
      .reviewSend(day, {
        ...(carry.size ? { carry: [...carry] } : {}),
        ...(askCarry.size ? { askCarry: [...askCarry] } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(mood ? { mood } : {}),
        ...(toJournal ? { toJournal: true } : {}),
      })
      .then(
        () => {
          setBusy(false);
          load();
        },
        (e: Error) => {
          setBusy(false);
          setError(e.message);
        },
      );
  };
  return (
    <div className="pb-96">
      <header className="flex items-baseline justify-between">
        <h1 className="text-title font-semibold">How did today go?</h1>
        <span className="text-small text-ink-2">{dayLabel(day)}</span>
      </header>
      <p className="mt-4 text-small text-ink-2">{v.line}</p>
      <div className="mt-12">
        <ReviewList items={v.items} owner={owner} action={action} />
      </div>
      {carry.size + askCarry.size > 0 ? (
        <p className="mt-8 text-small text-ink-2">
          {carry.size > 0 ? `${carry.size} of yours move to ${weekdayOf(tomorrow)}. ` : ''}
          {askCarry.size > 0 ? `${owner} is asked to carry ${askCarry.size}.` : ''}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {v.sent ? (
        <section aria-label="Sent" className="mt-16">
          <p className="text-small text-ink-2">{v.auto ? 'Closed at noon, with no note.' : `Sent${v.at ? ` at ${hmOf(v.at)}` : ''}.`}</p>
          {v.note ? <p className="mt-8 whitespace-pre-wrap break-words">{v.note}</p> : null}
          {v.mood ? <p className="mt-4">Mood {face(v.mood)}</p> : null}
          <Button variant="text" onClick={() => navigate('/p')}>
            Back to Today
          </Button>
        </section>
      ) : (
        <section aria-label="Your note" className="mt-16 flex flex-col gap-12">
          <Field label="A note for today (optional)" value={note} onChange={setNote} max={1000} multiline />
          <p className="text-small text-ink-2">Mood (optional)</p>
          <Faces label="Mood" value={mood} onChange={setMood} />
          <label className="flex min-h-44 items-center gap-8">
            <input type="checkbox" checked={toJournal} onChange={(e) => setToJournal(e.target.checked)} /> Also save to my journal
          </label>
          <p className="text-small text-ink-2">
            {me.agreement?.see.review === 'full'
              ? `${owner} sees this review, your note and your mood.`
              : me.agreement?.see.review === 'counts'
                ? `${owner} sees only the counts, never your note or mood.`
                : `${owner} doesn't see your review.`}
          </p>
          <div className="fixed inset-x-0 bottom-[calc(44px+env(safe-area-inset-bottom))] z-10 border-t border-line bg-bg px-16 py-8">
            <div className="mx-auto max-w-[42rem]">
              <Button variant="primary" size="xl" className="w-full" disabled={busy} onClick={send}>
                Send review
              </Button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
