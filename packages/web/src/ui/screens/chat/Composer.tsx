/**
 * Chat's composer (v0.10, spec 0.10 B14, B4), pinned at the bottom: a photo
 * button (44 px under a coarse pointer), a box that grows from one line to
 * six, and Send. Photos go through the session attachments' converter
 * (screens/session/attach/convert.ts) with a long edge of CHAT_PHOTO_EDGE:
 * JPEG at 0.85, EXIF and GPS dropped, HEIC made JPEG; PNG and WebP kept
 * only when small and clean; GIF as it is. Each one uploads at once (its
 * chip shows the progress and a × that cancels it or removes it from the
 * Mac); at most CHAT_PHOTOS_MAX a message. Send waits while a photo
 * uploads, offline, or with nothing to send. Enter sends, Shift+Enter is a
 * new line. Never a data: URL: chips show blob: URLs.
 */
import { ArrowUpIcon, ImageIcon, XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { CHAT_PHOTO_EDGE, CHAT_PHOTOS_MAX, CHAT_PHOTO_MAX_BYTES, CHAT_TEXT_MAX } from '@jantar/protocol';
import { errorText } from '../../../lib/api.js';
import { useDeps } from '../../context.js';
import { Spinner } from '../../kit/Spinner.js';
import { useFrame } from '../../shell/layout.js';
import { prepareFile } from '../session/attach/convert.js';

const LINE = 22;
const MAX_LINES = 6;
const COUNT_FROM = 1800;

export interface ChatChip {
  key: string;
  /** The Mac's id once uploaded. */
  id: string | null;
  url: string;
  sent: number;
  total: number;
  error: string | null;
  abort: AbortController;
}

/** The chips and their uploads; `take()` hands the ids over for a send and empties the row. */
export function useChips() {
  const { api } = useDeps();
  const [chips, setChips] = useState<ChatChip[]>([]);
  const live = useRef(chips);
  live.current = chips;
  useEffect(() => () => live.current.forEach((c) => URL.revokeObjectURL(c.url)), []);

  const patch = (key: string, p: Partial<ChatChip>) => setChips((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));

  const add = async (files: readonly File[]) => {
    const room = CHAT_PHOTOS_MAX - live.current.length;
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const prepared = await prepareFile(file, { edge: CHAT_PHOTO_EDGE });
      if ('refused' in prepared || prepared.kind !== 'image') {
        const blob = new Blob();
        setChips((cs) => [...cs, { key, id: null, url: URL.createObjectURL(blob), sent: 0, total: 0, error: 'refused' in prepared ? prepared.refused : 'Chat takes photos only', abort: new AbortController() }]);
        continue;
      }
      if (prepared.blob.size > CHAT_PHOTO_MAX_BYTES) {
        setChips((cs) => [...cs, { key, id: null, url: URL.createObjectURL(prepared.blob), sent: 0, total: 0, error: 'Photos up to 6 MB', abort: new AbortController() }]);
        continue;
      }
      const abort = new AbortController();
      setChips((cs) => [...cs, { key, id: null, url: URL.createObjectURL(prepared.blob), sent: 0, total: prepared.blob.size, error: null, abort }]);
      api.chatPhotoAdd(prepared.blob, { signal: abort.signal, onProgress: (sent, total) => patch(key, { sent, total }) }).then(
        (r) => patch(key, { id: r.id, sent: prepared.blob.size }),
        (e: unknown) => {
          if (!abort.signal.aborted) patch(key, { error: errorText(e) });
        },
      );
    }
  };

  const remove = (key: string) => {
    const c = live.current.find((x) => x.key === key);
    if (!c) return;
    c.abort.abort();
    URL.revokeObjectURL(c.url);
    if (c.id) void api.chatPhotoDelete(c.id).catch(() => {});
    setChips((cs) => cs.filter((x) => x.key !== key));
  };

  const take = (): string[] => {
    const ids = live.current.filter((c) => c.id && !c.error).map((c) => c.id as string);
    live.current.forEach((c) => URL.revokeObjectURL(c.url));
    setChips([]);
    return ids;
  };

  const uploading = chips.some((c) => !c.id && !c.error);
  const ready = chips.filter((c) => c.id && !c.error).length;
  return { chips, add, remove, take, uploading, ready };
}

export function Composer({
  area,
  draft,
  setDraft,
  sending,
  canSend,
  onSend,
  chips,
}: {
  area: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (text: string) => void;
  sending: boolean;
  canSend: boolean;
  onSend: () => void;
  chips: ReturnType<typeof useChips>;
}) {
  const id = useId();
  const phone = useFrame() === 'phone';
  const file = useRef<HTMLInputElement>(null);
  const can = canSend && !chips.uploading && (draft.trim().length > 0 || chips.ready > 0);

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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const square = phone ? 'size-44' : 'size-40';

  return (
    <form onSubmit={submit} aria-label="Message Chat">
      {chips.chips.length ? (
        <ul aria-label="Photos to send" className="mb-8 flex flex-wrap gap-8">
          {chips.chips.map((c) => (
            <li key={c.key} className="relative size-64">
              {c.error ? (
                <span className="flex size-64 items-center justify-center rounded-btn border border-line px-4 text-center type-small text-signal-text">{c.error}</span>
              ) : (
                <img src={c.url} alt="" className="size-64 rounded-btn border border-line object-cover" />
              )}
              {!c.id && !c.error ? (
                <span className="absolute inset-x-0 bottom-0 rounded-b-btn bg-bg/80 text-center type-mono text-ink-2" aria-label="Uploading">
                  {c.total ? Math.round((c.sent / c.total) * 100) : 0}%
                </span>
              ) : null}
              <button type="button" aria-label="Remove the photo" className="absolute -right-6 -top-6 flex size-24 items-center justify-center rounded-full border border-line bg-bg text-ink-2 coarse:size-44 coarse:-right-12 coarse:-top-12" onClick={() => chips.remove(c.key)}>
                <XIcon size={12} weight="bold" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-8">
        <input
          ref={file}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void chips.add(files);
          }}
        />
        <button
          type="button"
          aria-label="Add a photo"
          disabled={sending || chips.chips.length >= CHAT_PHOTOS_MAX}
          onClick={() => file.current?.click()}
          className={clsx('flex flex-none items-center justify-center rounded-btn border border-line-strong text-ink-2 transition duration-120 hover:not-disabled:text-ink disabled:text-ink-3', square)}
        >
          <ImageIcon size={phone ? 20 : 16} aria-hidden="true" />
        </button>
        <label htmlFor={`${id}-text`} className="sr-only">
          A message to Chat
        </label>
        <textarea
          id={`${id}-text`}
          ref={area}
          value={draft}
          rows={1}
          maxLength={CHAT_TEXT_MAX}
          placeholder="Ask or tell Jantar"
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
            square,
          )}
        >
          {sending ? <Spinner label="Sending" delayMs={0} /> : <ArrowUpIcon size={phone ? 20 : 16} weight="bold" aria-hidden="true" />}
        </button>
      </div>
      {draft.length > COUNT_FROM ? (
        <p className="mt-4 text-right type-mono text-ink-3">
          {draft.length} / {CHAT_TEXT_MAX}
        </p>
      ) : null}
    </form>
  );
}
