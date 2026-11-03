/**
 * v0.12 People (P3, spec 7.8): one chat turn, read only, as {owner}'s Chat
 * tab shows her thread. Her words and the assistant's answer render through
 * lib/markdown.tsx in its default (transcript) mode: escape-first, raw HTML
 * stays text, only http(s) links become clickable (no opener, no
 * referrer), and remote images are never loaded. Photos come only from her
 * thread's photo route. The change and card rows say what happened, with
 * no Undo, no card button and no delete: nothing here writes.
 */
import type { ChatChange, ChatTurn } from '@jantar/protocol';
import { renderMarkdown } from '../lib/markdown.js';
import { hmOf } from './time.js';

/** A change's word, as her own thread says it. */
export function changeWordOf(c: Pick<ChatChange, 'op' | 'state'>): string {
  if (c.state === 'undone') return 'Undone';
  if (c.op === 'add' || c.op === 'save' || c.op === 'todo') return 'Added';
  if (c.op === 'log' || c.op === 'paid') return 'Logged';
  if (c.op === 'done') return 'Done';
  if (c.op === 'skip') return 'Skipped';
  if (c.op === 'start') return 'Started';
  if (c.op === 'tick') return 'Ticked';
  return 'Changed';
}

const CARD_STATE: Record<string, string> = { waiting: 'Waiting for her tap', done: 'Done', dismissed: 'Dismissed', expired: 'Expired', failed: 'Failed' };

export function ChatRead({ turn, name, photoUrl }: { turn: ChatTurn; name: string; photoUrl: (id: string) => string }) {
  return (
    <li className="flex flex-col gap-8 border-b border-line py-12">
      <div className="type-small text-ink-2">
        {name} · {hmOf(turn.at)}
      </div>
      {turn.text ? <div className="min-w-0 break-words type-row text-ink [overflow-wrap:anywhere]">{renderMarkdown(turn.text)}</div> : null}
      {turn.photos.length ? (
        <div className="flex flex-wrap gap-8">
          {turn.photos.map((p) =>
            p.gone ? (
              <span key={p.id} className="type-small text-ink-2">
                Photo removed
              </span>
            ) : (
              <a key={p.id} href={photoUrl(p.id)} target="_blank" rel="noopener noreferrer">
                <img src={photoUrl(p.id)} alt="Photo she sent" width={96} height={Math.max(1, Math.round((96 * p.h) / Math.max(1, p.w)))} className="max-h-[8rem] w-[6rem] rounded-md object-cover" />
              </a>
            ),
          )}
        </div>
      ) : null}
      {turn.reply ? <div className="min-w-0 break-words rounded-md bg-hover px-12 py-8 type-row text-ink [overflow-wrap:anywhere]">{renderMarkdown(turn.reply)}</div> : null}
      {!turn.reply && turn.reason ? <p className="type-small text-ink-2">{turn.reason}</p> : null}
      {turn.state === 'queued' || turn.state === 'running' ? <p className="type-small text-ink-2">Working…</p> : null}
      {turn.changes.length || turn.cards.length ? (
        <ul className="flex flex-col gap-4">
          {turn.changes.map((c) => (
            <li key={`c${c.n}`} className="min-w-0 break-words type-small text-ink-2 [overflow-wrap:anywhere]">
              Her assistant: {changeWordOf(c)} · {c.label}
            </li>
          ))}
          {turn.cards.map((c) => (
            <li key={`k${c.n}`} className="min-w-0 break-words type-small text-ink-2 [overflow-wrap:anywhere]">
              Asked her: {c.label} · {CARD_STATE[c.state] ?? c.state}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
