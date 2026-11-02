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
 */
import { useEffect, useRef, useState } from 'react';
import type { ChatTurn } from '@jantar/protocol';
import { useDraft } from '../../../lib/drafts.js';
import { useDeps, useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { CommandSentence } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { Loaded, OfflineLine, RowMenu, SheetActions, useOffline } from '../life/today/parts.js';
import { Composer, useChips } from './Composer.js';
import { CHAT_COPY, EXAMPLES, PRIVACY, PRIVACY_SHORT, unfinished } from './model.js';
import { Refused, Turn, refusalText, useTap } from './Turn.js';

const CHIP = 'h-32 rounded-chip border border-line px-10 type-small text-ink-2 transition-colors duration-120 ease-hover hover:text-ink coarse:h-44';
const LINK = 'rounded-chip type-small font-medium text-ink-2 transition-colors duration-120 hover:text-ink coarse:min-h-44 coarse:px-8';

export function Chat() {
  const { api } = useDeps();
  const offline = useOffline();
  const nowMs = useNow(30_000);
  const load = useLifeLoad('chat', () => api.chatList());
  const [earlier, setEarlier] = useState<ChatTurn[]>([]);
  const [older, setOlder] = useState<string | null | undefined>(undefined);
  const turns = [...earlier.filter((t) => !(load.data?.turns ?? []).some((x) => x.id === t.id)), ...(load.data?.turns ?? [])];
  const area = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  // 0.11: the box is a draft (lib/drafts.ts), kept past leaving Chat and coming back.
  const [draft, setDraft] = useDraft('chat');
  const [confirm, setConfirm] = useState(false);
  const send = useTap();
  const clear = useTap();
  const more = useTap();
  const chips = useChips('chat');
  /** Failed turns sent again from here: their Try again goes, so a second tap sends no duplicate. */
  const [retried, setRetried] = useState<ReadonlySet<string>>(() => new Set());

  const ready = load.data?.ready.ok ?? false;
  const busy = turns.filter(unfinished).length >= 3;
  const canSend = ready && !busy && !offline && !send.busy;
  const cursor = older === undefined ? (load.data?.older ?? null) : older;

  const go = async (text: string, photos: readonly string[], fromBox: boolean): Promise<boolean> => {
    const t = text.trim();
    if ((!t && photos.length === 0) || !canSend) return false;
    const ok = await send.run((key) => api.chatSend(t, photos, key));
    if (ok && fromBox) setDraft('');
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
    if (!newest) return;
    end.current?.scrollIntoView({ block: 'end' });
    resetSend();
  }, [newest, resetSend]);

  const loadEarlier = async () => {
    if (!cursor) return;
    await more.run(async () => {
      const page = await api.chatList(cursor);
      setEarlier((e) => [...page.turns, ...e]);
      setOlder(page.older);
    });
  };

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
    }
    load.reload();
  };

  return (
    <>
      <div className="flex min-h-full flex-col animate-enter max-w-720">
        <header className="flex min-h-44 items-center gap-12 px-16 pb-8 pt-16 desk:pt-24">
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

        <div className="flex-1 pb-16">
          <Loaded load={load} count={3}>
            {(list) =>
              turns.length === 0 ? (
                list.ready.ok ? (
                  <div className="px-16 py-8">
                    <p className="type-small text-ink-2">{CHAT_COPY.empty}</p>
                    {/* The examples first: at 320 px the words below them may sit under the composer. */}
                    <div role="group" aria-label="Examples" className="mt-12 flex flex-wrap gap-6">
                      {EXAMPLES.map((x) => (
                        <button key={x} type="button" className={CHIP} onClick={() => fill(x)}>
                          {x}
                        </button>
                      ))}
                    </div>
                    <p className="mt-12 type-small text-pretty text-ink-3">{PRIVACY}</p>
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
          {load.data && !load.data.ready.ok ? (
            <CommandSentence sentence={load.data.ready.reason ?? CHAT_COPY.notReady} />
          ) : (
            <Composer area={area} draft={draft} setDraft={setDraft} sending={send.busy} canSend={canSend} chips={chips} onSend={() => void sendBox()} />
          )}
          {busy ? <p className="mt-8 type-small text-ink-2">{CHAT_COPY.wait}</p> : null}
          {send.error ? <Refused className="mt-8">{refusalText(send.error)}</Refused> : null}
          <Privacy />
        </div>
        <div ref={end} />
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
