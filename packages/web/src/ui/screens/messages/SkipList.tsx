/**
 * The skip list (0.15 Messages settings): the chats Messages never reads,
 * not in a Claude session, on this phone or in the morning run. Skipping a
 * 1:1 skips that person everywhere (their calls, their lines in groups);
 * skipping a group skips the group. What the morning made from the chat
 * (its drafts, open todos and call-backs) goes with it.
 *
 *   [ Find a chat to skip ]       the chats by name, 300 ms after typing stops
 *   Asha Test   1:1     [Skip]    asks first: only the Mac can read it again
 *   SKIPPED
 *   Ravi Test   1:1 · since …     no button: a phone never widens what Jantar
 *   Remove at the Mac: jantar messages skip remove <chat>
 *
 * The search is a read of his chats (the Mac logs it as the phone's): it
 * asks only for what he types, never on a blank box. A skipped chat never
 * shows in it (the reader hides it), so it can't be skipped twice.
 */
import { useEffect, useId, useState } from 'react';
import type { ChatOwner, MessagesChatsResponse, SkipEntry } from '@jantar/protocol/messages';
import { Button } from '../../kit/Button.js';
import { Panel } from '../../kit/Panel.js';
import { CommandSentence, NotSaved } from '../life/shared/states.js';
import { INPUT, useWrite } from '../life/today/parts.js';
import { KIND_WORD, REMOVE_AT_MAC, SEARCH_DEBOUNCE_MS, SEARCH_MAX_CHARS, SKIP_SEARCH_LIMIT, whenText } from './model.js';
import { MessagesError, useMessages } from './parts.js';

export interface SkipListProps {
  /** The list (null until it loads). */
  skip: readonly SkipEntry[] | null;
  error: unknown;
  card: boolean;
  offline: boolean;
  tz?: string | null | undefined;
  /** Load the list again (after a skip). */
  onSkipped: () => void;
}

export function SkipList({ skip, error, card, offline, tz, onSkipped }: SkipListProps) {
  const m = useMessages();
  const searchId = useId();
  const [text, setText] = useState('');
  const [found, setFound] = useState<{ q: string; reply: MessagesChatsResponse } | null>(null);
  const [findError, setFindError] = useState<unknown>(null);
  const [asking, setAsking] = useState<ChatOwner | null>(null);
  const write = useWrite();

  // Asked 300 ms after typing stops; a blank box asks nothing and clears the answer.
  useEffect(() => {
    const q = text.trim();
    if (!q) {
      setFound(null);
      setFindError(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      m.chats(q, SKIP_SEARCH_LIMIT).then(
        (reply) => {
          if (!live) return;
          setFound({ q, reply });
          setFindError(null);
        },
        (e: unknown) => {
          if (live) setFindError(e);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text, m]);

  const skipIt = async (chat: ChatOwner) => {
    const r = await write.run(`skip:${chat.chatKey}`, (k) => m.skip(chat.chatKey, k));
    if (!r.ok) return;
    setAsking(null);
    setFound((f) => (f ? { ...f, reply: { ...f.reply, chats: f.reply.chats.filter((c) => c.chatKey !== chat.chatKey) } } : f));
    onSkipped();
  };

  const chats = found?.reply.chats ?? [];
  return (
    <Panel label="Skip list" count={skip?.length} card={card}>
      <div className="px-16 pt-12">
        <p className="type-small text-ink-2">
          Skipped chats are never read: not by Claude sessions, this phone or the morning run. Skipping a 1:1 skips that person everywhere, their calls and
          their lines in groups too.
        </p>
        <label htmlFor={searchId} className="sr-only">
          Find a chat to skip
        </label>
        <input
          id={searchId}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Find a chat to skip"
          maxLength={SEARCH_MAX_CHARS}
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          disabled={offline}
          className={`${INPUT} mt-12`}
        />
      </div>
      {findError ? <MessagesError error={findError} offline={offline} /> : null}
      {found ? (
        chats.length ? (
          <>
            <ul aria-label="Chats found" className="mt-8">
              {chats.map((c) => (
                <li key={c.chatKey} className="flex items-center gap-8 border-b border-line py-4 pl-16 pr-8">
                  <span className="min-w-0 flex-1">
                    <span className="block break-words type-row text-ink">{c.name}</span>
                    <span className="block type-mono text-ink-3">{KIND_WORD[c.kind]}</span>
                  </span>
                  <Button size="sm" aria-label={`Skip ${c.name}`} disabled={offline || write.busy} onClick={() => setAsking(c)} className="flex-none coarse:min-w-44">
                    Skip
                  </Button>
                </li>
              ))}
            </ul>
            {found.reply.total > chats.length ? (
              <p className="px-16 pt-8 type-small text-ink-3">
                Showing {chats.length} of {found.reply.total.toLocaleString()}: type more of the name.
              </p>
            ) : null}
          </>
        ) : (
          <p className="px-16 pt-8 type-small text-ink-2">No chat by that name. Skipped chats don't show here.</p>
        )
      ) : null}
      {asking ? (
        <div role="group" aria-label={`Skip ${asking.name}`} className="mx-16 mt-8 rounded-btn border border-line-strong px-12 py-8">
          <p className="break-words type-small text-ink">
            Skip <span className="font-medium">{asking.name}</span>? Its reply drafts, and the open todos and call-backs the morning made from it, go too. Only
            the Mac can read it again.
          </p>
          <div data-actions className="mt-8 flex flex-wrap items-center gap-8">
            <Button variant="primary" disabled={offline || write.busy} onClick={() => void skipIt(asking)} className="coarse:min-w-44">
              Yes, skip
            </Button>
            <Button variant="text" onClick={() => setAsking(null)} className="coarse:min-w-44">
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {write.error ? (
        <div className="px-16">
          <NotSaved error={write.error} />
        </div>
      ) : null}
      <h3 className="px-16 pb-4 pt-16 type-rail text-ink-3">Skipped</h3>
      {skip === null ? (
        error ? (
          <MessagesError error={error} offline={offline} />
        ) : null
      ) : skip.length ? (
        <ul aria-label="Skipped chats" className="border-t border-line">
          {skip.map((s) => (
            <li key={s.chatKey} className="border-b border-line px-16 py-8">
              <span className="block break-words type-row text-ink">{s.name}</span>
              <span className="block type-mono text-ink-3">
                {KIND_WORD[s.kind]} · since {whenText(s.addedAt, tz, { date: true })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-16 type-small text-ink-2">No chats are skipped.</p>
      )}
      <div className="px-16 pb-12 pt-8">
        <CommandSentence sentence={REMOVE_AT_MAC} className="break-words" />
      </div>
    </Panel>
  );
}
