/**
 * The read log (0.15 Messages settings): who read his chats, newest first.
 * Each row: what was read (a chat's name, or the kind of read: the chat
 * list, a search, the calls to return) and how much, then when, who (a
 * Claude session, the Terminal, this phone, the morning run) and, for a
 * Claude session, its folder (advisory: the session's own word).
 *
 * The Mac logs ids and counts only, never a name. The names are the phone's
 * to find: the skip list's, and the newest chats', asked for once while the
 * log is open (that read is logged too, as the phone's). A chat in neither
 * is "A chat".
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SkipEntry } from '@jantar/protocol/messages';
import { Panel } from '../../kit/Panel.js';
import { LifeLoading } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { NAMES_LIMIT, READS_SHOWN, readWho, readWords } from './model.js';
import { MessagesError, useMessages } from './parts.js';

export interface ReadLogProps {
  /** The skip list (its names), null until it loads. */
  skip: readonly SkipEntry[] | null;
  card: boolean;
  offline: boolean;
  tz?: string | null | undefined;
}

export function ReadLog({ skip, card, offline, tz }: ReadLogProps) {
  const m = useMessages();
  const load = useLifeLoad('messages:reads', () => m.reads(READS_SHOWN));
  const reads = load.data?.reads ?? null;
  const needNames = reads?.some((e) => e.chatKey !== undefined) ?? false;
  const [chatNames, setChatNames] = useState<ReadonlyMap<string, string> | null>(null);
  // Once per open, and only when a row names a chat: the newest chats' names.
  const asked = useRef(false);
  useEffect(() => {
    if (!needNames || asked.current) return;
    asked.current = true;
    // Not found (the reader down): the rows keep "A chat".
    m.chats('', NAMES_LIMIT).then(
      (r) => setChatNames(new Map(r.chats.map((c) => [c.chatKey, c.name]))),
      () => undefined,
    );
  }, [needNames, m]);
  const names = useMemo(() => {
    const n = new Map<string, string>();
    for (const s of skip ?? []) n.set(s.chatKey, s.name);
    for (const [k, v] of chatNames ?? []) n.set(k, v);
    return n;
  }, [skip, chatNames]);

  let body: ReactNode;
  if (reads === null) body = load.error ? <MessagesError error={load.error} offline={offline} onRetry={load.reload} /> : <LifeLoading count={3} />;
  else if (reads.length === 0) body = <p className="px-16 py-12 type-small text-ink-2">Nothing has read your chats yet.</p>;
  else
    body = (
      <ul aria-label="Read log">
        {reads.map((e, i) => {
          const w = readWords(e, names);
          return (
            <li key={`${e.at}:${i}`} className="border-b border-line px-16 py-8">
              <div className="flex items-baseline gap-8">
                <span data-chat className="min-w-0 flex-1 break-words type-row text-ink">
                  {w.what}
                </span>
                <span className="flex-none type-mono text-ink-2">{w.count}</span>
              </div>
              <p className="break-words type-mono text-ink-3">{readWho(e, tz)}</p>
            </li>
          );
        })}
      </ul>
    );
  return (
    <Panel label="Read log" card={card}>
      {body}
    </Panel>
  );
}
