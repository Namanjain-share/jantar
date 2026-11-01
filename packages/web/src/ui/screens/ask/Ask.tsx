/**
 * Ask (v0.5.3 spec 1, `/ask`): plain words in, suggested Life items out.
 *
 *   Ask                                            ···   Clear history
 *                                  todo add call the bank
 *   A todo for tomorrow.
 *   Todo  Call the bank
 *   Tomorrow, Mon 2 Nov
 *   [Add] [Edit] Skip
 *   ┌──────────────────────────────────────┐ [↑]       sticky above the tabs
 *   Sent to Claude on your account: only what you type here …   always
 *
 * The turns are this device's, kept in the Mac's memory: `GET /v1/ask`,
 * again on every lifeTick (the Mac ticks on each turn's change) and when
 * the page comes back into view. Nothing is kept on the phone. A show
 * card's numbers come from one `GET /v1/life/today` for the page, made only
 * while a show card is on screen; the target is the Mac's, never a default.
 *
 * The box grows from one line to six (as the session composer does);
 * Cmd/Ctrl+Enter sends. One turn waits at a time: Send waits for it, and
 * Try again sends a failed turn's words as a new turn. While Ask can't run
 * the Mac's sentence takes the box's place and the history stays.
 */
import { ArrowUpIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { ASK_TEXT_MAX, type Todo } from '@jantar/protocol';
import { useDeps, useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { useFrame } from '../../shell/layout.js';
import { CommandSentence } from '../life/shared/states.js';
import { useLifeLoad, useLifeStatus } from '../life/shared/useLife.js';
import { Loaded, OfflineLine, RowMenu, SheetActions, UndoLine, useLifeClock, useOffline, useSheet } from '../life/today/parts.js';
import { useTodoActions } from '../life/todos/actions.js';
import { TodoSheet } from '../life/todos/TodoSheet.js';
import { useProjects } from '../life/todos/useProjects.js';
import { ASK_COPY, EXAMPLES, PRIVACY, unfinished } from './model.js';
import { ShowContext } from './Show.js';
import { Refused, Turn, refusalText, useTap } from './Turn.js';

const LINE = 22;
const MAX_LINES = 6;
/** The box shows a count once the words pass this. */
const COUNT_FROM = 900;
const CHIP = 'h-32 rounded-chip border border-line px-10 type-small text-ink-2 transition-colors duration-120 ease-hover hover:text-ink coarse:h-44';

export function Ask() {
  const { api } = useDeps();
  const offline = useOffline();
  const nowMs = useNow(30_000);
  const { status } = useLifeStatus();
  const load = useLifeLoad('ask', () => api.askList());
  const turns = load.data?.turns ?? [];
  const showing = turns.some((t) => t.cards.some((c) => c.action.type === 'show'));
  const today = useLifeLoad(showing ? 'ask:today' : null, () => api.lifeToday());
  const clock = useLifeClock(status, today.data?.day);
  const actions = useTodoActions(today.reload);
  const projects = useProjects();
  const todoSheet = useSheet<Todo>();
  const area = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState(false);
  const send = useTap();
  const clear = useTap();

  const ready = load.data?.ready ?? false;
  const waiting = turns.some(unfinished);
  const canSend = ready && !waiting && !offline && !send.busy;

  const ask = async (text: string, fromBox: boolean) => {
    const t = text.trim();
    if (!t || !canSend) return;
    const ok = await send.run((key) => api.askSend(t, key));
    if (ok && fromBox) setDraft('');
    load.reload();
  };

  // The newest turn in view: when one is added and when its answer comes.
  const last = turns.at(-1);
  const newest = last ? `${turns.length}:${last.id}:${last.state}` : '';
  useEffect(() => {
    if (newest) end.current?.scrollIntoView({ block: 'end' });
  }, [newest]);

  const fill = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => area.current?.focus());
  };

  const doClear = async () => {
    const ok = await clear.run((key) => api.askClear(key));
    if (ok) setConfirm(false);
    load.reload();
  };

  return (
    <ShowContext.Provider value={{ today, actions, now: clock, projects, offline, onEdit: (todo) => todoSheet.show(todo) }}>
      <div className="flex min-h-full flex-col animate-enter md:max-w-720">
        <header className="flex min-h-44 items-center gap-12 px-16 pb-8 pt-16 md:pt-24">
          <h1 data-display className="min-w-0 flex-1 truncate type-display text-ink">
            Ask
          </h1>
          <RowMenu label="Ask history" disabled={offline || !load.data?.turns.length} groups={[{ items: [{ label: 'Clear history', onSelect: () => setConfirm(true) }] }]} />
        </header>
        {offline ? <OfflineLine className="px-16 pb-8" /> : null}

        <div className="flex-1 pb-16">
          <Loaded load={load} count={3}>
            {(list) =>
              list.turns.length === 0 ? (
                <div className="px-16 py-8">
                  <p className="type-small text-ink-2">{ASK_COPY.empty}</p>
                  <div role="group" aria-label="Examples" className="mt-12 flex flex-wrap gap-6">
                    {EXAMPLES.map((x) => (
                      <button key={x} type="button" className={CHIP} onClick={() => fill(x)}>
                        {x}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <ol aria-label="Messages">
                  {list.turns.map((turn) => (
                    <Turn
                      key={turn.id}
                      turn={turn}
                      nowMs={nowMs}
                      today={clock.day}
                      currency={status?.currency ?? null}
                      projects={projects}
                      offline={offline}
                      canSend={canSend}
                      onRetry={(text) => void ask(text, false)}
                      onChanged={load.reload}
                    />
                  ))}
                </ol>
              )
            }
          </Loaded>
        </div>

        <div className="sticky bottom-0 z-3 border-t border-line bg-bg px-16 pb-12 pt-12">
          <UndoLine offer={actions.undo.offer} onUndo={actions.undo.take} className="-mx-16 -mt-12 mb-8" />
          {load.data && !load.data.ready ? (
            <CommandSentence sentence={load.data.reason ?? ASK_COPY.notReady} />
          ) : (
            <Box area={area} draft={draft} setDraft={setDraft} sending={send.busy} canSend={canSend} onSend={() => void ask(draft, true)} />
          )}
          {waiting ? <p className="mt-8 type-small text-ink-2">{ASK_COPY.wait}</p> : null}
          {send.error ? <Refused className="mt-8">{refusalText(send.error)}</Refused> : null}
          <p className="mt-8 type-small text-ink-3">{PRIVACY}</p>
        </div>
        <div ref={end} />
      </div>

      <Sheet open={confirm} onOpenChange={(o) => setConfirm(o)} title="Clear history">
        <div className="pb-16">
          <p className="type-small text-ink-2">{ASK_COPY.clear}</p>
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
      <TodoSheet
        open={todoSheet.open}
        onOpenChange={todoSheet.onOpenChange}
        sheetKey={todoSheet.key}
        todo={todoSheet.item}
        projects={projects}
        now={clock}
        onSaved={today.reload}
      />
    </ShowContext.Provider>
  );
}

/** The box: 1 to 6 lines, Cmd/Ctrl+Enter or the arrow sends, a count past 900 characters. */
function Box({
  area,
  draft,
  setDraft,
  sending,
  canSend,
  onSend,
}: {
  area: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (text: string) => void;
  sending: boolean;
  canSend: boolean;
  onSend: () => void;
}) {
  const id = useId();
  const phone = useFrame() === 'phone';
  const can = canSend && draft.trim().length > 0;

  // Grow with the text, one to six lines (CSSOM, which the CSP allows).
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(phone ? 44 : 40, Math.min(LINE * MAX_LINES + 18, el.scrollHeight + 2))}px`;
  }, [draft, phone, area]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (can) onSend();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} aria-label="Ask in plain words">
      <div className="flex items-end gap-8">
        <label htmlFor={`${id}-text`} className="sr-only">
          What to add, or a question about today
        </label>
        <textarea
          id={`${id}-text`}
          ref={area}
          value={draft}
          rows={1}
          maxLength={ASK_TEXT_MAX}
          placeholder="todo add call the bank"
          disabled={sending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          enterKeyHint="send"
          className={clsx(
            'no-scrollbar min-w-0 flex-1 resize-none rounded-btn border border-line-strong bg-surface px-12 type-input text-ink transition-colors duration-120',
            'focus-visible:outline-offset-0 disabled:border-line disabled:text-ink-3',
            phone ? 'h-44 py-10' : 'h-40 py-8',
          )}
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!can}
          className={clsx(
            'flex flex-none items-center justify-center rounded-btn bg-ink text-bg transition duration-120 ease-hover',
            'hover:not-disabled:bg-ink-2 active:not-disabled:scale-97 motion-reduce:active:not-disabled:scale-100 disabled:bg-line disabled:text-ink-3',
            phone ? 'size-44' : 'size-40',
          )}
        >
          {sending ? <Spinner label="Sending" delayMs={0} /> : <ArrowUpIcon size={phone ? 20 : 16} weight="bold" aria-hidden="true" />}
        </button>
      </div>
      {draft.length > COUNT_FROM ? (
        <p className="mt-4 text-right type-mono text-ink-3">
          {draft.length} / {ASK_TEXT_MAX}
        </p>
      ) : null}
    </form>
  );
}
