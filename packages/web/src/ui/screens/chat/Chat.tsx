/**
 * Chat (v0.10, spec 0.10 B14, `/chat`; `/ask` lands here): ask Jantar
 * anything, by text or with photos.
 *
 *   Chat                                           ···   Clear chat…
 *   [Earlier]
 *                                 Add oat milk to my list
 *   Added it.
 *   Added   Todo · Buy oat milk                  Undo
 *   ┌ Delete café Example Café and its 3 visits?  ┐
 *   └ [Confirm] Dismiss                            ┘
 *   [img] [+] ┌──────────────────────────┐ [↑]       pinned above the tabs
 *   Sent to Claude on your account.  What's sent
 *
 * One thread per Mac, shared with every control device and Siri: `GET
 * /v1/chat` (the newest page, oldest first), again on every lifeTick and on
 * visibility; "Earlier" pages back with ?before. Changes and cards come
 * from the Mac's journal, never from the reply. Nothing is kept on the
 * phone but what is on screen.
 *
 * 0.12 (build plan 2.2): a SplitPane ("chat", the thread always open).
 * From a pane of 800 the days list beside the thread (History.tsx: search,
 * the days, and Changes and Photos as segments), once there is a day to
 * list; from 1180 Changes and Photos have a column of their own (This
 * chat, ThisChat.tsx). While the thread is empty that column sits beside
 * it from 800 and says what Chat can see. The thread reads in a column of 680 at most; the composer is
 * pinned under it. A tap in the history scrolls the thread to the turn and
 * puts its day in the address (?day=). Below 800 the thread is alone, as
 * before.
 */
import { CaretLeftIcon, CornersOutIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ChatTurn } from '@jantar/protocol';
import { useDraft } from '../../../lib/drafts.js';
import { routePath } from '../../../lib/router.js';
import { useApp, useDeps, useNavigate, useNow } from '../../context.js';
import { useLookingAtNow } from '../../shell/lookingAt.js';
import { Button } from '../../kit/Button.js';
import { IconButton } from '../../kit/IconButton.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { SplitPane, useSplit } from '../../kit/SplitPane.js';
import { CommandSentence } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { Loaded, OfflineLine, RowMenu, SheetActions, useOffline } from '../life/today/parts.js';
import { Composer, useChips } from './Composer.js';
import { History } from './History.js';
import { CHAT_COPY, EXAMPLES, PRIVACY, PRIVACY_SHORT, dayOf, lookingWords, takesContext, unfinished } from './model.js';
import { ThisChat } from './ThisChat.js';
import { Refused, Turn, refusalText, useTap } from './Turn.js';

// The examples: chips on a phone; from a thread 640 wide, three 44 rows across the reading column.
const CHIP =
  'h-32 rounded-chip border border-line px-10 type-small text-ink-2 transition-colors duration-120 ease-hover hover:text-ink coarse:h-44 ' +
  '@md:flex @md:h-44 @md:w-full @md:items-center @md:rounded-btn @md:bg-raised @md:px-16 @md:text-left @md:type-row @md:text-ink';
const LINK = 'rounded-chip type-small font-medium text-ink-2 transition-colors duration-120 hover:text-ink coarse:min-h-44 coarse:px-8';

export interface ChatProps {
  /** 0.12, ?day=: the thread opens at that day's first turn. */
  day?: string | undefined;
  /** 0.12 (c28): the panel beside another screen (ChatDock.tsx): the thread alone, with its own header. */
  dock?: { focus: number; onClose: () => void; onOpenFull: () => void } | undefined;
}

export { ChatDock } from './ChatDock.js';

export function Chat({ day, dock }: ChatProps = {}) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const offline = useOffline();
  const nowMs = useNow(30_000);
  const load = useLifeLoad('chat', () => api.chatList());
  const [earlier, setEarlier] = useState<ChatTurn[]>([]);
  const [older, setOlder] = useState<string | null | undefined>(undefined);
  const turns = [...earlier.filter((t) => !(load.data?.turns ?? []).some((x) => x.id === t.id)), ...(load.data?.turns ?? [])];
  const area = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  // 0.12: the box is a draft (lib/drafts.ts), kept past leaving Chat and coming back.
  const [draft, setDraft] = useDraft('chat');
  const [confirm, setConfirm] = useState(false);
  const send = useTap();
  const clear = useTap();
  const more = useTap();
  const chips = useChips('chat');
  /** Failed turns sent again from here: their Try again goes, so a second tap sends no duplicate. */
  const [retried, setRetried] = useState<ReadonlySet<string>>(() => new Set());
  /** The turn the history last scrolled the thread to. */
  const [picked, setPicked] = useState<string | null>(null);

  const ready = load.data?.ready.ok ?? false;
  const busy = turns.filter(unfinished).length >= 3;
  const canSend = ready && !busy && !offline && !send.busy;
  const cursor = older === undefined ? (load.data?.older ?? null) : older;

  // 0.12 (c29): beside a screen, the "Looking at" chip names what it shows; it goes with the box's message while shown.
  const seen = useLookingAtNow();
  const [chipOff, setChipOff] = useState<string | null>(null);
  const looking = dock && seen && chipOff !== `${seen.kind}:${seen.id}` ? seen : null;
  const daemonVersion = useApp((s) => s.state.daemon?.daemonVersion);
  const go = async (text: string, photos: readonly string[], fromBox: boolean): Promise<boolean> => {
    const t = text.trim();
    if ((!t && photos.length === 0) || !canSend) return false;
    const about = fromBox ? looking : null;
    const asContext = about && takesContext(daemonVersion) ? { kind: about.kind, id: about.id } : undefined;
    const words = about && !asContext ? `${lookingWords(about.label)} ${t}`.trim() : t;
    const ok = await send.run((key) => (asContext ? api.chatSend(words, photos, key, asContext) : api.chatSend(words, photos, key)));
    if (ok && fromBox) setDraft('');
    // A new message is read at the end of the thread, not at the day the address had open.
    if (ok && day) navigate(routePath({ name: 'chat' }), { replace: true });
    load.reload();
    return ok;
  };

  // The box's message: the chips go once the Mac took it (a refused send keeps them), and the box keeps the focus.
  const sendBox = async () => {
    const ok = await go(draft, chips.ids(), true);
    if (ok) chips.clear();
    area.current?.focus();
  };

  // Try again sends the text and the photos still there (the Mac takes a failed turn's photos again).
  const retry = async (t: ChatTurn) => {
    const ok = await go(t.text, t.photos.filter((p) => !p.gone).map((p) => p.id), false);
    if (ok) setRetried((s) => new Set(s).add(t.id));
  };

  const last = turns.at(-1);
  const newest = last ? `${turns.length}:${last.id}:${last.state}` : '';
  const resetSend = send.reset;
  useEffect(() => {
    if (!newest || day) return;
    end.current?.scrollIntoView({ block: 'end' });
    resetSend();
  }, [newest, resetSend, day]);

  /** The thread scrolls to a turn (its `data-turn`). */
  const scrollTo = (id: string) => [...(thread.current?.querySelectorAll('[data-turn]') ?? [])].find((el) => el.getAttribute('data-turn') === id)?.scrollIntoView({ block: 'start' });
  // From the history: the thread goes to the turn, and the address keeps its day.
  const pick = (t: ChatTurn) => {
    setPicked(t.id);
    scrollTo(t.id);
    navigate(routePath({ name: 'chat', day: dayOf(t.at) }), { replace: true });
  };
  // Opened with ?day=: once the turns are here, the thread starts at that day's first one.
  const startedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!day || startedAt.current === day || !turns.length) return;
    const first = turns.find((t) => dayOf(t.at) === day);
    if (!first) return;
    startedAt.current = day;
    setPicked(first.id);
    scrollTo(first.id);
  }, [day, turns]);

  const loadEarlier = async () => {
    if (!cursor) return;
    await more.run(async () => {
      const page = await api.chatList(cursor);
      setEarlier((e) => [...page.turns, ...e]);
      setOlder(page.older);
    });
  };

  // The panel opened by ⌘J or its button: the box takes the focus.
  const dockFocus = dock?.focus ?? 0;
  useEffect(() => {
    if (dockFocus) area.current?.focus();
  }, [dockFocus]);

  const fill = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => area.current?.focus());
  };

  const doClear = async () => {
    const ok = await clear.run((key) => api.chatClear(key));
    if (ok) {
      setConfirm(false);
      setEarlier([]);
      setOlder(undefined);
      setPicked(null);
    }
    load.reload();
  };

  // `side`: This chat is beside the thread, and says what Chat can see in place of the line here.
  const threadPane = (side: boolean) => (
    <div className="flex min-h-full flex-col animate-enter">
      {dock ? (
        <header className="flex h-pane flex-none items-center gap-4 border-b border-line pl-16 pr-8">
          <h2 className="min-w-0 flex-1 truncate type-title text-ink">Chat</h2>
          <IconButton aria-label="Open in Chat" className="coarse:size-44" onClick={dock.onOpenFull}>
            <CornersOutIcon size={18} aria-hidden="true" />
          </IconButton>
          <IconButton aria-label="Close Chat" title="Close (⌘J)" className="coarse:size-44" onClick={dock.onClose}>
            <XIcon size={18} aria-hidden="true" />
          </IconButton>
        </header>
      ) : null}
      <header className={dock ? 'hidden' : 'flex min-h-44 items-center gap-12 px-16 pb-8 pt-16 desk:pt-24'}>
        <DaysButton />
        <h1 data-display className="min-w-0 flex-1 truncate type-display text-ink">
          Chat
        </h1>
        <RowMenu
          label="Chat history"
          disabled={offline || turns.length === 0}
          groups={[
            {
              items: [
                {
                  label: 'Clear chat…',
                  onSelect: () => {
                    clear.reset();
                    setConfirm(true);
                  },
                },
              ],
            },
          ]}
        />
      </header>
      {offline ? <OfflineLine className="px-16 pb-8" /> : null}

      {/* The reading column: 680 at most, in the middle of a wide thread. */}
      <div className="mx-auto w-full max-w-680 flex-1 pb-16">
        <Loaded load={load} count={3}>
          {(list) =>
            turns.length === 0 ? (
              list.ready.ok ? (
                <div className="px-16 py-8">
                  <p className="type-small text-ink-2">{CHAT_COPY.empty}</p>
                  {/* The examples first: at 320 px the words below them may sit under the composer. */}
                  <div role="group" aria-label="Examples" className="mt-12 flex flex-wrap gap-6 @md:flex-col @md:gap-8">
                    {EXAMPLES.map((x) => (
                      <button key={x} type="button" className={CHIP} onClick={() => fill(x)}>
                        {x}
                      </button>
                    ))}
                  </div>
                  {side ? null : <p className="mt-12 type-small text-pretty text-ink-3">{PRIVACY}</p>}
                </div>
              ) : null
            ) : (
              <>
                {cursor ? (
                  <div className="px-16 pb-8">
                    <Button variant="text" size="sm" disabled={offline || more.busy} onClick={() => void loadEarlier()}>
                      {more.busy ? <Spinner label="Loading" /> : null}
                      {CHAT_COPY.earlier}
                    </Button>
                  </div>
                ) : null}
                <ol aria-label="Messages">
                  {turns.map((turn) => (
                    <Turn
                      key={turn.id}
                      turn={turn}
                      nowMs={nowMs}
                      offline={offline}
                      canSend={canSend}
                      retried={retried.has(turn.id)}
                      onRetry={(t) => void retry(t)}
                      onChanged={load.reload}
                    />
                  ))}
                </ol>
              </>
            )
          }
        </Loaded>
      </div>

      <div className="sticky bottom-0 z-3 border-t border-line bg-bg px-16 pb-[max(12px,env(safe-area-inset-bottom))] pt-12">
        <div className="mx-auto w-full max-w-680">
          {load.data && !load.data.ready.ok ? (
            <CommandSentence sentence={load.data.ready.reason ?? CHAT_COPY.notReady} />
          ) : (
            <>
              {looking ? (
                <div className="mb-8 flex min-w-0">
                  <span className="flex h-44 min-w-0 items-center gap-8 rounded-btn border border-line bg-raised pl-12 type-small text-ink-2">
                    <span className="min-w-0 truncate">
                      Looking at: <span className="text-ink">{looking.label}</span>
                    </span>
                    <IconButton aria-label={`Don't send what you're looking at: ${looking.label}`} className="size-44 flex-none" onClick={() => setChipOff(`${looking.kind}:${looking.id}`)}>
                      <XIcon size={14} aria-hidden="true" />
                    </IconButton>
                  </span>
                </div>
              ) : null}
              <Composer area={area} draft={draft} setDraft={setDraft} sending={send.busy} canSend={canSend} chips={chips} onSend={() => void sendBox()} />
            </>
          )}
          {busy ? <p className="mt-8 type-small text-ink-2">{CHAT_COPY.wait}</p> : null}
          {send.error ? <Refused className="mt-8">{refusalText(send.error)}</Refused> : null}
          <Privacy />
        </div>
      </div>
      <div ref={end} />
    </div>
  );

  // The panel: the thread alone (its own scroll box and query container), the composer pinned under it.
  if (dock) {
    return (
      <>
        <div ref={thread} data-thread className="@container h-full min-h-0 overflow-y-auto">
          {threadPane(false)}
        </div>
        <Sheet open={confirm} onOpenChange={(o) => setConfirm(o)} title="Clear chat">
          <div className="pb-16">
            <p className="type-small text-ink-2">{CHAT_COPY.clear}</p>
            {clear.error ? <Refused className="mt-8">{refusalText(clear.error)}</Refused> : null}
            <SheetActions>
              <Button variant="primary" size="lg" className="flex-1" disabled={clear.busy || offline} onClick={() => void doClear()}>
                {clear.busy ? <Spinner label="Clearing" /> : null}
                Clear
              </Button>
              <Button variant="text" size="lg" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </SheetActions>
          </div>
        </Sheet>
      </>
    );
  }

  return (
    <>
      {/* 0.12: the days beside the thread from a pane of 800 (none until there is a day to list), This chat beside it from 1180. */}
      <SplitPane
        name="chat"
        listWidth="history"
        noList={turns.length === 0}
        list={
          <History
            turns={turns}
            nowMs={nowMs}
            offline={offline}
            picked={picked}
            earlier={Boolean(cursor)}
            loadingEarlier={more.busy}
            onEarlier={() => void loadEarlier()}
            onPick={pick}
            onChanged={load.reload}
          />
        }
        detail={
          <ThreadAndSide
            thread={threadPane}
            empty={turns.length === 0}
            threadRef={thread}
            side={<ThisChat turns={turns} nowMs={nowMs} offline={offline} keepDays={load.data?.keepDays ?? 30} onPick={pick} onChanged={load.reload} />}
          />
        }
        selection="thread"
        overlay
        listLabel="Days"
        detailLabel="Thread"
      />

      <Sheet open={confirm} onOpenChange={(o) => setConfirm(o)} title="Clear chat">
        <div className="pb-16">
          <p className="type-small text-ink-2">{CHAT_COPY.clear}</p>
          {clear.error ? <Refused className="mt-8">{refusalText(clear.error)}</Refused> : null}
          <SheetActions>
            <Button variant="primary" size="lg" className="flex-1" disabled={clear.busy || offline} onClick={() => void doClear()}>
              {clear.busy ? <Spinner label="Clearing" /> : null}
              Clear
            </Button>
            <Button variant="text" size="lg" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </SheetActions>
        </div>
      </Sheet>
    </>
  );
}

/**
 * The thread, its own scroll box and query container, and This chat beside
 * it in a pane of 1180 or more (D7), or in any split pane while the thread
 * is empty (no days take the room yet, and it says what Chat can see).
 */
function ThreadAndSide({ thread, empty, threadRef, side }: { thread: (side: boolean) => ReactNode; empty: boolean; threadRef: RefObject<HTMLDivElement | null>; side: ReactNode }) {
  const split = useSplit();
  const beside = Boolean(split?.split && (split.wide || empty));
  return (
    <div className="flex h-full min-h-0">
      <div ref={threadRef} data-thread className="@container min-h-0 min-w-0 flex-1 overflow-y-auto">
        {thread(beside)}
      </div>
      {beside ? side : null}
    </div>
  );
}

/** 0.12 (c25): "‹ Days" where the days aren't beside the thread (a pane under 800 beside the phone): calls them over it. */
function DaysButton() {
  const over = useSplit()?.overlay;
  if (!over) return null;
  return (
    <Button variant="text" className="-ml-8 flex-none gap-2 px-8" aria-expanded={over.open} onClick={() => over.set(!over.open)}>
      <CaretLeftIcon size={16} aria-hidden="true" />
      Days
    </Button>
  );
}

/** One line under the box; "What's sent" opens the full words in a sheet (the pinned composer keeps its height). */
function Privacy() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="mt-4 flex flex-wrap items-center gap-x-8 type-small text-ink-3">
        <span>{PRIVACY_SHORT}</span>
        <button type="button" className={LINK} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          What's sent
        </button>
      </p>
      <Sheet open={open} onOpenChange={setOpen} title="What's sent">
        <p className="pb-16 type-small text-pretty text-ink-2">{PRIVACY}</p>
      </Sheet>
    </>
  );
}
