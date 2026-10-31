/**
 * The composer (direction.md 5.2), shown only when no card is open: a 16 px
 * textarea that grows from one line to six, and an --ink square "Send" with
 * an arrow. Cmd/Ctrl+Enter sends; plain Enter is a new line (phones have no
 * Cmd). Offline it is disabled with the reason. A prompt the daemon would
 * refuse on sight ("!" bash mode, /clear and its aliases) says why before
 * anything is sent. v0.3: the Rewrite button sits next to Send while Rewrite
 * is on (ui/rewrite/RewriteButton.tsx, W1's). v0.4.2 (spec 6.1): the + left
 * of the box (attach/AttachButton.tsx) and the attachment chips above it
 * (attach/Chips.tsx). Pasting a file or an image into the box adds it as a
 * chip (text pastes as before), and so does dropping files on the composer,
 * which draws the box's border in --ink meanwhile. A paste that holds text
 * as well (cells copied from a spreadsheet carry a picture of them) says it
 * went as a file, with "Paste the text instead". Send takes text, chips or
 * both, once every chip is on the Mac; files with a slash command say why
 * they can't go before anything is sent.
 */
import { ArrowUpIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useLayoutEffect, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '../../kit/Button.js';
import { Keycap } from '../../kit/Keycap.js';
import { RewriteButton } from '../../rewrite/RewriteButton.js';
import { useFeatures } from '../../shell/data.js';
import { AttachButton } from './attach/AttachButton.js';
import { Chips } from './attach/Chips.js';
import { usePaneKeys } from './keys.js';
import { ATTACH_COPY, chipsWaiting, filesProblem, promptProblem, type Sends } from './sends.js';

const LINE = 22;
const MAX_LINES = 6;
/** The daemon's limit on a prompt (writer/text.ts), the box's maxLength. */
const PROMPT_CHARS = 16_000;

/** A drag that carries files (not text or a link). */
export const carriesFiles = (dt: DataTransfer | null) => Boolean(dt && Array.from(dt.types ?? []).includes('Files'));

/** The files of a paste: `files`, or the file items where a browser lists them only there. Never navigator.clipboard.read(). */
function pastedFiles(cd: DataTransfer | null): File[] {
  if (!cd) return [];
  if (cd.files?.length) return Array.from(cd.files);
  return Array.from(cd.items ?? []).flatMap((item) => {
    const file = item.kind === 'file' ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

/** The text a paste holds besides its files, unless it only names one of them (a file copied in the Finder). */
function textBesides(cd: DataTransfer | null, files: readonly File[]): string {
  const text = typeof cd?.getData === 'function' ? cd.getData('text/plain') : '';
  const t = text.trim();
  return t && !files.some((f) => f.name && t.endsWith(f.name)) ? text : '';
}

/** A paste that went as files although it held text too: the chips it added, and where the text would have gone. */
interface MixedPaste {
  text: string;
  keys: string[];
  draft: string;
  start: number;
  end: number;
}

export function Composer({
  sid,
  folder,
  sends,
  phone,
  offline,
  onShowOnMac,
}: {
  sid: string;
  folder: string;
  sends: Sends;
  phone: boolean;
  offline: boolean;
  onShowOnMac: () => void;
}) {
  const { draft, setDraft, submit, area, attachments } = sends;
  const features = useFeatures();
  const [dropping, setDropping] = useState(false);
  const [mixed, setMixed] = useState<MixedPaste | null>(null);
  // Only while one of its chips is still in the composer and free (not sent, removed or taken by a send).
  const mixedShown = mixed && attachments.some((a) => mixed.keys.includes(a.key) && !a.sending) ? mixed : null;
  const problem = promptProblem(draft);
  const withFiles = problem ? null : filesProblem(draft, attachments);
  const canSend = (Boolean(draft.trim()) || attachments.length > 0) && !chipsWaiting(attachments) && !problem && !withFiles && !offline;

  // Grow with the text, one to six lines (CSSOM, which the CSP allows).
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const min = phone ? 44 : 40;
    el.style.height = 'auto';
    const max = LINE * MAX_LINES + 18;
    el.style.height = `${Math.max(min, Math.min(max, el.scrollHeight + 2))}px`;
  }, [draft, phone, area]);

  usePaneKeys({ r: () => area.current?.focus() }, !phone && !offline);

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    submit();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };
  // A pasted file or image becomes a chip; a text paste goes ahead as before. When no chip could be added
  // (ten already, offline) the paste goes ahead too, so the text half of a mixed paste isn't lost.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pastedFiles(e.clipboardData);
    if (!files.length) return;
    const keys = sends.addFiles(files);
    if (!keys.length) return;
    e.preventDefault();
    const text = keys.length ? textBesides(e.clipboardData, files) : '';
    const el = e.currentTarget;
    setMixed(text ? { text, keys, draft, start: el.selectionStart, end: el.selectionEnd } : null);
  };
  // "Paste the text instead": the paste's chips go (and their uploads), its text goes where the paste was.
  const pasteText = () => {
    const m = mixedShown;
    if (!m) return;
    for (const key of m.keys) sends.removeAttachment(key);
    setDraft((d) => {
      const [start, end] = d === m.draft ? [m.start, m.end] : [d.length, d.length];
      return `${d.slice(0, start)}${m.text}${d.slice(end)}`.slice(0, PROMPT_CHARS);
    });
    setMixed(null);
    requestAnimationFrame(() => area.current?.focus());
  };
  // Files dropped anywhere on the composer (iPad, desktop). Without preventDefault the browser would open the file.
  const onDragOver = (e: DragEvent<HTMLFormElement>) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    // "copy" offline too: the drop must still arrive, to say why it adds nothing.
    e.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  };
  const onDragLeave = (e: DragEvent<HTMLFormElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
  };
  const onDrop = (e: DragEvent<HTMLFormElement>) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDropping(false);
    sends.addFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <form
      onSubmit={send}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label="Send a prompt"
      className={clsx(phone && 'flex-none border-t border-line bg-bg px-16 pb-safe-16 pt-12')}
    >
      <Chips sends={sends} phone={phone} />
      <div className="flex items-end gap-8">
        <AttachButton sid={sid} sends={sends} phone={phone} offline={offline} />
        <label htmlFor={`prompt-${sid}`} className="sr-only">
          Prompt for Claude
        </label>
        <textarea
          id={`prompt-${sid}`}
          ref={area}
          value={draft}
          rows={1}
          maxLength={PROMPT_CHARS}
          placeholder={offline ? "Offline: can't send right now" : `Send a prompt to ${folder}`}
          disabled={offline}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          enterKeyHint="send"
          className={clsx(
            'no-scrollbar min-w-0 flex-1 resize-none rounded-btn border bg-surface px-12 type-input text-ink transition-colors duration-120',
            dropping ? 'border-ink' : 'border-line-strong',
            'focus-visible:outline-offset-0 disabled:border-line disabled:text-ink-3',
            phone ? 'h-44 py-10' : 'h-40 py-8',
          )}
        />
        {features.rewrite ? <RewriteButton sid={sid} folder={folder} sends={sends} phone={phone} offline={offline} /> : null}
        <button
          type="submit"
          aria-label="Send"
          disabled={!canSend}
          className={clsx(
            'flex flex-none items-center justify-center rounded-btn bg-ink text-bg transition duration-120 ease-hover',
            'hover:not-disabled:bg-ink-2 active:not-disabled:scale-97 motion-reduce:active:not-disabled:scale-100 disabled:bg-line disabled:text-ink-3',
            phone ? 'size-44' : 'size-40',
          )}
        >
          <ArrowUpIcon size={phone ? 20 : 16} weight="bold" aria-hidden="true" />
        </button>
      </div>
      {mixedShown ? (
        <p role="status" className="mt-8 flex flex-wrap items-center gap-x-8 type-small text-ink-2">
          <span>{ATTACH_COPY.pasted}</span>
          <Button variant="text" size="sm" className="-ml-8" onClick={pasteText}>
            {ATTACH_COPY.pasteText}
          </Button>
        </p>
      ) : null}
      {problem ? (
        <p role="status" className="mt-8 flex flex-wrap items-center gap-x-8 type-small text-ink-2">
          <span>{problem}</span>
          <Button variant="text" size="sm" className="-ml-8" onClick={onShowOnMac}>
            Show on Mac
          </Button>
        </p>
      ) : withFiles ? (
        <p role="status" className="mt-8 type-small text-ink-2">
          {withFiles}
        </p>
      ) : offline ? (
        <p className="mt-8 type-mono text-ink-3">Offline: can't send right now</p>
      ) : !phone ? (
        <p className="mt-8 flex items-center gap-6 type-mono text-ink-3">
          <Keycap size="sm">⌘↵</Keycap>
          <span>sends · typed into the terminal on your Mac</span>
        </p>
      ) : null}
    </form>
  );
}
