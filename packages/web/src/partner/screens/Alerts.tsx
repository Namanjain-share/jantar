/**
 * v0.11 People: her Alerts page (`/p/alerts`, spec 6), a lazy screen. One
 * list both ways, newest first, with each alert's status ("Sent", "Held",
 * "Saved", "Seen 10:42", the reply) and one-tap replies that close after
 * 24 hours ("Expired", no blame). Opening one marks it seen; a push being
 * delivered never does. The send sheet has the preset buttons, Custom…,
 * an optional note, and his caps and hold line under it.
 */
import { ALERT_KINDS, ALERT_REPLY_LABELS, type AlertKind } from '@jantar/protocol/people-core';
import type { AlertsResponse, PersonAlert, PersonMe } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { dayLabel, hmOf } from '../../people-shared/time.js';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { Field, Sheet } from '../ui.js';

const HERS: AlertKind[] = ['check_in', 'call_me', 'running_late', 'good_morning', 'good_night', 'thinking_of_you'];

export function deliveryText(a: PersonAlert, mine: boolean): string {
  if (a.reply) return `Replied: ${ALERT_REPLY_LABELS[a.reply.kind]}${a.reply.note ? `. ${a.reply.note}` : ''}`;
  if (a.seenAt) return `Seen ${hmOf(a.seenAt)}`;
  if (!mine) return '';
  switch (a.delivery) {
    case 'sent':
    case 'released':
      return 'Sent';
    case 'capped':
      return 'Saved (over the limit)';
    case 'held_quiet':
      return 'Held (quiet hours)';
    case 'held_mute':
      return 'Held (muted)';
    case 'held_space':
      return 'Held (space)';
    case 'held_focus':
      return 'Held (focus)';
    case 'held_sleep':
      return 'Held (asleep)';
    case 'held_pause':
      return 'Held (paused)';
  }
}

export function alertLabel(a: PersonAlert): string {
  if (a.kind === 'nudge') return `Reminder${a.ref ? `: ${a.ref.title}` : ''}`;
  if (a.kind === 'change_request') return a.carry ? 'Asks to carry steps' : `Asks to change${a.ref ? `: ${a.ref.title}` : ''}`;
  return ALERT_KINDS[a.kind].label;
}

export default function Alerts({ me, api, id, tick }: { me: PersonMe; api: PersonApi; id: string | null; tick: number }) {
  const [r, setR] = useState<AlertsResponse | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.alerts().then(setR, (e: Error) => setError(e.message)), [api]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  const me_ = me.person.id;
  const owner = me.owner.name;
  // Opening the page with an alert's link (from its push) marks that one seen.
  useEffect(() => {
    if (id && r?.alerts.some((a) => a.id === id && a.to === me_ && !a.seenAt)) void api.alertSeen(id).then(load);
  }, [id, r, me_, api, load]);
  const now = Date.now();
  return (
    <div>
      <header className="flex items-baseline justify-between">
        <h1 className="text-title font-semibold">Alerts</h1>
        <Button variant="primary" onClick={() => setSending(true)}>
          Send {owner} an alert
        </Button>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      <ul className="mt-12 divide-y divide-line">
        {(r?.alerts ?? []).map((a) => {
          const mine = a.from === me_;
          const open = !mine && !a.reply && Date.parse(a.expiresAt) > now;
          return (
            <li key={a.id} className={`py-8 ${id === a.id ? 'bg-hover' : ''}`}>
              <button type="button" className="block min-h-44 w-full text-left" onClick={() => !mine && !a.seenAt && void api.alertSeen(a.id).then(load)}>
                <p className="text-small text-ink-2">
                  {mine ? `You → ${owner}` : `${owner} → you`} · {dayLabel(a.at.slice(0, 10))} {hmOf(a.at)}
                  {a.urgency === 'urgent' ? ' · Urgent' : ''}
                </p>
                <p className="break-words font-medium">{alertLabel(a)}</p>
                {a.text ? <p className="whitespace-pre-wrap break-words">{a.text}</p> : null}
                <p className="text-small text-ink-2">{deliveryText(a, mine) || (!mine && !open && !a.reply ? 'Expired' : '')}</p>
              </button>
              {open ? (
                <div className="mt-4 flex flex-wrap gap-8">
                  {ALERT_KINDS[a.kind].replies.map((k) => (
                    <Button key={k} variant="outline" size="sm" className="min-h-44 min-w-44" onClick={() => void api.alertReply(a.id, { kind: k }).then(load, (e: Error) => setError(e.message))}>
                      {ALERT_REPLY_LABELS[k]}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {r && r.alerts.length === 0 ? <p className="mt-12 text-ink-2">No alerts yet.</p> : null}
      <SendSheet open={sending} owner={owner} api={api} sheet={r?.sheet ?? null} close={() => setSending(false)} done={() => void load()} />
    </div>
  );
}

function SendSheet({ open, owner, api, sheet, close, done }: { open: boolean; owner: string; api: PersonApi; sheet: AlertsResponse['sheet'] | null; close: () => void; done: () => void }) {
  const [kind, setKind] = useState<AlertKind | 'custom' | null>(null);
  const [text, setText] = useState('');
  const [gentle, setGentle] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  if (!open) return null;
  const send = (k: AlertKind) =>
    void api
      .alertSend({ kind: k, ...(text.trim() ? { text: text.trim() } : {}), ...(k === 'custom' ? { urgency: gentle ? 'gentle' : 'normal' } : {}) })
      .then(
        (r) => {
          setResult(r.delivery === 'sent' ? 'Sent.' : r.delivery === 'capped' ? 'Saved: over the limit, so no notification.' : 'Held: it reaches them when their quiet time ends.');
          setText('');
          setKind(null);
          done();
        },
        (e: Error) => setResult(e.message),
      );
  return (
    <Sheet open onOpenChange={(o) => !o && (close(), setResult(null))} title={`Alert ${owner}`}>
      <div className="flex flex-col gap-12 pb-24">
        <div className="grid grid-cols-2 gap-8">
          {HERS.map((k) => (
            <Button key={k} variant={kind === k ? 'primary' : 'outline'} size="lg" onClick={() => setKind(k)}>
              {ALERT_KINDS[k].label}
            </Button>
          ))}
          <Button variant={kind === 'urgent' ? 'primary' : 'outline'} size="lg" onClick={() => setKind('urgent')}>
            Urgent
          </Button>
          <Button variant={kind === 'custom' ? 'primary' : 'outline'} size="lg" onClick={() => setKind('custom')}>
            Custom…
          </Button>
        </div>
        {kind ? <Field label={kind === 'custom' ? 'Message' : 'A note (optional)'} value={text} onChange={setText} max={140} /> : null}
        {kind === 'custom' ? (
          <label className="flex min-h-44 items-center gap-8 text-small">
            <input type="checkbox" checked={gentle} onChange={(e) => setGentle(e.target.checked)} /> Gentle (no sound)
          </label>
        ) : null}
        {sheet?.hold ? <p className="text-small text-ink-2">{sheet.hold}</p> : null}
        {result ? <p role="status">{result}</p> : null}
        <Button variant="primary" size="xl" disabled={!kind || (kind === 'custom' && !text.trim())} onClick={() => kind && send(kind)}>
          Send
        </Button>
      </div>
    </Sheet>
  );
}
