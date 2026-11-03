/**
 * v0.12 People (P3, spec 7): her assistant (`/p/chat`), a lazy screen.
 *
 * - While {owner} can read it, the line "{owner} can read this chat" sits
 *   above the composer on every visit: permanent, not a banner she can
 *   dismiss. ⓘ opens the disclosure, built by the Mac from her live
 *   agreement, and a new thread starts with it as the first message.
 * - "12 messages left today" under the box; her refusals are the Mac's
 *   fixed words.
 * - Each turn: her words and photos, the answer as plain text, each change
 *   with Undo while it's under a day old, cards (Confirm, Do it, Dismiss),
 *   Stop while it works, and Delete (gone for both, no trace). Clear chat
 *   clears hers only.
 */
import type { ChatChange, ChatTurn } from '@jantar/protocol';
import type { PersonChatList, PersonMe } from '@jantar/protocol/people';
import { chatHeaderLine, chatLeftLine } from '@jantar/protocol/people-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { changeWordOf } from '../../people-shared/ChatRead.js';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { Sheet } from '../ui.js';

const TEXT_MAX = 2000;
const PHOTOS_MAX = 4;
const UNDO_MS = 24 * 60 * 60_000;
const unfinished = (t: Pick<ChatTurn, 'state'>) => t.state === 'queued' || t.state === 'running';

export default function Chat({ me, api, tick }: { me: PersonMe; api: PersonApi; tick: number }) {
  const owner = me.owner.name;
  const [list, setList] = useState<PersonChatList | null>(null);
  const [earlier, setEarlier] = useState<ChatTurn[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState(false);
  const [clearing, setClearing] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const l = await api.chat();
      setList(l);
      setOlder((o) => (earlier.length ? o : l.older));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, earlier.length]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  // While a turn works, ask again every two seconds (her stream also ticks when it ends).
  const working = list?.turns.some(unfinished) ?? false;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [working, load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const t = text.trim();
    if (!t && photos.length === 0) return;
    const ok = await run(() => api.chatSend(t, photos.map((p) => p.id)));
    if (ok) {
      setText('');
      setPhotos([]);
    }
  };

  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files).slice(0, PHOTOS_MAX - photos.length)) {
      await run(async () => {
        const r = await api.chatPhotoAdd(f);
        setPhotos((p) => [...p, { id: r.id, name: f.name }]);
      });
    }
    if (file.current) file.current.value = '';
  };

  const more = async () => {
    if (!older) return;
    await run(async () => {
      const r = await api.chat(older);
      setEarlier((e) => [...r.turns, ...e]);
      setOlder(r.older);
    });
  };

  if (!list) return <p className="text-ink-2">{error ?? 'Loading…'}</p>;
  const turns = [...earlier, ...list.turns];
  const ready = list.ready.ok;
  return (
    <div className="flex flex-col gap-12 pb-[10rem]">
      <div className="flex items-center justify-between gap-8">
        <h1 className="text-title font-semibold">Assistant</h1>
        <div className="flex gap-4">
          <Button variant="text" onClick={() => setInfo(true)} aria-label="Who can read this chat">
            ⓘ
          </Button>
          {turns.length ? (
            <Button variant="text" onClick={() => setClearing(true)}>
              Clear
            </Button>
          ) : null}
        </div>
      </div>
      {older ? (
        <Button variant="text" onClick={() => void more()} disabled={busy}>
          Earlier
        </Button>
      ) : null}
      <ol className="flex flex-col gap-12">
        {turns.length === 0 ? (
          <li className="rounded-md bg-hover px-12 py-12 text-row text-ink">{list.disclosure}</li>
        ) : null}
        {turns.map((t) => (
          <Turn key={t.id} turn={t} api={api} busy={busy} run={run} />
        ))}
      </ol>
      <div className="fixed inset-x-0 bottom-[calc(44px+env(safe-area-inset-bottom))] border-t border-line bg-bg px-16 py-8">
        <div className="mx-auto flex max-w-[42rem] flex-col gap-8">
          {list.ownerCanRead ? (
            <p role="note" className="text-small font-medium text-ink">
              {chatHeaderLine(owner)}
            </p>
          ) : null}
          {photos.length ? (
            <div className="flex flex-wrap gap-8">
              {photos.map((p) => (
                <span key={p.id} className="rounded-btn bg-hover px-8 py-4 text-small">
                  {p.name}{' '}
                  <button type="button" aria-label="Remove photo" onClick={() => void run(async () => (await api.chatPhotoDelete(p.id), setPhotos((x) => x.filter((y) => y.id !== p.id))))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-8">
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple className="hidden" onChange={(e) => void addPhotos(e.target.files)} />
            <Button variant="text" onClick={() => file.current?.click()} disabled={!ready || busy || photos.length >= PHOTOS_MAX} aria-label="Add a photo">
              Photo
            </Button>
            <textarea
              aria-label="Message"
              value={text}
              maxLength={TEXT_MAX}
              rows={2}
              onChange={(e) => setText(e.target.value)}
              disabled={!ready}
              className="min-h-44 flex-1 resize-none rounded-btn border border-line bg-bg px-12 py-8 text-row text-ink"
            />
            <Button onClick={() => void send()} disabled={!ready || busy || (!text.trim() && photos.length === 0)}>
              Send
            </Button>
          </div>
          <p className="text-small text-ink-2">{ready ? chatLeftLine(list.left) : list.ready.reason}</p>
          {error ? (
            <p role="alert" className="text-small text-ink">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <Sheet open={info} onOpenChange={setInfo} title="Your assistant">
        <p className="pb-24 text-row text-ink">{list.disclosure}</p>
      </Sheet>
      <Sheet open={clearing} onOpenChange={setClearing} title="Clear chat?">
        <p className="text-row text-ink">Its messages, photos and Undo go, for {owner} too. What it added stays.</p>
        <div className="flex gap-8 py-16">
          <Button
            onClick={() =>
              void run(async () => {
                await api.chatClear();
                setEarlier([]);
                setOlder(null);
                setClearing(false);
              })
            }
          >
            Clear
          </Button>
          <Button variant="text" onClick={() => setClearing(false)}>
            Keep
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function Turn({ turn, api, busy, run }: { turn: ChatTurn; api: PersonApi; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const fresh = Date.now() - Date.parse(turn.at) < UNDO_MS;
  const canUndo = (c: ChatChange) => c.state === 'done' && c.undoable && fresh;
  return (
    <li className="flex flex-col gap-8">
      {turn.text || turn.photos.length ? (
        <div className="self-end rounded-md bg-hover px-12 py-8">
          {turn.text ? <p className="whitespace-pre-wrap break-words text-row text-ink [overflow-wrap:anywhere]">{turn.text}</p> : null}
          {turn.photos.length ? (
            <div className="mt-4 flex flex-wrap gap-8">
              {turn.photos.map((p) => (p.gone ? <span key={p.id} className="text-small text-ink-2">Photo removed</span> : <img key={p.id} src={api.chatPhotoUrl(p.id)} alt="Your photo" className="max-h-[8rem] w-[6rem] rounded-md object-cover" />))}
            </div>
          ) : null}
        </div>
      ) : null}
      {unfinished(turn) ? (
        <div className="flex items-center gap-8 text-small text-ink-2">
          Working…
          <Button variant="text" disabled={busy} onClick={() => void run(() => api.chatCancel(turn.id))}>
            Stop
          </Button>
        </div>
      ) : null}
      {turn.reply ? <p className="whitespace-pre-wrap break-words text-row text-ink [overflow-wrap:anywhere]">{turn.reply}</p> : null}
      {!turn.reply && turn.reason ? <p className="text-small text-ink-2">{turn.reason}</p> : null}
      {turn.changes.map((c) => (
        <div key={`c${c.n}`} className="flex flex-wrap items-center gap-8 text-small text-ink-2">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
            {changeWordOf(c)} · {c.label}
          </span>
          {canUndo(c) ? (
            <Button variant="text" disabled={busy} onClick={() => void run(() => api.chatUndo(turn.id, c.n))}>
              Undo
            </Button>
          ) : null}
        </div>
      ))}
      {turn.cards.map((c) => (
        <div key={`k${c.n}`} className="flex flex-col gap-4 rounded-md border border-line px-12 py-8">
          <p className="break-words text-row text-ink [overflow-wrap:anywhere]">{c.label}</p>
          {c.state === 'waiting' && fresh ? (
            <div className="flex gap-8">
              <Button disabled={busy} onClick={() => void run(() => api.chatCard(turn.id, c.n))}>
                {c.kind === 'confirm' ? 'Confirm' : 'Do it'}
              </Button>
              <Button variant="text" disabled={busy} onClick={() => void run(() => api.chatDismiss(turn.id, c.n))}>
                Dismiss
              </Button>
            </div>
          ) : (
            <p className="text-small text-ink-2">{c.state === 'done' ? 'Done' : c.state === 'dismissed' ? 'Dismissed' : c.state === 'failed' ? (c.reason ?? 'Failed') : 'Expired'}</p>
          )}
        </div>
      ))}
      {!unfinished(turn) ? (
        <Button variant="text" disabled={busy} onClick={() => void run(() => api.chatTurnDelete(turn.id))}>
          Delete
        </Button>
      ) : null}
    </li>
  );
}
