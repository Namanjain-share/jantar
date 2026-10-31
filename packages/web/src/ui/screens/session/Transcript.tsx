/**
 * The Transcript tab (direction.md 5.2): Claude's text with no bubble, your
 * turns with delivery receipts, runs of tool calls folded into one mono line,
 * and what Claude is running right now. Older messages load when you scroll
 * to the top; new ones arriving while you read further up show "↓ 3 new".
 *
 * The API pages newest first (limit 50); the list shows oldest first. A new
 * reply, a status change or a proven send fetches the newest page again and
 * merges it by item id.
 */
import { ArrowDownIcon, CaretRightIcon, CheckIcon, WarningIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session, TranscriptItem } from '@jantar/protocol';
import { errorText } from '../../../lib/api.js';
import { accountId, ago, clock } from '../../../lib/format.js';
import { useDeps } from '../../context.js';
import type { GlyphState } from '../../kit/glyph.js';
import { Spinner } from '../../kit/Spinner.js';
import { spanShort } from './order.js';
import { Prose } from './Prose.js';
import { SendReceipt } from './SendReceipt.js';
import { isProven, sendFilesWord, turnOfSend, type Sends, type SendView } from './sends.js';

const PAGE = 50;
const REFRESH_MIN_MS = 2500;

type Block =
  | { kind: 'user'; item: TranscriptItem; send?: SendView }
  | { kind: 'text'; item: TranscriptItem }
  | { kind: 'tools'; items: TranscriptItem[] }
  | { kind: 'meta'; item: TranscriptItem };

/** Items (oldest first) as blocks; consecutive tool calls fold into one. */
function toBlocks(items: TranscriptItem[], matched: Map<string, SendView>): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    if (item.kind === 'tool_use' || item.kind === 'tool_result') {
      const last = out[out.length - 1];
      if (item.kind === 'tool_result') continue;
      if (last?.kind === 'tools') last.items.push(item);
      else out.push({ kind: 'tools', items: [item] });
      continue;
    }
    if (item.role === 'user' && (item.kind === 'text' || item.kind === 'queued')) out.push({ kind: 'user', item, send: matched.get(item.id) });
    else if (item.role === 'assistant' && item.kind === 'text') out.push({ kind: 'text', item });
    else out.push({ kind: 'meta', item });
  }
  return out;
}

/**
 * Attach this device's proven sends to the transcript turns that prove them.
 * v0.4.2: a send with files is proven by the prompt the daemon composed from
 * it (its words, then the file list), and one of files alone has no words.
 */
function matchSends(items: TranscriptItem[], sends: SendView[]) {
  const matched = new Map<string, SendView>();
  const shown: SendView[] = [];
  const used = new Set<string>();
  for (const s of sends) {
    if (s.job && isProven(s.job.stage) && (s.text?.trim() || s.local?.attachments?.length)) {
      const since = Date.parse(s.job.createdAt) - 60_000;
      const hit = items.find((it) => !used.has(it.id) && it.role === 'user' && turnOfSend(it.text, s) && (!it.at || Date.parse(it.at) >= since));
      if (hit) {
        used.add(hit.id);
        matched.set(hit.id, s);
        continue;
      }
    }
    shown.push(s);
  }
  return { matched, pending: shown };
}

function ToolLine({ tool, text }: { tool?: string; text: string }) {
  return (
    <span className="flex min-w-0 items-center gap-12 type-mono">
      <span className="flex-none text-ink-2">{tool ?? 'Tool'}</span>
      <span className="min-w-0 truncate text-ink-3">{text}</span>
    </span>
  );
}

function ToolRun({ items }: { items: TranscriptItem[] }) {
  const [open, setOpen] = useState(false);
  const first = items[0];
  if (!first) return null;
  if (items.length === 1) {
    return (
      <div className="flex h-24 items-center" data-item="tools">
        <ToolLine tool={first.tool} text={first.text} />
      </div>
    );
  }
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.tool ?? 'Tool', (counts.get(it.tool ?? 'Tool') ?? 0) + 1);
  const last = items[items.length - 1];
  const span = first.at && last?.at ? spanShort(Date.parse(last.at) - Date.parse(first.at)) : '';
  const label = [`${items.length} tool calls`, ...[...counts].map(([t, n]) => `${t} ${n}`), span].filter(Boolean).join(' · ');
  const SHOWN = 40;
  return (
    <div data-item="tools">
      <button
        type="button"
        className="-ml-2 flex h-24 max-w-full items-center gap-6 rounded-chip pl-2 pr-4 type-mono coarse:h-44 text-ink-3 transition-colors duration-120 ease-hover hover:text-ink-2"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <CaretRightIcon size={12} weight="bold" aria-hidden="true" className={clsx('flex-none transition-transform duration-160 ease-out motion-reduce:transition-none', open && 'rotate-90')} />
        <span className="truncate">{label}</span>
      </button>
      {open ? (
        <ul className="mt-4 flex flex-col pl-18" aria-label="Tool calls">
          {items.slice(0, SHOWN).map((it) => (
            <li key={it.id} className="flex h-20 items-center">
              <ToolLine tool={it.tool} text={it.text} />
            </li>
          ))}
          {items.length > SHOWN ? <li className="flex h-20 items-center type-mono text-ink-3">and {items.length - SHOWN} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/** One of your turns: "you · 14:01", the text on --surface, then its receipt. */
export function UserTurn({
  who = 'you',
  at,
  now,
  text,
  children,
}: {
  who?: string;
  at?: string;
  now: number;
  text: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start" data-item="user">
      <p className="mb-6 type-mono text-ink-3">
        {who}
        {at ? ` · ${clock(at, now)}` : ''}
      </p>
      <div className="max-w-560 whitespace-pre-wrap rounded-btn bg-surface px-12 py-8 type-body text-ink wrap-break-word">{text}</div>
      {children}
    </div>
  );
}

function SendTurn({ s, sends, now }: { s: SendView; sends: Sends; now: number }) {
  const who = s.actor === undefined ? 'you' : s.actor === 'cli' ? 'from the Mac' : 'from another device';
  // v0.4.2: "2 files" under the words (or alone, for files with no words) until the transcript shows the prompt.
  const files = sendFilesWord(s);
  const text =
    s.text === null ? (
      <span className="text-ink-2">Prompt ({s.textLength} characters)</span>
    ) : files ? (
      <>
        {s.text ? <span className="block">{s.text}</span> : null}
        <span className="block type-mono text-ink-3">{files}</span>
      </>
    ) : (
      s.text
    );
  return (
    <UserTurn who={who} now={now} at={s.job?.createdAt ?? (s.local ? new Date(s.local.at).toISOString() : undefined)} text={text}>
      <SendReceipt s={s} sends={sends} now={now} />
    </UserTurn>
  );
}

/** "running now · Bash pnpm vitest", "Compacting the conversation", a move, the last error. */
function LiveTail({ session, glyph, now }: { session: Session; glyph: GlyphState; now: number }) {
  const lines: ReactNode[] = [];
  const working = session.status === 'working' || session.status === 'compacting';
  if (working) {
    const compacting = session.status === 'compacting';
    const label = glyph === 'stale' ? `no update ${ago(session.statusAt ?? session.statusSince, now)}` : 'running now';
    const tool = compacting ? 'Compacting' : session.now?.kind === 'tool' ? session.now.tool : undefined;
    const text = compacting ? 'the conversation' : session.now?.text ?? '';
    if (tool || text) {
      lines.push(
        <div key="live" data-item="live">
          <p className="mb-4 type-mono text-ink-3">{label}</p>
          <div className="flex min-h-24 min-w-0 items-center gap-8">
            {tool ? <ToolLine tool={tool} text={text} /> : <span className="type-body text-ink-2">{text}</span>}
            {session.subagentsRunning > 0 ? <span className="flex-none type-mono text-ink-3">· +{session.subagentsRunning} agents</span> : null}
          </div>
        </div>,
      );
    }
  }
  if (session.move) {
    const m = session.move;
    lines.push(
      <p key="move" className="type-mono text-ink-3">
        Moving {accountId(m.from)}
        {m.to !== undefined ? ` → ${accountId(m.to)}` : ''} · {m.step}
        {m.why ? ` · ${m.why}` : ''}
      </p>,
    );
  }
  if (session.errorLast && session.status !== 'ended') {
    lines.push(
      <p key="err" className="flex items-start gap-8 type-small text-ink-2">
        <WarningIcon size={16} aria-hidden="true" className="mt-1 flex-none" />
        <span className="min-w-0">{session.errorLast}</span>
      </p>,
    );
  }
  return <>{lines}</>;
}

export function Transcript({
  session,
  glyph,
  sends,
  now,
  phone,
  dim = false,
  labelledBy,
  id,
}: {
  session: Session;
  glyph: GlyphState;
  sends: Sends;
  now: number;
  phone: boolean;
  /** The session is gone: the last known transcript, dimmed. */
  dim?: boolean;
  labelledBy?: string;
  id?: string;
}) {
  const { api } = useDeps();
  const sid = session.sid;
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [busyOlder, setBusyOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const alive = useRef(true);
  const lastFetch = useRef(0);
  const anchor = useRef<number | null>(null);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const loadLatest = useCallback(async () => {
    lastFetch.current = Date.now();
    try {
      const res = await api.getTranscript(sid, { limit: PAGE });
      if (!alive.current || !res) return;
      const page = [...res.items].reverse();
      const prev = itemsRef.current;
      const ids = new Set(page.map((i) => i.id));
      const overlap = prev.some((i) => ids.has(i.id));
      if (!prev.length || (page.length && !overlap)) {
        setItems(page);
        setNext(res.nextBefore);
      } else {
        setItems([...prev.filter((i) => !ids.has(i.id)), ...page]);
      }
      setError(null);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, [api, sid]);

  const loadOlder = useCallback(async () => {
    if (!next || busyOlder) return;
    setBusyOlder(true);
    try {
      const res = await api.getTranscript(sid, { before: next, limit: PAGE });
      if (!alive.current) return;
      const el = scroller.current;
      anchor.current = el ? el.scrollHeight - el.scrollTop : null;
      const older = [...res.items].reverse();
      setItems((prev) => {
        const ids = new Set(prev.map((i) => i.id));
        return [...older.filter((i) => !ids.has(i.id)), ...prev];
      });
      setNext(res.nextBefore);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setBusyOlder(false);
    }
  }, [api, sid, next, busyOlder]);

  // First page on open.
  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  // A new reply, a status change or a proven send: fetch the newest page again (throttled).
  const proven = sends.views.filter((s) => s.job && isProven(s.job.stage)).length;
  const sig = `${session.lastReply?.at ?? ''}|${session.status}|${proven}|${session.now?.text ?? ''}`;
  const firstSig = useRef(sig);
  useEffect(() => {
    if (sig === firstSig.current) return;
    firstSig.current = sig;
    const wait = Math.max(300, REFRESH_MIN_MS - (Date.now() - lastFetch.current));
    const t = setTimeout(() => void loadLatest(), wait);
    return () => clearTimeout(t);
  }, [sig, loadLatest]);

  // Scroll to the top: load older messages.
  useEffect(() => {
    const el = top.current;
    const root = scroller.current;
    if (!el || !root || typeof IntersectionObserver === 'undefined' || !next) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadOlder();
    }, { root, rootMargin: '120px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [next, loadOlder]);

  const { matched, pending } = useMemo(() => matchSends(items, sends.views), [items, sends.views]);
  // While working, the live line says what runs now; drop the same call from the end of the list.
  const nowTool = session.status === 'working' && session.now?.kind === 'tool' ? session.now : null;
  const shownItems = useMemo(() => {
    const last = items[items.length - 1];
    if (nowTool && last?.kind === 'tool_use' && last.tool === nowTool.tool && last.text.trim() === nowTool.text.trim()) return items.slice(0, -1);
    return items;
  }, [items, nowTool]);
  const blocks = useMemo(() => toBlocks(shownItems, matched), [shownItems, matched]);
  const tailKey = `${items[items.length - 1]?.id ?? ''}|${pending.length}|${pending.map((p) => p.job?.stage ?? '').join(',')}|${session.now?.text ?? ''}`;
  const tailRef = useRef(tailKey);
  const countRef = useRef(items.length + pending.length);

  // Keep the newest in view while you are at the bottom; count arrivals otherwise.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const count = items.length + pending.length;
    const added = Math.max(0, count - countRef.current);
    countRef.current = count;
    if (anchor.current !== null) {
      // Older messages were put on top: keep what you were reading in place.
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
      return;
    }
    if (tailRef.current === tailKey) return;
    tailRef.current = tailKey;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else if (added) setFresh((n) => n + added);
  }, [tailKey, items.length, pending.length]);

  // First paint: start at the newest.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [loaded]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    if (atBottom.current && fresh) setFresh(0);
  };
  const toBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setFresh(0);
  };

  const fallback = !items.length && session.lastReply?.text ? session.lastReply : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        id={id}
        role="tabpanel"
        aria-labelledby={labelledBy}
        tabIndex={0}
        onScroll={onScroll}
        className={clsx('no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto focus-visible:-outline-offset-2', phone ? 'px-16 pb-16 pt-20' : 'pb-20 pt-24')}
      >
        <div className="mt-auto flex flex-col gap-16">
          <div ref={top} aria-hidden="true" />
          {next ? (
            <button
              type="button"
              className="flex h-24 items-center gap-8 self-start rounded-chip type-small text-ink-3 coarse:h-44 transition-colors duration-120 hover:text-ink-2"
              onClick={() => void loadOlder()}
              disabled={busyOlder}
            >
              Earlier messages
              <Spinner active={busyOlder} label="Loading earlier messages" />
            </button>
          ) : null}
          {blocks.map((b) => {
            switch (b.kind) {
              case 'user':
                return (
                  <UserTurn key={b.item.id} at={b.item.at} now={now} text={b.item.text}>
                    {b.send ? (
                      <SendReceipt s={b.send} sends={sends} now={now} />
                    ) : (
                      <p className="mt-6 flex items-center gap-6 type-mono text-ink-3">
                        {b.item.kind === 'queued' ? 'queued' : 'delivered'}
                        {b.item.kind === 'queued' ? null : <CheckIcon size={12} weight="bold" aria-hidden="true" />}
                      </p>
                    )}
                  </UserTurn>
                );
              case 'text':
                return (
                  <div key={b.item.id} data-item="assistant" className="max-w-600">
                    <Prose text={b.item.text} dim={dim} />
                  </div>
                );
              case 'tools':
                return <ToolRun key={b.items[0]?.id} items={b.items} />;
              case 'meta':
                return (
                  <p key={b.item.id} data-item="meta" className="max-w-600 type-small text-ink-3 wrap-break-word">
                    {b.item.text}
                  </p>
                );
            }
          })}
          {fallback ? (
            <div data-item="assistant" className="max-w-600">
              <Prose text={fallback.text} dim={dim} />
            </div>
          ) : null}
          {loaded && !items.length && !fallback && !pending.length && !error ? (
            <p className="type-small text-ink-3">No messages yet.</p>
          ) : null}
          {!loaded && !fallback ? <Spinner label="Loading the transcript" /> : null}
          {error ? (
            <p className="flex items-center gap-8 type-small text-ink-2">
              Could not load the transcript: {error}
              <button type="button" className="rounded-chip text-ink underline decoration-line-strong underline-offset-3 coarse:min-h-44" onClick={() => void loadLatest()}>
                Try again
              </button>
            </p>
          ) : null}
          {pending.map((s) => (
            <SendTurn key={s.key} s={s} sends={sends} now={now} />
          ))}
          <LiveTail session={session} glyph={glyph} now={now} />
        </div>
      </div>
      {fresh > 0 ? (
        <button
          type="button"
          onClick={toBottom}
          className="absolute bottom-12 left-1/2 inline-flex h-24 -translate-x-1/2 coarse:h-44 animate-fade items-center gap-6 rounded-chip border border-line-strong bg-raised px-8 type-mono text-ink-2 transition-colors duration-120 hover:text-ink"
        >
          <ArrowDownIcon size={12} weight="bold" aria-hidden="true" />
          {fresh} new
        </button>
      ) : null}
    </div>
  );
}
